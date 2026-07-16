'use strict';

// Wire message schema for the WebSocket signaling channel.
//
// All inbound messages are JSON objects with a `type` string. This module
// validates shape and required fields, and normalizes optional fields to
// canonical form. Invalid messages are dropped by the gateway.

const KNOWN_TYPES = new Set(['hello', 'offer', 'answer', 'candidate', 'hangup']);

function fail(reason, extra) {
  return { ok: false, reason, ...(extra || {}) };
}

function validateMessage(data) {
  if (typeof data !== 'object' || data === null || Array.isArray(data)) {
    return fail('not-object');
  }
  if (typeof data.type !== 'string') return fail('no-type');
  if (!KNOWN_TYPES.has(data.type)) return fail('unknown-type', { type: data.type });

  switch (data.type) {
    case 'hello': {
      let role = 'nurse';
      if (data.role != null) {
        if (data.role !== 'nurse' && data.role !== 'room') return fail('bad-role');
        role = data.role;
      }
      let bedId = null;
      if (role === 'room') {
        if (typeof data.bedId !== 'string' || data.bedId.length === 0 || data.bedId.length > 32) {
          return fail('bad-bedId');
        }
        bedId = data.bedId;
      }
      return { ok: true, message: { type: 'hello', role, bedId } };
    }
    case 'offer': {
      if (typeof data.sdp !== 'string' || data.sdp.length < 10) return fail('no-sdp');
      if (typeof data.callId !== 'string' || data.callId.length === 0 || data.callId.length > 64) {
        return fail('bad-callId');
      }
      if (typeof data.targetBed !== 'string' || data.targetBed.length === 0 || data.targetBed.length > 32) {
        return fail('bad-targetBed');
      }
      return {
        ok: true,
        message: { type: 'offer', sdp: data.sdp, callId: data.callId, targetBed: data.targetBed },
      };
    }
    case 'answer': {
      if (typeof data.sdp !== 'string' || data.sdp.length < 10) return fail('no-sdp');
      if (typeof data.callId !== 'string' || data.callId.length === 0 || data.callId.length > 64) {
        return fail('bad-callId');
      }
      return { ok: true, message: { type: 'answer', sdp: data.sdp, callId: data.callId } };
    }
    case 'candidate': {
      if (typeof data.candidate !== 'object' || data.candidate === null) return fail('no-candidate');
      if (typeof data.callId !== 'string' || data.callId.length === 0 || data.callId.length > 64) {
        return fail('bad-callId');
      }
      return {
        ok: true,
        message: { type: 'candidate', candidate: data.candidate, callId: data.callId },
      };
    }
    case 'hangup': {
      if (typeof data.callId !== 'string' || data.callId.length === 0 || data.callId.length > 64) {
        return fail('bad-callId');
      }
      return { ok: true, message: { type: 'hangup', callId: data.callId } };
    }
    default:
      return fail('unreachable');
  }
}

module.exports = { validateMessage, KNOWN_TYPES };
