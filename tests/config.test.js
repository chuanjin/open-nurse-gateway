'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const { loadConfig } = require('../src/config');

test('defaults', () => {
  const c = loadConfig({});
  assert.equal(c.httpPort, 3000);
  assert.equal(c.ingestPort, 4001);
  assert.equal(c.ingestEnabled, true);
  assert.equal(c.ingestBindHost, '127.0.0.1');
  assert.equal(c.authToken, null);
  assert.deepEqual(c.allowedOrigins, ['http://localhost:3000', 'http://127.0.0.1:3000']);
  assert.equal(c.mockInjectorEnabled, false);
  assert.equal(c.iceServersIsDefault, true);
  assert.equal(c.msgMaxBytes, 65536);
  assert.equal(c.rateLimitPerSec, 50);
  assert.equal(c.logLevel, 'info');
});

test('PORT env parsed', () => {
  const c = loadConfig({ PORT: '4000' });
  assert.equal(c.httpPort, 4000);
});

test('bad PORT throws', () => {
  assert.throws(() => loadConfig({ PORT: 'not-a-number' }), /Invalid PORT/);
});

test('ALLOWED_ORIGINS split + trimmed', () => {
  const c = loadConfig({ ALLOWED_ORIGINS: 'http://a.com, http://b.com ,http://c.com' });
  assert.deepEqual(c.allowedOrigins, ['http://a.com', 'http://b.com', 'http://c.com']);
});

test('ALLOWED_ORIGINS wildcard preserved', () => {
  const c = loadConfig({ ALLOWED_ORIGINS: '*' });
  assert.deepEqual(c.allowedOrigins, ['*']);
});

test('AUTH_TOKEN captured', () => {
  const c = loadConfig({ AUTH_TOKEN: 'sekret' });
  assert.equal(c.authToken, 'sekret');
});

test('AUTH_TOKEN empty string treated as null', () => {
  const c = loadConfig({ AUTH_TOKEN: '' });
  assert.equal(c.authToken, null);
});

test('ICE_SERVERS json parsed', () => {
  const c = loadConfig({ ICE_SERVERS: '[{"urls":"stun:custom:19302"}]' });
  assert.equal(c.iceServersIsDefault, false);
  assert.deepEqual(c.iceServers, [{ urls: 'stun:custom:19302' }]);
});

test('ICE_SERVERS invalid json throws', () => {
  assert.throws(() => loadConfig({ ICE_SERVERS: '{not json' }), /Invalid ICE_SERVERS/);
});

test('ICE_SERVERS must be array', () => {
  assert.throws(() => loadConfig({ ICE_SERVERS: '{"urls":"stun:x"}' }), /must be a JSON array/);
});

test('ICE_SERVERS entry must have urls', () => {
  assert.throws(() => loadConfig({ ICE_SERVERS: '[{"foo":"bar"}]' }), /must have string or string\[]/);
});

test('MOCK_INJECTOR_ENABLED=1 enables', () => {
  const c = loadConfig({ MOCK_INJECTOR_ENABLED: '1' });
  assert.equal(c.mockInjectorEnabled, true);
});

test('MOCK_INJECTOR_ENABLED unset or 0 → disabled', () => {
  assert.equal(loadConfig({}).mockInjectorEnabled, false);
  assert.equal(loadConfig({ MOCK_INJECTOR_ENABLED: '0' }).mockInjectorEnabled, false);
  assert.equal(loadConfig({ MOCK_INJECTOR_ENABLED: 'yes' }).mockInjectorEnabled, false);
});

test('INGEST_ENABLED=0 disables ingest', () => {
  const c = loadConfig({ INGEST_ENABLED: '0' });
  assert.equal(c.ingestEnabled, false);
});
