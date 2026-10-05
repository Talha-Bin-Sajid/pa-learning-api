/**
 * Minimal structured logger (JSON lines). Keeps the dependency count low;
 * swap for pino later without touching callers.
 */

type Level = 'debug' | 'info' | 'warn' | 'error';
const ORDER: Record<Level, number> = { debug: 10, info: 20, warn: 30, error: 40 };
const REDACT = /pass(word)?|secret|token|authorization|api[-_]?key|service[-_]?role/i;

export interface Logger {
  debug(msg: string, meta?: Record<string, unknown>): void;
  info(msg: string, meta?: Record<string, unknown>): void;
  warn(msg: string, meta?: Record<string, unknown>): void;
  error(msg: string, meta?: Record<string, unknown>): void;
}

function redact(value: unknown, depth = 0): unknown {
  if (depth > 4 || value === null || typeof value !== 'object') return value;
  if (value instanceof Error) return { name: value.name, message: value.message, stack: value.stack };
  if (Array.isArray(value)) return value.map((v) => redact(v, depth + 1));
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(value)) out[k] = REDACT.test(k) ? '[redacted]' : redact(v, depth + 1);
  return out;
}

export function createLogger(minLevel: Level = 'info'): Logger {
  const write = (level: Level, msg: string, meta?: Record<string, unknown>) => {
    if (ORDER[level] < ORDER[minLevel]) return;
    const line = JSON.stringify({
      time: new Date().toISOString(),
      level,
      msg,
      ...(redact(meta ?? {}) as object),
    });
    if (level === 'error' || level === 'warn') process.stderr.write(line + '\n');
    else process.stdout.write(line + '\n');
  };
  return {
    debug: (m, meta) => write('debug', m, meta),
    info: (m, meta) => write('info', m, meta),
    warn: (m, meta) => write('warn', m, meta),
    error: (m, meta) => write('error', m, meta),
  };
}

/** Logger that discards everything - for tests. */
export const silentLogger: Logger = { debug() {}, info() {}, warn() {}, error() {} };
