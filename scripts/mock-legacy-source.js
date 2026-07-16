#!/usr/bin/env node
'use strict';

// Standalone mock legacy telemetry source.
//
// Connects to the gateway's TCP ingest port and emits realistic ATC-style
// frames on an interval. Simulates a hardware controller that would sit on an
// RS485 bus and translate room button presses into serialized commands.
//
// Env:
//   INGEST_HOST         (default 127.0.0.1)
//   INGEST_PORT         (default 4001)
//   MOCK_INTERVAL_MS    (default 10000)
//   MOCK_BEDS           (default "102,205,301")   — decimal bed numbers
//   MOCK_PREFIXES       (default "ATC")           — comma-separated ∈ ATC|NRS|STF
//   MOCK_FIRST_DELAY_MS (default 1500)            — first emit after connect

const net = require('net');

const HOST = process.env.INGEST_HOST || '127.0.0.1';
const PORT = parseInt(process.env.INGEST_PORT || '4001', 10);
const INTERVAL_MS = parseInt(process.env.MOCK_INTERVAL_MS || '10000', 10);
const FIRST_DELAY_MS = parseInt(process.env.MOCK_FIRST_DELAY_MS || '1500', 10);
const BEDS = (process.env.MOCK_BEDS || '102,205,301').split(',').map((s) => s.trim()).filter(Boolean);
const PREFIXES = (process.env.MOCK_PREFIXES || 'ATC').split(',').map((s) => s.trim()).filter(Boolean);

function bedToAddr(bed) {
  const n = parseInt(bed, 10);
  if (!Number.isFinite(n) || n < 0 || n > 65535) {
    throw new Error(`Invalid bed number "${bed}" — must be 0..65535`);
  }
  return n.toString(16).toUpperCase().padStart(4, '0');
}

function makeFrame() {
  const bed = BEDS[Math.floor(Math.random() * BEDS.length)];
  const prefix = PREFIXES[Math.floor(Math.random() * PREFIXES.length)];
  const addr = bedToAddr(bed);
  return { frame: `${prefix} ${addr} ${addr}\n`, bed, prefix };
}

let socket = null;
let running = true;
let alertInterval = null;
let firstShot = null;

function log(msg) {
  process.stderr.write(`[mock-source] ${msg}\n`);
}

function connect() {
  socket = net.createConnection({ host: HOST, port: PORT });
  socket.setEncoding('utf8');

  socket.on('connect', () => {
    log(`connected to ${HOST}:${PORT}`);
    scheduleEmits();
  });

  socket.on('data', (chunk) => {
    // ACK/NAK from gateway.
    log(`rx: ${JSON.stringify(chunk)}`);
  });

  socket.on('error', (err) => {
    log(`error: ${err.message}`);
  });

  socket.on('close', () => {
    log('disconnected');
    if (alertInterval) clearInterval(alertInterval);
    if (firstShot) clearTimeout(firstShot);
    alertInterval = null;
    firstShot = null;
    socket = null;
    if (running) setTimeout(connect, 2000);
  });
}

function emitOnce() {
  if (!socket || socket.destroyed) return;
  try {
    const { frame, bed, prefix } = makeFrame();
    log(`tx: ${prefix} ${bed}`);
    socket.write(frame);
  } catch (e) {
    log(`emit fail: ${e.message}`);
  }
}

function scheduleEmits() {
  if (alertInterval) clearInterval(alertInterval);
  if (firstShot) clearTimeout(firstShot);
  firstShot = setTimeout(emitOnce, FIRST_DELAY_MS);
  alertInterval = setInterval(emitOnce, INTERVAL_MS);
}

function shutdown(signal) {
  log(`shutdown (${signal})`);
  running = false;
  if (alertInterval) clearInterval(alertInterval);
  if (firstShot) clearTimeout(firstShot);
  if (socket) socket.destroy();
  setTimeout(() => process.exit(0), 200).unref();
}

process.on('SIGINT', () => shutdown('SIGINT'));
process.on('SIGTERM', () => shutdown('SIGTERM'));

log(`starting: interval=${INTERVAL_MS}ms beds=[${BEDS.join(',')}] prefixes=[${PREFIXES.join(',')}]`);
connect();
