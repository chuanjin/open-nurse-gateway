'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const { validateMessage } = require('../src/schema');

const SDP_STUB = 'v=0\r\no=- 4611731400430051336 2 IN IP4 127.0.0.1\r\ns=-\r\nt=0 0';

test('reject non-object', () => {
  assert.equal(validateMessage(null).ok, false);
  assert.equal(validateMessage('str').ok, false);
  assert.equal(validateMessage(42).ok, false);
  assert.equal(validateMessage([]).ok, false);
  assert.equal(validateMessage(undefined).ok, false);
});

test('reject missing type', () => {
  const r = validateMessage({});
  assert.equal(r.ok, false);
  assert.equal(r.reason, 'no-type');
});

test('reject unknown type', () => {
  const r = validateMessage({ type: 'evil' });
  assert.equal(r.ok, false);
  assert.equal(r.reason, 'unknown-type');
});

test('hello: default role=nurse when role omitted', () => {
  const r = validateMessage({ type: 'hello' });
  assert.equal(r.ok, true);
  assert.equal(r.message.role, 'nurse');
  assert.equal(r.message.bedId, null);
});

test('hello: role=room requires bedId', () => {
  const bad = validateMessage({ type: 'hello', role: 'room' });
  assert.equal(bad.ok, false);
  assert.equal(bad.reason, 'bad-bedId');

  const ok = validateMessage({ type: 'hello', role: 'room', bedId: '102' });
  assert.equal(ok.ok, true);
  assert.equal(ok.message.bedId, '102');
});

test('hello: bad role rejected', () => {
  const r = validateMessage({ type: 'hello', role: 'admin' });
  assert.equal(r.ok, false);
  assert.equal(r.reason, 'bad-role');
});

test('hello: oversized bedId rejected', () => {
  const r = validateMessage({ type: 'hello', role: 'room', bedId: 'x'.repeat(33) });
  assert.equal(r.ok, false);
  assert.equal(r.reason, 'bad-bedId');
});

test('offer: rejects missing sdp / callId / targetBed', () => {
  assert.equal(validateMessage({ type: 'offer' }).reason, 'no-sdp');
  assert.equal(validateMessage({ type: 'offer', sdp: 'x' }).reason, 'no-sdp');
  assert.equal(validateMessage({ type: 'offer', sdp: SDP_STUB }).reason, 'bad-callId');
  assert.equal(
    validateMessage({ type: 'offer', sdp: SDP_STUB, callId: 'c1' }).reason,
    'bad-targetBed'
  );
});

test('offer: happy path', () => {
  const r = validateMessage({ type: 'offer', sdp: SDP_STUB, callId: 'c1', targetBed: '102' });
  assert.equal(r.ok, true);
  assert.equal(r.message.callId, 'c1');
  assert.equal(r.message.targetBed, '102');
});

test('answer: requires sdp + callId', () => {
  assert.equal(validateMessage({ type: 'answer', sdp: SDP_STUB }).reason, 'bad-callId');
  const r = validateMessage({ type: 'answer', sdp: SDP_STUB, callId: 'c1' });
  assert.equal(r.ok, true);
});

test('candidate: requires candidate + callId', () => {
  const bad = validateMessage({ type: 'candidate', callId: 'c1' });
  assert.equal(bad.reason, 'no-candidate');

  const r = validateMessage({
    type: 'candidate',
    callId: 'c1',
    candidate: { candidate: 'candidate:1 1 UDP 100 1.2.3.4 5000 typ host' },
  });
  assert.equal(r.ok, true);
});

test('hangup: requires callId', () => {
  assert.equal(validateMessage({ type: 'hangup' }).reason, 'bad-callId');
  const r = validateMessage({ type: 'hangup', callId: 'c1' });
  assert.equal(r.ok, true);
});

test('oversized callId rejected', () => {
  const r = validateMessage({ type: 'hangup', callId: 'x'.repeat(65) });
  assert.equal(r.ok, false);
  assert.equal(r.reason, 'bad-callId');
});
