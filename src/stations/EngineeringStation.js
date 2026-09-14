import * as THREE from 'three';
import { StationBase } from './StationBase.js';
import { PatchCable, Socket } from '../controls/PatchCable.js';
import { BreakerSwitch } from '../controls/BreakerSwitch.js';
import { Lever } from '../controls/Lever.js';
import { RotaryDial } from '../controls/RotaryDial.js';
import { ScreenPanel } from '../controls/ScreenPanel.js';
import { PALETTE } from '../core/Constants.js';
import { BUSES } from '../sim/ShipState.js';

const WALL_FACE_Z = -0.85;

/**
 * Engineering & Power Systems. A standing power-grid wall: two heavy patch
 * cables from the bus bar feed any of five sockets; breakers, a thermal
 * vent lever and a coolant valve keep the reactor out of runaway.
 */
export class EngineeringStation extends StationBase {
  build() {
    Object.assign(this.values, { cableMoved: false });

    // Sockets
    this.sockets = {};
    const socketX = { WEAPONS: -0.8, THRUSTERS: -0.4, SHIELDS: 0.0, SENSORS: 0.4, AUXILIARY: 0.8 };
    for (const bus of BUSES) {
      const s = new Socket({ id: bus, label: bus });
      s.group.position.set(socketX[bus], 1.65, WALL_FACE_Z + 0.002);
      this.group.add(s.group);
      this.sockets[bus] = s;
      this.updaters.push((dt) => s.update(dt));
    }
    const socketList = Object.values(this.sockets);

    // Cables from the bus bar
    this.cables = [];
    [[-0.5, 'AUXILIARY', 0xffa14a], [0.5, 'SHIELDS', 0x5ad0ff]].forEach(([x, initial, color], i) => {
      const cable = new PatchCable({
        id: `${i}`, anchor: new THREE.Vector3(x, 2.2, -0.76), sockets: socketList, color, name: 'cable',
        onPlug: (socket) => this._onPlug(socket), onUnplug: (socket) => this._onUnplug(socket),
      });
      this.addControl(cable);
      cable.plugInto(this.sockets[initial], true);
      this.cables.push(cable);
    });

    // Breakers
    this.breakers = {};
    const breakerX = { MAIN: -0.85, WEAPONS: -0.55, THRUSTERS: -0.25, SHIELDS: 0.05, BOOST: 0.35 };
    for (const [id, x] of Object.entries(breakerX)) {
      const b = new BreakerSwitch({ id, label: id, on: this.ship.breakers[id], onToggle: (on) => this._onBreaker(id, on) });
      this.addControl(b, this.uprightMount(x, 1.15, WALL_FACE_Z + 0.03));
      this.breakers[id] = b;
    }
    this.ship.events.on('breakerTrip', ({ id }) => this.breakers[id]?.trip());

    // Vent lever & coolant valve on the shelf
    this.ventLever = this.addControl(
      new Lever({ length: 0.16, mode: 'throttle', minAngle: 0.55, maxAngle: -0.55, value: 0, label: 'THERMAL VENT', color: 0xff5a6a, grip: 'bar', name: 'vent', onChange: (v) => (this.ship.venting = v) })
    );
    this.ventLever.root.position.set(-0.6, 0.995, -0.66);
    this.coolant = this.addControl(
      new RotaryDial({ radius: 0.045, min: 0, max: 100, value: 50, perTurn: 100, step: 5, unit: '%', label: 'COOLANT VALVE', name: 'coolant', glow: 0x5ad0ff, onChange: (v) => (this.ship.coolant = v / 100) }),
      this.deskMount(0.0, 1.0, -0.7)
    );

    // Screens
    this.thermalScreen = new ScreenPanel({ width: 0.42, height: 0.3, px: 512, name: 'eng-thermal', tint: '#ffa14a' });
    this.thermalScreen.setDraw((ctx, w, h, p) => this._drawThermal(ctx, w, h, p));
    this.addScreen(this.thermalScreen, this.uprightMount(0.8, 1.15, WALL_FACE_Z + 0.02));

    this.gridScreen = new ScreenPanel({ width: 0.52, height: 0.3, px: 640, name: 'eng-grid', tint: '#ffa14a' });
    this.gridScreen.setDraw((ctx, w, h, p) => this._drawGrid(ctx, w, h, p));
    this.addScreen(this.gridScreen, this.uprightMount(0.55, 1.95, WALL_FACE_Z + 0.02));

    this.buildCommon({
      statusMount: this.uprightMount(-0.55, 1.95, WALL_FACE_Z + 0.02),
      ackMount: this.deskMount(0.62, 1.0, -0.62),
      statusSize: { width: 0.52, height: 0.3 },
    });

    this._syncPower();
    this.damage.group.position.set(-0.6, 1.4, -0.7);
    // Steam vents from the shelf when the reactor is hot
    this.damage.steam.points.position.set(0.9, -0.5, 0.15);
  }

  _syncPower() {
    for (const bus of BUSES) this.ship.power[bus] = !!this.sockets[bus].plug;
    this.gridScreen.invalidate();
  }

  _onPlug(socket) {
    if (socket.id === 'THRUSTERS' && (this.engine?.timer.t ?? 0) >= 45) this.values.cableMoved = true;
    this._syncPower();
    this.ship.logEvent(this.engine?.timer.t ?? 0, `BUS ${socket.id} ENERGISED`, 'ok');
  }

  _onUnplug(socket) {
    this._syncPower();
    this.ship.logEvent(this.engine?.timer.t ?? 0, `BUS ${socket.id} DE-ENERGISED`, 'warn');
  }

  _onBreaker(id, on) {
    this.ship.breakers[id] = on;
    this.gridScreen.invalidate();
  }

  onLockoutChanged(locked) {
    if (locked) {
      for (const b of Object.values(this.breakers)) if (b.on) b.trip();
    } else {
      this.breakers.MAIN.setOn(true, true);
      this.ship.breakers.MAIN = true;
    }
  }

  setThreat() {}
  clearThreat() {}

  update(dt) {
    super.update(dt);
    const th = this.ship.thermal;
    const level = this.locked ? 2 : th > 95 ? 1 : 0;
    if (level !== this.damage.level) this.damage.setLevel(level);
    if (th > 90 && !this.locked) this.alarmLight.set('amber', true);
    else if (!this.locked && this._alertPulse <= 0) this.alarmLight.set('off');
    this._clock = (this._clock ?? 0) + dt;
    if (this._clock > 1 / 8) {
      this._clock = 0;
      this.thermalScreen.invalidate();
      this.gridScreen.invalidate();
    }
  }

  _drawThermal(ctx, w, h, p) {
    const s = this.ship;
    p.header('REACTOR THERMAL', this.tintHex());
    const v = s.thermal / 130;
    const color = s.thermal >= 100 ? PALETTE.red : s.thermal >= 80 ? PALETTE.amber : PALETTE.green;
    // vertical gauge
    const gx = 30;
    const gy = 56;
    const gh = h - 90;
    ctx.fillStyle = 'rgba(255,255,255,0.08)';
    ctx.fillRect(gx, gy, 40, gh);
    ctx.fillStyle = color;
    ctx.fillRect(gx, gy + gh * (1 - v), 40, gh * v);
    ctx.strokeStyle = PALETTE.red;
    ctx.lineWidth = 2;
    const limitY = gy + gh * (1 - 100 / 130);
    ctx.beginPath();
    ctx.moveTo(gx - 6, limitY);
    ctx.lineTo(gx + 46, limitY);
    ctx.stroke();
    p.text('LIMIT', gx + 50, limitY - 8, { size: 12, color: PALETTE.red });
    p.text(`${s.thermal.toFixed(0)}%`, 130, 56, { size: 44, color, weight: 'bold' });
    const rate = s.thermalRate;
    p.text(`${rate >= 0 ? '▲' : '▼'} ${Math.abs(rate).toFixed(1)} %/s`, 130, 108, { size: 18, color: rate > 0.5 ? PALETTE.amber : PALETTE.screenFg });
    p.text(`LOAD    ${(s.reactorLoad * 100).toFixed(0)}%`, 130, 140, { size: 15, color: PALETTE.white });
    p.text(`VENT    ${(s.venting * 100).toFixed(0)}%`, 130, 160, { size: 15, color: PALETTE.white });
    p.text(`COOLANT ${(s.coolant * 100).toFixed(0)}%`, 130, 180, { size: 15, color: PALETTE.white });
    if (s.thermal >= 100) {
      const blink = Math.floor(performance.now() / 250) % 2 === 0;
      if (blink) p.text(`RUNAWAY IN ${Math.max(0, 6 - s.criticalTimer).toFixed(1)}s`, w - 14, h - 28, { size: 16, align: 'right', color: PALETTE.red, weight: 'bold' });
    } else if (s.thermal >= 85) p.text('VENT NOW', w - 14, h - 28, { size: 16, align: 'right', color: PALETTE.amber, weight: 'bold' });
  }

  _drawGrid(ctx, w, h, p) {
    const s = this.ship;
    p.header('POWER GRID · BUS VOLTAGE', this.tintHex());
    const main = s.breakers.MAIN;
    let y = 54;
    for (const bus of BUSES) {
      const plugged = !!this.sockets[bus].plug;
      const brk = bus in s.breakers ? s.breakers[bus] : true;
      const live = plugged && brk && main;
      const volts = live ? 0.82 + Math.sin(performance.now() / 180 + bus.length) * 0.03 + (s.breakers.BOOST && bus === 'THRUSTERS' ? 0.12 : 0) : plugged ? 0.08 : 0;
      p.bar(150, y, w - 170, 20, volts, { color: live ? PALETTE.green : PALETTE.red });
      p.text(bus, 14, y + 2, { size: 15, color: live ? PALETTE.white : PALETTE.screenDim, weight: 'bold' });
      p.text(live ? `${(volts * 480).toFixed(0)} V` : plugged ? 'BRK OPEN' : 'NO CABLE', w - 24, y + 3, { size: 13, align: 'right', color: live ? PALETTE.white : PALETTE.red });
      y += 28;
    }
    const bstates = Object.entries(s.breakers).map(([k, v]) => `${k}:${v ? 'ON' : 'OFF'}`).join('  ');
    p.text(bstates, 14, h - 24, { size: 12, color: main ? PALETTE.screenFg : PALETTE.red });
  }
}
