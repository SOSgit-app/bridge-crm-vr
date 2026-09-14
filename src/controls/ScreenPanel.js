import * as THREE from 'three';
import { PALETTE } from '../core/Constants.js';
import { MAT } from './Materials.js';

/**
 * A physical display: a metal bezel, a recessed emissive glass face and a
 * canvas texture rendered by a user supplied draw callback. Nothing here
 * floats; every panel is parented into console geometry.
 */
export class ScreenPanel {
  constructor({ width = 0.4, height = 0.25, px = 512, bezel = 0.012, depth = 0.03, tint = PALETTE.screenFg, name = 'screen' } = {}) {
    this.width = width;
    this.height = height;
    this.tint = tint;
    this.dirty = true;
    this.drawFn = null;

    this.canvas = document.createElement('canvas');
    this.canvas.width = px;
    this.canvas.height = Math.round((px * height) / width);
    this.ctx = this.canvas.getContext('2d');
    this.texture = new THREE.CanvasTexture(this.canvas);
    this.texture.colorSpace = THREE.SRGBColorSpace;
    this.texture.anisotropy = 4;
    this.texture.minFilter = THREE.LinearFilter;

    this.group = new THREE.Group();
    this.group.name = name;

    const frame = new THREE.Mesh(new THREE.BoxGeometry(width + bezel * 2, height + bezel * 2, depth), MAT.trim);
    frame.position.z = -depth / 2;
    frame.userData.hittable = false;
    frame.userData.static = true;
    this.group.add(frame);

    // Emissive-only face: no specular response so the screen's own glow light
    // and console indicators never bloom on the glass.
    const faceMat = new THREE.MeshStandardMaterial({
      map: this.texture,
      emissiveMap: this.texture,
      emissive: new THREE.Color(0xffffff),
      emissiveIntensity: 1.1,
      color: 0x000000,
      roughness: 1.0,
      metalness: 0.0,
    });
    this.face = new THREE.Mesh(new THREE.PlaneGeometry(width, height), faceMat);
    this.face.position.z = 0.002;
    this.face.userData.hittable = false;
    this.group.add(this.face);

    // Local glow so the screen visibly lights the console around it.
    // Small readouts skip the light to stay inside the standalone light budget.
    if (width >= 0.2) {
      this.glow = new THREE.PointLight(new THREE.Color(tint), 0.35, Math.max(0.8, width * 2.2), 2);
      this.glow.position.set(0, -height * 0.6, 0.18);
      this.group.add(this.glow);
    }
  }

  setDraw(fn) {
    this.drawFn = fn;
    this.dirty = true;
  }

  invalidate() {
    this.dirty = true;
  }

  render(force = false) {
    if (!this.dirty && !force) return;
    const { ctx, canvas } = this;
    ctx.save();
    ctx.fillStyle = PALETTE.screenBg;
    ctx.fillRect(0, 0, canvas.width, canvas.height);
    // subtle scanlines for a CRT-ish diegetic feel
    ctx.fillStyle = 'rgba(255,255,255,0.025)';
    for (let y = 0; y < canvas.height; y += 4) ctx.fillRect(0, y, canvas.width, 1);
    ctx.restore();
    if (this.drawFn) {
      ctx.save();
      this.drawFn(ctx, canvas.width, canvas.height, this);
      ctx.restore();
    }
    this.texture.needsUpdate = true;
    this.dirty = false;
  }

  // ---- drawing helpers -------------------------------------------------

  text(str, x, y, { size = 22, color = this.tint, align = 'left', weight = 'normal', font = 'Consolas, Menlo, monospace' } = {}) {
    const ctx = this.ctx;
    ctx.font = `${weight} ${size}px ${font}`;
    ctx.fillStyle = color;
    ctx.textAlign = align;
    ctx.textBaseline = 'top';
    ctx.fillText(str, x, y);
  }

  header(str, color = this.tint) {
    const w = this.canvas.width;
    this.ctx.fillStyle = color;
    this.ctx.fillRect(0, 0, w, 3);
    this.text(str, 12, 12, { size: 20, color, weight: 'bold' });
    this.ctx.fillStyle = color;
    this.ctx.globalAlpha = 0.35;
    this.ctx.fillRect(12, 38, w - 24, 1);
    this.ctx.globalAlpha = 1;
  }

  bar(x, y, w, h, value, { color = this.tint, bg = 'rgba(255,255,255,0.08)', label } = {}) {
    const ctx = this.ctx;
    ctx.fillStyle = bg;
    ctx.fillRect(x, y, w, h);
    ctx.fillStyle = color;
    ctx.fillRect(x, y, Math.max(0, Math.min(1, value)) * w, h);
    ctx.strokeStyle = 'rgba(255,255,255,0.2)';
    ctx.strokeRect(x + 0.5, y + 0.5, w - 1, h - 1);
    if (label) this.text(label, x + 6, y + h / 2 - 8, { size: 15, color: PALETTE.white });
  }

  lines(arr, x, y, lineHeight = 26, opts = {}) {
    arr.forEach((l, i) => {
      if (typeof l === 'string') this.text(l, x, y + i * lineHeight, opts);
      else this.text(l.text, x, y + i * lineHeight, { ...opts, ...l });
    });
  }
}
