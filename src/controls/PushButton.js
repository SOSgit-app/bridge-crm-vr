import * as THREE from 'three';
import { Interactable } from '../core/Interaction.js';
import { MAT } from './Materials.js';
import { makeLabel } from './Label.js';
import { sfx } from '../core/Audio.js';

/**
 * A physical momentary (or latching) push button with travel, an emissive cap
 * and an optional engraved label. Pokeable with tracked hands.
 */
export class PushButton extends Interactable {
  constructor({
    width = 0.06, height = 0.03, depth = 0.02, color = 0x2f3a4c, glow = 0x8fd3ff, label = '', labelSize = 0.012,
    latching = false, onPress = null, name = 'button', shape = 'box',
  } = {}) {
    const group = new THREE.Group();
    group.name = name;
    super(group);
    this.pokeable = true;
    this.latching = latching;
    this.latched = false;
    this.onPress = onPress;
    this.glowColor = new THREE.Color(glow);
    this.baseColor = new THREE.Color(color);
    this.travel = depth * 0.45;
    this._anim = 0;
    this.lit = false;

    const bezel =
      shape === 'round'
        ? new THREE.Mesh(new THREE.CylinderGeometry(width * 0.6, width * 0.6, 0.008, 24), MAT.brushed)
        : new THREE.Mesh(new THREE.BoxGeometry(width + 0.008, height + 0.008, 0.008), MAT.brushed);
    if (shape === 'round') bezel.rotation.x = Math.PI / 2;
    bezel.userData.hittable = false;
    group.add(bezel);

    this.capMat = new THREE.MeshStandardMaterial({
      color, roughness: 0.35, metalness: 0.5, emissive: this.glowColor, emissiveIntensity: 0,
    });
    this.cap =
      shape === 'round'
        ? new THREE.Mesh(new THREE.CylinderGeometry(width * 0.5, width * 0.5, depth, 24), this.capMat)
        : new THREE.Mesh(new THREE.BoxGeometry(width, height, depth), this.capMat);
    if (shape === 'round') this.cap.rotation.x = Math.PI / 2;
    this.cap.position.z = depth / 2;
    this.restZ = this.cap.position.z;
    group.add(this.cap);

    if (label) {
      const lbl = makeLabel(label, { size: labelSize, color: '#dfe9f3', width: width * 1.6 });
      lbl.position.set(0, -(height / 2) - labelSize * 0.9, 0.003);
      lbl.userData.hittable = false;
      group.add(lbl);
      this.labelMesh = lbl;
    }
  }

  setLit(v) {
    this.lit = v;
    this.capMat.emissiveIntensity = v ? 1.4 : 0;
  }

  setColor(hex) {
    this.glowColor.setHex(hex);
    this.capMat.emissive.copy(this.glowColor);
  }

  onHoverStart() {
    if (!this.lit) this.capMat.emissiveIntensity = 0.35;
  }

  onHoverEnd() {
    if (!this.lit) this.capMat.emissiveIntensity = 0;
  }

  onPressStart(pointer) {
    this._anim = 1;
    sfx.click();
    if (this.latching) {
      this.latched = !this.latched;
      this.setLit(this.latched);
    }
    this.onPress?.(this, pointer);
  }

  onEnabledChanged(v) {
    this.capMat.color.copy(this.baseColor);
    if (!v) this.capMat.color.multiplyScalar(0.4);
  }

  update(dt) {
    if (this._anim > 0) {
      this._anim = Math.max(0, this._anim - dt * 6);
      const k = Math.sin(this._anim * Math.PI);
      this.cap.position.z = this.restZ - this.travel * k;
    }
  }
}
