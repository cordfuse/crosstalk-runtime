import { appendFileSync, mkdirSync } from 'fs';
import { dirname } from 'path';
import { createHash } from 'crypto';

export type LogLevel = 'debug' | 'info' | 'warn' | 'error';

interface LogEntry {
  ts: string;
  level: LogLevel;
  event: string;
  [key: string]: unknown;
}

let _logFile: string | null = null;

export function initLogger(logFile: string): void {
  mkdirSync(dirname(logFile), { recursive: true });
  _logFile = logFile;
}

// Deterministic 8-char trace ID derived from message path — correlates
// dispatch_start / dispatch_complete / dispatch_failed for the same message.
export function traceId(messageRelPath: string): string {
  return createHash('sha256').update(messageRelPath).digest('hex').slice(0, 8);
}

function write(level: LogLevel, event: string, fields: Record<string, unknown> = {}): void {
  const entry: LogEntry = { ts: new Date().toISOString(), level, event, ...fields };
  const line = JSON.stringify(entry);
  (level === 'error' || level === 'warn') ? console.error(line) : console.log(line);
  if (_logFile) {
    try { appendFileSync(_logFile, line + '\n'); } catch { /* never crash on log write */ }
  }
}

export const log = {
  debug: (event: string, fields?: Record<string, unknown>) => write('debug', event, fields),
  info:  (event: string, fields?: Record<string, unknown>) => write('info',  event, fields),
  warn:  (event: string, fields?: Record<string, unknown>) => write('warn',  event, fields),
  error: (event: string, fields?: Record<string, unknown>) => write('error', event, fields),
};
