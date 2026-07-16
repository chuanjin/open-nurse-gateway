'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const { parseFrame, consume, bedFromAddress } = require('../src/parser');

test('parseFrame: happy path ATC → Emergency', () => {
  const r = parseFrame('ATC 0066 0066');
  assert.equal(r.ok, true);
  assert.equal(r.telemetry.type, 'Emergency');
  assert.equal(r.telemetry.bed, '102'); // 0x66 = 102
  assert.equal(r.telemetry.addr, '0066');
  assert.equal(r.telemetry.prefix, 'ATC');
});

test('parseFrame: NRS → Nurse', () => {
  const r = parseFrame('NRS 00CD 00CD');
  assert.equal(r.ok, true);
  assert.equal(r.telemetry.type, 'Nurse');
  assert.equal(r.telemetry.bed, '205'); // 0xCD = 205
});

test('parseFrame: STF → Staff (multi-floor)', () => {
  const r = parseFrame('STF 012D 012D');
  assert.equal(r.ok, true);
  assert.equal(r.telemetry.type, 'Staff');
  assert.equal(r.telemetry.bed, '1-45'); // 0x01, 0x2D
});

test('parseFrame: redundancy mismatch rejected', () => {
  const r = parseFrame('ATC 0066 0077');
  assert.equal(r.ok, false);
  assert.equal(r.reason, 'redundancy-mismatch');
});

test('parseFrame: unknown prefix rejected', () => {
  const r = parseFrame('XYZ 0066 0066');
  assert.equal(r.ok, false);
  assert.equal(r.reason, 'unknown-prefix');
});

test('parseFrame: malformed rejected', () => {
  const r = parseFrame('gibberish');
  assert.equal(r.ok, false);
  assert.equal(r.reason, 'format');
});

test('parseFrame: empty', () => {
  const r = parseFrame('');
  assert.equal(r.ok, false);
  assert.equal(r.reason, 'empty');
});

test('parseFrame: lowercase hex rejected (protocol is uppercase)', () => {
  const r = parseFrame('ATC 00cd 00cd');
  assert.equal(r.ok, false);
  assert.equal(r.reason, 'format');
});

test('consume: single frame with LF', () => {
  const { telemetries, malformed, state } = consume('ATC 0066 0066\n', { buffer: '' });
  assert.equal(telemetries.length, 1);
  assert.equal(telemetries[0].bed, '102');
  assert.equal(malformed.length, 0);
  assert.equal(state.buffer, '');
});

test('consume: single frame with CRLF', () => {
  const { telemetries, malformed, state } = consume('ATC 0066 0066\r\n', { buffer: '' });
  assert.equal(telemetries.length, 1);
  assert.equal(telemetries[0].bed, '102');
  assert.equal(malformed.length, 0);
  assert.equal(state.buffer, '');
});

test('consume: three frames one chunk', () => {
  const chunk = 'ATC 0066 0066\nNRS 00CD 00CD\nSTF 012D 012D\n';
  const { telemetries, malformed } = consume(chunk, { buffer: '' });
  assert.equal(telemetries.length, 3);
  assert.equal(malformed.length, 0);
  assert.deepEqual(telemetries.map((t) => t.type), ['Emergency', 'Nurse', 'Staff']);
});

test('consume: cross-chunk frame preserved in buffer', () => {
  let state = { buffer: '' };
  const r1 = consume('ATC 006', state);
  assert.equal(r1.telemetries.length, 0);
  assert.equal(r1.state.buffer, 'ATC 006');
  state = r1.state;

  const r2 = consume('6 0066\nNRS 00', state);
  assert.equal(r2.telemetries.length, 1);
  assert.equal(r2.telemetries[0].bed, '102');
  assert.equal(r2.state.buffer, 'NRS 00');
});

test('consume: malformed mixed with valid — malformed reported, valid emitted', () => {
  const chunk = 'ATC 0066 0066\ngarbage\nNRS 00CD 00CD\n';
  const { telemetries, malformed } = consume(chunk, { buffer: '' });
  assert.equal(telemetries.length, 2);
  assert.equal(malformed.length, 1);
  assert.equal(malformed[0].reason, 'format');
});

test('consume: oversize buffer without newline → whole buffer dropped', () => {
  const huge = 'x'.repeat(1000);
  const { telemetries, malformed, state } = consume(huge, { buffer: '' }, 100);
  assert.equal(telemetries.length, 0);
  assert.equal(malformed.length, 1);
  assert.equal(malformed[0].reason, 'oversize');
  assert.equal(state.buffer, '');
});

test('consume: oversize with trailing valid line → salvages last line', () => {
  const junk = 'x'.repeat(200);
  const good = 'ATC 0066 0066';
  const { telemetries, malformed } = consume(`${junk}\n${good}\n`, { buffer: '' }, 100);
  // Everything before the last newline in the oversized window is discarded,
  // then anything after (including a valid frame that arrived in the same chunk)
  // parses normally.
  assert.equal(malformed[0].reason, 'oversize');
  assert.equal(telemetries.length, 1);
  assert.equal(telemetries[0].bed, '102');
});

test('consume: empty chunks tolerated', () => {
  const { telemetries, malformed, state } = consume('', { buffer: '' });
  assert.equal(telemetries.length, 0);
  assert.equal(malformed.length, 0);
  assert.equal(state.buffer, '');
});

test('bedFromAddress: floor zero → bare unit', () => {
  assert.equal(bedFromAddress('0066'), '102');
  assert.equal(bedFromAddress('0000'), '0');
});

test('bedFromAddress: floor non-zero → floor-unit', () => {
  assert.equal(bedFromAddress('0102'), '1-2');
  assert.equal(bedFromAddress('FFFF'), '255-255');
});
