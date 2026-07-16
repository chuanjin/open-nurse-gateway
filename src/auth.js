'use strict';

// WebSocket upgrade auth.
//
// Two mechanisms supported side-by-side:
//   1. Query string:  ws://host/?token=xxx    ← primary for browsers
//   2. Subprotocol:   Sec-WebSocket-Protocol: bearer, <token>
//
// Both are token-in-plaintext when the transport is ws:// — that is a PoC
// deployment concern, not this layer's. The subprotocol path exists so a
// production deployment can prefer it under wss:// without protocol changes.
//
// Also enforces an Origin allowlist. Non-browser clients (Node ws, curl) may
// omit Origin — those are only accepted when '*' is in the allowlist.

const { URL } = require('url');

function extractToken(req) {
  const proto = req.headers['sec-websocket-protocol'];
  if (typeof proto === 'string') {
    const parts = proto.split(',').map((s) => s.trim());
    if (parts.length >= 2 && parts[0] === 'bearer') {
      return { token: parts[1], via: 'subprotocol' };
    }
  }
  try {
    const url = new URL(req.url || '/', 'http://placeholder');
    const q = url.searchParams.get('token');
    if (q) return { token: q, via: 'query' };
  } catch (_) {
    // Malformed URL: fall through.
  }
  return { token: null, via: null };
}

function isOriginAllowed(req, allowed) {
  const origin = req.headers.origin;
  if (allowed.includes('*')) return true;
  if (!origin) {
    // Non-browser clients omit Origin. In strict mode we reject; only permit
    // via explicit '*' allowlist (handled above).
    return false;
  }
  return allowed.includes(origin);
}

function constantTimeEqual(a, b) {
  if (typeof a !== 'string' || typeof b !== 'string') return false;
  if (a.length !== b.length) return false;
  let mismatch = 0;
  for (let i = 0; i < a.length; i++) {
    mismatch |= a.charCodeAt(i) ^ b.charCodeAt(i);
  }
  return mismatch === 0;
}

// Returns:
//   { ok: true,  via: 'anonymous' | 'query' | 'subprotocol' }
//   { ok: false, code: 401 | 403, reason: string, ... }
function verifyUpgrade(req, config) {
  if (!isOriginAllowed(req, config.allowedOrigins)) {
    return { ok: false, code: 403, reason: 'origin-not-allowed', origin: req.headers.origin || null };
  }
  if (config.authToken) {
    const { token, via } = extractToken(req);
    if (!token) return { ok: false, code: 401, reason: 'no-token' };
    if (!constantTimeEqual(token, config.authToken)) {
      return { ok: false, code: 401, reason: 'bad-token', via };
    }
    return { ok: true, via };
  }
  return { ok: true, via: 'anonymous' };
}

module.exports = { extractToken, isOriginAllowed, verifyUpgrade, constantTimeEqual };
