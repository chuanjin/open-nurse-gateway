'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const net = require('net');

const { TCPIngest } = require('../src/ingest');

// ── Helpers ───────────────────────────────────────────────────────────────────

function makeLogger() {
  return {
    info: () => {},
    warn: () => {},
    debug: () => {},
    error: () => {},
    child() { return this; },
  };
}

let portCounter = 54200 + Math.floor(Math.random() * 500);
function nextPort() { return portCounter++; }

function delay(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function tcpConnect(port) {
  return new Promise((resolve, reject) => {
    const sock = net.createConnection({ host: '127.0.0.1', port });
    sock.once('connect', () => resolve(sock));
    sock.once('error', reject);
  });
}

function readAll(sock, timeoutMs = 200) {
  return new Promise((resolve) => {
    let buf = '';
    const timer = setTimeout(() => resolve(buf), timeoutMs);
    sock.on('data', (chunk) => {
      buf += chunk.toString('utf8');
      clearTimeout(timer);
      // collect for a bit more
      setTimeout(() => resolve(buf), 30);
    });
  });
}

// ── Tests ─────────────────────────────────────────────────────────────────────

test('start: server is listening after start()', async () => {
  const port = nextPort();
  const ingest = new TCPIngest({ port, host: '127.0.0.1', maxLineBytes: 512, logger: makeLogger() });
  try {
    await ingest.start();
    // Connection attempt succeeds if server is listening
    const sock = await tcpConnect(port);
    assert.ok(!sock.destroyed, 'socket should be open');
    sock.destroy();
  } finally {
    await ingest.stop();
  }
});

test('stop: closes server and rejects new connections', async () => {
  const port = nextPort();
  const ingest = new TCPIngest({ port, host: '127.0.0.1', maxLineBytes: 512, logger: makeLogger() });
  await ingest.start();
  await ingest.stop();

  let threw = false;
  try {
    await tcpConnect(port);
  } catch (e) {
    threw = true;
    assert.ok(e.code === 'ECONNREFUSED' || e.code === 'ECONNRESET', `unexpected error code: ${e.code}`);
  }
  assert.ok(threw, 'expected connection to be refused after stop()');
});

test('valid frame: telemetry event emitted', async () => {
  const port = nextPort();
  const ingest = new TCPIngest({ port, host: '127.0.0.1', maxLineBytes: 512, logger: makeLogger() });
  try {
    await ingest.start();

    const received = [];
    ingest.on('telemetry', (t) => received.push(t));

    const sock = await tcpConnect(port);
    sock.write('ATC 0066 0066\n');
    await delay(100);
    sock.destroy();

    assert.equal(received.length, 1);
    assert.equal(received[0].bed, '102');
    assert.equal(received[0].type, 'Emergency');
  } finally {
    await ingest.stop();
  }
});

test('valid frame: socket receives ACK', async () => {
  const port = nextPort();
  const ingest = new TCPIngest({ port, host: '127.0.0.1', maxLineBytes: 512, logger: makeLogger() });
  try {
    await ingest.start();
    ingest.on('telemetry', () => {});

    const sock = await tcpConnect(port);
    sock.write('ATC 0066 0066\n');
    const resp = await readAll(sock, 300);
    sock.destroy();

    assert.ok(resp.includes('ACK'), `expected ACK in "${resp}"`);
  } finally {
    await ingest.stop();
  }
});

test('malformed frame: socket receives NAK', async () => {
  const port = nextPort();
  const ingest = new TCPIngest({ port, host: '127.0.0.1', maxLineBytes: 512, logger: makeLogger() });
  try {
    await ingest.start();

    const sock = await tcpConnect(port);
    sock.write('garbage\n');
    const resp = await readAll(sock, 300);
    sock.destroy();

    assert.ok(resp.includes('NAK'), `expected NAK in "${resp}"`);
  } finally {
    await ingest.stop();
  }
});

test('cross-chunk: frame split across two writes → single telemetry event', async () => {
  const port = nextPort();
  const ingest = new TCPIngest({ port, host: '127.0.0.1', maxLineBytes: 512, logger: makeLogger() });
  try {
    await ingest.start();

    const received = [];
    ingest.on('telemetry', (t) => received.push(t));

    const sock = await tcpConnect(port);
    sock.write('ATC 006');
    await delay(30);
    sock.write('6 0066\n');
    await delay(100);
    sock.destroy();

    assert.equal(received.length, 1);
    assert.equal(received[0].bed, '102');
  } finally {
    await ingest.stop();
  }
});

test('multiple frames in one write → multiple telemetry events', async () => {
  const port = nextPort();
  const ingest = new TCPIngest({ port, host: '127.0.0.1', maxLineBytes: 512, logger: makeLogger() });
  try {
    await ingest.start();

    const received = [];
    ingest.on('telemetry', (t) => received.push(t));

    const sock = await tcpConnect(port);
    sock.write('ATC 0066 0066\nNRS 00CD 00CD\nSTF 012D 012D\n');
    await delay(150);
    sock.destroy();

    assert.equal(received.length, 3);
    assert.deepEqual(
      received.map((t) => t.type),
      ['Emergency', 'Nurse', 'Staff'],
    );
  } finally {
    await ingest.stop();
  }
});

test('oversize line: server-side socket destroyed (abusive source killed)', async () => {
  const port = nextPort();
  const ingest = new TCPIngest({ port, host: '127.0.0.1', maxLineBytes: 20, logger: makeLogger() });
  try {
    await ingest.start();

    const sock = await tcpConnect(port);
    sock.on('error', () => {});

    assert.equal(ingest._connections.size, 1, 'one connection before oversize');

    sock.write('x'.repeat(200) + '\n');
    await delay(150);

    assert.equal(ingest._connections.size, 0, 'server closed abusive connection');
    sock.destroy();
  } finally {
    await ingest.stop();
  }
});

test('two concurrent connections: both receive ACK independently', async () => {
  const port = nextPort();
  const ingest = new TCPIngest({ port, host: '127.0.0.1', maxLineBytes: 512, logger: makeLogger() });
  try {
    await ingest.start();
    ingest.on('telemetry', () => {});

    const [sock1, sock2] = await Promise.all([tcpConnect(port), tcpConnect(port)]);
    sock1.write('ATC 0066 0066\n');
    sock2.write('NRS 00CD 00CD\n');

    const [resp1, resp2] = await Promise.all([readAll(sock1, 300), readAll(sock2, 300)]);
    sock1.destroy();
    sock2.destroy();

    assert.ok(resp1.includes('ACK'), `sock1 expected ACK, got "${resp1}"`);
    assert.ok(resp2.includes('ACK'), `sock2 expected ACK, got "${resp2}"`);
  } finally {
    await ingest.stop();
  }
});

test('telemetry count matches valid frame count', async () => {
  const port = nextPort();
  const ingest = new TCPIngest({ port, host: '127.0.0.1', maxLineBytes: 512, logger: makeLogger() });
  try {
    await ingest.start();

    const received = [];
    ingest.on('telemetry', (t) => received.push(t));

    const sock = await tcpConnect(port);
    // 2 valid + 1 malformed
    sock.write('ATC 0066 0066\nbad frame here\nNRS 00CD 00CD\n');
    await delay(150);
    sock.destroy();

    assert.equal(received.length, 2, 'exactly 2 valid frames → 2 telemetry events');
  } finally {
    await ingest.stop();
  }
});

test('stop is idempotent: calling stop twice does not throw', async () => {
  const port = nextPort();
  const ingest = new TCPIngest({ port, host: '127.0.0.1', maxLineBytes: 512, logger: makeLogger() });
  await ingest.start();
  await assert.doesNotReject(() => ingest.stop());
  await assert.doesNotReject(() => ingest.stop());
});
