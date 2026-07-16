'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const {
  extractToken,
  isOriginAllowed,
  verifyUpgrade,
  constantTimeEqual,
} = require('../src/auth');

function mockReq({ url = '/', headers = {} } = {}) {
  return { url, headers };
}

test('extractToken: query string', () => {
  const t = extractToken(mockReq({ url: '/?token=abc123' }));
  assert.equal(t.token, 'abc123');
  assert.equal(t.via, 'query');
});

test('extractToken: subprotocol bearer', () => {
  const t = extractToken(mockReq({ headers: { 'sec-websocket-protocol': 'bearer, xyz789' } }));
  assert.equal(t.token, 'xyz789');
  assert.equal(t.via, 'subprotocol');
});

test('extractToken: subprotocol takes precedence over query', () => {
  const t = extractToken(mockReq({
    url: '/?token=fromQuery',
    headers: { 'sec-websocket-protocol': 'bearer, fromProto' },
  }));
  assert.equal(t.token, 'fromProto');
  assert.equal(t.via, 'subprotocol');
});

test('extractToken: none provided', () => {
  const t = extractToken(mockReq());
  assert.equal(t.token, null);
  assert.equal(t.via, null);
});

test('isOriginAllowed: exact match', () => {
  const req = mockReq({ headers: { origin: 'http://localhost:3000' } });
  assert.equal(isOriginAllowed(req, ['http://localhost:3000']), true);
});

test('isOriginAllowed: mismatch rejected', () => {
  const req = mockReq({ headers: { origin: 'http://evil.com' } });
  assert.equal(isOriginAllowed(req, ['http://localhost:3000']), false);
});

test('isOriginAllowed: wildcard permits any', () => {
  const req = mockReq({ headers: { origin: 'http://anything.com' } });
  assert.equal(isOriginAllowed(req, ['*']), true);
});

test('isOriginAllowed: wildcard permits missing origin', () => {
  assert.equal(isOriginAllowed(mockReq(), ['*']), true);
});

test('isOriginAllowed: missing origin rejected when wildcard absent', () => {
  assert.equal(isOriginAllowed(mockReq(), ['http://localhost:3000']), false);
});

test('verifyUpgrade: no token configured → anonymous ok', () => {
  const req = mockReq({ headers: { origin: 'http://localhost:3000' } });
  const v = verifyUpgrade(req, { allowedOrigins: ['http://localhost:3000'], authToken: null });
  assert.equal(v.ok, true);
  assert.equal(v.via, 'anonymous');
});

test('verifyUpgrade: bad origin blocked (403)', () => {
  const req = mockReq({ headers: { origin: 'http://evil.com' } });
  const v = verifyUpgrade(req, { allowedOrigins: ['http://localhost:3000'], authToken: null });
  assert.equal(v.ok, false);
  assert.equal(v.code, 403);
});

test('verifyUpgrade: token required and missing (401)', () => {
  const req = mockReq({ headers: { origin: 'http://localhost:3000' } });
  const v = verifyUpgrade(req, { allowedOrigins: ['http://localhost:3000'], authToken: 'sekret' });
  assert.equal(v.ok, false);
  assert.equal(v.code, 401);
  assert.equal(v.reason, 'no-token');
});

test('verifyUpgrade: token matches (query)', () => {
  const req = mockReq({ url: '/?token=sekret', headers: { origin: 'http://localhost:3000' } });
  const v = verifyUpgrade(req, { allowedOrigins: ['http://localhost:3000'], authToken: 'sekret' });
  assert.equal(v.ok, true);
  assert.equal(v.via, 'query');
});

test('verifyUpgrade: token wrong (401)', () => {
  const req = mockReq({ url: '/?token=wrong', headers: { origin: 'http://localhost:3000' } });
  const v = verifyUpgrade(req, { allowedOrigins: ['http://localhost:3000'], authToken: 'sekret' });
  assert.equal(v.ok, false);
  assert.equal(v.code, 401);
  assert.equal(v.reason, 'bad-token');
});

test('constantTimeEqual', () => {
  assert.equal(constantTimeEqual('a', 'a'), true);
  assert.equal(constantTimeEqual('a', 'b'), false);
  assert.equal(constantTimeEqual('abc', 'ab'), false);
  assert.equal(constantTimeEqual('', ''), true);
});

test('constantTimeEqual: non-string inputs', () => {
  assert.equal(constantTimeEqual(null, 'a'), false);
  assert.equal(constantTimeEqual('a', undefined), false);
  assert.equal(constantTimeEqual(1, 1), false);
});
