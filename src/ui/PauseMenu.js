import * as THREE from 'three';
import { PushButton } from '../controls/PushButton.js';
import { ScreenPanel } from '../controls/ScreenPanel.js';
import { PALETTE, ROLE_META } from '../core/Constants.js';
import { MAT } from '../controls/Materials.js';
import { sfx } from '../core/Audio.js';

/**
 * In-headset pause panel. Opens on Quest B / Y (or Escape on desktop).
 * Floats in front of the camera so it stays readable while seated.
 */
export class PauseMenu {
  constructor({ interaction, onResume, onMainMenu }) {
    this.interaction = interaction;
    this.onResume = onResume;
    this.onMainMenu = onMainMenu;
    this.open = false;
    this.controls = [];

    this.root = new THREE.Group();
    this.root.name = 'PauseMenu';
    this.root.visible = false;

    const plate = new THREE.Mesh(new THREE.BoxGeometry(0.42, 0.36, 0.02), MAT.panel.clone());
    plate.material.vertexColors = false;
    plate.position.z = -0.01;
    plate.userData.hittable = false;
    this.root.add(plate);

    this.screen = new ScreenPanel({ width: 0.38, height: 0.12, px: 640, name: 'pause-screen', tint: PALETTE.amber });
    this.screen.setDraw((ctx, w, h, p) => this._draw(ctx, w, h, p));
    this.screen.group.position.set(0, 0.1, 0.012);
    this.root.add(this.screen.group);

    this.resume = this._button({
      label: 'RESUME',
      y: -0.02,
      color: 0x1f4a35,
      glow: 0x4dff88,
      onPress: () => {
        sfx.confirm();
        this.onResume?.();
      },
    });
    this.mainMenu = this._button({
      label: 'MAIN MENU · CHANGE ROLE',
      y: -0.1,
      color: 0x3a3320,
      glow: 0xffb347,
      width: 0.34,
      onPress: () => {
        sfx.tick();
        this.onMainMenu?.();
      },
    });

    this.light = new THREE.PointLight(0xffb347, 0.9, 1.2, 2);
    this.light.position.set(0, 0.05, 0.15);
    this.root.add(this.light);

    this.role = null;
    this.phaseLabel = '';
  }

  _button({ label, y, color, glow, onPress, width = 0.28 }) {
    const b = new PushButton({
      width, height: 0.055, depth: 0.018, color, glow, label, labelSize: 0.012, name: `pause-${label}`,
      onPress,
    });
    b.root.position.set(0, y, 0.02);
    this.root.add(b.root);
    this.interaction.add(b);
    this.controls.push(b);
    b.setEnabled(false);
    return b;
  }

  setContext({ role, phaseLabel }) {
    this.role = role;
    this.phaseLabel = phaseLabel ?? '';
    this.screen.invalidate();
  }

  show() {
    if (this.open) return;
    this.open = true;
    this.root.visible = true;
    for (const c of this.controls) c.setEnabled(true);
    this.screen.invalidate();
    sfx.tick();
  }

  hide() {
    if (!this.open) return;
    this.open = false;
    this.root.visible = false;
    for (const c of this.controls) c.setEnabled(false);
  }

  update(dt) {
    if (!this.open) return;
    this.light.intensity = 0.7 + 0.2 * Math.sin((this._t = (this._t ?? 0) + dt) * 3);
    this.screen.render();
  }

  _draw(ctx, w, h, p) {
    p.header('PAUSED', PALETTE.amber);
    const meta = this.role ? ROLE_META[this.role] : null;
    p.text(meta ? meta.label : 'BRIDGE', w / 2, 48, { size: 28, align: 'center', color: PALETTE.white, weight: 'bold' });
    p.text(this.phaseLabel || 'Session menu', w / 2, 80, { size: 14, align: 'center', color: PALETTE.screenFg });
    p.text('B / Y · toggle  ·  Esc on desktop', w / 2, h - 18, { size: 12, align: 'center', color: PALETTE.screenDim });
  }

  dispose() {
    this.hide();
    for (const c of this.controls) this.interaction.remove(c);
    this.root.parent?.remove(this.root);
  }
}
