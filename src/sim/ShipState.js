import { EventBus } from '../core/EventBus.js';
import { ROLES } from '../core/Constants.js';

export const BUSES = ['WEAPONS', 'THRUSTERS', 'SHIELDS', 'SENSORS', 'AUXILIARY'];
export const ARCS = ['FORE', 'AFT', 'PORT', 'STARBOARD'];

/**
 * Local truth model of the ship. Each headset runs one; it reflects what THIS
 * operator has actually done plus the deterministic scenario. Cross-station
 * consequences are transferred verbally and acknowledged through the
 * Captain's debrief nodes and the crew's STANDBY-ACK buttons.
 */
export class ShipState {
  constructor() {
    this.events = new EventBus();
    this.reset();
  }

  reset() {
    this.hull = 100;
    this.shields = { FORE: 100, AFT: 100, PORT: 100, STARBOARD: 100 };
    this.shieldFacing = 'FORE';
    // Power: which buses are energised. Defaults nominal; Engineering owns it.
    this.power = { WEAPONS: false, THRUSTERS: true, SHIELDS: true, SENSORS: true, AUXILIARY: true };
    this.breakers = { MAIN: true, WEAPONS: true, THRUSTERS: true, SHIELDS: true, BOOST: false };
    this.thermal = 22; // % of reactor thermal limit
    this.thermalRate = 0;
    this.venting = 0; // 0..1 vent lever
    this.coolant = 0.5; // 0..1 coolant valve
    this.reactorLoad = 0.4;
    this.attitude = { bearing: 0, pitch: 0, roll: 0 };
    this.throttle = 0.35;
    this.lockouts = new Set();
    this.criticalTimer = 0;
    this.log = [];
    this.alive = true;
  }

  logEvent(t, text, level = 'info') {
    this.log.push({ t, text, level });
    if (this.log.length > 60) this.log.shift();
    this.events.emit('log', { t, text, level });
  }

  isLocked(role) {
    return this.lockouts.has(role);
  }

  lockout(role, t, reason) {
    if (this.lockouts.has(role)) return;
    this.lockouts.add(role);
    this.logEvent(t, `${role} CRITICAL LOCKOUT: ${reason}`, 'critical');
    this.events.emit('lockout', { role, reason });
  }

  restore(role, t) {
    if (!this.lockouts.delete(role)) return;
    this.logEvent(t, `${role} systems restored`, 'ok');
    this.events.emit('restore', { role });
  }

  /**
   * Apply damage from an arc. Shields on that arc absorb if energised and
   * facing; otherwise the hull takes it directly.
   */
  applyDamage(amount, { arc = 'FORE', source = 'impact', t = 0 } = {}) {
    let toHull = amount;
    const shieldsUp = this.power.SHIELDS && this.breakers.SHIELDS && this.breakers.MAIN;
    if (shieldsUp && this.shieldFacing === arc && this.shields[arc] > 0) {
      const absorbed = Math.min(this.shields[arc], amount);
      this.shields[arc] -= absorbed;
      toHull = amount - absorbed;
      this.logEvent(t, `${source}: ${arc} shields absorbed ${absorbed.toFixed(0)}%`, 'warn');
    } else {
      this.logEvent(t, `${source}: HULL HIT ${amount.toFixed(0)}% (shields ${shieldsUp ? 'wrong arc' : 'down'})`, 'critical');
    }
    if (toHull > 0) this.hull = Math.max(0, this.hull - toHull);
    this.events.emit('damage', { amount, arc, source, toHull });
    if (this.hull <= 0 && this.alive) {
      this.alive = false;
      this.events.emit('destroyed');
    }
  }

  drainShields(pct, t, reason) {
    for (const k of Object.keys(this.shields)) this.shields[k] = Math.max(0, this.shields[k] - pct);
    this.logEvent(t, `${reason}: shields drained ${pct}%`, 'warn');
    this.events.emit('damage', { amount: pct, arc: 'ALL', source: reason, toHull: 0 });
  }

  get shieldAverage() {
    return (this.shields.FORE + this.shields.AFT + this.shields.PORT + this.shields.STARBOARD) / 4;
  }

  /** Reactor thermal model, stepped by the deterministic clock. */
  step(dt, t, { weaponsArmed = false, firing = false } = {}) {
    let load = 0.25;
    if (this.power.WEAPONS) load += weaponsArmed ? 0.55 : 0.25;
    if (this.breakers.BOOST) load += 0.35;
    if (this.power.THRUSTERS) load += this.throttle * 0.25;
    if (firing) load += 0.6;
    this.reactorLoad = load;
    const cooling = 0.18 + this.venting * 0.9 + this.coolant * 0.35;
    this.thermalRate = (load - cooling) * 9;
    this.thermal = Math.min(130, Math.max(15, this.thermal + this.thermalRate * dt));

    if (this.thermal >= 100) {
      this.criticalTimer += dt;
      if (this.criticalTimer > 6 && !this.lockouts.has(ROLES.ENGINEERING)) {
        this.breakers.MAIN = false;
        this.lockout(ROLES.ENGINEERING, t, 'reactor thermal runaway');
      }
    } else this.criticalTimer = Math.max(0, this.criticalTimer - dt * 0.5);
    if (this.thermal >= 112 && this.breakers.WEAPONS) {
      this.breakers.WEAPONS = false;
      this.events.emit('breakerTrip', { id: 'WEAPONS' });
      this.logEvent(t, 'WEAPONS relay blown (thermal)', 'critical');
    }
  }

  /** Helm attitude integration from joystick axes. */
  steer(dt, { pitchYaw, rollThrust }) {
    const yawRate = 38; // deg/s at full deflection
    const pitchRate = 28;
    const rollRate = 45;
    const thrustOk = this.power.THRUSTERS && this.breakers.THRUSTERS && this.breakers.MAIN;
    const k = thrustOk ? 1 : 0.25;
    this.attitude.bearing = ((this.attitude.bearing + pitchYaw.x * yawRate * k * dt) % 360 + 360) % 360;
    this.attitude.pitch = Math.max(-60, Math.min(60, this.attitude.pitch - pitchYaw.y * pitchRate * k * dt));
    this.attitude.roll = Math.max(-90, Math.min(90, this.attitude.roll + rollThrust.x * rollRate * k * dt));
    // Roll self-centres slowly when the stick is released
    if (Math.abs(rollThrust.x) < 0.05) this.attitude.roll *= Math.max(0, 1 - dt * 1.2);
    if (Math.abs(rollThrust.y) > 0.05) this.throttle = Math.max(0, Math.min(1, this.throttle - rollThrust.y * 0.4 * dt));
  }
}
