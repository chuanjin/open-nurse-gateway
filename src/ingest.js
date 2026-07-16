'use strict';

// TCP ingest driver for legacy nurse-call telemetry.
//
// Listens on a configurable TCP port. Each connecting legacy source (or mock)
// streams ATC-style frames terminated by \n or \r\n. Per Oracle guidance:
//   - per-connection buffer (multiple concurrent sources safe)
//   - max-line safeguard (prevents OOM from a producer that never sends \n)
//   - ACK/NAK response after each frame (mimics real serial hardware handshake)
//
// Emits: 'telemetry' (parsed frame object) — consumers hook this and
// broadcast to WebSocket clients.

const net = require('net');
const { EventEmitter } = require('events');
const { consume } = require('./parser');

class TCPIngest extends EventEmitter {
  constructor({ port, host = '127.0.0.1', maxLineBytes = 512, logger }) {
    super();
    this.port = port;
    this.host = host;
    this.maxLineBytes = maxLineBytes;
    this.logger = logger.child({ mod: 'ingest' });
    this.server = null;
    this._connections = new Set();
  }

  start() {
    this.server = net.createServer((socket) => this._onConnection(socket));
    this.server.on('error', (err) => {
      this.logger.error('server error', { err: err.message });
    });

    return new Promise((resolve, reject) => {
      const onError = (err) => {
        this.server.removeListener('error', onError);
        reject(err);
      };
      this.server.once('error', onError);
      this.server.listen(this.port, this.host, () => {
        this.server.removeListener('error', onError);
        this.logger.info('ingest listening', { host: this.host, port: this.port });
        resolve();
      });
    });
  }

  _onConnection(socket) {
    const remote = `${socket.remoteAddress}:${socket.remotePort}`;
    this.logger.info('legacy source connected', { remote });
    this._connections.add(socket);
    let state = { buffer: '' };
    socket.setEncoding('utf8');

    socket.on('data', (chunk) => {
      const result = consume(chunk, state, this.maxLineBytes);
      state = result.state;
      for (const t of result.telemetries) {
        this.logger.debug('frame parsed', { bed: t.bed, type: t.type, prefix: t.prefix });
        this.emit('telemetry', t);
        if (!socket.destroyed) socket.write('ACK\n');
      }
      for (const m of result.malformed) {
        this.logger.warn('malformed frame', m);
        if (!socket.destroyed) socket.write('NAK\n');
        if (m.reason === 'oversize') {
          // Kill an abusive source rather than let it flood.
          this.logger.warn('closing abusive source', { remote });
          socket.destroy();
        }
      }
    });

    socket.on('close', () => {
      this._connections.delete(socket);
      this.logger.info('legacy source disconnected', { remote });
    });

    socket.on('error', (err) => {
      this.logger.warn('legacy source error', { remote, err: err.message });
    });
  }

  async stop() {
    if (!this.server) return;
    for (const s of this._connections) {
      try { s.destroy(); } catch (_) { /* ignore */ }
    }
    this._connections.clear();
    return new Promise((resolve) => this.server.close(() => resolve()));
  }
}

module.exports = { TCPIngest };
