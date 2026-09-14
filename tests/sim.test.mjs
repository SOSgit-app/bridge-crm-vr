import { test } from 'node:test';
import assert from 'node:assert/strict';
import { TimerManager } from '../src/sim/TimerManager.js';
import { ShipState } from '../src/sim/ShipState.js';
import { ScenarioEngine } from '../src/sim/ScenarioEngine.js';
import { verifyCode, verifyHeading, verifyDial, headingError, gradeFromTasks } from '../src/sim/Verification.js';
import { shakedown, KEYS } from '../src/scenario/shakedown.js';
import { ROLES } from '../src/core/Constants.js';
import { encodeReadback, decodeReadback, compareReadback } from '../src/sim/Readback.js';

// Minimal station stub matching the StationBase contract the engine relies on.
function stationStub(values = {}) {
  return { values: { acceptedKeys: new Set(), ...values }, standbyAckAt: null, onImpact() {}, onKill() {}, setSignal() {}, setMarker() {}, setThreat() {}, clearThreat() {}, showChecklist() {} };
}

function run(engine, seconds, dt = 1 / 72) {
  const steps = Math.round(seconds / dt);
  for (let i = 0; i < steps; i++) engine.timer.advance(dt);
}

test('TimerManager fires injects at exact ticks regardless of frame rate', () => {
  const fired = [];
  const mk = (dt) => {
    const tm = new TimerManager();
    tm.at(1.0, (t) => fired.push([dt, t]));
    tm.engage();
    for (let i = 0; i < Math.ceil(2 / dt); i++) tm.advance(dt);
    return tm;
  };
  mk(1 / 72);
  mk(1 / 90);
  mk(1 / 30);
  assert.equal(fired.length, 3);
  for (const [, t] of fired) assert.ok(Math.abs(t - 1.0) < 1 / 60 + 1e-9, `fired at ${t}`);
});

test('TimerManager formats MM:SS', () => {
  assert.equal(TimerManager.format(0), '00:00');
  assert.equal(TimerManager.format(105), '01:45');
  assert.equal(TimerManager.format(180), '03:00');
});

test('verifyCode accepts canonical, spaced and shorthand forms', () => {
  assert.ok(verifyCode('DELTA-9', 'DELTA-9'));
  assert.ok(verifyCode('delta 9', 'DELTA-9'));
  assert.ok(verifyCode('D9', 'DELTA-9'));
  assert.ok(!verifyCode('DELTA-8', 'DELTA-9'));
  assert.ok(!verifyCode('', 'DELTA-9'));
});

test('heading verification wraps around 360', () => {
  assert.equal(headingError(359, 1), 2);
  assert.ok(verifyHeading(178, 180, 5));
  assert.ok(!verifyHeading(170, 180, 5));
  assert.ok(verifyDial(101, 100, 2));
});

test('ShipState: shields absorb on facing arc, hull takes it otherwise', () => {
  const s = new ShipState();
  s.applyDamage(20, { arc: 'FORE' });
  assert.equal(s.shields.FORE, 80);
  assert.equal(s.hull, 100);
  s.applyDamage(20, { arc: 'AFT' });
  assert.equal(s.hull, 80);
  s.power.SHIELDS = false;
  s.applyDamage(10, { arc: 'FORE' });
  assert.equal(s.hull, 70);
});

test('ShipState: thermal runaway locks out Engineering after sustained overload', () => {
  const s = new ShipState();
  s.power.WEAPONS = true;
  s.breakers.BOOST = true;
  s.venting = 0;
  s.coolant = 0;
  let t = 0;
  const dt = 1 / 60;
  while (t < 60 && !s.lockouts.has(ROLES.ENGINEERING)) {
    s.step(dt, t, { weaponsArmed: true, firing: true });
    t += dt;
  }
  assert.ok(s.lockouts.has(ROLES.ENGINEERING), 'engineering should lock out');
  assert.equal(s.breakers.MAIN, false);
  // and venting recovers it
  s.venting = 1;
  s.coolant = 1;
  for (let i = 0; i < 60 * 20; i++) s.step(dt, t, {});
  assert.ok(s.thermal < 100);
});

// ---- Pre-flight (untimed check-off) --------------------------------------

test('Pre-flight: crew task has no clock and resolves when the station is configured', () => {
  const timer = new TimerManager();
  const ship = new ShipState();
  const station = stationStub({ laserFreq: 0, ecmFreq: 0 });
  const engine = new ScenarioEngine({ scenario: shakedown, timer, ship, role: ROLES.TACTICAL, station });
  engine.startPreflight();
  assert.equal(engine.preflight, true);
  assert.equal(timer.running, false, 'no clock in pre-flight');
  assert.ok(engine.messages.some((m) => m.id === 'pre-laser' && m.t < 0), 'pre-flight order delivered');
  const cal = engine.tasks.find((t) => t.id === 'pre-tac-laser');
  assert.equal(cal.state, 'active');
  assert.equal(cal.until, Infinity);
  for (let i = 0; i < 500; i++) engine.tickPreflight(1 / 72); // ~7 s of idling: never fails
  assert.equal(cal.state, 'active');
  station.values.laserFreq = KEYS.BUOY_FREQ;
  engine.tickPreflight(1 / 72);
  assert.equal(cal.state, 'success');
  assert.equal(engine.readyToEngage, true, 'crew ENGAGE is never gated');
  // ENGAGE: clock starts at 00:00 and pre-flight results carry into the grade
  engine.start();
  assert.equal(engine.preflight, false);
  assert.equal(timer.t, 0);
  assert.equal(engine.tasks.find((t) => t.id === 'pre-tac-laser').state, 'success');
});

test('Pre-flight: Captain ENGAGE arms only after all four station codes verify', () => {
  const timer = new TimerManager();
  const ship = new ShipState();
  const station = stationStub({ checklist: [], checklistDone: false });
  const engine = new ScenarioEngine({ scenario: shakedown, timer, ship, role: ROLES.CAPTAIN, station });
  let verifiedEvent = false;
  engine.events.on('preflight', (e) => e.verified && (verifiedEvent = true));
  engine.startPreflight();
  assert.equal(engine.readyToEngage, false);
  assert.equal(engine.readback.active?.id, 'systems-check');
  assert.equal(engine.readback.active.until, null);

  const crew = new ShipState();
  // Helm not yet on the marker → correction with hint, still not ready
  crew.attitude.bearing = 20;
  const helmBad = engine.submitReadback(encodeReadback(ROLES.HELM, {}, crew));
  assert.equal(helmBad.state, 'correction');
  assert.match(helmBad.hints[0].hint, /050/);
  assert.equal(engine.readyToEngage, false);

  crew.attitude.bearing = KEYS.MARKER.bearing;
  assert.equal(engine.submitReadback(encodeReadback(ROLES.HELM, {}, crew)).state, 'verified');
  assert.equal(engine.submitReadback(encodeReadback(ROLES.SCIENCE, { lockedFreq: null, waveFreq: KEYS.BUOY_FREQ }, crew)).state, 'verified');
  assert.equal(engine.submitReadback(encodeReadback(ROLES.TACTICAL, { acceptedKeys: new Set(), laserFreq: KEYS.BUOY_FREQ }, crew)).state, 'verified');
  assert.equal(engine.readyToEngage, false, 'three of four is not enough');
  assert.equal(engine.submitReadback(encodeReadback(ROLES.ENGINEERING, {}, crew)).state, 'verified');
  assert.equal(engine.readyToEngage, true);
  engine.tickPreflight(1 / 72);
  assert.ok(verifiedEvent);
  assert.equal(engine.tasks.find((t) => t.id === 'pre-cap-verify').state, 'success');

  engine.start();
  assert.equal(engine.readback.active, null, 'pre-flight window closes on ENGAGE');
  assert.equal(engine.tasks.find((t) => t.id === 'pre-cap-verify').state, 'success');
});

test('Pre-flight: unmet items are graded as failed when the crew engages anyway', () => {
  const timer = new TimerManager();
  const ship = new ShipState();
  const station = stationStub({ laserFreq: 0 });
  const engine = new ScenarioEngine({ scenario: shakedown, timer, ship, role: ROLES.TACTICAL, station });
  engine.startPreflight();
  engine.start();
  assert.equal(engine.tasks.find((t) => t.id === 'pre-tac-laser').state, 'failed');
});

// ---- Timed mission ---------------------------------------------------------

test('Scenario: Tactical fails the asteroid window without action', () => {
  const timer = new TimerManager();
  const ship = new ShipState();
  const station = stationStub({ laserFreq: 0, ecmFreq: 0 });
  const engine = new ScenarioEngine({ scenario: shakedown, timer, ship, role: ROLES.TACTICAL, station });
  engine.start();
  run(engine, 62); // through the asteroid window (15–60) with no action
  const asteroid = engine.tasks.find((t) => t.id.startsWith('asteroid:'));
  assert.equal(asteroid.state, 'failed');
  assert.equal(ship.shields.FORE, 90, 'asteroid scrape drains 10% shields');
});

test('Scenario: STANDBY ack inside the window satisfies an un-tasked branch (closed-loop CRM)', () => {
  const timer = new TimerManager();
  const ship = new ShipState();
  const station = stationStub({ laserFreq: 0 });
  const engine = new ScenarioEngine({ scenario: shakedown, timer, ship, role: ROLES.TACTICAL, station });
  engine.start();
  run(engine, 25);
  station.standbyAckAt = timer.t;
  run(engine, 1);
  const asteroid = engine.tasks.find((t) => t.id.startsWith('asteroid:'));
  assert.equal(asteroid.state, 'success');
  assert.equal(asteroid.matched.standby, true);
});

test('Scenario: full kinetic drone kill on Tactical', () => {
  const timer = new TimerManager();
  const ship = new ShipState();
  let killed = false;
  const station = stationStub({ laserFreq: 0 });
  station.onKill = () => (killed = true);
  const engine = new ScenarioEngine({ scenario: shakedown, timer, ship, role: ROLES.TACTICAL, station });
  engine.start();
  run(engine, 25);
  station.standbyAckAt = timer.t; // asteroid: told to stand by
  run(engine, 82); // t = 107, past EXECUTE at 105
  station.values.acceptedKeys.add(KEYS.DRONE_ARM_KEY);
  station.values.laserFreq = KEYS.DRONE_SHIELD_FREQ;
  station.values.launchedAt = timer.t;
  run(engine, 1);
  const drone = engine.tasks.find((t) => t.id.startsWith('drone:'));
  assert.equal(drone.state, 'success');
  assert.ok(killed);
  let summary = null;
  engine.events.on('complete', (s) => (summary = s));
  run(engine, 30);
  assert.ok(summary, 'scenario should complete at 02:15');
  assert.equal(summary.success, true);
  assert.equal(ship.hull, 100);
});

test('Scenario: Captain decision gates alternatives and generates keys', () => {
  const timer = new TimerManager();
  const ship = new ShipState();
  const station = stationStub({ checklistDone: false });
  const engine = new ScenarioEngine({ scenario: shakedown, timer, ship, role: ROLES.CAPTAIN, station });
  let decision = null;
  engine.events.on('decision', (d) => (decision = d));
  engine.start();
  run(engine, 16);
  assert.ok(decision && decision.id === 'asteroid');
  assert.equal(decision.options.length, 2);
  assert.ok(engine.choose('asteroid', 'blast'));
  assert.equal(decision.options.find((o) => o.id === 'blast').code, 'ALPHA-1');
  run(engine, 1);
  assert.equal(engine.tasks.find((t) => t.id === 'cap-asteroid').state, 'success');
  run(engine, 70);
  assert.ok(decision && decision.id === 'drone');
  assert.equal(decision.options.length, 3);
  engine.choose('drone', 'kinetic');
  assert.equal(engine.choices.drone, 'kinetic');
  assert.equal(decision.options.find((o) => o.id === 'kinetic').code, 'DELTA-9');
});

// ---- Readback verification ---------------------------------------------

test('Readback: every station round-trips its configuration losslessly', () => {
  const ship = new ShipState();
  ship.attitude.bearing = 327;
  ship.attitude.pitch = -12;
  ship.throttle = 1;
  ship.power.WEAPONS = true;
  ship.breakers.BOOST = true;
  ship.thermal = 88;

  const helm = decodeReadback(encodeReadback(ROLES.HELM, {}, ship));
  assert.equal(helm.role, ROLES.HELM);
  assert.equal(helm.fields.bearing, 327);
  assert.equal(helm.fields.pitch, -12);
  assert.ok(Math.abs(helm.fields.throttle - 1) < 1e-9);

  const tacVals = { acceptedKeys: new Set(['DELTA-9', 'WARP-7']), laserFreq: 340, ecmFreq: 12, pdFired: true, launchedAt: null, jamming: false, shieldArc: 'PORT' };
  const tac = decodeReadback(encodeReadback(ROLES.TACTICAL, tacVals, ship));
  assert.deepEqual(tac.fields.keys, ['DELTA-9', 'WARP-7']);
  assert.equal(tac.fields.laserFreq, 340);
  assert.equal(tac.fields.ecmFreq, 12);
  assert.equal(tac.fields.pdFired, true);
  assert.equal(tac.fields.launched, false);
  assert.equal(tac.fields.shieldArc, 'PORT');

  const sci = decodeReadback(encodeReadback(ROLES.SCIENCE, { lockedFreq: null, waveFreq: 215 }, ship));
  assert.equal(sci.fields.lockedFreq, null);
  assert.equal(sci.fields.waveFreq, 215);

  const eng = decodeReadback(encodeReadback(ROLES.ENGINEERING, {}, ship));
  assert.deepEqual(eng.fields.power, ['WEAPONS', 'THRUSTERS', 'SHIELDS', 'SENSORS', 'AUXILIARY']);
  assert.deepEqual(eng.fields.breakers, ['MAIN', 'WEAPONS', 'THRUSTERS', 'SHIELDS', 'BOOST']);
  assert.equal(eng.fields.thermal, 90);

  // Codes are short enough to speak and never contain I or O
  for (const code of [encodeReadback(ROLES.HELM, {}, ship), encodeReadback(ROLES.TACTICAL, tacVals, ship)]) {
    assert.ok(code.length <= 10, code);
    assert.ok(!/[IO]/.test(code), code);
  }
});

test('Readback: misheard digit is caught by checksum, spoken variants normalise', () => {
  const ship = new ShipState();
  const code = encodeReadback(ROLES.SCIENCE, { lockedFreq: 100, waveFreq: 100 }, ship);
  const ok = decodeReadback(code.toLowerCase().replace(/-/g, ' '));
  assert.equal(ok.role, ROLES.SCIENCE);
  assert.equal(ok.fields.lockedFreq, 100);
  // flip one payload character
  const chars = code.replace(/-/g, '').split('');
  chars[2] = chars[2] === '7' ? '8' : '7';
  const bad = decodeReadback(chars.join(''));
  assert.equal(bad.error, 'GARBLED');
  assert.equal(decodeReadback('Z1234').error, 'UNKNOWN_ROLE');
  assert.equal(decodeReadback('H12').error, 'LENGTH');
});

test('Readback: compare gives per-field hints', () => {
  const ship = new ShipState();
  const d = decodeReadback(encodeReadback(ROLES.TACTICAL, { acceptedKeys: new Set(), laserFreq: 320 }, ship));
  const cmp = compareReadback(ROLES.TACTICAL, d.fields, {
    keys: { includes: ['DELTA-9'], hint: 'Enter DELTA-9' },
    laserFreq: { value: 340, tol: 3, hint: 'Dial to 340' },
  });
  assert.equal(cmp.ok, false);
  assert.equal(cmp.mismatches.length, 2);
  assert.equal(cmp.mismatches[0].field, 'keys');
  assert.equal(cmp.mismatches[1].actual, '320 MHz');
  assert.equal(cmp.mismatches[1].hint, 'Dial to 340');
});

test('Scenario: Captain verifies crew readbacks against the chosen route; auto-clears the crew report', () => {
  const timer = new TimerManager();
  const ship = new ShipState();
  const station = stationStub({ checklistDone: false });
  const engine = new ScenarioEngine({ scenario: shakedown, timer, ship, role: ROLES.CAPTAIN, station });
  engine.start();
  run(engine, 16);

  // Before a route is chosen, nothing can be verified.
  const crewShip = new ShipState();
  const tacGood = encodeReadback(ROLES.TACTICAL, { acceptedKeys: new Set([KEYS.ASTEROID_KEY]), laserFreq: 100, pdFired: true }, crewShip);
  assert.equal(engine.submitReadback(tacGood).state, 'no-route');

  engine.choose('asteroid', 'blast');
  // Tactical forgot to pull point-defense: correction with a hint
  const tacBad = encodeReadback(ROLES.TACTICAL, { acceptedKeys: new Set([KEYS.ASTEROID_KEY]), laserFreq: 100, pdFired: false }, crewShip);
  const r1 = engine.submitReadback(tacBad);
  assert.equal(r1.state, 'correction');
  assert.equal(r1.role, ROLES.TACTICAL);
  assert.equal(r1.hints[0].field, 'pdFired');
  assert.match(r1.hints[0].hint, /POINT DEFENSE/);
  assert.equal(engine.readback.roleStatus('asteroid', ROLES.TACTICAL).state, 'correction');

  // Helm has nothing to do on BLAST: standby
  assert.equal(engine.submitReadback(encodeReadback(ROLES.HELM, {}, crewShip)).state, 'standby');

  // Corrected Tactical + Science lock → all verified → Captain task passes
  assert.equal(engine.submitReadback(tacGood).state, 'verified');
  const sci = encodeReadback(ROLES.SCIENCE, { lockedFreq: KEYS.ASTEROID_RETURN_FREQ, waveFreq: KEYS.ASTEROID_RETURN_FREQ }, crewShip);
  assert.equal(engine.submitReadback(sci).state, 'verified');
  run(engine, 1);
  assert.equal(engine.tasks.find((t) => t.id === 'cap-readback-asteroid').state, 'success');

  // Crew report auto-resolves to CLEARED because readbacks were verified
  let debrief = null;
  engine.events.on('debrief', (d) => (debrief = d));
  run(engine, 45); // t = 62
  assert.ok(debrief && debrief.id === 'asteroid-report');
  assert.equal(debrief.chosen, 'cleared');
  assert.equal(ship.shieldAverage, 100);
});

test('gradeFromTasks buckets', () => {
  assert.equal(gradeFromTasks([{ state: 'success' }, { state: 'success' }]), 'EXEMPLARY');
  assert.equal(gradeFromTasks([{ state: 'success' }, { state: 'failed' }]), 'MARGINAL');
});
