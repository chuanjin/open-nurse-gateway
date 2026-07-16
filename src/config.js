'use strict';

// Central config: env → typed object. Fail-fast on obviously wrong input so
// misconfiguration surfaces at boot rather than as mysterious runtime errors.
// All fields exposed here MUST have a sane default so `node server.js` with an
// empty env starts a usable PoC.

const DEFAULT_ICE_SERVERS = [{ urls: 'stun:stun.l.google.com:19302' }];
const DEFAULT_ALLOWED_ORIGINS = 'http://localhost:3000,http://127.0.0.1:3000';

function parseIntEnv(name, def, env) {
  const raw = env[name];
  if (raw == null || raw === '') return def;
  const n = parseInt(raw, 10);
  if (!Number.isFinite(n)) {
    throw new Error(`Invalid ${name}=${raw}: expected integer`);
  }
  return n;
}

function parseIceServers(raw) {
  if (!raw) return { value: DEFAULT_ICE_SERVERS, isDefault: true };
  let parsed;
  try {
    parsed = JSON.parse(raw);
  } catch (e) {
    throw new Error(`Invalid ICE_SERVERS JSON: ${e.message}`);
  }
  if (!Array.isArray(parsed)) {
    throw new Error('ICE_SERVERS must be a JSON array');
  }
  for (const entry of parsed) {
    if (typeof entry !== 'object' || entry === null) {
      throw new Error('ICE_SERVERS entry must be an object');
    }
    if (typeof entry.urls !== 'string' && !Array.isArray(entry.urls)) {
      throw new Error('ICE_SERVERS entry must have string or string[] "urls"');
    }
  }
  return { value: parsed, isDefault: false };
}

function parseOrigins(raw) {
  const s = raw ?? DEFAULT_ALLOWED_ORIGINS;
  return s.split(',').map((x) => x.trim()).filter(Boolean);
}

function loadConfig(env = process.env) {
  const ice = parseIceServers(env.ICE_SERVERS);
  return {
    httpPort: parseIntEnv('PORT', 3000, env),
    ingestPort: parseIntEnv('INGEST_PORT', 4001, env),
    ingestEnabled: env.INGEST_ENABLED !== '0',
    ingestBindHost: env.INGEST_BIND_HOST || '127.0.0.1',
    ingestMaxLineBytes: parseIntEnv('INGEST_MAX_LINE_BYTES', 512, env),
    authToken: env.AUTH_TOKEN || null,
    allowedOrigins: parseOrigins(env.ALLOWED_ORIGINS),
    iceServers: ice.value,
    iceServersIsDefault: ice.isDefault,
    msgMaxBytes: parseIntEnv('MSG_MAX_BYTES', 65536, env),
    rateLimitPerSec: parseIntEnv('RATE_LIMIT_PER_SEC', 50, env),
    mockInjectorEnabled: env.MOCK_INJECTOR_ENABLED === '1',
    mockInjectorIntervalMs: parseIntEnv('MOCK_INJECTOR_INTERVAL_MS', 15000, env),
    logLevel: env.LOG_LEVEL || 'info',
  };
}

module.exports = { loadConfig };
