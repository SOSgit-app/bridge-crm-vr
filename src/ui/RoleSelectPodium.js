import * as THREE from 'three';
import { ROLE_ORDER, ROLE_META, PALETTE } from '../core/Constants.js';
import { PushButton } from '../controls/PushButton.js';
import { ScreenPanel } from '../controls/ScreenPanel.js';
import { MAT } from '../controls/Materials.js';
import { makeLabel } from '../controls/Label.js';

export const PODIUM_SEAT = { position: new THREE.Vector3(0, 0, 0.9), yaw: 0, seated: false, pitch: -0.55 };

/**
 * A physical briefing podium at the bridge centre. Five role plates
 * (pre-assigned in the room), a recenter control and a briefing display.
 */
export class RoleSelectPodium {
  constructor({ interaction, onSelect, onRecenter }) {
    this.interaction = interaction;
    this.group = new THREE.Group();
    this.group.name = 'RoleSelectPodium';
    this.group.position.set(0, 0, 0.25);
    this.controls = [];

    const stem = new THREE.Mesh(new THREE.CylinderGeometry(0.08, 0.14, 0.9, 24), MAT.trim.clone());
    stem.material.vertexColors = false;
    stem.position.y = 0.45;
    this.group.add(stem);
    const top = new THREE.Mesh(new THREE.BoxGeometry(1.5, 0.05, 0.42), MAT.panel.clone());
    top.material.vertexColors = false;
    top.position.set(0, 0.95, 0);
    top.rotation.x = 0.35;
    this.group.add(top);

    // Plates lie on the tilted top: tilt first, then rotate so +z points out of the surface.
    const face = new THREE.Group();
    face.position.set(0, 0.975, 0);
    face.rotation.x = 0.35;
    this.group.add(face);
    const plateMount = new THREE.Group();
    plateMount.rotation.x = -Math.PI / 2;
    face.add(plateMount);

    this.title = new ScreenPanel({ width: 0.6, height: 0.22, px: 640, name: 'podium-title', tint: PALETTE.screenFg });
    this.title.setDraw((ctx, w, h, p) => {
      p.header('BRIDGE // CREW RESOURCE MANAGEMENT', PALETTE.screenFg);
      p.text('SELECT YOUR ASSIGNED ROLE', w / 2, 60, { size: 30, align: 'center', color: PALETTE.white, weight: 'bold' });
      p.text('Roles were assigned in the room before headsets went on.', w / 2, 104, { size: 15, align: 'center', color: PALETTE.screenDim });
      p.text('Pick yours. The Captain runs the ENGAGE countdown aloud.', w / 2, 126, { size: 15, align: 'center', color: PALETTE.screenDim });
      p.text('100% OFFLINE · NO NETWORK · VERBAL SYNC', w / 2, h - 34, { size: 13, align: 'center', color: PALETTE.amber });
    });
    this.title.group.position.set(0, 1.42, -0.25);
    this.title.group.rotation.x = -0.15;
    this.group.add(this.title.group);
    const post = new THREE.Mesh(new THREE.BoxGeometry(0.04, 0.4, 0.04), MAT.brushed);
    post.position.set(0, 1.15, -0.25);
    this.group.add(post);

    ROLE_ORDER.forEach((role, i) => {
      const meta = ROLE_META[role];
      const b = new PushButton({
        width: 0.25, height: 0.11, depth: 0.025, color: 0x1b2230, glow: meta.color, label: '', name: `role-${role}`,
        onPress: () => onSelect(role),
      });
      const x = (i - 2) * 0.28;
      b.root.position.set(x, 0.0, 0.03);
      plateMount.add(b.root);
      const l1 = makeLabel(meta.label, { size: 0.03, color: '#ffffff', width: 0.22 });
      l1.position.set(0, 0.012, 0.0135);
      b.cap.add(l1);
      const l2 = makeLabel(meta.sub, { size: 0.013, color: '#bcd3e6', width: 0.22 });
      l2.position.set(0, -0.028, 0.0135);
      b.cap.add(l2);
      const stripe = new THREE.Mesh(new THREE.BoxGeometry(0.25, 0.006, 0.004), new THREE.MeshStandardMaterial({ color: 0x000000, emissive: meta.color, emissiveIntensity: 2 }));
      stripe.position.set(0, 0.05, 0.013);
      stripe.userData.hittable = false;
      b.cap.add(stripe);
      interaction.add(b);
      this.controls.push(b);
    });

    const recenter = new PushButton({
      width: 0.16, height: 0.05, depth: 0.02, color: 0x203040, glow: 0x8fd3ff, label: 'RECENTER VIEW', labelSize: 0.011, name: 'podium-recenter',
      onPress: () => onRecenter(),
    });
    recenter.root.position.set(0, -0.12, 0.03);
    plateMount.add(recenter.root);
    interaction.add(recenter);
    this.controls.push(recenter);

    this.light = new THREE.PointLight(0x8fd3ff, 0.7, 2.5, 2);
    this.light.position.set(0, 1.6, 0.5);
    this.group.add(this.light);
  }

  update() {
    this.title.render();
  }

  dispose() {
    for (const c of this.controls) this.interaction.remove(c);
    this.group.parent?.remove(this.group);
  }
}
