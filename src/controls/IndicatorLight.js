import * as THREE from 'three';
import { MAT } from './Materials.js';

const COLORS = {
  off: 0x000000,
  green: 0x4dff88,
  amber: 0xffb347,
  red: 0xff3b4d,
  blue: 0x5ad0ff,
  white: 0xe6f7ff,
};

/**
 * A physical indicator lens with an optional real point light so the
 * indicator visibly lights the operator's hands and the console around it.
 */
export class IndicatorLight {
  constructor({ radius = 0.012, light = false, lightRange = 0.6, lightIntensity = 0.8, state = 'off', label } = {}) {
    this.group = new THREE.Group();
    this.group.name = 'indicator';
    this.state = state;
    this.strobe = false;
    this._t = 0;
    this._lightIntensity = lightIntensity;

    const housing = new THREE.Mesh(new THREE.CylinderGeometry(radius * 1.35, radius * 1.35, 0.01, 16), MAT.brushed);
    housing.rotation.x = Math.PI / 2;
    housing.userData.hittable = false;
    this.group.add(housing);

    this.lens = new THREE.Mesh(
      new THREE.SphereGeometry(radius, 16, 12, 0, Math.PI * 2, 0, Math.PI / 2),
      new THREE.MeshStandardMaterial({ color: 0x111111, emissive: 0x000000, emissiveIntensity: 2, roughness: 0.2 })
    );
    this.lens.rotation.x = Math.PI / 2;
    this.lens.position.z = 0.004;
    this.lens.userData.hittable = false;
    this.group.add(this.lens);

    if (light) {
      this.light = new THREE.PointLight(0xffffff, 0, lightRange, 2);
      this.light.position.z = 0.05;
      this.group.add(this.light);
    }
    if (label) this.group.userData.label = label;
    this.set(state);
  }

  set(state, strobe = false) {
    this.state = state;
    this.strobe = strobe;
    const c = COLORS[state] ?? COLORS.off;
    this.lens.material.emissive.setHex(c);
    this.lens.material.color.setHex(state === 'off' ? 0x111111 : c).multiplyScalar(0.3);
    if (this.light) {
      this.light.color.setHex(c || 0x000000);
      this.light.intensity = state === 'off' ? 0 : this._lightIntensity;
    }
  }

  update(dt) {
    if (!this.strobe) return;
    this._t += dt;
    const on = Math.sin(this._t * 10) > 0;
    this.lens.material.emissiveIntensity = on ? 2.4 : 0.15;
    if (this.light) this.light.intensity = on ? this._lightIntensity * 1.6 : 0;
  }
}
