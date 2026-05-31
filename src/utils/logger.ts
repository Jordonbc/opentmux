import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

const logFile = path.join(os.tmpdir(), 'opencode-agent-tmux.log');

export type LogLevel = 'off' | 'error' | 'info' | 'debug';

const LOG_LEVEL_PRIORITY: Record<LogLevel, number> = {
  off: 0,
  error: 1,
  info: 2,
  debug: 3,
};

function normalizeLogLevel(value: string | undefined): LogLevel {
  switch ((value ?? '').trim().toLowerCase()) {
    case 'off':
    case 'none':
      return 'off';
    case 'error':
      return 'error';
    case 'debug':
    case 'trace':
      return 'debug';
    case 'info':
    case '':
      return 'info';
    default:
      return 'info';
  }
}

function getConfiguredLogLevel(): LogLevel {
  return normalizeLogLevel(process.env.OPENCODE_TMUX_LOG_LEVEL);
}

function shouldLog(level: LogLevel): boolean {
  return LOG_LEVEL_PRIORITY[getConfiguredLogLevel()] >= LOG_LEVEL_PRIORITY[level];
}

function serializeLogData(data: unknown): string {
  if (data === undefined) {
    return '';
  }

  try {
    return ` ${JSON.stringify(data)}`;
  } catch {
    return ` ${String(data)}`;
  }
}

export function log(message: string, data?: unknown): void {
  logAtLevel('info', message, data);
}

export function logError(message: string, data?: unknown): void {
  logAtLevel('error', message, data);
}

export function logDebug(message: string, data?: unknown): void {
  logAtLevel('debug', message, data);
}

function logAtLevel(level: Exclude<LogLevel, 'off'>, message: string, data?: unknown): void {
  if (!shouldLog(level)) {
    return;
  }

  try {
    const timestamp = new Date().toISOString();
    const logEntry = `[${timestamp}] [${level}] ${message}${serializeLogData(data)}\n`;
    fs.appendFileSync(logFile, logEntry);
  } catch {
    // Silently ignore logging errors
  }
}
