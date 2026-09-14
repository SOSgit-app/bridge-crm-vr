import * as THREE from 'three';
import { Interactable } from '../core/Interaction.js';
import { MAT } from './Materials.js';
import { makeLabel } from './Label.js';

/**
 * A two-axis flight stick on a gimbal. The operator grabs the grip; the
 * pointer's projection onto the horizontal grip plane, relative to the base,
 * becomes the deflection. Springs back to centre on release.
 */
export class Joystick extends Interactable {
  constructor({ height = 0.14, maxTilt = 0.45, spring = true, label = '', deadzone = 0.12, name = 'joystick', color = 0x1d232d, response = 1.55 } = {}) {
    const group = new THREE.Group();
    group.name = name;
    super(group);
    this.axes = new THREE.Vector2(0, 0);
    this.height = height;
    this.maxTilt = maxTilt;
    this.spring = spring;
    this.deadzone = deadzone;
    this.response = response;
    this._plane = new THREE.Plane();
    this._tmp = new THREE.Vector3();
    this._grabOffset = new THREE.Vector2();
    this._smoothed = new THREE.Vector2(0, 0);

    const base = new THREE.Mesh(new THREE.CylinderGeometry(0.055, 0.065, 0.02, 32), MAT.brushed);
    base.position.y = 0.01;
    base.userData.hittable = false;
    group.add(base);
    const boot = new THREE.Mesh(new THREE.SphereGeometry(0.035, 24, 16, 0, Math.PI * 2, 0, Math.PI / 2), MAT.rubber);
    boot.position.y = 0.02;
    boot.userData.hittable = false;
    group.add(boot);

    this.gimbal = new THREE.Group();
    this.gimbal.position.y = 0.02;
    const shaft = new THREE.Mesh(new THREE.CylinderGeometry(0.011, 0.014, height, 16), MAT.brushed);
    shaft.position.y = height / 2;
    shaft.userData.hittable = false;
    this.gimbal.add(shaft);

    this.gripMat = new THREE.MeshStandardMaterial({ color, roughness: 0.6, metalness: 0.25, emissive: 0x5ad0ff, emissiveIntensity: 0 });
    const grip = new THREE.Mesh(new THREE.CapsuleGeometry(0.022, 0.07, 6, 16), this.gripMat);
    grip.position.y = height + 0.03;
    this.gimbal.add(grip);
    const trigger = new THREE.Mesh(new THREE.BoxGeometry(0.012, 0.025, 0.012), MAT.rubber);
    trigger.position.set(0, height + 0.02, -0.028);
    trigger.userData.hittable = false;
    this.gimbal.add(trigger);
    const hat = new THREE.Mesh(new THREE.CylinderGeometry(0.006, 0.006, 0.005, 12), new THREE.MeshStandardMaterial({ color: 0xff5a6a, emissive: 0xff5a6a, emissiveIntensity: 0.8 }));
    hat.position.set(0.012, height + 0.062, 0.006);
    hat.userData.hittable = false;
    this.gimbal.add(hat);
    group.add(this.gimbal);

    if (label) {
      const lbl = makeLabel(label, { size: 0.011, width: 0.12 });
      lbl.position.set(0, 0.021, 0.075);
      lbl.rotation.x = -Math.PI / 2;
      group.add(lbl);
    }
  }

  _project(pointer) {
    const q = this.root.getWorldQuaternion(new THREE.Quaternion());
    const up = new THREE.Vector3(0, 1, 0).applyQuaternion(q);
    const gripWorld = this.root.localToWorld(new THREE.Vector3(0, this.height + 0.04, 0));
    this._plane.setFromNormalAndCoplanarPoint(up, gripWorld);
    const ray = new THREE.Ray(pointer.origin, pointer.direction);
    let hit = ray.intersectPlane(this._plane, this._tmp);
    if (!hit && pointer.hasTip) hit = this._plane.projectPoint(pointer.tip, this._tmp);
    if (!hit) return null;
    const local = this.root.worldToLocal(hit.clone());
    // Push grip toward console (-Z) → negative Y (nose-down / forward).
    // Drag right (+X) → positive X. Keep the same sign as the hand so the
    // stick visually follows the pointer instead of opposing it.
    return new THREE.Vector2(local.x / 0.11, local.z / 0.11);
  }

  onHoverStart() {
    this.gripMat.emissiveIntensity = 0.25;
  }
  onHoverEnd() {
    if (!this.pressedBy) this.gripMat.emissiveIntensity = 0;
  }

  onPressStart(pointer) {
    this.gripMat.emissiveIntensity = 0.5;
    const p = this._project(pointer);
    this._grabOffset.copy(p ? p.sub(this.axes) : new THREE.Vector2());
  }

  onDrag(pointer) {
    const p = this._project(pointer);
    if (!p) return;
    p.sub(this._grabOffset);
    if (p.length() > 1) p.normalize();
    this.axes.copy(p);
  }

  onPressEnd() {
    this.gripMat.emissiveIntensity = this.hovered ? 0.25 : 0;
  }

  /** Axes with deadzone + soft response curve applied. */
  getAxes() {
    const v = this._smoothed.clone();
    const len = v.length();
    if (len < this.deadzone) return v.set(0, 0);
    const t = THREE.MathUtils.clamp((len - this.deadzone) / (1 - this.deadzone), 0, 1);
    const shaped = Math.pow(t, this.response);
    return v.multiplyScalar(shaped / len);
  }

  update(dt) {
    if (!this.pressedBy && this.spring) {
      this.axes.lerp(new THREE.Vector2(0, 0), Math.min(1, dt * 6));
    }
    // Low-pass the stick so tiny hand jitter doesn't flick the ship.
    this._smoothed.lerp(this.axes, Math.min(1, dt * 8));
    // Visual follows hand: negative Y (push forward) → negative rotation.x → tip toward -Z.
    this.gimbal.rotation.x = this._smoothed.y * this.maxTilt;
    this.gimbal.rotation.z = -this._smoothed.x * this.maxTilt;
  }
}
