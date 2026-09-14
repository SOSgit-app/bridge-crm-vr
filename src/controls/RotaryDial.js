import * as THREE from 'three';
import { Interactable } from '../core/Interaction.js';
import { MAT } from './Materials.js';
import { makeLabel } from './Label.js';
import { ScreenPanel } from './ScreenPanel.js';
import { sfx } from '../core/Audio.js';

/**
 * A knurled rotary knob. The operator grabs it and moves the pointer in a
 * circle around the knob axis; the angular delta of the projected pointer
 * turns the knob. Multi-turn: `perTurn` units per revolution, clamped to
 * [min,max]. Detents provide click feedback at `step` intervals.
 */
export class RotaryDial extends Interactable {
  constructor({
    radius = 0.03, height = 0.025, min = 0, max = 100, value = 0, perTurn = 100, step = 1, unit = '', label = '',
    decimals = 0, onChange = null, readout = true, color = 0x2a3140, glow = 0x8fd3ff, name = 'dial',
  } = {}) {
    const group = new THREE.Group();
    group.name = name;
    super(group);
    this.min = min;
    this.max = max;
    this.perTurn = perTurn;
    this.step = step;
    this.unit = unit;
    this.decimals = decimals;
    this.onChange = onChange;
    this.value = value;
    this.radius = radius;
    this._plane = new THREE.Plane();
    this._lastAngle = null;
    this._tmp = new THREE.Vector3();
    this._center = new THREE.Vector3();
    this._normal = new THREE.Vector3();
    this._lastDetent = Math.round(value / step);

    const base = new THREE.Mesh(new THREE.CylinderGeometry(radius * 1.25, radius * 1.3, 0.006, 32), MAT.brushed);
    base.rotation.x = Math.PI / 2;
    base.userData.hittable = false;
    group.add(base);

    // Tick ring
    const ticks = new THREE.Group();
    for (let i = 0; i < 24; i++) {
      const t = new THREE.Mesh(new THREE.BoxGeometry(0.002, i % 6 === 0 ? 0.008 : 0.004, 0.001), MAT.brushed);
      const a = (i / 24) * Math.PI * 2;
      t.position.set(Math.cos(a) * radius * 1.42, Math.sin(a) * radius * 1.42, 0.0035);
      t.rotation.z = a + Math.PI / 2;
      t.userData.hittable = false;
      ticks.add(t);
    }
    group.add(ticks);

    this.knobMat = new THREE.MeshStandardMaterial({ color, roughness: 0.45, metalness: 0.75, emissive: glow, emissiveIntensity: 0 });
    this.knob = new THREE.Group();
    const body = new THREE.Mesh(new THREE.CylinderGeometry(radius, radius * 1.05, height, 32), this.knobMat);
    body.rotation.x = Math.PI / 2;
    body.position.z = height / 2;
    this.knob.add(body);
    // knurling
    for (let i = 0; i < 16; i++) {
      const k = new THREE.Mesh(new THREE.BoxGeometry(0.004, height * 0.8, 0.004), MAT.rubber);
      const a = (i / 16) * Math.PI * 2;
      k.position.set(Math.cos(a) * radius, Math.sin(a) * radius, height / 2);
      k.rotation.z = a;
      k.rotation.x = Math.PI / 2;
      k.userData.hittable = false;
      this.knob.add(k);
    }
    const pointer = new THREE.Mesh(
      new THREE.BoxGeometry(0.004, radius * 0.7, 0.003),
      new THREE.MeshStandardMaterial({ color: 0xffffff, emissive: glow, emissiveIntensity: 1.2 })
    );
    pointer.position.set(0, radius * 0.55, height + 0.001);
    pointer.userData.hittable = false;
    this.knob.add(pointer);
    group.add(this.knob);

    if (label) {
      const lbl = makeLabel(label, { size: 0.011, width: radius * 3.2 });
      lbl.position.set(0, -radius * 1.75, 0.003);
      group.add(lbl);
    }
    if (readout) {
      this.readout = new ScreenPanel({ width: radius * 2.6, height: radius * 1.0, px: 256, bezel: 0.004, depth: 0.012, name: `${name}-readout` });
      this.readout.group.position.set(0, radius * 2.15, 0.006);
      this.readout.setDraw((ctx, w, h, p) => {
        p.text(this.format(), w / 2, h * 0.18, { size: h * 0.62, align: 'center', weight: 'bold' });
      });
      group.add(this.readout.group);
    }
    this._applyRotation();
  }

  format() {
    return `${this.value.toFixed(this.decimals)}${this.unit ? ' ' + this.unit : ''}`;
  }

  setValue(v, silent = false) {
    const clamped = THREE.MathUtils.clamp(v, this.min, this.max);
    const snapped = Math.round(clamped / this.step) * this.step;
    if (snapped === this.value) return;
    this.value = snapped;
    this._applyRotation();
    this.readout?.invalidate();
    if (!silent) this.onChange?.(this.value, this);
  }

  _applyRotation() {
    this.knob.rotation.z = -((this.value / this.perTurn) * Math.PI * 2);
  }

  onHoverStart() {
    this.knobMat.emissiveIntensity = 0.3;
  }
  onHoverEnd() {
    if (!this.pressedBy) this.knobMat.emissiveIntensity = 0;
  }

  _projectAngle(pointer) {
    this.root.getWorldPosition(this._center);
    this._normal.set(0, 0, 1).applyQuaternion(this.root.getWorldQuaternion(new THREE.Quaternion()));
    this._plane.setFromNormalAndCoplanarPoint(this._normal, this._center);
    const ray = new THREE.Ray(pointer.origin, pointer.direction);
    // For hands, use the fingertip position directly (physical twist) if the ray misses.
    let hit = ray.intersectPlane(this._plane, this._tmp);
    if (!hit) {
      if (!pointer.hasTip) return null;
      hit = this._plane.projectPoint(pointer.tip, this._tmp);
    }
    const local = this.root.worldToLocal(hit.clone());
    return Math.atan2(local.y, local.x);
  }

  onPressStart(pointer) {
    this._lastAngle = this._projectAngle(pointer);
    this.knobMat.emissiveIntensity = 0.6;
  }

  onDrag(pointer) {
    const a = this._projectAngle(pointer);
    if (a === null || this._lastAngle === null) return;
    let d = a - this._lastAngle;
    if (d > Math.PI) d -= Math.PI * 2;
    if (d < -Math.PI) d += Math.PI * 2;
    this._lastAngle = a;
    const deltaValue = (-d / (Math.PI * 2)) * this.perTurn;
    // Accumulate un-snapped so slow turns still cross detents.
    this._acc = THREE.MathUtils.clamp((this._acc ?? this.value) + deltaValue, this.min, this.max);
    this.setValue(this._acc);
    const detent = Math.round(this.value / this.step);
    if (detent !== this._lastDetent) {
      this._lastDetent = detent;
      sfx.tick();
      pointer.inputSource?.gamepad?.hapticActuators?.[0]?.pulse?.(0.2, 8);
    }
  }

  onPressEnd() {
    this._acc = this.value;
    this.knobMat.emissiveIntensity = this.hovered ? 0.3 : 0;
  }

  update() {
    this.readout?.render();
  }
}
