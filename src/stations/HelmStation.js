import * as THREE from 'three';
import { StationBase } from './StationBase.js';
import { Joystick } from '../controls/Joystick.js';
import { Lever } from '../controls/Lever.js';
import { ScreenPanel } from '../controls/ScreenPanel.js';
import { IndicatorLight } from '../controls/IndicatorLight.js';
import { PALETTE } from '../core/Constants.js';
import { SpaceScape } from '../environment/SpaceScape.js';
import { headingError } from '../sim/Verification.js';

const PANEL = { center: new THREE.Vector3(0, 1.08, -1.05), rotX: -0.42 };

/**
 * Helm / Flight Operations. Dual 6-DOF sticks (left: pitch/yaw, right:
 * roll/thrust trim), a throttle lever and a spatial flight HUD. The stick
 * inputs integrate into the local ShipState attitude, which counter-rotates
 * the universe seen through the viewport.
 */
export class HelmStation extends StationBase {
  build() {
    this.values.marker = null;
    this.values.threat = null;

    // Sticks on the desk
    this.leftStick = this.addControl(new Joystick({ label: 'PITCH / YAW', name: 'stick-L' }));
    this.leftStick.root.position.set(-0.22, 0.78, -0.6);
    this.rightStick = this.addControl(new Joystick({ label: 'ROLL / TRIM', name: 'stick-R', color: 0x2a1d1d }));
    this.rightStick.root.position.set(0.22, 0.78, -0.6);

    // Throttle on the left pod, swings fore/aft
    this.throttle = this.addControl(
      new Lever({
        length: 0.13, mode: 'throttle', minAngle: 0.55, maxAngle: -0.55, value: this.ship.throttle, label: 'THROTTLE', color: 0x2f6fb5, grip: 'bar',
        name: 'throttle', onChange: (v) => (this.ship.throttle = v),
      })
    );
    this.throttle.root.position.set(-0.6, 0.755, -0.35);
    this.throttle.root.rotation.y = 0.35;

    // Flight HUD on the sloped panel
    this.hud = new ScreenPanel({ width: 0.62, height: 0.36, px: 768, name: 'helm-hud', tint: PALETTE.screenFg });
    this.hud.setDraw((ctx, w, h, p) => this._drawHud(ctx, w, h, p));
    this.addScreen(this.hud, this.panelMount(PANEL.center, PANEL.rotX, -0.3, 0.02));

    // Status / orders on the right
    this.buildCommon({
      statusMount: this.panelMount(PANEL.center, PANEL.rotX, 0.42, 0.02),
      ackMount: this.deskMount(0.52, 0.782, -0.5),
      statusSize: { width: 0.42, height: 0.3 },
    });

    // Debris / collision warning lights along the desk lip
    this.warnLights = [];
    ['DEBRIS', 'COLLISION', 'THRUST'].forEach((label, i) => {
      const ind = new IndicatorLight({ radius: 0.011, light: true, lightRange: 0.5, lightIntensity: 0.9 });
      ind.group.position.set(-0.5 + i * 0.07, 0.785, -0.47);
      ind.group.rotation.x = -Math.PI / 2;
      this.addIndicator(ind);
      const lbl = labelPlate(label);
      lbl.position.set(-0.5 + i * 0.07, 0.786, -0.44);
      this.group.add(lbl);
      this.warnLights.push(ind);
    });
    this.warnLights[2].set('green');

    // Damage point: under the desk lip on the right
    this.damage.group.position.set(0.45, 0.6, -0.75);
  }

  setMarker(m) {
    this.values.marker = m;
    this.space.setMarker('helm-marker', { bearing: m.bearing, pitch: m.pitch, kind: 'marker', distance: 70, color: 0x5ad0ff });
    this.hud.invalidate();
  }

  setThreat(t) {
    this.values.threat = t;
    const m = this.space.setMarker('threat', { bearing: t.bearing, pitch: t.pitch, kind: t.kind, distance: t.kind === 'asteroid' ? 140 : 90 });
    if (t.kind === 'asteroid') m.userData.approach = 130 / t.eta;
    this.warnLights[0].set('amber', true);
    if (t.kind === 'asteroid') this.warnLights[1].set('red', true);
  }

  clearThreat() {
    this.values.threat = null;
    this.space.removeMarker('threat');
    this.warnLights[0].set('off');
    this.warnLights[1].set('off');
  }

  onTaskSuccess(task) {
    if (task.id === 'helm-marker') this.space.removeMarker('helm-marker');
  }

  update(dt) {
    super.update(dt);
    if (!this.locked) {
      this.ship.steer(dt, { pitchYaw: this.leftStick.getAxes(), rollThrust: this.rightStick.getAxes() });
      if (!this.throttle.pressedBy) this.throttle.setValue(this.ship.throttle, true);
    }
    const thrustOk = this.ship.power.THRUSTERS && this.ship.breakers.THRUSTERS && this.ship.breakers.MAIN;
    this.warnLights[2].set(thrustOk ? 'green' : 'red', !thrustOk);
    this.space.setAttitude(SpaceScape.attitudeQuaternion(this.ship.attitude));
    this.space.speed = this.ship.throttle;
    this._hudClock = (this._hudClock ?? 0) + dt;
    if (this._hudClock > 1 / 20) {
      this._hudClock = 0;
      this.hud.invalidate();
    }
  }

  _drawHud(ctx, w, h, p) {
    const a = this.ship.attitude;
    p.header('FLIGHT HUD', this.tintHex());
    const cx = w / 2;
    const cy = h / 2 + 20;

    // Bearing tape
    ctx.strokeStyle = PALETTE.screenDim;
    ctx.lineWidth = 1;
    for (let d = -60; d <= 60; d += 10) {
      const b = ((Math.round(a.bearing / 10) * 10 + d) % 360 + 360) % 360;
      const xx = cx + (((b - a.bearing + 540) % 360) - 180) * 3.2;
      if (xx < 60 || xx > w - 60) continue;
      ctx.beginPath();
      ctx.moveTo(xx, 52);
      ctx.lineTo(xx, b % 30 === 0 ? 66 : 60);
      ctx.stroke();
      if (b % 30 === 0) p.text(String(b).padStart(3, '0'), xx, 68, { size: 13, align: 'center', color: PALETTE.screenDim });
    }
    p.text(String(Math.round(a.bearing)).padStart(3, '0') + '°', cx, 84, { size: 26, align: 'center', color: PALETTE.white, weight: 'bold' });
    ctx.strokeStyle = PALETTE.white;
    ctx.beginPath();
    ctx.moveTo(cx, 48);
    ctx.lineTo(cx, 58);
    ctx.stroke();

    // Attitude indicator with roll
    ctx.save();
    ctx.translate(cx, cy);
    ctx.rotate(THREE.MathUtils.degToRad(-a.roll));
    ctx.strokeStyle = PALETTE.screenDim;
    for (let pd = -30; pd <= 30; pd += 10) {
      const y = (a.pitch - pd) * 3.4;
      if (Math.abs(y) > 90) continue;
      ctx.beginPath();
      ctx.moveTo(-60, y);
      ctx.lineTo(-25, y);
      ctx.moveTo(25, y);
      ctx.lineTo(60, y);
      ctx.stroke();
      if (pd !== 0) {
        p.text(String(pd), -72, y - 7, { size: 12, align: 'right', color: PALETTE.screenDim });
        p.text(String(pd), 72, y - 7, { size: 12, align: 'left', color: PALETTE.screenDim });
      }
    }
    ctx.restore();

    // Fixed reticle (nose)
    ctx.strokeStyle = PALETTE.green;
    ctx.lineWidth = 2;
    ctx.beginPath();
    ctx.moveTo(cx - 40, cy);
    ctx.lineTo(cx - 12, cy);
    ctx.moveTo(cx + 12, cy);
    ctx.lineTo(cx + 40, cy);
    ctx.moveTo(cx, cy - 12);
    ctx.lineTo(cx, cy + 12);
    ctx.stroke();
    ctx.beginPath();
    ctx.arc(cx, cy, 20, 0, Math.PI * 2);
    ctx.stroke();

    // Marker / threat symbols projected by angular error
    const drawSym = (target, color, label, shape) => {
      let db = ((target.bearing - a.bearing + 540) % 360) - 180;
      let dp = target.pitch - a.pitch;
      const x = cx + THREE.MathUtils.clamp(db, -50, 50) * 3.2;
      const y = cy - THREE.MathUtils.clamp(dp, -28, 28) * 3.4;
      ctx.strokeStyle = color;
      ctx.lineWidth = 2;
      ctx.beginPath();
      if (shape === 'diamond') {
        ctx.moveTo(x, y - 16);
        ctx.lineTo(x + 16, y);
        ctx.lineTo(x, y + 16);
        ctx.lineTo(x - 16, y);
        ctx.closePath();
      } else {
        ctx.rect(x - 16, y - 16, 32, 32);
      }
      ctx.stroke();
      const inArc = headingError(a.bearing, target.bearing) <= 5 && Math.abs(dp) <= 5;
      p.text(label, x, y + 20, { size: 13, align: 'center', color });
      if (inArc) p.text('ALIGNED', x, y - 34, { size: 13, align: 'center', color: PALETTE.green, weight: 'bold' });
      if (Math.abs(db) > 50 || Math.abs(dp) > 28) p.text(`${db > 0 ? '→' : '←'} ${Math.abs(Math.round(db))}° ${dp > 0 ? '↑' : '↓'} ${Math.abs(Math.round(dp))}°`, x, y + 36, { size: 12, align: 'center', color });
    };
    if (this.values.marker) drawSym(this.values.marker, PALETTE.screenFg, `${this.values.marker.label}  X:${String(this.values.marker.bearing).padStart(3, '0')} Y:${String(this.values.marker.pitch).padStart(3, '0')}`, 'diamond');
    if (this.values.threat) drawSym(this.values.threat, PALETTE.red, this.values.threat.kind.toUpperCase() + (this.values.threat.lock ? ' · LOCKED ON US' : ''), 'box');

    // Readouts
    p.text(`PITCH ${a.pitch.toFixed(0).padStart(3)}°`, 14, h - 62, { size: 16, color: PALETTE.white });
    p.text(`ROLL  ${a.roll.toFixed(0).padStart(3)}°`, 14, h - 42, { size: 16, color: PALETTE.white });
    p.text(`YAW   ${a.bearing.toFixed(0).padStart(3)}°`, 14, h - 22, { size: 16, color: PALETTE.white });
    p.bar(w - 170, h - 40, 150, 18, this.ship.throttle, { color: this.tintHex(), label: `THR ${(this.ship.throttle * 100).toFixed(0)}%` });
    const thrustOk = this.ship.power.THRUSTERS && this.ship.breakers.THRUSTERS && this.ship.breakers.MAIN;
    p.text(thrustOk ? 'THRUSTERS NOMINAL' : 'THRUSTERS UNPOWERED', w - 20, h - 62, { size: 14, align: 'right', color: thrustOk ? PALETTE.green : PALETTE.red });
  }
}

function labelPlate(text) {
  const c = document.createElement('canvas');
  c.width = 128;
  c.height = 32;
  const ctx = c.getContext('2d');
  ctx.fillStyle = '#dfe9f3';
  ctx.font = 'bold 20px Consolas, monospace';
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  ctx.fillText(text, 64, 16);
  const tex = new THREE.CanvasTexture(c);
  tex.colorSpace = THREE.SRGBColorSpace;
  const m = new THREE.Mesh(new THREE.PlaneGeometry(0.056, 0.014), new THREE.MeshBasicMaterial({ map: tex, transparent: true, depthWrite: false }));
  m.rotation.x = -Math.PI / 2;
  m.userData.hittable = false;
  return m;
}
