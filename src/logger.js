'use strict';

// Minimal structured JSON logger. Zero deps. Level-filtered. Emits one JSON
// object per line to stdout. Supports .child(bindings) for scoped context.

const LEVELS = { error: 40, warn: 30, info: 20, debug: 10 };

function createLogger(minLevel = 'info', bindings = {}) {
  const min = LEVELS[minLevel] ?? LEVELS.info;

  function write(level, msg, data) {
    if ((LEVELS[level] ?? 0) < min) return;
    const entry = { t: new Date().toISOString(), level, msg };
    if (bindings && typeof bindings === 'object') Object.assign(entry, bindings);
    if (data && typeof data === 'object') Object.assign(entry, data);
    // Serialize errors readably (Error properties are non-enumerable by default).
    if (data && data.err instanceof Error) {
      entry.err = { message: data.err.message, name: data.err.name, stack: data.err.stack };
    }
    try {
      process.stdout.write(JSON.stringify(entry) + '\n');
    } catch (e) {
      // Last resort: don't crash the app because of a logging failure.
      process.stderr.write(`[logger-fail] ${e.message}\n`);
    }
  }

  return {
    error: (msg, data) => write('error', msg, data),
    warn: (msg, data) => write('warn', msg, data),
    info: (msg, data) => write('info', msg, data),
    debug: (msg, data) => write('debug', msg, data),
    child(more) {
      return createLogger(minLevel, { ...bindings, ...more });
    },
  };
}

module.exports = { createLogger };
