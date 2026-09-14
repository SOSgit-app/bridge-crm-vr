import * as THREE from 'three';
import { Interactable } from '../core/Interaction.js';
import { MAT } from './Materials.js';
import { makeLabel } from './Label.js';
import { IndicatorLight } from './IndicatorLight.js';
import { sfx } from '../core/Audio.js';

/**
 * A heavy rocker / breaker switch. Press to toggle; can be "tripped" by the
 * ship model, at which point it flips off, glows red and must be reset.
 */
export class BreakerSwitch extends Interactable {
  constructor({ id, label = '', on = true, onToggle = null, name = 'breaker' } = {}) {
    const group = new THREE.Group();
    group.name = `${name}-${id}`;
    super(group);
    this.pokeable = true;
    this.id = id;
    this.on = on;
    this.tripped = false;
    this.onToggle = onToggle;
    this._anim = 0;

    const housing = new THREE.Mesh(new THREE.BoxGeometry(0.05, 0.1, 0.03), MAT.knob);
    housing.position.z = -0.015;
    housing.userData.hittable = false;
    group.add(housing);

    this.rockerMat = new THREE.MeshStandardMaterial({ color: 0x8a94a3, roughness: 0.35, metalness: 0.9, emissive: 0xff3b4d, emissiveIntensity: 0 });
    this.rocker = new THREE.Mesh(new THREE.BoxGeometry(0.036, 0.07, 0.03), this.rockerMat);
    this.rocker.position.z = 0.012;
    group.add(this.rocker);

    this.indicator = new IndicatorLight({ radius: 0.007, light: true, lightRange: 0.22, lightIntensity: 0.25 });
    this.indicator.group.position.set(0, 0.065, 0);
    group.add(this.indicator.group);

    if (label) {
      const lbl = makeLabel(label, { size: 0.011, width: 0.09 });
      lbl.position.set(0, -0.068, 0.002);
      group.add(lbl);
    }
    this._apply();
  }

  _apply() {
    this.rocker.rotation.x = this.on ? -0.35 : 0.35;
    this.indicator.set(this.tripped ? 'red' : this.on ? 'green' : 'off', this.tripped);
    this.rockerMat.emissiveIntensity = this.tripped ? 0.6 : 0;
  }

  trip() {
    if (this.tripped) return;
    this.tripped = true;
    this.on = false;
    sfx.error();
    this._apply();
    this.onToggle?.(false, this);
  }

  setOn(v, silent = false) {
    this.on = v;
    if (v) this.tripped = false;
    this._apply();
    if (!silent) this.onToggle?.(this.on, this);
  }

  onHoverStart() {
    if (!this.tripped) this.rockerMat.emissiveIntensity = 0.15;
  }
  onHoverEnd() {
    if (!this.tripped) this.rockerMat.emissiveIntensity = 0;
  }

  onPressStart() {
    sfx.click();
    this.setOn(!this.on);
  }

  update(dt) {
    this.indicator.update(dt);
  }
}
