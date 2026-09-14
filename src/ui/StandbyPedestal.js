import * as THREE from 'three';
import { ROLE_META, PALETTE } from '../core/Constants.js';
import { PushButton } from '../controls/PushButton.js';
import { ScreenPanel } from '../controls/ScreenPanel.js';
import { IndicatorLight } from '../controls/IndicatorLight.js';
import { MAT } from '../controls/Materials.js';

/**
 * Calibration pedestal that rises between the operator and their console:
 * RECENTER SEATED VIEW + STATION READY. It drops away for pre-flight and the
 * mission (ENGAGE lives on each console), then rises again with the result.
 */
export class StandbyPedestal {
  constructor({ role, interaction, seated, onRecenter, onReady }) {
    this.role = role;
    this.meta = ROLE_META[role];
    this.interaction = interaction;
    this.controls = [];
    this.phase = 'CALIBRATE';
    this.group = new THREE.Group();
    this.group.name = 'StandbyPedestal';
    const topY = seated ? 0.82 : 1.05;
    this.topY = topY;
    this.restY = 0;
    this.group.position.set(0, this.restY, -0.42);
    this.rise = 0;
    this.targetRise = 1;
    this._t = 0;

    const stem = new THREE.Mesh(new THREE.CylinderGeometry(0.05, 0.09, topY, 20), MAT.trim.clone());
    stem.material.vertexColors = false;
    stem.position.y = topY / 2;
    this.group.add(stem);
    const top = new THREE.Mesh(new THREE.CylinderGeometry(0.24, 0.26, 0.04, 32), MAT.panel.clone());
    top.material.vertexColors = false;
    top.position.y = topY;
    this.group.add(top);

    const face = new THREE.Group();
    face.position.y = topY + 0.02;
    face.rotation.x = -Math.PI / 2;
    this.group.add(face);

    // High-contrast display standing up at the back of the pedestal
    this.screen = new ScreenPanel({ width: 0.44, height: 0.2, px: 640, name: 'standby-screen', tint: '#ffffff' });
    this.screen.setDraw((ctx, w, h, p) => this._draw(ctx, w, h, p));
    this.screen.group.position.set(0, topY + 0.16, -0.2);
    this.screen.group.rotation.x = -0.2;
    this.group.add(this.screen.group);

    // Calibration controls
    this.recenter = new PushButton({
      width: 0.2, height: 0.06, depth: 0.02, color: 0x203040, glow: 0x8fd3ff, label: seated ? 'RECENTER SEATED VIEW' : 'RECENTER STANDING VIEW', labelSize: 0.011, name: 'recenter',
      onPress: () => onRecenter(),
    });
    this.recenter.root.position.set(0, 0.06, 0);
    face.add(this.recenter.root);
    interaction.add(this.recenter);
    this.controls.push(this.recenter);

    this.ready = new PushButton({
      width: 0.2, height: 0.06, depth: 0.02, color: 0x1f4a35, glow: 0x4dff88, label: 'STATION READY', labelSize: 0.011, name: 'ready',
      onPress: () => onReady(),
    });
    this.ready.root.position.set(0, -0.06, 0);
    face.add(this.ready.root);
    interaction.add(this.ready);
    this.controls.push(this.ready);

    this.readyLight = new IndicatorLight({ radius: 0.016, light: true, lightRange: 0.9, lightIntensity: 1.2 });
    this.readyLight.group.position.set(0.19, 0.0, 0.0);
    face.add(this.readyLight.group);
    this.readyLight.set('amber', true);

    this.light = new THREE.PointLight(0xffffff, 0.8, 2.0, 2);
    this.light.position.set(0, topY + 0.4, 0.2);
    this.group.add(this.light);
    // Start fully retracted below the floor; rise slides it up (no Y-squash).
    this.group.position.y = this.restY - this.topY - 0.2;
    this.group.visible = false;
  }

  setPhase(phase) {
    this.phase = phase;
    const calibrate = phase === 'CALIBRATE';
    this.recenter.root.visible = calibrate;
    this.ready.root.visible = calibrate;
    this.recenter.setEnabled(calibrate);
    this.ready.setEnabled(calibrate);
    this.readyLight.set('amber', true);
    this.light.color.setHex(0xffffff);
    this.screen.invalidate();
  }

  hide() {
    // Controls go dead at once — pedestal then slides under the deck.
    for (const c of this.controls) c.setEnabled(false);
    this.targetRise = 0;
  }

  /** Mission end: rise again with the result banner and a STAND DOWN control. */
  showResult(summary, onStandDown) {
    this.phase = 'RESULT';
    this.summary = summary;
    this.recenter.root.visible = false;
    this.recenter.setEnabled(false);
    this.ready.root.visible = true;
    this.ready.setEnabled(true);
    this.ready.onPress = () => onStandDown();
    this.ready.labelMesh?.parent?.remove(this.ready.labelMesh);
    const lbl = engraved('STAND DOWN', 0.012);
    lbl.position.set(0, -0.045, 0.003);
    this.ready.root.add(lbl);
    this.readyLight.set(summary.success ? 'green' : 'red', !summary.success);
    this.light.color.setHex(summary.success ? 0x4dff88 : 0xff4c5b);
    this.light.intensity = 1.4;
    this.group.visible = true;
    this.targetRise = 1;
    this.screen.invalidate();
  }

  update(dt) {
    this._t += dt;
    this.rise += (this.targetRise - this.rise) * Math.min(1, dt * 5);
    // Slide the whole pedestal up/down; never squash it into the floor.
    const buried = this.topY + 0.2;
    this.group.position.y = this.restY - (1 - this.rise) * buried;
    if (this.targetRise > 0.5 && this.rise > 0.02) this.group.visible = true;
    if (this.targetRise < 0.5 && this.rise < 0.05) this.group.visible = false;
    this.readyLight.update(dt);
    this.screen.render();
  }

  _draw(ctx, w, h, p) {
    if (this.phase === 'RESULT') {
      const s = this.summary;
      const ok = s.success;
      ctx.fillStyle = ok ? '#0b2a18' : '#2a0b10';
      ctx.fillRect(0, 0, w, h);
      p.text(ok ? 'MISSION SUCCESS' : 'MISSION FAILED', w / 2, 14, { size: 44, align: 'center', color: ok ? '#6dff9c' : '#ff4c5b', weight: 'bold' });
      p.text(`${this.meta.label} · GRADE ${s.grade}`, w / 2, 66, { size: 22, align: 'center', color: PALETTE.white, weight: 'bold' });
      p.text(`HULL ${s.hull.toFixed(0)}%   SHIELDS ${s.shields.toFixed(0)}%`, w / 2, 96, { size: 16, align: 'center', color: PALETTE.white });
      const done = s.tasks.filter((t) => t.state === 'success').length;
      p.text(`${done}/${s.tasks.length} station tasks verified`, w / 2, 120, { size: 16, align: 'center', color: PALETTE.white });
      p.text('Stand down from stations · debrief in the room', w / 2, h - 30, { size: 14, align: 'center', color: PALETTE.amber });
      return;
    }
    ctx.fillStyle = '#04101c';
    ctx.fillRect(0, 0, w, h);
    p.header(`STATION: ${this.meta.label}`, '#' + this.meta.color.toString(16).padStart(6, '0'));
    p.text('CALIBRATE VIEW', w / 2, 56, { size: 34, align: 'center', color: PALETTE.white, weight: 'bold' });
    p.text('Sit in your physical station. Look straight at the console.', w / 2, 104, { size: 15, align: 'center', color: PALETTE.screenFg });
    p.text('Tap RECENTER until the console is squarely in front of you,', w / 2, 126, { size: 15, align: 'center', color: PALETTE.screenFg });
    p.text('then STATION READY — pre-flight orders come up on your console.', w / 2, 148, { size: 15, align: 'center', color: PALETTE.screenFg });
  }

  dispose() {
    for (const c of this.controls) this.interaction.remove(c);
    this.group.parent?.remove(this.group);
  }
}

function engraved(text, size) {
  const c = document.createElement('canvas');
  c.width = 512;
  c.height = 128;
  const ctx = c.getContext('2d');
  ctx.fillStyle = '#ffffff';
  ctx.font = 'bold 96px Consolas, monospace';
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  ctx.fillText(text, 256, 68);
  const tex = new THREE.CanvasTexture(c);
  tex.colorSpace = THREE.SRGBColorSpace;
  const m = new THREE.Mesh(new THREE.PlaneGeometry(size * 4, size), new THREE.MeshBasicMaterial({ map: tex, transparent: true, depthWrite: false }));
  m.userData.hittable = false;
  m.renderOrder = 2;
  return m;
}
