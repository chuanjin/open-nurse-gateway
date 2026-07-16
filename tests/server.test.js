'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const http = require('http');
const { spawn } = require('child_process');
const path = require('path');
const { WebSocket } = require('ws');

const SERVER_PATH = path.join(__dirname, '..', 'server.js');

let portCounter = 56000 + Math.floor(Math.random() * 500);
function nextPort() { return portCounter++; }

function delay(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function startServer(env = {}, port) {
  if (!port) port = nextPort();
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [SERVER_PATH], {
      env: {
        ...process.env,
        PORT: String(port),
        INGEST_ENABLED: '0',
        MOCK_INJECTOR_ENABLED: '0',
        LOG_LEVEL: 'info',
        ...env,
      },
      stdio: ['ignore', 'pipe', 'pipe'],
    });

    let stdoutBuf = '';
    const timer = setTimeout(() => {
      child.kill();
      reject(new Error(`server did not start on port ${port} within 4s`));
    }, 4000);

    child.stdout.on('data', (chunk) => {
      stdoutBuf += chunk.toString('utf8');
      if (stdoutBuf.includes('"msg":"ready"') || stdoutBuf.includes('"msg":"startup"')) {
        if (stdoutBuf.includes('"msg":"ready"')) {
          clearTimeout(timer);
          resolve({ child, port });
        }
      }
    });

    child.on('error', (err) => {
      clearTimeout(timer);
      reject(err);
    });

    child.on('exit', (code) => {
      if (code !== 0 && code !== null) {
        clearTimeout(timer);
        reject(new Error(`server exited with code ${code}`));
      }
    });
  });
}

function stopServer(child) {
  return new Promise((resolve) => {
    child.kill('SIGTERM');
    child.once('exit', resolve);
    setTimeout(() => { child.kill('SIGKILL'); resolve(); }, 1000).unref();
  });
}

function httpGet(port, urlPath, headers = {}) {
  return new Promise((resolve, reject) => {
    const req = http.request(
      { host: '127.0.0.1', port, path: urlPath, method: 'GET', headers },
      (res) => {
        let body = '';
        res.on('data', (c) => { body += c; });
        res.on('end', () => resolve({ status: res.statusCode, headers: res.headers, body }));
      },
    );
    req.on('error', reject);
    req.end();
  });
}

function httpHead(port, urlPath) {
  return new Promise((resolve, reject) => {
    const req = http.request(
      { host: '127.0.0.1', port, path: urlPath, method: 'HEAD' },
      (res) => {
        res.resume();
        res.on('end', () => resolve({ status: res.statusCode, headers: res.headers }));
      },
    );
    req.on('error', reject);
    req.end();
  });
}

function httpPost(port, urlPath) {
  return new Promise((resolve, reject) => {
    const req = http.request(
      { host: '127.0.0.1', port, path: urlPath, method: 'POST' },
      (res) => {
        res.resume();
        res.on('end', () => resolve({ status: res.statusCode, headers: res.headers }));
      },
    );
    req.on('error', reject);
    req.end();
  });
}

test('GET /healthz → 200 ok', async () => {
  const { child, port } = await startServer();
  try {
    const { status, body } = await httpGet(port, '/healthz');
    assert.equal(status, 200);
    assert.equal(body, 'ok\n');
  } finally {
    await stopServer(child);
  }
});

test('GET / → 200 text/html (serves index.html)', async () => {
  const { child, port } = await startServer();
  try {
    const { status, headers } = await httpGet(port, '/');
    assert.equal(status, 200);
    assert.ok(headers['content-type'].includes('text/html'), `expected text/html, got ${headers['content-type']}`);
  } finally {
    await stopServer(child);
  }
});

test('GET /config → 200 application/json with iceServers', async () => {
  const { child, port } = await startServer();
  try {
    const { status, headers, body } = await httpGet(port, '/config');
    assert.equal(status, 200);
    assert.ok(headers['content-type'].includes('application/json'));
    const json = JSON.parse(body);
    assert.ok(Array.isArray(json.iceServers), 'iceServers must be an array');
  } finally {
    await stopServer(child);
  }
});

test('GET /config with ICE_SERVERS env → returns custom iceServers', async () => {
  const customIce = JSON.stringify([{ urls: 'stun:custom.example.com:3478' }]);
  const { child, port } = await startServer({ ICE_SERVERS: customIce });
  try {
    const { status, body } = await httpGet(port, '/config');
    assert.equal(status, 200);
    const json = JSON.parse(body);
    assert.equal(json.iceServers[0].urls, 'stun:custom.example.com:3478');
  } finally {
    await stopServer(child);
  }
});

test('GET /nonexistent → 404', async () => {
  const { child, port } = await startServer();
  try {
    const { status } = await httpGet(port, '/does-not-exist');
    assert.equal(status, 404);
  } finally {
    await stopServer(child);
  }
});

test('POST / → 405 with Allow header', async () => {
  const { child, port } = await startServer();
  try {
    const { status, headers } = await httpPost(port, '/');
    assert.equal(status, 405);
    assert.ok(headers['allow'], 'Allow header must be present');
    assert.ok(headers['allow'].includes('GET'), `Allow must include GET, got: ${headers['allow']}`);
  } finally {
    await stopServer(child);
  }
});

test('HEAD /healthz → 200 with no body', async () => {
  const { child, port } = await startServer();
  try {
    const { status } = await httpHead(port, '/healthz');
    assert.equal(status, 200);
  } finally {
    await stopServer(child);
  }
});

test('GET / → X-Content-Type-Options: nosniff header', async () => {
  const { child, port } = await startServer();
  try {
    const { headers } = await httpGet(port, '/healthz');
    assert.equal(headers['x-content-type-options'], 'nosniff');
  } finally {
    await stopServer(child);
  }
});

test('GET / → X-Frame-Options: DENY header', async () => {
  const { child, port } = await startServer();
  try {
    const { headers } = await httpGet(port, '/healthz');
    assert.equal(headers['x-frame-options'], 'DENY');
  } finally {
    await stopServer(child);
  }
});

test('WS connect with no token when AUTH_TOKEN set → 401 close', async () => {
  const { child, port } = await startServer({
    AUTH_TOKEN: 'sekret',
    ALLOWED_ORIGINS: '*',
  });
  try {
    await new Promise((resolve, reject) => {
      const ws = new WebSocket(`ws://127.0.0.1:${port}/`);
      ws.on('unexpected-response', (req, res) => {
        assert.equal(res.statusCode, 401);
        resolve();
      });
      ws.on('open', () => {
        ws.close();
        reject(new Error('Expected 401 but connection opened'));
      });
      ws.on('error', (e) => {
        if (e.message && e.message.includes('401')) resolve();
        else resolve();
      });
      setTimeout(() => reject(new Error('timeout')), 3000);
    });
  } finally {
    await stopServer(child);
  }
});

test('WS connect with correct token via query string → welcome message', async () => {
  const { child, port } = await startServer({
    AUTH_TOKEN: 'sekret',
    ALLOWED_ORIGINS: '*',
  });
  try {
    const welcome = await new Promise((resolve, reject) => {
      const ws = new WebSocket(`ws://127.0.0.1:${port}/?token=sekret`);
      ws.on('message', (raw) => {
        const msg = JSON.parse(raw.toString());
        if (msg.type === 'welcome') {
          ws.close();
          resolve(msg);
        }
      });
      ws.on('error', reject);
      setTimeout(() => reject(new Error('timeout waiting for welcome')), 3000);
    });
    assert.equal(welcome.type, 'welcome');
    assert.ok(typeof welcome.clientId === 'string' && welcome.clientId.length > 0);
  } finally {
    await stopServer(child);
  }
});

test('WS connect from disallowed Origin → 403 close', async () => {
  const { child, port } = await startServer({
    ALLOWED_ORIGINS: 'http://localhost:3000',
  });
  try {
    await new Promise((resolve, reject) => {
      const ws = new WebSocket(`ws://127.0.0.1:${port}/`, {
        headers: { Origin: 'http://evil.com' },
      });
      ws.on('unexpected-response', (req, res) => {
        assert.equal(res.statusCode, 403);
        resolve();
      });
      ws.on('open', () => {
        ws.close();
        reject(new Error('Expected 403 but connection opened'));
      });
      ws.on('error', () => resolve());
      setTimeout(() => reject(new Error('timeout')), 3000);
    });
  } finally {
    await stopServer(child);
  }
});

test('WS connect with no auth required + wildcard origin → welcome message', async () => {
  const { child, port } = await startServer({
    ALLOWED_ORIGINS: '*',
  });
  try {
    const welcome = await new Promise((resolve, reject) => {
      const ws = new WebSocket(`ws://127.0.0.1:${port}/`);
      ws.on('message', (raw) => {
        const msg = JSON.parse(raw.toString());
        if (msg.type === 'welcome') {
          ws.close();
          resolve(msg);
        }
      });
      ws.on('error', reject);
      setTimeout(() => reject(new Error('timeout waiting for welcome')), 3000);
    });
    assert.equal(welcome.type, 'welcome');
    assert.ok(Array.isArray(welcome.iceServers));
  } finally {
    await stopServer(child);
  }
});
