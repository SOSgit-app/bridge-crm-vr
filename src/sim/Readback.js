import { ROLES } from '../core/Constants.js';
import { BUSES } from './ShipState.js';
import { headingError } from './Verification.js';

/**
 * Readback verification.
 *
 * Every crew station encodes its live control configuration into a short
 * spoken code (role letter + base-32 payload + checksum). The operator reads
 * it to the Captain; the Captain types it on the Holo-Table keypad. The
 * Captain's headset decodes the exact configuration and compares it with what
 * the chosen route requires, producing VERIFIED or a per-field correction hint.
 *
 * The alphabet omits I and O so codes are unambiguous when spoken.
 */
export const ALPHABET = '0123456789ABCDEFGHJKLMNPQRSTUVWX';
const BITS = 5;

const AUTH_KEYS = ['ALPHA-1', 'DELTA-9', 'ECHO-3', 'WARP-7'];
const ARCS = ['FORE', 'AFT', 'PORT', 'STARBOARD'];
const BREAKERS = ['MAIN', 'WEAPONS', 'THRUSTERS', 'SHIELDS', 'BOOST'];
const NONE_10 = 1023;

const bitmask = (list, present) => list.reduce((m, k, i) => (present(k) ? m | (1 << i) : m), 0);
const unmask = (list, m) => list.filter((_, i) => m & (1 << i));

/**
 * Field schema per role. `bits` is the payload width; `gather` pulls the raw
 * value from station values + ship; `encode`/`decode` map to/from integers.
 */
export const SCHEMAS = {
  [ROLES.HELM]: {
    letter: 'H',
    fields: [
      { key: 'bearing', label: 'BEARING', bits: 10, gather: (v, s) => s.attitude.bearing, encode: (b) => ((Math.round(b) % 360) + 360) % 360, decode: (n) => n, format: (n) => `${String(n).padStart(3, '0')}°` },
      { key: 'pitch', label: 'PITCH', bits: 10, gather: (v, s) => s.attitude.pitch, encode: (p) => Math.round(p) + 90, decode: (n) => n - 90, format: (n) => `${n > 0 ? '+' : ''}${n}°` },
      { key: 'throttle', label: 'THROTTLE', bits: 5, gather: (v, s) => s.throttle, encode: (t) => Math.round(t * 31), decode: (n) => n / 31, format: (n) => `${Math.round(n * 100)}%` },
    ],
  },
  [ROLES.TACTICAL]: {
    letter: 'T',
    fields: [
      { key: 'keys', label: 'AUTH KEYS', bits: 5, gather: (v) => v.acceptedKeys ?? new Set(), encode: (set) => bitmask(AUTH_KEYS, (k) => set.has(k)), decode: (n) => unmask(AUTH_KEYS, n), format: (a) => (a.length ? a.join('+') : 'none') },
      { key: 'laserFreq', label: 'LASER/TORPEDO MOD', bits: 10, gather: (v) => v.laserFreq ?? 0, encode: (f) => Math.round(f), decode: (n) => n, format: (n) => `${n} MHz` },
      { key: 'ecmFreq', label: 'ECM FREQ', bits: 10, gather: (v) => v.ecmFreq ?? 0, encode: (f) => Math.round(f), decode: (n) => n, format: (n) => `${n} MHz` },
      { key: 'pdFired', label: 'POINT DEFENSE', bits: 1, gather: (v) => !!v.pdFired, encode: (b) => (b ? 1 : 0), decode: (n) => !!n, format: (b) => (b ? 'FIRED' : 'not fired') },
      { key: 'launched', label: 'TORPEDO', bits: 1, gather: (v) => v.launchedAt != null, encode: (b) => (b ? 1 : 0), decode: (n) => !!n, format: (b) => (b ? 'LAUNCHED' : 'not launched') },
      { key: 'jamming', label: 'ECM JAM', bits: 1, gather: (v) => !!v.jamming, encode: (b) => (b ? 1 : 0), decode: (n) => !!n, format: (b) => (b ? 'ON' : 'off') },
      { key: 'shieldArc', label: 'SHIELD FACING', bits: 2, gather: (v) => v.shieldArc ?? 'FORE', encode: (a) => Math.max(0, ARCS.indexOf(a)), decode: (n) => ARCS[n] ?? 'FORE', format: (a) => a },
    ],
  },
  [ROLES.SCIENCE]: {
    letter: 'S',
    fields: [
      { key: 'lockedFreq', label: 'SENSOR LOCK', bits: 10, gather: (v) => v.lockedFreq, encode: (f) => (f == null ? NONE_10 : Math.round(f)), decode: (n) => (n === NONE_10 ? null : n), format: (n) => (n == null ? 'NO LOCK' : `${n} MHz`) },
      { key: 'waveFreq', label: 'WAVE DIAL', bits: 10, gather: (v) => v.waveFreq ?? 0, encode: (f) => Math.round(f), decode: (n) => n, format: (n) => `${n} MHz` },
    ],
  },
  [ROLES.ENGINEERING]: {
    letter: 'E',
    fields: [
      { key: 'power', label: 'POWERED BUSES', bits: 5, gather: (v, s) => s.power, encode: (p) => bitmask(BUSES, (b) => !!p[b]), decode: (n) => unmask(BUSES, n), format: (a) => (a.length ? a.join('+') : 'none') },
      { key: 'breakers', label: 'BREAKERS ON', bits: 5, gather: (v, s) => s.breakers, encode: (b) => bitmask(BREAKERS, (k) => !!b[k]), decode: (n) => unmask(BREAKERS, n), format: (a) => (a.length ? a.join('+') : 'none') },
      { key: 'thermal', label: 'REACTOR THERMAL', bits: 5, gather: (v, s) => s.thermal, encode: (t) => Math.min(31, Math.max(0, Math.round(t / 5))), decode: (n) => n * 5, format: (n) => `~${n}%` },
    ],
  },
};

export const ROLE_BY_LETTER = Object.fromEntries(Object.entries(SCHEMAS).map(([role, s]) => [s.letter, role]));

function packBits(fields) {
  let acc = 0n;
  let total = 0;
  for (const { bits, value } of fields) {
    const max = (1 << bits) - 1;
    const v = Math.min(max, Math.max(0, value | 0));
    acc = (acc << BigInt(bits)) | BigInt(v);
    total += bits;
  }
  const chars = Math.ceil(total / BITS);
  acc <<= BigInt(chars * BITS - total);
  let out = '';
  for (let i = chars - 1; i >= 0; i--) out += ALPHABET[Number((acc >> BigInt(i * BITS)) & 31n)];
  return out;
}

function unpackBits(str, widths) {
  let acc = 0n;
  for (const ch of str) acc = (acc << BigInt(BITS)) | BigInt(ALPHABET.indexOf(ch));
  const total = widths.reduce((a, b) => a + b, 0);
  acc >>= BigInt(str.length * BITS - total);
  const out = [];
  let remaining = total;
  for (const w of widths) {
    remaining -= w;
    out.push(Number((acc >> BigInt(remaining)) & BigInt((1 << w) - 1)));
  }
  return out;
}

function checksum(body) {
  let sum = 0;
  for (let i = 0; i < body.length; i++) sum += ALPHABET.indexOf(body[i]) * (i + 1);
  return ALPHABET[sum % 32];
}

export function payloadLength(role) {
  const total = SCHEMAS[role].fields.reduce((a, f) => a + f.bits, 0);
  return Math.ceil(total / BITS);
}

/** Encode a station's current configuration. Returns e.g. "T-7KM2AQ-4". */
export function encodeReadback(role, values, ship) {
  const schema = SCHEMAS[role];
  if (!schema) return null;
  const packed = packBits(schema.fields.map((f) => ({ bits: f.bits, value: f.encode(f.gather(values, ship)) })));
  const body = schema.letter + packed;
  return `${schema.letter}-${packed}-${checksum(body)}`;
}

export function normalizeReadback(input) {
  return String(input ?? '')
    .toUpperCase()
    .replace(/[^0-9A-Z]/g, '')
    .replace(/I/g, '1')
    .replace(/O/g, '0');
}

/** Decode a spoken/typed code. Returns { role, fields } or { error, reason }. */
export function decodeReadback(input) {
  const s = normalizeReadback(input);
  if (s.length < 3) return { error: 'INCOMPLETE', reason: 'Code too short — ask them to read it again.' };
  const role = ROLE_BY_LETTER[s[0]];
  if (!role) return { error: 'UNKNOWN_ROLE', reason: `"${s[0]}" is not a station letter (H, T, S, E).` };
  const expectedLen = 1 + payloadLength(role) + 1;
  if (s.length !== expectedLen) return { error: 'LENGTH', reason: `${role} codes are ${expectedLen} characters — heard ${s.length}.`, role };
  const body = s.slice(0, -1);
  if (checksum(body) !== s.at(-1)) return { error: 'GARBLED', reason: 'Checksum failed — a digit was misheard. Ask them to repeat.', role };
  for (const ch of s) if (!ALPHABET.includes(ch)) return { error: 'GARBLED', reason: `"${ch}" is not a valid code character.`, role };
  const schema = SCHEMAS[role];
  const nums = unpackBits(s.slice(1, -1), schema.fields.map((f) => f.bits));
  const fields = {};
  schema.fields.forEach((f, i) => (fields[f.key] = f.decode(nums[i])));
  return { role, fields };
}

/**
 * Compare decoded fields with an expectation block:
 *   { fieldKey: { value, tol, wrap, hint } }          numeric within tolerance
 *   { fieldKey: { includes: [...], hint } }           list must contain all
 *   { fieldKey: { excludes: [...], hint } }           list must contain none
 *   { fieldKey: { equals: x, hint } }                 exact equality
 *   { fieldKey: { max: x, hint } }                    numeric upper bound
 */
export function compareReadback(role, fields, expectation) {
  const schema = SCHEMAS[role];
  const mismatches = [];
  for (const [key, rule] of Object.entries(expectation ?? {})) {
    const f = schema.fields.find((x) => x.key === key);
    if (!f) continue;
    const actual = fields[key];
    let ok = true;
    if (rule.value !== undefined) {
      if (typeof actual !== 'number') ok = false;
      else if (rule.wrap) ok = headingError(actual, rule.value) <= (rule.tol ?? 0);
      else ok = Math.abs(actual - rule.value) <= (rule.tol ?? 0);
    }
    if (ok && rule.includes) ok = Array.isArray(actual) && rule.includes.every((x) => actual.includes(x));
    if (ok && rule.excludes) ok = Array.isArray(actual) && rule.excludes.every((x) => !actual.includes(x));
    if (ok && rule.equals !== undefined) ok = actual === rule.equals;
    if (ok && rule.max !== undefined) ok = typeof actual === 'number' && actual <= rule.max;
    if (!ok) {
      mismatches.push({
        field: key,
        label: f.label,
        actual: f.format(actual),
        expected: describeRule(rule, f),
        hint: rule.hint ?? `${f.label} should be ${describeRule(rule, f)}`,
      });
    }
  }
  return { ok: mismatches.length === 0, mismatches };
}

function describeRule(rule, f) {
  if (rule.value !== undefined) return f.format(rule.value) + (rule.tol ? ` (±${rule.tol})` : '');
  if (rule.includes) return `includes ${rule.includes.join('+')}`;
  if (rule.excludes) return `without ${rule.excludes.join('+')}`;
  if (rule.equals !== undefined) return f.format(rule.equals);
  if (rule.max !== undefined) return `≤ ${f.format(rule.max)}`;
  return '?';
}

/**
 * Tracks readback windows and per-role verification status on the Captain's
 * headset. Expectations may depend on the Captain's chosen route, so they are
 * resolved lazily via `expect(ctx)`.
 */
export class ReadbackTracker {
  constructor(windows = []) {
    this.windows = windows;
    this.active = null;
    this.status = {}; // windowId -> role -> { state, hints, code, t }
  }

  open(win, t) {
    this.active = win;
    this.status[win.id] ??= {};
    return this.active;
  }

  close(win) {
    if (this.active?.id === win.id) this.active = null;
  }

  /** Expectation map for the active window given Captain context; null when not yet decidable. */
  expectations(ctx) {
    if (!this.active) return null;
    const e = typeof this.active.expect === 'function' ? this.active.expect(ctx) : this.active.expect;
    return e ?? null;
  }

  requiredRoles(ctx) {
    const e = this.expectations(ctx);
    if (!e) return [];
    return Object.entries(e)
      .filter(([, rule]) => rule && !rule.standby)
      .map(([role]) => role);
  }

  roleStatus(windowId, role) {
    return this.status[windowId]?.[role] ?? { state: 'pending', hints: [] };
  }

  allVerified(windowId, ctx) {
    const win = this.windows.find((w) => w.id === windowId);
    if (!win) return false;
    const e = typeof win.expect === 'function' ? win.expect(ctx) : win.expect;
    if (!e) return false;
    const required = Object.entries(e).filter(([, r]) => r && !r.standby).map(([r]) => r);
    if (!required.length) return false;
    return required.every((r) => this.status[windowId]?.[r]?.state === 'verified');
  }

  /**
   * Submit a typed code. Returns a result record that is also stored under the
   * active window for the decoded role.
   */
  submit(code, ctx) {
    const t = ctx.t;
    const decoded = decodeReadback(code);
    if (decoded.error) {
      const res = { state: 'garbled', role: decoded.role ?? null, code, t, reason: decoded.reason, hints: [] };
      if (this.active && decoded.role) this.status[this.active.id][decoded.role] = res;
      return res;
    }
    if (!this.active) {
      return { state: 'no-window', role: decoded.role, code, t, reason: 'No readback window is open right now.', hints: [] };
    }
    const exp = this.expectations(ctx);
    if (!exp) {
      return { state: 'no-route', role: decoded.role, code, t, reason: 'Select a route on the Holo-Table before verifying readbacks.', hints: [] };
    }
    const rule = exp[decoded.role];
    let res;
    if (!rule || rule.standby) {
      res = { state: 'standby', role: decoded.role, code, t, reason: `${decoded.role} has no task on this route — stand by.`, hints: [] };
    } else {
      const cmp = compareReadback(decoded.role, decoded.fields, rule);
      res = cmp.ok
        ? { state: 'verified', role: decoded.role, code, t, fields: decoded.fields, hints: [] }
        : { state: 'correction', role: decoded.role, code, t, fields: decoded.fields, hints: cmp.mismatches };
    }
    this.status[this.active.id][decoded.role] = res;
    return res;
  }
}
