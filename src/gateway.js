'use strict';

// Signaling gateway. Owns:
//   - The set of connected WebSocket clients (with role + bedId).
//   - The Map of in-flight calls keyed by callId.
//   - Message routing: offer targeted to specific room, answer/candidate/hangup
//     scoped to callId, alerts broadcast to all nurses.
//   - Cleanup on ws close: any call involving the departed client is torn down
//     and a synthetic 'hangup' delivered to the counterpart (Oracle guidance).
//   - Per-connection rate limiting + size limiting.

const crypto = require('crypto');
const { validateMessage } = require('./schema');

class SignalingGateway {
  constructor({ config, logger }) {
    this.config = config;
    this.logger = logger.child({ mod: 'gateway' });
    // clientId -> { ws, role, bedId, msgTimes: number[] }
    this.clients = new Map();
    // callId -> { callerId, calleeId, state: 'ringing'|'active', createdAt, targetBed }
    this.calls = new Map();
  }

  hasActiveCall() {
    for (const c of this.calls.values()) {
      if (c.state === 'ringing' || c.state === 'active') return true;
    }
    return false;
  }

  onConnection(ws) {
    const clientId = crypto.randomUUID();
    const entry = { ws, role: 'nurse', bedId: null, msgTimes: [] };
    this.clients.set(clientId, entry);
    this.logger.info('client connected', { clientId, total: this.clients.size });

    this._send(ws, {
      type: 'welcome',
      clientId,
      iceServers: this.config.iceServers,
    });

    ws.on('message', (raw, isBinary) => {
      if (isBinary) {
        this.logger.warn('binary message dropped', { clientId });
        return;
      }
      this._handleMessage(clientId, raw.toString('utf8'));
    });
    ws.on('close', () => this._handleClose(clientId));
    ws.on('error', (err) => {
      this.logger.warn('ws error', { clientId, err: err.message });
    });
  }

  _handleMessage(clientId, raw) {
    if (raw.length > this.config.msgMaxBytes) {
      this.logger.warn('message too large', { clientId, bytes: raw.length });
      return;
    }
    const now = Date.now();
    const entry = this.clients.get(clientId);
    if (!entry) return;
    // Sliding-window rate limit.
    entry.msgTimes = entry.msgTimes.filter((t) => t > now - 1000);
    if (entry.msgTimes.length >= this.config.rateLimitPerSec) {
      this.logger.warn('rate limit hit', { clientId, count: entry.msgTimes.length });
      return;
    }
    entry.msgTimes.push(now);

    let data;
    try {
      data = JSON.parse(raw);
    } catch (_) {
      this.logger.warn('json parse fail', { clientId });
      return;
    }
    const v = validateMessage(data);
    if (!v.ok) {
      this.logger.warn('schema fail', { clientId, reason: v.reason, type: v.type });
      return;
    }
    const msg = v.message;
    switch (msg.type) {
      case 'hello': return this._onHello(clientId, msg);
      case 'offer': return this._onOffer(clientId, msg);
      case 'answer': return this._onAnswer(clientId, msg);
      case 'candidate': return this._onCandidate(clientId, msg);
      case 'hangup': return this._onHangup(clientId, msg);
      default: this.logger.error('unhandled type', { type: msg.type });
    }
  }

  _onHello(clientId, msg) {
    const entry = this.clients.get(clientId);
    if (!entry) return;
    // Guard: only one hello per connection; ignore later renames to prevent
    // a nurse from promoting to a room mid-call.
    if (entry.role === 'nurse' && entry.bedId === null && (msg.role !== 'nurse' || msg.bedId !== null)) {
      entry.role = msg.role;
      entry.bedId = msg.bedId;
      this.logger.info('client identified', { clientId, role: msg.role, bedId: msg.bedId });
    } else {
      this.logger.debug('hello ignored (already identified or default)', { clientId });
    }
  }

  _findRoomByBed(bedId) {
    for (const [id, entry] of this.clients) {
      if (entry.role === 'room' && entry.bedId === bedId && entry.ws.readyState === 1) {
        return { id, entry };
      }
    }
    return null;
  }

  _onOffer(clientId, msg) {
    const { callId, sdp, targetBed } = msg;
    if (this.calls.has(callId)) {
      this.logger.warn('duplicate callId', { callId });
      this._sendTo(clientId, { type: 'error', callId, reason: 'duplicate-callId' });
      return;
    }
    const target = this._findRoomByBed(targetBed);
    if (!target) {
      this.logger.warn('offer target offline', { callId, targetBed });
      this._sendTo(clientId, { type: 'error', callId, reason: 'target-offline', targetBed });
      return;
    }
    if (target.id === clientId) {
      this._sendTo(clientId, { type: 'error', callId, reason: 'self-call' });
      return;
    }
    this.calls.set(callId, {
      callerId: clientId,
      calleeId: target.id,
      state: 'ringing',
      createdAt: Date.now(),
      targetBed,
    });
    this.logger.info('offer routed', {
      callId,
      callerId: clientId,
      calleeId: target.id,
      targetBed,
    });
    this._send(target.entry.ws, { type: 'offer', callId, sdp });
  }

  _onAnswer(clientId, msg) {
    const { callId, sdp } = msg;
    const call = this.calls.get(callId);
    if (!call) {
      this.logger.warn('answer unknown callId', { clientId, callId });
      return;
    }
    if (call.calleeId !== clientId) {
      this.logger.warn('answer from non-callee', { clientId, callId });
      return;
    }
    call.state = 'active';
    this._sendTo(call.callerId, { type: 'answer', callId, sdp });
    this.logger.info('answer routed', { callId });
  }

  _onCandidate(clientId, msg) {
    const { callId, candidate } = msg;
    const call = this.calls.get(callId);
    if (!call) return; // silently drop late candidates
    if (call.callerId !== clientId && call.calleeId !== clientId) {
      this.logger.warn('candidate from stranger', { clientId, callId });
      return;
    }
    const counterpartId = call.callerId === clientId ? call.calleeId : call.callerId;
    this._sendTo(counterpartId, { type: 'candidate', callId, candidate });
  }

  _onHangup(clientId, msg) {
    const { callId } = msg;
    const call = this.calls.get(callId);
    if (!call) return;
    if (call.callerId !== clientId && call.calleeId !== clientId) {
      this.logger.warn('hangup from stranger', { clientId, callId });
      return;
    }
    const counterpartId = call.callerId === clientId ? call.calleeId : call.callerId;
    this._sendTo(counterpartId, { type: 'hangup', callId });
    this.calls.delete(callId);
    this.logger.info('hangup', { callId, byClient: clientId });
  }

  _handleClose(clientId) {
    this.clients.delete(clientId);
    this.logger.info('client disconnected', { clientId, total: this.clients.size });
    // Tear down any calls involving this client — send synthetic hangup to
    // counterpart so its UI unwinds cleanly.
    for (const [callId, call] of Array.from(this.calls)) {
      if (call.callerId === clientId || call.calleeId === clientId) {
        const counterpartId = call.callerId === clientId ? call.calleeId : call.callerId;
        this._sendTo(counterpartId, { type: 'hangup', callId, reason: 'peer-disconnected' });
        this.calls.delete(callId);
        this.logger.info('call ended by disconnect', { callId, disconnected: clientId });
      }
    }
  }

  // Called by the ingest driver after a legacy telemetry frame is parsed.
  broadcastTelemetry(telemetry) {
    const payload = { ...telemetry, type: 'alert' };
    let sent = 0;
    for (const entry of this.clients.values()) {
      if (entry.role === 'nurse' && entry.ws.readyState === 1) {
        this._send(entry.ws, payload);
        sent += 1;
      }
    }
    this.logger.debug('alert broadcast', { bed: telemetry.bed, sent });
    return sent;
  }

  // Returns the bedIds of currently connected rooms — used by the mock
  // injector to only fire alerts for beds that have a room endpoint.
  connectedRoomBeds() {
    const beds = [];
    for (const entry of this.clients.values()) {
      if (entry.role === 'room' && entry.bedId && entry.ws.readyState === 1) {
        beds.push(entry.bedId);
      }
    }
    return beds;
  }

  _send(ws, obj) {
    if (!ws || ws.readyState !== 1) return;
    try {
      ws.send(JSON.stringify(obj));
    } catch (e) {
      this.logger.warn('send fail', { err: e.message });
    }
  }

  _sendTo(clientId, obj) {
    const entry = this.clients.get(clientId);
    if (entry) this._send(entry.ws, obj);
  }
}

module.exports = { SignalingGateway };
