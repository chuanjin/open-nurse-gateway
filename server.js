'use strict';

const http = require('http');
const fs = require('fs');
const path = require('path');
const { WebSocketServer } = require('ws');

const { loadConfig } = require('./src/config');
const { createLogger } = require('./src/logger');
const { verifyUpgrade } = require('./src/auth');
const { SignalingGateway } = require('./src/gateway');
const { TCPIngest } = require('./src/ingest');

const config = loadConfig();
const logger = createLogger(config.logLevel);

logger.info('startup', {
  httpPort: config.httpPort,
  ingestPort: config.ingestPort,
  ingestEnabled: config.ingestEnabled,
  authEnabled: !!config.authToken,
  mockInjectorEnabled: config.mockInjectorEnabled,
  iceServersIsDefault: config.iceServersIsDefault,
  msgMaxBytes: config.msgMaxBytes,
  rateLimitPerSec: config.rateLimitPerSec,
});

if (config.iceServersIsDefault) {
  logger.warn('using default public STUN (stun.l.google.com) — set ICE_SERVERS for production');
}

const gateway = new SignalingGateway({ config, logger });

const SECURITY_HEADERS = {
  'X-Content-Type-Options': 'nosniff',
  'X-Frame-Options': 'DENY',
  'Referrer-Policy': 'no-referrer',
  'Cross-Origin-Opener-Policy': 'same-origin',
};

function writeSecure(res, status, headers, body, method) {
  res.writeHead(status, { ...SECURITY_HEADERS, ...headers });
  if (method === 'HEAD' || body == null) {
    res.end();
  } else {
    res.end(body);
  }
}

function routeGet(req, res, method) {
  const url = req.url || '/';

  if (url === '/' || url.startsWith('/?') || url === '/index.html' || url.startsWith('/index.html?')) {
    fs.readFile(path.join(__dirname, 'index.html'), (err, data) => {
      if (err) {
        logger.error('index.html read failed', { err });
        writeSecure(
          res,
          500,
          { 'Content-Type': 'text/plain; charset=utf-8' },
          'Internal Server Error\n',
          method,
        );
        return;
      }
      writeSecure(
        res,
        200,
        {
          'Content-Type': 'text/html; charset=utf-8',
          'Content-Length': Buffer.byteLength(data),
        },
        data,
        method,
      );
    });
    return;
  }

  if (url === '/config' || url === '/config.json' || url.startsWith('/config?')) {
    const body = JSON.stringify({
      iceServers: config.iceServers,
      authRequired: !!config.authToken,
    });
    writeSecure(
      res,
      200,
      {
        'Content-Type': 'application/json; charset=utf-8',
        'Content-Length': Buffer.byteLength(body),
        'Cache-Control': 'no-store',
      },
      body,
      method,
    );
    return;
  }

  if (url === '/healthz') {
    writeSecure(res, 200, { 'Content-Type': 'text/plain; charset=utf-8' }, 'ok\n', method);
    return;
  }

  writeSecure(res, 404, { 'Content-Type': 'text/plain; charset=utf-8' }, 'Not Found\n', method);
}

const server = http.createServer((req, res) => {
  const method = req.method || 'GET';
  if (method !== 'GET' && method !== 'HEAD') {
    writeSecure(
      res,
      405,
      { 'Allow': 'GET, HEAD', 'Content-Type': 'text/plain; charset=utf-8' },
      'Method Not Allowed\n',
      method,
    );
    return;
  }
  routeGet(req, res, method);
});

const wss = new WebSocketServer({
  noServer: true,
  maxPayload: config.msgMaxBytes,
});

server.on('upgrade', (req, socket, head) => {
  const verdict = verifyUpgrade(req, config);
  if (!verdict.ok) {
    logger.warn('ws upgrade rejected', {
      code: verdict.code,
      reason: verdict.reason,
      origin: req.headers.origin || null,
    });
    const statusText = verdict.code === 401 ? 'Unauthorized' : 'Forbidden';
    socket.write(
      `HTTP/1.1 ${verdict.code} ${statusText}\r\n` +
        `Content-Type: text/plain\r\n` +
        `Content-Length: 0\r\n` +
        `Connection: close\r\n` +
        `\r\n`,
    );
    socket.destroy();
    return;
  }

  wss.handleUpgrade(req, socket, head, (ws) => {
    gateway.onConnection(ws);
  });
});

let ingest = null;
if (config.ingestEnabled) {
  ingest = new TCPIngest({
    port: config.ingestPort,
    host: config.ingestBindHost,
    maxLineBytes: config.ingestMaxLineBytes,
    logger,
  });
  ingest.on('telemetry', (t) => gateway.broadcastTelemetry(t));
  ingest.start().catch((err) => {
    logger.error('ingest start failed', { err });
  });
}

let mockInterval = null;
if (config.mockInjectorEnabled) {
  mockInterval = setInterval(() => {
    if (gateway.hasActiveCall()) return;
    const roomBeds = gateway.connectedRoomBeds();
    const beds = roomBeds.length > 0 ? roomBeds : ['102', '205', '301'];
    const bed = beds[Math.floor(Math.random() * beds.length)];
    logger.info('mock injection', { bed, hasRoom: roomBeds.length > 0 });
    gateway.broadcastTelemetry({ bed, type: 'Emergency', timestamp: Date.now() });
  }, config.mockInjectorIntervalMs);
  logger.info('mock injector enabled', { intervalMs: config.mockInjectorIntervalMs });
}

server.listen(config.httpPort, () => {
  logger.info('ready', { url: `http://localhost:${config.httpPort}` });
});

function shutdown(signal) {
  logger.info('shutdown', { signal });
  if (mockInterval) clearInterval(mockInterval);
  server.close(() => logger.info('http closed'));
  wss.clients.forEach((c) => {
    try { c.terminate(); } catch (_) { /* ignore */ }
  });
  if (ingest) ingest.stop().catch(() => { /* ignore */ });
  setTimeout(() => process.exit(0), 500).unref();
}
process.on('SIGINT', () => shutdown('SIGINT'));
process.on('SIGTERM', () => shutdown('SIGTERM'));

module.exports = { server, gateway, config, ingest };
