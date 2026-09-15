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
 * Helm / Flight Operations. Dual sticks (left: pitch/yaw, right: roll/thrust
 * trim), a throttle lever and a spatial flight HUD.
 *
 * In XR: squeeze grip to arm that hand. While armed you can fly with either
 * the Quest thumbstick OR by tilting the physical controller (relative to the
 * pose at the moment you gripped). Console sticks follow visually. Diegetic
 * grab still works on desktop and when grips are released.
 */
export class HelmStation extends StationBase {
  build() {
    this.values.marker = null;
    this.values.threat = null;
    this._gripArmed = { left: false, right: false };
    // World quat captured when grip arms — tilt is measured from this zero.
    this._poseZero = { left: null, right: null };
    this._tmpQ = new THREE.Quaternion();
    this._tmpInv = new THREE.Quaternion();
    this._tmpE = new THREE.Euler();
    this._padAxes = new THREE.Vector2();
    this._poseAxes = new THREE.Vector2();

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
    const color = m.color ?? (m.label?.startsWith('VECTOR') ? 0xffb347 : 0x5ad0ff);
    this.space.setMarker('helm-marker', { bearing: m.bearing, pitch: m.pitch ?? 0, kind: 'marker', distance: m.distance ?? 70, color });
    this.hud.invalidate();
  }

  clearMarker() {
    this.values.marker = null;
    this.space.removeMarker('helm-marker');
    this.hud.invalidate();
  }

  setThreat(t) {
    this.values.threat = t;
    const m = this.space.setMarker('threat', { bearing: t.bearing, pitch: t.pitch, kind: t.kind, distance: t.kind === 'asteroid' ? 140 : 90 });
    if (t.kind === 'asteroid') m.userData.approach = 130 / t.eta;
    this.warnLights[0].set('amber', true);
    if (t.kind === 'asteroid') this.warnLights[1].set('red', true);
    this.hud.invalidate();
  }

  clearThreat() {
    this.values.threat = null;
    this.space.removeMarker('threat');
    this.warnLights[0].set('off');
    this.warnLights[1].set('off');
    this.hud.invalidate();
  }

  onTaskSuccess(task) {
    const id = task.matched?.id ?? task.id;
    // Pre-flight cal marker, or a vector marker once the nose is on it.
    if (id === 'pre-helm-marker' || id === 'helm-blast' || id === 'helm-evade' || id === 'helm-escape' || id === 'helm-marker') {
      this.clearMarker();
    }
  }

  /**
   * Resolve pitch/yaw and roll/trim from Quest pads + controller tilt
   * (grip-armed) or diegetic sticks. Console meshes always follow the active source.
   */
  _flightAxes() {
    const xr = this.interaction.xr;
    const pads = xr.inXR ? xr.pollFlightPads() : null;
    const pitchYaw = new THREE.Vector2();
    const rollThrust = new THREE.Vector2();

    if (pads) {
      for (const hand of ['left', 'right']) {
        const g = pads[hand].grip;
        if (g && !this._gripArmed[hand]) {
          xr.pulseHand(hand, 0.45, 35);
          // Zero the tilt reference at the pose you're holding when you grip.
          const q = xr.getControllerWorldQuat(hand, this._tmpQ);
          this._poseZero[hand] = q ? q.clone() : null;
        }
        if (!g && this._gripArmed[hand]) {
          xr.pulseHand(hand, 0.2, 20);
          this._poseZero[hand] = null;
        }
        this._gripArmed[hand] = g;
      }

      if (pads.left.grip) {
        shapePad(pads.left, this._padAxes);
        poseFromTilt(xr, 'left', this._poseZero.left, this._tmpQ, this._tmpInv, this._tmpE, this._poseAxes);
        combineFlight(this._padAxes, this._poseAxes, pitchYaw);
        this.leftStick.setAxes(pitchYaw.x, pitchYaw.y, { immediate: true });
        this.leftStick.gripMat.emissiveIntensity = 0.55;
      } else {
        pitchYaw.copy(this.leftStick.getAxes());
        if (!this.leftStick.pressedBy && !this.leftStick.hovered) this.leftStick.gripMat.emissiveIntensity = 0;
      }

      if (pads.right.grip) {
        shapePad(pads.right, this._padAxes);
        poseFromTilt(xr, 'right', this._poseZero.right, this._tmpQ, this._tmpInv, this._tmpE, this._poseAxes);
        combineFlight(this._padAxes, this._poseAxes, rollThrust);
        this.rightStick.setAxes(rollThrust.x, rollThrust.y, { immediate: true });
        this.rightStick.gripMat.emissiveIntensity = 0.55;
      } else {
        rollThrust.copy(this.rightStick.getAxes());
        if (!this.rightStick.pressedBy && !this.rightStick.hovered) this.rightStick.gripMat.emissiveIntensity = 0;
      }
    } else {
      this._gripArmed.left = this._gripArmed.right = false;
      this._poseZero.left = this._poseZero.right = null;
      pitchYaw.copy(this.leftStick.getAxes());
      rollThrust.copy(this.rightStick.getAxes());
    }

    return { pitchYaw, rollThrust, pads };
  }

  update(dt) {
    super.update(dt);
    if (!this.locked) {
      const { pitchYaw, rollThrust } = this._flightAxes();
      this.ship.steer(dt, { pitchYaw, rollThrust });
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

    // Grip-arm status (Quest) or desktop grab hint
    const inXR = this.interaction.xr.inXR;
    if (inXR) {
      const l = this._gripArmed.left;
      const r = this._gripArmed.right;
      p.text(l ? 'L GRIP · TILT / STICK' : 'L GRIP TO ARM', 14, 48, { size: 12, color: l ? PALETTE.green : PALETTE.screenDim, weight: l ? 'bold' : 'normal' });
      p.text(r ? 'R GRIP · TILT / STICK' : 'R GRIP TO ARM', w - 14, 48, { size: 12, align: 'right', color: r ? PALETTE.green : PALETTE.screenDim, weight: r ? 'bold' : 'normal' });
    }

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
    if (this.values.marker) drawSym(this.values.marker, this.values.marker.label?.startsWith('VECTOR') ? PALETTE.amber : PALETTE.screenFg, `${this.values.marker.label}  X:${String(Math.round(this.values.marker.bearing)).padStart(3, '0')} Y:${String(Math.round(this.values.marker.pitch ?? 0)).padStart(3, '0')}`, 'diamond');
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

/** Deadzone + soft curve for Quest thumbsticks (cleaner than hand-grab sticks). */
function shapePad(pad, out = new THREE.Vector2()) {
  const dead = 0.1;
  const response = 1.35;
  out.set(pad.x, pad.y);
  const len = out.length();
  if (len < dead) return out.set(0, 0);
  const t = THREE.MathUtils.clamp((len - dead) / (1 - dead), 0, 1);
  return out.multiplyScalar(Math.pow(t, response) / len);
}

/**
 * Controller tilt relative to the grip-zero pose → stick axes.
 * Tip forward → negative Y (nose down), tip right → positive X — matches the
 * diegetic sticks. ~28° of tilt is full deflection.
 */
const POSE_FULL = THREE.MathUtils.degToRad(28);

function poseFromTilt(xr, hand, zero, tmpQ, tmpInv, tmpE, out) {
  out.set(0, 0);
  if (!zero) return out;
  if (!xr.getControllerWorldQuat(hand, tmpQ)) return out;
  // delta = zero^{-1} * current (tmpQ holds current, then becomes delta)
  tmpInv.copy(zero).invert();
  tmpQ.premultiply(tmpInv);
  tmpE.setFromQuaternion(tmpQ, 'YXZ');
  const x = THREE.MathUtils.clamp(tmpE.y / POSE_FULL, -1, 1);
  const y = THREE.MathUtils.clamp(-tmpE.x / POSE_FULL, -1, 1);
  out.set(x, y);
  const len = out.length();
  if (len < 0.08) return out.set(0, 0);
  if (len > 1) out.multiplyScalar(1 / len);
  return out;
}

/** Per-axis: use whichever input (thumbstick or tilt) is stronger. */
function combineFlight(pad, pose, out) {
  out.x = Math.abs(pad.x) >= Math.abs(pose.x) ? pad.x : pose.x;
  out.y = Math.abs(pad.y) >= Math.abs(pose.y) ? pad.y : pose.y;
  return out;
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
