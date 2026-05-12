import type { ActorConfig } from './registry.js';
import { commitActorMessage, ensureActorClone, machineGitEmail, writeResponseMessage } from './git.js';
import { announceTimeout } from './system.js';
import { writeCursor } from './cursor.js';
import { homedir } from 'os';
import { join } from 'path';
import { spawn, type ChildProcess } from 'child_process';
import { readFile } from 'fs/promises';
import { text } from 'stream/consumers';

const HOME = homedir();
const EXTRA_PATH = [join(HOME, '.bun', 'bin'), join(HOME, '.local', 'bin')];
const augmentedPath = [...EXTRA_PATH, process.env.PATH ?? ''].join(':');

const DEDUP_WINDOW_MS = 2000;
const recentlyDispatched = new Map<string, number>();

export function isDuplicate(key: string): boolean {
  const now = Date.now();
  const last = recentlyDispatched.get(key);
  if (last && now - last < DEDUP_WINDOW_MS) return true;
  recentlyDispatched.set(key, now);
  for (const [k, t] of recentlyDispatched) {
    if (now - t > DEDUP_WINDOW_MS * 10) recentlyDispatched.delete(k);
  }
  return false;
}

function substituteVars(template: string, vars: Record<string, string>): string {
  return template.replace(/\{(\w+)\}/g, (_, key) => vars[key] ?? `{${key}}`);
}

// Common spawn options for agent CLIs: ignore stdin, capture stdout, inherit stderr.
const AGENT_STDIO = ['ignore', 'pipe', 'inherit'] as const;

function spawnClaude(actor: ActorConfig, messageContent: string): ChildProcess {
  const personality = actor.personality ?? `You are ${actor.name}.`;
  const model = actor.model ?? 'claude-sonnet-4-6';
  const userPrompt = `The following message arrived in your channel:\n\n${messageContent}\n\nRespond in character. Write only your response.`;

  return spawn('claude', [
    '--print',
    '--dangerously-skip-permissions',
    '--model', model,
    '--no-session-persistence',
    '--system-prompt', personality,
    userPrompt,
  ], {
    stdio: [...AGENT_STDIO],
    env: { ...process.env, PATH: augmentedPath },
  });
}

function spawnGemini(actor: ActorConfig, messageContent: string): ChildProcess {
  const personality = actor.personality ?? `You are ${actor.name}.`;
  const model = actor.model ?? 'gemini-2.5-flash';
  // Gemini has no --system-prompt flag; bake personality into the prompt body
  const prompt = `${personality}\n\n---\n\nThe following message arrived in your channel:\n\n${messageContent}\n\nRespond in character. Write only your response.`;

  return spawn('gemini', ['-m', model, '-p', prompt, '-y', '--output-format', 'text'], {
    stdio: [...AGENT_STDIO],
    env: { ...process.env, PATH: augmentedPath },
  });
}

function spawnQwen(actor: ActorConfig, messageContent: string): ChildProcess {
  const personality = actor.personality ?? `You are ${actor.name}.`;
  const model = actor.model ?? 'qwen-plus';
  const userPrompt = `The following message arrived in your channel:\n\n${messageContent}\n\nRespond in character. Write only your response.`;

  return spawn('qwen', [
    userPrompt,
    '--system-prompt', personality,
    '--model', model,
    '-y',
    '--output-format', 'text',
    '--no-chat-recording',
  ], {
    stdio: [...AGENT_STDIO],
    env: { ...process.env, PATH: augmentedPath },
  });
}

function spawnOpenCode(actor: ActorConfig, messageContent: string): ChildProcess {
  const personality = actor.personality ?? `You are ${actor.name}.`;
  const model = actor.model ?? 'ollama/mistral-nemo:latest';
  // OpenCode has no --system-prompt flag; bake personality into the message
  const prompt = `${personality}\n\n---\n\nThe following message arrived in your channel:\n\n${messageContent}\n\nRespond in character. Write only your response.`;

  return spawn('opencode', ['run', prompt, '-m', model, '--dangerously-skip-permissions', '--format', 'json'], {
    stdio: [...AGENT_STDIO],
    env: { ...process.env, PATH: augmentedPath },
  });
}

// Extract response text from opencode's JSONL event stream
function extractOpenCodeText(jsonl: string): string {
  return jsonl
    .split('\n')
    .filter(Boolean)
    .reduce((acc, line) => {
      try {
        const ev = JSON.parse(line) as { type: string; part?: { type: string; text: string } };
        if (ev.type === 'text' && ev.part?.type === 'text') return acc + ev.part.text;
      } catch {}
      return acc;
    }, '');
}

function spawnCustom(actor: ActorConfig, vars: Record<string, string>): ChildProcess {
  if (!actor.command) throw new Error(`[dispatch] ${actor.name}: no command defined and agent "${actor.agent}" is not a native provider`);
  const args = actor.args.map(a => substituteVars(a, vars));
  return spawn(actor.command, args, {
    stdio: [...AGENT_STDIO],
    env: { ...process.env, PATH: augmentedPath },
  });
}

export async function dispatch(
  actor: ActorConfig,
  transportRoot: string,
  channelGuid: string,
  messagePath: string,
  actorEmailSuffix: string,
  sessionId = 'default',
  defaultHeartbeatInterval?: number,
): Promise<void> {
  const actorTransport = await ensureActorClone(transportRoot, actor.name);

  const vars: Record<string, string> = {
    transport_root: actorTransport,
    channel: channelGuid,
    message_path: messagePath,
    session_id: sessionId,
    actor_name: actor.name,
  };

  console.log(`[dispatch] → ${actor.name}  agent=${actor.agent ?? 'custom'}  msg=${messagePath}`);

  // Read message from the shared transport (not the actor clone — it may not be committed yet)
  let messageContent = '';
  try {
    messageContent = await readFile(join(transportRoot, 'channels', channelGuid, messagePath), 'utf-8');
  } catch {
    console.error(`[dispatch] could not read message: ${messagePath}`);
    return;
  }

  let proc: ChildProcess;
  try {
    proc = actor.agent === 'claude' ? spawnClaude(actor, messageContent)
      : actor.agent === 'gemini' ? spawnGemini(actor, messageContent)
      : actor.agent === 'qwen' ? spawnQwen(actor, messageContent)
      : actor.agent === 'opencode' ? spawnOpenCode(actor, messageContent)
      : spawnCustom(actor, vars);
  } catch (err) {
    console.error(`[dispatch] ${actor.name} spawn failed: ${err}`);
    return;
  }

  const exited = new Promise<number | null>((resolve) => {
    proc.on('exit', code => resolve(code));
    proc.on('error', () => resolve(null));
  });

  const timeoutMs = (actor.heartbeatInterval ?? defaultHeartbeatInterval ?? 30) * 1000;
  const timer = setTimeout(async () => {
    proc.kill();
    console.error(`[dispatch] ${actor.name} timed out after ${timeoutMs / 1000}s`);
    await announceTimeout(transportRoot, actor.name, channelGuid);
  }, timeoutMs);

  exited.then(async code => {
    clearTimeout(timer);
    console.log(`[dispatch] ${actor.name} exited code=${code}`);

    if (code !== 0 && code !== null) {
      console.error(`[dispatch] ${actor.name} failed with code ${code}`);
      await writeCursor(sessionId, channelGuid, messagePath);
      return;
    }

    try {
      const raw = proc.stdout ? await text(proc.stdout) : '';
      const stdout = actor.agent === 'opencode' ? extractOpenCodeText(raw) : raw;
      console.log(`[dispatch] ${actor.name} stdout length=${stdout.length}`);
      const gitEmail = actor.gitEmail ?? machineGitEmail(actor.name, actorEmailSuffix);

      if (stdout.trim()) {
        await writeResponseMessage(
          actorTransport, channelGuid, actor.name, gitEmail,
          stdout.trim(), actor.agent, actor.model,
        );
        console.log(`[dispatch] ${actor.name} response written`);
      } else {
        await commitActorMessage(actorTransport, channelGuid, actor.name, gitEmail);
      }

      await writeCursor(sessionId, channelGuid, messagePath);
    } catch (err) {
      console.error(`[dispatch] ${actor.name} post-exit error: ${err}`);
    }
  });
}
