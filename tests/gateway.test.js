'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { EventEmitter } = require('events');

const { SignalingGateway } = require('../src/gateway');

// ── Stubs ─────────────────────────────────────────────────────────────────────

function makeLogger() {
  return {
    info: () => {},
    warn: () => {},
    debug: () => {},
    error: () => {},
    child() { return this; },
  };
}

function makeConfig(overrides = {}) {
  return {
    msgMaxBytes: 65536,
    rateLimitPerSec: 50,
    iceServers: [{ urls: 'stun:test.example.com:19302' }],
    allowedOrigins: [],
    ...overrides,
  };
}

// Fake WebSocket — extends EventEmitter so ws.emit('message', ...) / ws.emit('close') work.
class FakeWS extends EventEmitter {
  constructor() {
    super();
    this.readyState = 1; // OPEN
    this.messages = [];
  }
  send(raw) {
    this.messages.push(JSON.parse(raw));
  }
  // Helper: get last message
  last() { return this.messages[this.messages.length - 1]; }
}

function makeGateway(configOverrides = {}) {
  return new SignalingGateway({ config: makeConfig(configOverrides), logger: makeLogger() });
}

// Connect a fake WS, return { ws, clientId }.
function connect(gw) {
  const ws = new FakeWS();
  gw.onConnection(ws);
  const welcome = ws.messages[0];
  assert.equal(welcome.type, 'welcome', 'first message must be welcome');
  return { ws, clientId: welcome.clientId };
}

// Send a raw message as if coming from clientId.
function send(gw, clientId, obj) {
  gw._handleMessage(clientId, JSON.stringify(obj));
}

const SDP = 'v=0\r\no=- 46117 2 IN IP4 127.0.0.1\r\ns=-\r\nt=0 0\r\na=recvonly';

// ── Tests ─────────────────────────────────────────────────────────────────────

test('welcome: sent on connect with clientId and iceServers', () => {
  const gw = makeGateway();
  const { ws, clientId } = connect(gw);
  assert.equal(ws.messages.length, 1);
  assert.equal(ws.messages[0].type, 'welcome');
  assert.equal(typeof clientId, 'string');
  assert.ok(clientId.length > 0);
  assert.deepEqual(ws.messages[0].iceServers, [{ urls: 'stun:test.example.com:19302' }]);
});

test('hello: sets role=room with bedId', () => {
  const gw = makeGateway();
  const { ws, clientId } = connect(gw);
  send(gw, clientId, { type: 'hello', role: 'room', bedId: '102' });
  const entry = gw.clients.get(clientId);
  assert.equal(entry.role, 'room');
  assert.equal(entry.bedId, '102');
});

test('hello: ignored on second call (guard prevents re-identification)', () => {
  const gw = makeGateway();
  const { ws, clientId } = connect(gw);
  send(gw, clientId, { type: 'hello', role: 'room', bedId: '102' });
  // Second hello should be ignored
  send(gw, clientId, { type: 'hello', role: 'room', bedId: '999' });
  const entry = gw.clients.get(clientId);
  assert.equal(entry.bedId, '102'); // unchanged
});

test('offer: routed to target room, not back to caller', () => {
  const gw = makeGateway();
  const { ws: nurseWs, clientId: nurseId } = connect(gw);
  const { ws: roomWs, clientId: roomId } = connect(gw);
  send(gw, roomId, { type: 'hello', role: 'room', bedId: '102' });

  send(gw, nurseId, { type: 'offer', sdp: SDP, callId: 'call-1', targetBed: '102' });

  // Room gets the offer
  const roomMsgs = roomWs.messages.filter(m => m.type === 'offer');
  assert.equal(roomMsgs.length, 1);
  assert.equal(roomMsgs[0].callId, 'call-1');
  assert.equal(roomMsgs[0].sdp, SDP);

  // Nurse does NOT get its own offer back
  const nurseMsgs = nurseWs.messages.filter(m => m.type === 'offer');
  assert.equal(nurseMsgs.length, 0);
});

test('offer: unknown targetBed → error sent to caller', () => {
  const gw = makeGateway();
  const { ws: nurseWs, clientId: nurseId } = connect(gw);

  send(gw, nurseId, { type: 'offer', sdp: SDP, callId: 'call-x', targetBed: '999' });

  const err = nurseWs.messages.find(m => m.type === 'error');
  assert.ok(err, 'error message must be sent');
  assert.equal(err.reason, 'target-offline');
  assert.equal(err.callId, 'call-x');
});

test('offer: duplicate callId → error sent to caller', () => {
  const gw = makeGateway();
  const { ws: nurseWs, clientId: nurseId } = connect(gw);
  const { clientId: roomId } = connect(gw);
  send(gw, roomId, { type: 'hello', role: 'room', bedId: '102' });

  send(gw, nurseId, { type: 'offer', sdp: SDP, callId: 'dup', targetBed: '102' });
  send(gw, nurseId, { type: 'offer', sdp: SDP, callId: 'dup', targetBed: '102' });

  const errs = nurseWs.messages.filter(m => m.type === 'error' && m.reason === 'duplicate-callId');
  assert.equal(errs.length, 1);
});

test('answer: routed to original caller', () => {
  const gw = makeGateway();
  const { ws: nurseWs, clientId: nurseId } = connect(gw);
  const { ws: roomWs, clientId: roomId } = connect(gw);
  send(gw, roomId, { type: 'hello', role: 'room', bedId: '102' });

  send(gw, nurseId, { type: 'offer', sdp: SDP, callId: 'c1', targetBed: '102' });
  send(gw, roomId, { type: 'answer', sdp: SDP, callId: 'c1' });

  const ans = nurseWs.messages.find(m => m.type === 'answer');
  assert.ok(ans, 'caller must receive answer');
  assert.equal(ans.callId, 'c1');
});

test('answer: from wrong client (not callee) → dropped', () => {
  const gw = makeGateway();
  const { ws: nurseWs, clientId: nurseId } = connect(gw);
  const { clientId: roomId } = connect(gw);
  const { ws: strangerWs, clientId: strangerId } = connect(gw);
  send(gw, roomId, { type: 'hello', role: 'room', bedId: '102' });

  send(gw, nurseId, { type: 'offer', sdp: SDP, callId: 'c1', targetBed: '102' });
  const beforeCount = nurseWs.messages.length;
  send(gw, strangerId, { type: 'answer', sdp: SDP, callId: 'c1' });
  assert.equal(nurseWs.messages.length, beforeCount); // no new message to nurse
});

test('candidate: forwarded to counterpart', () => {
  const gw = makeGateway();
  const { ws: nurseWs, clientId: nurseId } = connect(gw);
  const { ws: roomWs, clientId: roomId } = connect(gw);
  send(gw, roomId, { type: 'hello', role: 'room', bedId: '102' });
  send(gw, nurseId, { type: 'offer', sdp: SDP, callId: 'c1', targetBed: '102' });
  send(gw, roomId, { type: 'answer', sdp: SDP, callId: 'c1' });

  const cand = { candidate: 'candidate:1 1 UDP 100 1.2.3.4 5000 typ host' };
  send(gw, nurseId, { type: 'candidate', callId: 'c1', candidate: cand });

  const roomCands = roomWs.messages.filter(m => m.type === 'candidate');
  assert.equal(roomCands.length, 1);
  assert.deepEqual(roomCands[0].candidate, cand);
});

test('hangup: sent to counterpart + call removed', () => {
  const gw = makeGateway();
  const { ws: nurseWs, clientId: nurseId } = connect(gw);
  const { ws: roomWs, clientId: roomId } = connect(gw);
  send(gw, roomId, { type: 'hello', role: 'room', bedId: '102' });
  send(gw, nurseId, { type: 'offer', sdp: SDP, callId: 'c1', targetBed: '102' });

  send(gw, nurseId, { type: 'hangup', callId: 'c1' });

  const hangup = roomWs.messages.find(m => m.type === 'hangup');
  assert.ok(hangup, 'room must receive hangup');
  assert.equal(hangup.callId, 'c1');
  assert.equal(gw.calls.has('c1'), false, 'call must be removed');
});

test('disconnect: triggers synthetic hangup to counterpart', () => {
  const gw = makeGateway();
  const { ws: nurseWs, clientId: nurseId } = connect(gw);
  const { ws: roomWs, clientId: roomId } = connect(gw);
  send(gw, roomId, { type: 'hello', role: 'room', bedId: '102' });
  send(gw, nurseId, { type: 'offer', sdp: SDP, callId: 'c1', targetBed: '102' });

  // Simulate nurse disconnecting
  nurseWs.emit('close');

  const hangup = roomWs.messages.find(m => m.type === 'hangup' && m.callId === 'c1');
  assert.ok(hangup, 'room must receive synthetic hangup on peer disconnect');
  assert.equal(gw.calls.has('c1'), false);
});

test('broadcastTelemetry: sends alert to nurses only, not rooms', () => {
  const gw = makeGateway();
  const { ws: nurseWs } = connect(gw);
  const { ws: roomWs, clientId: roomId } = connect(gw);
  send(gw, roomId, { type: 'hello', role: 'room', bedId: '102' });

  gw.broadcastTelemetry({ bed: '102', type: 'Emergency', timestamp: Date.now() });

  const nurseAlerts = nurseWs.messages.filter(m => m.type === 'alert');
  assert.equal(nurseAlerts.length, 1);
  assert.equal(nurseAlerts[0].bed, '102');

  const roomAlerts = roomWs.messages.filter(m => m.type === 'alert');
  assert.equal(roomAlerts.length, 0);
});

test('broadcastTelemetry: returns sent count', () => {
  const gw = makeGateway();
  connect(gw); // nurse 1
  connect(gw); // nurse 2
  const { clientId: roomId } = connect(gw);
  send(gw, roomId, { type: 'hello', role: 'room', bedId: '102' });

  const count = gw.broadcastTelemetry({ bed: '102', type: 'Emergency', timestamp: Date.now() });
  assert.equal(count, 2); // 2 nurses, 0 rooms
});

test('broadcastTelemetry: alert type not overridden by telemetry.type', () => {
  const gw = makeGateway();
  const { ws: nurseWs } = connect(gw);

  gw.broadcastTelemetry({ bed: '205', type: 'Nurse', timestamp: Date.now() });

  const alert = nurseWs.messages.find(m => m.type === 'alert');
  assert.ok(alert, 'nurse must receive alert');
  // The alert envelope type should be 'alert' (not overridden by telemetry.type)
  assert.equal(alert.type, 'alert');
  assert.equal(alert.bed, '205');
});

test('message over msgMaxBytes: dropped silently', () => {
  const gw = makeGateway({ msgMaxBytes: 20 });
  const { ws: nurseWs, clientId: nurseId } = connect(gw);
  const before = nurseWs.messages.length;

  // Send a valid JSON message but whose raw string exceeds 20 bytes
  gw._handleMessage(nurseId, JSON.stringify({ type: 'hangup', callId: 'x'.repeat(50) }));

  assert.equal(nurseWs.messages.length, before); // no new messages
});

test('rate limit: messages after rateLimitPerSec are dropped', () => {
  const gw = makeGateway({ rateLimitPerSec: 3 });
  const { ws: nurseWs, clientId: nurseId } = connect(gw);
  const { ws: roomWs, clientId: roomId } = connect(gw);
  send(gw, roomId, { type: 'hello', role: 'room', bedId: '102' });

  // Send 5 offers — only first 3 should get processed (rate limit = 3)
  // Each offer needs a unique callId; after 3 the rate limit kicks in
  for (let i = 0; i < 5; i++) {
    send(gw, nurseId, { type: 'offer', sdp: SDP, callId: `call-${i}`, targetBed: '102' });
  }

  // Room should receive at most 3 offers (rate limit), first call also used as hello logic
  // Actually: first offer establishes a call. 2nd offer to same room will fail with target-offline
  // because room is in a call... wait, room can still receive offers. Let's count differently.
  // Rate limit = 3: messages 1,2,3 processed; 4,5 dropped.
  // Messages 1: offer routed to room (call-0)
  // Messages 2: offer with dup? no — call-1 is new callId, but room is taken
  //   Actually gateway doesn't prevent multiple calls to same room, only duplicate callId.
  //   call-0,call-1,call-2 all routed successfully to room (3 offers in room.messages)
  // Messages 4 & 5 (call-3, call-4): rate limited, dropped
  const roomOffers = roomWs.messages.filter(m => m.type === 'offer');
  assert.ok(roomOffers.length <= 3, `Expected at most 3 offers but got ${roomOffers.length}`);
  assert.ok(roomOffers.length >= 1, 'Expected at least 1 offer to be processed');
});

test('invalid JSON: dropped, no crash', () => {
  const gw = makeGateway();
  const { ws: nurseWs, clientId: nurseId } = connect(gw);
  const before = nurseWs.messages.length;

  // Should not throw
  assert.doesNotThrow(() => {
    gw._handleMessage(nurseId, '{invalid json}');
  });

  assert.equal(nurseWs.messages.length, before);
});

test('schema validation fail: unknown type dropped', () => {
  const gw = makeGateway();
  const { ws: nurseWs, clientId: nurseId } = connect(gw);
  const { ws: roomWs, clientId: roomId } = connect(gw);
  const before = roomWs.messages.length;

  send(gw, nurseId, { type: 'evil', payload: 'attack' });

  assert.equal(roomWs.messages.length, before); // no forwarding
});

test('connectedRoomBeds: returns only room bedIds', () => {
  const gw = makeGateway();
  connect(gw); // nurse — no bedId
  const { clientId: r1 } = connect(gw);
  const { clientId: r2 } = connect(gw);
  send(gw, r1, { type: 'hello', role: 'room', bedId: '102' });
  send(gw, r2, { type: 'hello', role: 'room', bedId: '205' });

  const beds = gw.connectedRoomBeds();
  assert.ok(beds.includes('102'));
  assert.ok(beds.includes('205'));
  assert.equal(beds.length, 2);
});

test('hasActiveCall: true when ringing, false when none', () => {
  const gw = makeGateway();
  assert.equal(gw.hasActiveCall(), false);

  const { clientId: nurseId } = connect(gw);
  const { clientId: roomId } = connect(gw);
  send(gw, roomId, { type: 'hello', role: 'room', bedId: '102' });
  send(gw, nurseId, { type: 'offer', sdp: SDP, callId: 'c1', targetBed: '102' });

  assert.equal(gw.hasActiveCall(), true);
});

test('hangup by caller: cleans up call state', () => {
  const gw = makeGateway();
  const { clientId: nurseId } = connect(gw);
  const { clientId: roomId } = connect(gw);
  send(gw, roomId, { type: 'hello', role: 'room', bedId: '102' });
  send(gw, nurseId, { type: 'offer', sdp: SDP, callId: 'c1', targetBed: '102' });

  assert.equal(gw.calls.has('c1'), true);
  send(gw, nurseId, { type: 'hangup', callId: 'c1' });
  assert.equal(gw.calls.has('c1'), false);
  assert.equal(gw.hasActiveCall(), false);
});

test('candidate: late candidate for unknown callId silently dropped', () => {
  const gw = makeGateway();
  const { clientId: nurseId } = connect(gw);

  assert.doesNotThrow(() => {
    send(gw, nurseId, { type: 'candidate', callId: 'nonexistent', candidate: { candidate: 'test' } });
  });
});

test('offer: room with closed ws (readyState != 1) treated as offline', () => {
  const gw = makeGateway();
  const { ws: nurseWs, clientId: nurseId } = connect(gw);
  const { ws: roomWs, clientId: roomId } = connect(gw);
  send(gw, roomId, { type: 'hello', role: 'room', bedId: '102' });

  // Simulate room ws closed
  roomWs.readyState = 3; // CLOSED

  send(gw, nurseId, { type: 'offer', sdp: SDP, callId: 'c1', targetBed: '102' });

  const err = nurseWs.messages.find(m => m.type === 'error');
  assert.ok(err, 'should get target-offline error');
  assert.equal(err.reason, 'target-offline');
});
