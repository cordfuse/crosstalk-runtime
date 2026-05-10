import { join } from 'path';
import { homedir } from 'os';
import { parseFrontmatter } from './frontmatter.js';

const LOCAL_CONFIG_PATH = join(homedir(), '.crosstalk', 'config.md');

export interface Config {
  transport: string;
  actorEmailSuffix: string;
  webhookPort?: number;
  webhookSecret?: string;
  defaultHeartbeatInterval?: number;
}

export async function loadConfig(): Promise<Config> {
  let localContent: string;
  try {
    localContent = await Bun.file(LOCAL_CONFIG_PATH).text();
  } catch {
    throw new Error(`~/.crosstalk/config.md not found. Create it with:\n\n---\ntransport: /path/to/transport\n---`);
  }

  const { data: localData } = parseFrontmatter(localContent);
  if (!localData.transport || typeof localData.transport !== 'string') {
    throw new Error(`~/.crosstalk/config.md is missing the 'transport' field`);
  }

  const transport = localData.transport.replace(/^~/, homedir());

  // read transport-level config for shared settings
  let actorEmailSuffix = 'crosstalk.noreply';
  try {
    const transportConfigPath = join(transport, 'config.md');
    const transportContent = await Bun.file(transportConfigPath).text();
    const { data: transportData } = parseFrontmatter(transportContent);
    if (typeof transportData['actor-email-suffix'] === 'string') {
      actorEmailSuffix = transportData['actor-email-suffix'];
    }
  } catch {
    // transport config.md is optional — use default suffix
  }

  let webhookPort: number | undefined;
  let webhookSecret: string | undefined;
  let defaultHeartbeatInterval: number | undefined;
  if (typeof localData['webhook-port'] === 'number') webhookPort = localData['webhook-port'] as number;
  if (typeof localData['webhook-secret'] === 'string') webhookSecret = localData['webhook-secret'] as string;
  if (typeof localData['default-heartbeat-interval'] === 'number') defaultHeartbeatInterval = localData['default-heartbeat-interval'] as number;

  return { transport, actorEmailSuffix, webhookPort, webhookSecret, defaultHeartbeatInterval };
}
