import * as THREE from 'three';
import { Interactable } from '../core/Interaction.js';
import { makeLabel } from './Label.js';
import { sfx } from '../core/Audio.js';

/**
 * A holographic hex node that rises out of the Holo-Table. Tapping it makes
 * a decision. Nodes are spatial, pokeable and emit light onto the table.
 */
export class HoloNode extends Interactable {
  constructor({ id, label, sub = '', color = 0xffc85a, radius = 0.075, onSelect = null, name = 'holo-node' } = {}) {
    const group = new THREE.Group();
    group.name = `${name}-${id}`;
    super(group);
    this.pokeable = true;
    this.id = id;
    this.onSelect = onSelect;
    this.color = new THREE.Color(color);
    this.selected = false;
    this.rise = 0; // 0 hidden → 1 fully risen
    this.targetRise = 0;
    this.baseY = 0;
    this._t = Math.random() * 10;

    this.mat = new THREE.MeshStandardMaterial({
      color: 0x000000, emissive: this.color, emissiveIntensity: 0.9, transparent: true, opacity: 0.55, roughness: 0.2, metalness: 0.0, side: THREE.DoubleSide,
    });
    this.prism = new THREE.Mesh(new THREE.CylinderGeometry(radius, radius * 0.9, 0.06, 6), this.mat);
    this.prism.position.y = 0.03;
    group.add(this.prism);
    const edge = new THREE.Mesh(new THREE.TorusGeometry(radius * 1.02, 0.003, 6, 6), new THREE.MeshBasicMaterial({ color: this.color }));
    edge.rotation.x = Math.PI / 2;
    edge.rotation.z = Math.PI / 6;
    edge.position.y = 0.061;
    edge.userData.hittable = false;
    group.add(edge);
    this.edge = edge;

    const lbl = makeLabel(label, { size: 0.02, color: '#ffffff', width: radius * 1.8 });
    lbl.rotation.x = -Math.PI / 2;
    lbl.position.y = 0.062;
    group.add(lbl);
    this.label = lbl;
    if (sub) {
      const s = makeLabel(sub, { size: 0.011, color: '#ffe9c0', width: radius * 1.8 });
      s.rotation.x = -Math.PI / 2;
      s.position.set(0, 0.062, 0.03);
      group.add(s);
    }
    this.light = new THREE.PointLight(this.color, 0, 0.45, 2);
    this.light.position.y = 0.08;
    group.add(this.light);
    group.scale.setScalar(0.001);
    group.visible = false;
  }

  show(v = true) {
    this.targetRise = v ? 1 : 0;
    if (v) this.root.visible = true;
  }

  setSelected(v) {
    this.selected = v;
    this.mat.emissiveIntensity = v ? 2.2 : 0.9;
    this.mat.opacity = v ? 0.9 : 0.55;
  }

  onHoverStart() {
    if (!this.selected) this.mat.emissiveIntensity = 1.6;
  }
  onHoverEnd() {
    if (!this.selected) this.mat.emissiveIntensity = 0.9;
  }
  onPressStart() {
    sfx.confirm();
    this.onSelect?.(this);
  }

  update(dt) {
    this._t += dt;
    this.rise += (this.targetRise - this.rise) * Math.min(1, dt * 6);
    if (this.rise < 0.01 && this.targetRise === 0) {
      this.root.visible = false;
      this.enabled = false;
      return;
    }
    this.enabled = this.rise > 0.6;
    const s = Math.max(0.001, this.rise);
    this.root.scale.set(s, s, s);
    this.root.position.y = this.baseY + (1 - this.rise) * -0.04 + Math.sin(this._t * 2) * 0.003;
    this.light.intensity = this.rise * (this.selected ? 1.2 : 0.5);
    this.edge.rotation.y = this._t * 0.6;
  }
}
