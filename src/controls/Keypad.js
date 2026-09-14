import * as THREE from 'three';
import { PushButton } from './PushButton.js';
import { ScreenPanel } from './ScreenPanel.js';
import { MAT } from './Materials.js';
import { sfx } from '../core/Audio.js';
import { PALETTE } from '../core/Constants.js';

/**
 * A physical alphanumeric keypad with a recessed readout. Emits the buffered
 * string on ENTER; the owner decides whether it is a valid authorization key.
 */
export class Keypad {
  constructor({ interaction, maxLength = 8, onEnter = null, keys = 'alnum', name = 'keypad' } = {}) {
    this.group = new THREE.Group();
    this.group.name = name;
    this.buffer = '';
    this.maxLength = maxLength;
    this.onEnter = onEnter;
    this.status = null; // null | 'ok' | 'bad'
    this.statusTimer = 0;
    this.buttons = [];
    this.locked = false;

    const layout =
      keys === 'alnum'
        ? [
            ['1', '2', '3', 'A'],
            ['4', '5', '6', 'B'],
            ['7', '8', '9', 'C'],
            ['CLR', '0', '-', 'D'],
            ['E', 'F', 'G', 'ENT'],
          ]
        : [
            ['1', '2', '3'],
            ['4', '5', '6'],
            ['7', '8', '9'],
            ['CLR', '0', 'ENT'],
          ];

    const bw = 0.034;
    const gap = 0.006;
    const cols = layout[0].length;
    const rows = layout.length;
    const totalW = cols * bw + (cols - 1) * gap;
    const totalH = rows * bw + (rows - 1) * gap;

    const plate = new THREE.Mesh(new THREE.BoxGeometry(totalW + 0.03, totalH + 0.09, 0.012), MAT.panel.clone());
    plate.material.vertexColors = false;
    plate.position.set(0, -0.015, -0.006);
    plate.userData.hittable = false;
    this.group.add(plate);

    this.display = new ScreenPanel({ width: totalW, height: 0.036, px: 384, bezel: 0.005, depth: 0.014, name: `${name}-display` });
    this.display.group.position.set(0, totalH / 2 + 0.03, 0.004);
    this.display.setDraw((ctx, w, h, p) => {
      const color = this.status === 'ok' ? PALETTE.green : this.status === 'bad' ? PALETTE.red : PALETTE.screenFg;
      const shown = this.status === 'ok' ? 'ACCEPTED' : this.status === 'bad' ? 'REJECTED' : this.buffer || '_';
      p.text(shown, 10, h * 0.2, { size: h * 0.6, color, weight: 'bold' });
      if (this.locked) p.text('LOCKED', w - 10, h * 0.25, { size: h * 0.45, color: PALETTE.red, align: 'right' });
    });
    this.group.add(this.display.group);

    layout.forEach((row, r) => {
      row.forEach((k, c) => {
        const isEnter = k === 'ENT';
        const isClr = k === 'CLR';
        const b = new PushButton({
          width: bw, height: bw, depth: 0.014, label: '', name: `key-${k}`,
          color: isEnter ? 0x1f5a35 : isClr ? 0x5a1f25 : 0x2f3a4c,
          glow: isEnter ? 0x4dff88 : isClr ? 0xff3b4d : 0x8fd3ff,
          onPress: () => this._key(k),
        });
        const x = -totalW / 2 + bw / 2 + c * (bw + gap);
        const y = totalH / 2 - bw / 2 - r * (bw + gap);
        b.root.position.set(x, y, 0);
        // legend etched on the cap
        const legend = makeLegend(k);
        legend.position.set(0, 0, 0.0075);
        b.cap.add(legend);
        this.group.add(b.root);
        this.buttons.push(b);
        interaction.add(b);
      });
    });
  }

  _key(k) {
    if (this.locked) {
      sfx.error();
      return;
    }
    this.status = null;
    if (k === 'CLR') this.buffer = '';
    else if (k === 'ENT') {
      const value = this.buffer;
      const ok = this.onEnter?.(value, this);
      this.status = ok ? 'ok' : 'bad';
      this.statusTimer = 1.6;
      ok ? sfx.confirm() : sfx.error();
      if (ok) this.buffer = '';
    } else if (this.buffer.length < this.maxLength) this.buffer += k;
    this.display.invalidate();
  }

  setLocked(v) {
    this.locked = v;
    this.buttons.forEach((b) => b.setEnabled(!v));
    this.display.invalidate();
  }

  update(dt) {
    if (this.statusTimer > 0) {
      this.statusTimer -= dt;
      if (this.statusTimer <= 0) {
        this.status = null;
        this.display.invalidate();
      }
    }
    this.display.render();
  }
}

const legendCache = new Map();
function makeLegend(text) {
  let tex = legendCache.get(text);
  if (!tex) {
    const c = document.createElement('canvas');
    c.width = 64;
    c.height = 64;
    const ctx = c.getContext('2d');
    ctx.fillStyle = '#e6f7ff';
    ctx.font = `bold ${text.length > 1 ? 22 : 40}px Consolas, monospace`;
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.fillText(text, 32, 34);
    tex = new THREE.CanvasTexture(c);
    tex.colorSpace = THREE.SRGBColorSpace;
    legendCache.set(text, tex);
  }
  const m = new THREE.Mesh(new THREE.PlaneGeometry(0.026, 0.026), new THREE.MeshBasicMaterial({ map: tex, transparent: true, depthWrite: false }));
  m.userData.hittable = false;
  m.renderOrder = 2;
  return m;
}
