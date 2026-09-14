import { test } from 'node:test';
import assert from 'node:assert/strict';
import { TimerManager } from '../src/sim/TimerManager.js';
import { ShipState } from '../src/sim/ShipState.js';
import { ScenarioEngine } from '../src/sim/ScenarioEngine.js';
import { verifyCode, verifyHeading, verifyDial, headingError, gradeFromTasks } from '../src/sim/Verification.js';
import { shakedown, KEYS } from '../src/scenario/shakedown.js';
import { ROLES } from '../src/core/Constants.js';

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

test('Scenario: Tactical succeeds phase 1 laser calibration and fails asteroid without action', () => {
  const timer = new TimerManager();
  const ship = new ShipState();
  const station = stationStub({ laserFreq: 0, ecmFreq: 0 });
  const engine = new ScenarioEngine({ scenario: shakedown, timer, ship, role: ROLES.TACTICAL, station });
  engine.start();
  run(engine, 35);
  station.values.laserFreq = KEYS.BUOY_FREQ;
  run(engine, 1);
  const cal = engine.tasks.find((t) => t.id === 'tac-laser-cal');
  assert.equal(cal.state, 'success');
  run(engine, 70); // through the asteroid window with no action
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
  run(engine, 70);
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
  run(engine, 70);
  station.standbyAckAt = timer.t; // asteroid: told to stand by
  run(engine, 82); // t = 152
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
  assert.ok(summary, 'scenario should complete at 03:00');
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
  run(engine, 61);
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

test('gradeFromTasks buckets', () => {
  assert.equal(gradeFromTasks([{ state: 'success' }, { state: 'success' }]), 'EXEMPLARY');
  assert.equal(gradeFromTasks([{ state: 'success' }, { state: 'failed' }]), 'MARGINAL');
});
