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

/** Inspect a raw message file. If it's encrypted (encryption: age frontmatter
 * + fenced ```age block in body), attempt to decrypt with this actor's
 * private key (current + archived for rotated keys). On success, return a
 * new message-file string with the body replaced by the decrypted plaintext
 * — frontmatter preserved EXCEPT the encryption-related fields are stripped
 * so downstream code (agents, validators) sees a normal plaintext message.
 *
 * Returns:
 * - the original messageContent unchanged if not encrypted
 * - the decrypted-body messageContent if encrypted + we have a key that works
 * - the literal string 'skip' if encrypted + we don't have a key that works
 *   (caller should skip dispatch, not propagate ciphertext to the agent)
 *
 * Throws on unexpected errors (malformed armor, etc.) — caller treats as
 * skip + cursor-advance to avoid retry loops.
 */
async function maybeDecryptInbound(messageContent: string, actorName: string): Promise<string | 'skip'> {
  const { parseFrontmatter } = await import('./frontmatter.js')
  const { data, body } = parseFrontmatter(messageContent)
  const encryption = String(data.encryption ?? '')
  if (encryption !== 'age') return messageContent  // not encrypted, pass through

  const { unwrapFromMessageBody, decrypt } = await import('./crypto.js')
  const armored = unwrapFromMessageBody(body)
  if (!armored) {
    throw new Error(`encryption: age set but no fenced age block in body`)
  }

  const { loadActorIdentity, loadActorIdentityArchive } = await import('./keys.js')
  const current = loadActorIdentity(actorName)
  const archived = loadActorIdentityArchive(actorName)

  // Try current first, then archived (newest archive first per loader sort).
  // Any one matching identity successfully decrypts (age multi-recipient envelope
  // unwraps with whichever key is in the recipient list).
  const candidates = current ? [current, ...archived] : archived
  if (candidates.length === 0) {
    return 'skip'
  }

  for (const id of candidates) {
    try {
      const plaintext = await decrypt(armored, id)
      // Successfully decrypted. Reconstruct the message file with plaintext body
      // and encryption fields stripped from frontmatter.
      const cleanData: Record<string, unknown> = { ...data }
      delete cleanData.encryption
      delete cleanData['encrypted-to']
      const fmLines = Object.entries(cleanData).map(([k, v]) => `${k}: ${v}`).join('\n')
      return `---\n${fmLines}\n---\n\n${plaintext}\n`
    } catch {
      continue  // try next identity
    }
  }

  // None of our identities (current + archived) could decrypt — message is
  // encrypted to a recipient set that doesn't include any of our actor's keys.
  return 'skip'
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

  // v0.8.1+ — capture the inbound's privacy state BEFORE decrypting, so the
  // outbound response can encrypt back to the same recipient set ("respond
  // in kind"). For plaintext inbound, both fields stay null and the response
  // goes plaintext. For encrypted inbound, response gets encrypted to the
  // ORIGINAL recipient set (preserves group conversation visibility per the
  // PRIVACY.md `to:` is routing, `encrypted-to:` is privacy distinction).
  let inboundFrom: string | null = null;
  let inboundEncryptedTo: string[] | null = null;
  try {
    const { parseFrontmatter } = await import('./frontmatter.js');
    const { data } = parseFrontmatter(messageContent);
    inboundFrom = typeof data.from === 'string' ? data.from : null;
    if (String(data.encryption ?? '') === 'age') {
      const et = String(data['encrypted-to'] ?? '');
      inboundEncryptedTo = et ? et.split(',').map(s => s.trim()).filter(Boolean) : [];
    }
  } catch {
    // Malformed frontmatter — fall through; downstream decrypt-or-skip catches.
  }

  // v0.8.0-alpha.4+ inbound decryption: if the message is encrypted with age,
  // decrypt the body using this actor's private key before passing to the
  // agent. If decryption fails (no key, wrong key, malformed ciphertext),
  // log + skip dispatch — never pass ciphertext to an agent that can't read it,
  // and never silent-fail to plaintext.
  try {
    const decrypted = await maybeDecryptInbound(messageContent, actor.name)
    if (decrypted === 'skip') {
      console.warn(`[dispatch] skipping ${actor.name} for ${messagePath}: encrypted message + no usable key on this machine`)
      // Advance cursor so we don't keep retrying — operator must add a key (or
      // accept the message stays undelivered to this actor).
      await writeCursor(sessionId, channelGuid, messagePath);
      return;
    }
    messageContent = decrypted
  } catch (err) {
    console.error(`[dispatch] ${actor.name} decryption error for ${messagePath}: ${err}`)
    await writeCursor(sessionId, channelGuid, messagePath);
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

  // v0.8.1+ — start the stdout consumer IMMEDIATELY (before awaiting exit).
  // Required for fast writers: if a process writes a small payload and exits
  // before any stream consumer is attached, node loses the output (the data
  // sits in the OS pipe, the writer side closes on exit, and the read-side
  // stream emits 'end' with nothing buffered to JS). Real LLM agents take
  // seconds and write KB+ of output, so they don't hit this — but custom-
  // command actors with quick responses (or test harnesses) do.
  const stdoutP: Promise<string> = proc.stdout ? text(proc.stdout) : Promise.resolve('');

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
      const raw = await stdoutP;
      const stdout = actor.agent === 'opencode' ? extractOpenCodeText(raw) : raw;
      console.log(`[dispatch] ${actor.name} stdout length=${stdout.length}`);
      const gitEmail = actor.gitEmail ?? machineGitEmail(actor.name, actorEmailSuffix);

      if (stdout.trim()) {
        // v0.8.1+ — if inbound was encrypted, encrypt the response back to the
        // same recipient set ("respond in kind"). Preserves group visibility:
        // if alice posted encrypted to [bob, carol], bob's response goes
        // encrypted to [alice, bob, carol] (alice added so the original sender
        // can read the reply; bob added for self-readability). Routing
        // `to: <inbound from>` since the response is addressed to the asker.
        let body = stdout.trim();
        let toOverride: string | undefined;
        let extraFrontmatter: Record<string, string> | undefined;

        if (inboundEncryptedTo !== null) {
          const recipientSet = new Set<string>(inboundEncryptedTo);
          if (inboundFrom) recipientSet.add(inboundFrom);
          recipientSet.add(actor.name);
          const recipientNames = [...recipientSet];

          try {
            const { loadActorRecipients } = await import('./keys.js');
            const recipientMap = loadActorRecipients(transportRoot, recipientNames);
            const missing = recipientNames.filter(n => !recipientMap.has(n));

            if (recipientMap.size === 0) {
              console.warn(`[dispatch] ${actor.name} response-in-kind: NO recipients have pubkeys on this machine — falling back to PLAINTEXT response (privacy regression). Missing: ${missing.join(', ')}`);
            } else {
              if (missing.length > 0) {
                console.warn(`[dispatch] ${actor.name} response-in-kind: ${missing.length} recipient(s) without pubkey will see opaque ciphertext: ${missing.join(', ')}`);
              }
              const recipients = [...recipientMap.values()];
              const encryptedToNames = [...recipientMap.keys()];
              const { encrypt, wrapForMessageBody } = await import('./crypto.js');
              const armored = await encrypt(stdout.trim(), recipients);
              body = wrapForMessageBody(armored).trimEnd();
              extraFrontmatter = { encryption: 'age', 'encrypted-to': encryptedToNames.join(', ') };
              if (inboundFrom) toOverride = inboundFrom;
              console.log(`[dispatch] ${actor.name} response encrypted to ${recipientMap.size} recipient(s): ${encryptedToNames.join(', ')}`);
            }
          } catch (err) {
            console.error(`[dispatch] ${actor.name} response-in-kind encryption failed: ${err} — falling back to PLAINTEXT response (privacy regression)`);
          }
        }

        await writeResponseMessage(
          actorTransport, channelGuid, actor.name, gitEmail,
          body, actor.agent, actor.model,
          toOverride, extraFrontmatter,
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
