/**
 * Station-side verification primitives. Everything the crew exchanges
 * verbally (keys, frequencies, vectors) is validated here against the
 * scenario's expected values. Pure functions, unit-tested in Node.
 */

export function normalizeCode(s) {
  return String(s ?? '')
    .toUpperCase()
    .replace(/[\s\-_.]/g, '');
}

/** "DELTA-9" accepts "DELTA9", "delta 9", "D-9"? No: only the full key or its shorthand form. */
export function verifyCode(input, expected, { allowShort = true } = {}) {
  const a = normalizeCode(input);
  const b = normalizeCode(expected);
  if (!a || !b) return false;
  if (a === b) return true;
  if (allowShort) {
    // Keypad shorthand: first letter + digits ("D9" for "DELTA-9")
    const short = b[0] + b.replace(/[^0-9]/g, '');
    if (a === short) return true;
  }
  return false;
}

export function verifyDial(value, target, tolerance = 2) {
  return Math.abs(value - target) <= tolerance + 1e-9;
}

/** Heading comparison with 360° wraparound. */
export function headingError(bearing, target) {
  let d = ((bearing - target) % 360 + 540) % 360 - 180;
  return Math.abs(d);
}

export function verifyHeading(bearing, target, tolerance = 5) {
  return headingError(bearing, target) <= tolerance;
}

export function verifyVector({ bearing, pitch }, { bearing: tb, pitch: tp }, { bearingTol = 5, pitchTol = 4 } = {}) {
  return verifyHeading(bearing, tb, bearingTol) && Math.abs(pitch - tp) <= pitchTol;
}

/** Joystick alignment: axes within a radius of a target deflection. */
export function verifyJoystick(axes, target, tolerance = 0.15) {
  const dx = axes.x - target.x;
  const dy = axes.y - target.y;
  return Math.hypot(dx, dy) <= tolerance;
}

/** Power routing: every required bus must be energised. */
export function verifyRouting(power, required) {
  return required.every((bus) => !!power[bus]);
}

export function gradeFromTasks(tasks) {
  const done = tasks.filter((t) => t.state === 'success').length;
  const total = tasks.length || 1;
  const pct = done / total;
  if (pct >= 0.99) return 'EXEMPLARY';
  if (pct >= 0.75) return 'PROFICIENT';
  if (pct >= 0.5) return 'MARGINAL';
  return 'REMEDIAL';
}
