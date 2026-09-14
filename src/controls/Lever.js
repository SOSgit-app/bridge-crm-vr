import * as THREE from 'three';
import { Interactable } from '../core/Interaction.js';
import { MAT } from './Materials.js';
import { makeLabel } from './Label.js';
import { sfx } from '../core/Audio.js';

/**
 * A pivoting lever / handle. The lever swings about its local X axis; the
 * operator grabs the handle and drags it through an arc. Modes:
 *  - 'throttle' analog 0..1, stays where it is left
 *  - 'latch'    snaps to 0 or 1 at release, fires onPull when it reaches 1
 *  - 'spring'   returns to 0 on release, fires onPull when it hits 1
 */
export class Lever extends Interactable {
  constructor({
    length = 0.16, mode = 'latch', minAngle = -0.5, maxAngle = 0.5, value = 0, label = '', color = 0xc7362f,
    onPull = null, onChange = null, onRelease = null, name = 'lever', handleRadius = 0.018, grip = 'ball',
  } = {}) {
    const group = new THREE.Group();
    group.name = name;
    super(group);
    this.mode = mode;
    this.minAngle = minAngle;
    this.maxAngle = maxAngle;
    this.value = value;
    this.onPull = onPull;
    this.onChange = onChange;
    this.onRelease = onRelease;
    this.length = length;
    this._fired = false;
    this._plane = new THREE.Plane();
    this._tmp = new THREE.Vector3();

    const slotMat = MAT.hullDark.clone();
    slotMat.vertexColors = false;
    const slot = new THREE.Mesh(new THREE.BoxGeometry(0.03, 0.012, length * 1.25), slotMat);
    slot.position.set(0, 0.002, 0);
    slot.userData.hittable = false;
    group.add(slot);

    const pivotHousing = new THREE.Mesh(new THREE.CylinderGeometry(0.02, 0.02, 0.05, 20), MAT.brushed);
    pivotHousing.rotation.z = Math.PI / 2;
    pivotHousing.userData.hittable = false;
    group.add(pivotHousing);

    this.arm = new THREE.Group();
    const shaft = new THREE.Mesh(new THREE.CylinderGeometry(0.007, 0.009, length, 12), MAT.brushed);
    shaft.position.y = length / 2;
    shaft.userData.hittable = false;
    this.arm.add(shaft);

    this.handleMat = new THREE.MeshStandardMaterial({ color, roughness: 0.5, metalness: 0.3, emissive: color, emissiveIntensity: 0 });
    const handle =
      grip === 'ball'
        ? new THREE.Mesh(new THREE.SphereGeometry(handleRadius, 20, 16), this.handleMat)
        : new THREE.Mesh(new THREE.BoxGeometry(handleRadius * 2.6, handleRadius * 1.4, handleRadius * 2), this.handleMat);
    handle.position.y = length;
    this.arm.add(handle);
    this.handle = handle;
    group.add(this.arm);

    if (label) {
      const lbl = makeLabel(label, { size: 0.011, width: 0.12 });
      lbl.position.set(0, 0.004, length * 0.7);
      lbl.rotation.x = -Math.PI / 2;
      group.add(lbl);
    }
    this._apply();
  }

  _apply() {
    this.arm.rotation.x = THREE.MathUtils.lerp(this.minAngle, this.maxAngle, this.value);
  }

  setValue(v, silent = false) {
    const nv = THREE.MathUtils.clamp(v, 0, 1);
    if (nv === this.value) return;
    this.value = nv;
    this._apply();
    if (!silent) this.onChange?.(this.value, this);
    if (this.mode !== 'throttle') {
      if (this.value > 0.92 && !this._fired) {
        this._fired = true;
        sfx.click();
        this.onPull?.(this);
      } else if (this.value < 0.4) this._fired = false;
    }
  }

  onHoverStart() {
    this.handleMat.emissiveIntensity = 0.3;
  }
  onHoverEnd() {
    if (!this.pressedBy) this.handleMat.emissiveIntensity = 0;
  }

  _angleFromPointer(pointer) {
    const pivot = this.root.getWorldPosition(new THREE.Vector3());
    const q = this.root.getWorldQuaternion(new THREE.Quaternion());
    const normal = new THREE.Vector3(1, 0, 0).applyQuaternion(q);
    this._plane.setFromNormalAndCoplanarPoint(normal, pivot);
    const ray = new THREE.Ray(pointer.origin, pointer.direction);
    let hit = ray.intersectPlane(this._plane, this._tmp);
    if (!hit && pointer.hasTip) hit = this._plane.projectPoint(pointer.tip, this._tmp);
    if (!hit) return null;
    const local = this.root.worldToLocal(hit.clone());
    // arm points +Y at angle 0, rotating about +X: y = cos(a), z = -sin(a)
    return Math.atan2(-local.z, local.y);
  }

  onPressStart(pointer) {
    this.handleMat.emissiveIntensity = 0.7;
    const a = this._angleFromPointer(pointer);
    this._grabOffset = a === null ? 0 : a - this.arm.rotation.x;
  }

  onDrag(pointer) {
    const a = this._angleFromPointer(pointer);
    if (a === null) return;
    const target = a - this._grabOffset;
    const v = (target - this.minAngle) / (this.maxAngle - this.minAngle);
    this.setValue(v);
  }

  onPressEnd() {
    this.handleMat.emissiveIntensity = this.hovered ? 0.3 : 0;
    if (this.mode === 'latch') this.setValue(this.value > 0.5 ? 1 : 0);
    if (this.mode === 'spring') this.setValue(0);
    this.onRelease?.(this.value, this);
  }
}
