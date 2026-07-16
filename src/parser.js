'use strict';

// Legacy control-plane frame parser (ATC-style).
//
// Wire format:  <PREFIX> <ADDR> <ADDR>\n
//   PREFIX ∈ {ATC, NRS, STF}   → call type
//   ADDR   = 4 hex chars (2 chars floor + 2 chars unit)
//   ADDR   is doubled for redundancy — a hallmark of real serial line
//   protocols where line noise can flip bits. Mismatched halves are dropped.
//   Frame terminates with \n (LF) or \r\n (CRLF, common on real serial gear).
//
// The parser is a pure function so it is trivially unit-testable. The
// streaming consumer preserves a per-connection buffer across TCP chunks.
// A max-buffer safeguard prevents unbounded memory growth from a malformed
// producer that never emits a newline.

const FRAME_RE = /^([A-Z]{3}) ([0-9A-F]{4}) ([0-9A-F]{4})$/;
const TYPE_MAP = {
  ATC: 'Emergency',
  NRS: 'Nurse',
  STF: 'Staff',
};

function parseFrame(line) {
  const trimmed = line.trim();
  if (trimmed === '') return { ok: false, reason: 'empty' };
  const m = FRAME_RE.exec(trimmed);
  if (!m) return { ok: false, reason: 'format', raw: line };
  const [, prefix, a, b] = m;
  if (a !== b) return { ok: false, reason: 'redundancy-mismatch', raw: line };
  const type = TYPE_MAP[prefix];
  if (!type) return { ok: false, reason: 'unknown-prefix', raw: line };
  return {
    ok: true,
    telemetry: {
      bed: bedFromAddress(a),
      addr: a,
      type,
      prefix,
      timestamp: Date.now(),
    },
  };
}

function bedFromAddress(addr) {
  // 4 hex chars: (floor:2)(unit:2). Preserve demo-friendly output:
  //   floor==0 → bare unit (decimal)  e.g. "0066" → "102"
  //   floor>0  → "floor-unit"         e.g. "0102" → "1-2"
  const floor = parseInt(addr.slice(0, 2), 16);
  const unit = parseInt(addr.slice(2, 4), 16);
  if (floor === 0) return String(unit);
  return `${floor}-${unit}`;
}

// Streaming consumer.
// Input:  chunk (string), state ({buffer: string}), maxLineBytes (per-line cap).
// Output: {telemetries[], malformed[], state}
//   - Splits combined on \n (also handles \r\n by stripping trailing \r).
//   - Preserves the last (possibly partial) line in state.buffer.
//   - Any single line whose length exceeds maxLineBytes is reported as
//     'oversize' and discarded — this bounds memory against a producer that
//     never sends a newline (buffer would grow unbounded otherwise).
//   - Valid lines that arrive in the same chunk as an oversize line still
//     parse normally (per-line, not per-chunk).
function consume(chunk, state, maxLineBytes = 8192) {
  if (!state || typeof state.buffer !== 'string') state = { buffer: '' };
  const combined = state.buffer + chunk;
  const telemetries = [];
  const malformed = [];

  const parts = combined.split('\n');
  let carry = parts.pop() ?? '';

  // Guard the trailing partial line so a producer streaming garbage without a
  // newline cannot grow this buffer indefinitely.
  if (carry.length > maxLineBytes) {
    malformed.push({ ok: false, reason: 'oversize', bytesDropped: carry.length });
    carry = '';
  }

  for (const raw of parts) {
    const line = raw.endsWith('\r') ? raw.slice(0, -1) : raw;
    if (line.length > maxLineBytes) {
      malformed.push({ ok: false, reason: 'oversize', bytesDropped: line.length });
      continue;
    }
    const result = parseFrame(line);
    if (result.ok) {
      telemetries.push(result.telemetry);
    } else if (result.reason !== 'empty') {
      malformed.push(result);
    }
  }

  return { telemetries, malformed, state: { buffer: carry } };
}

module.exports = { parseFrame, consume, bedFromAddress, TYPE_MAP };
