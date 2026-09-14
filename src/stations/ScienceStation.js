import * as THREE from 'three';
import { StationBase } from './StationBase.js';
import { RotaryDial } from '../controls/RotaryDial.js';
import { PushButton } from '../controls/PushButton.js';
import { ScreenPanel } from '../controls/ScreenPanel.js';
import { IndicatorLight } from '../controls/IndicatorLight.js';
import { PALETTE } from '../core/Constants.js';
import { sfx } from '../core/Audio.js';

const BANK = { center: new THREE.Vector3(0, 1.4, -1.1), rotX: -0.15, depth: 0.13 };
const LOCK_TOL = 2;

/**
 * Science & Sensors (ISR). Raw signals appear on the spectrum analyzer; the
 * operator turns the wave-tuning dial until the holographic beat pattern
 * collapses into a clean wave, presses SENSOR LOCK, and reads the decoded
 * value out loud to the bridge.
 */
export class ScienceStation extends StationBase {
  build() {
    Object.assign(this.values, { waveFreq: 0, lockedFreq: null, signals: [] });

    this.waveDial = this.addControl(
      new RotaryDial({
        radius: 0.04, min: 0, max: 500, value: 0, perTurn: 100, step: 1, unit: 'MHz', label: 'WAVE TUNING', name: 'wave-dial', glow: 0x7dff9a,
        onChange: (v) => {
          this.values.waveFreq = v;
          this.analyzer.invalidate();
        },
      }),
      this.deskMount(-0.25, 0.792, -0.7)
    );

    this.lockButton = this.addControl(
      new PushButton({ width: 0.09, height: 0.04, depth: 0.02, label: 'SENSOR LOCK', labelSize: 0.011, color: 0x1f4a35, glow: 0x7dff9a, name: 'sensor-lock', onPress: () => this._lock() }),
      this.deskMount(0.02, 0.792, -0.62)
    );
    this.lockLight = new IndicatorLight({ radius: 0.011, light: true, lightRange: 0.5, lightIntensity: 0.9 });
    this.lockLight.group.position.set(0.02, 0.795, -0.7);
    this.lockLight.group.rotation.x = -Math.PI / 2;
    this.addIndicator(this.lockLight);

    // Holographic wave column on the desk (physical emitter + animated trace)
    this._buildWaveHologram();

    // Spectrum analyzer: big display on the bank
    this.analyzer = new ScreenPanel({ width: 0.78, height: 0.42, px: 896, name: 'sci-analyzer', tint: '#7dff9a' });
    this.analyzer.setDraw((ctx, w, h, p) => this._drawAnalyzer(ctx, w, h, p));
    this.addScreen(this.analyzer, this.panelMount(BANK.center, BANK.rotX, -0.4, -0.02, BANK.depth));

    // Decoded readout (large digits) + status
    this.decoded = new ScreenPanel({ width: 0.5, height: 0.16, px: 512, name: 'sci-decoded', tint: '#7dff9a' });
    this.decoded.setDraw((ctx, w, h, p) => {
      p.header('DECODED OUTPUT', this.tintHex());
      const v = this.values.lockedFreq;
      p.text(v == null ? '--- MHz' : `${v} MHz`, w / 2, 52, { size: 54, align: 'center', color: v == null ? PALETTE.screenDim : PALETTE.white, weight: 'bold' });
      if (v != null) p.text('READ OUT TO BRIDGE', w - 12, h - 22, { size: 13, align: 'right', color: PALETTE.amber });
    });
    this.addScreen(this.decoded, this.panelMount(BANK.center, BANK.rotX, 0.42, 0.24, BANK.depth));
    this.buildCommon({
      statusMount: this.panelMount(BANK.center, BANK.rotX, 0.42, -0.16, BANK.depth),
      ackMount: this.deskMount(0.55, 0.792, -0.55),
      statusSize: { width: 0.5, height: 0.34 },
    });

    this.damage.group.position.set(0.55, 0.7, -0.9);
  }

  _buildWaveHologram() {
    const holo = new THREE.Group();
    holo.position.set(0.35, 0.79, -0.78);
    this.group.add(holo);
    const emitter = new THREE.Mesh(new THREE.CylinderGeometry(0.11, 0.13, 0.02, 32), new THREE.MeshStandardMaterial({ color: 0x2a3140, roughness: 0.4, metalness: 0.8 }));
    emitter.position.y = 0.01;
    holo.add(emitter);
    const ring = new THREE.Mesh(new THREE.TorusGeometry(0.1, 0.004, 8, 48), new THREE.MeshStandardMaterial({ color: 0x000000, emissive: 0x7dff9a, emissiveIntensity: 2 }));
    ring.rotation.x = Math.PI / 2;
    ring.position.y = 0.021;
    holo.add(ring);
    this.holoLight = new THREE.PointLight(0x7dff9a, 0.6, 0.7, 2);
    this.holoLight.position.y = 0.15;
    holo.add(this.holoLight);

    this.waveN = 96;
    this.waveLines = [];
    for (let k = 0; k < 2; k++) {
      const pos = new Float32Array(this.waveN * 3);
      const geo = new THREE.BufferGeometry();
      geo.setAttribute('position', new THREE.BufferAttribute(pos, 3));
      const mat = new THREE.LineBasicMaterial({ color: k === 0 ? 0x7dff9a : 0xffb347, transparent: true, opacity: 0.9, blending: THREE.AdditiveBlending });
      const line = new THREE.Line(geo, mat);
      line.position.y = 0.14;
      holo.add(line);
      this.waveLines.push(line);
    }
    const cyl = new THREE.Mesh(
      new THREE.CylinderGeometry(0.105, 0.105, 0.24, 32, 1, true),
      new THREE.MeshBasicMaterial({ color: 0x7dff9a, transparent: true, opacity: 0.05, side: THREE.DoubleSide, depthWrite: false })
    );
    cyl.position.y = 0.14;
    cyl.userData.hittable = false;
    holo.add(cyl);
    this.holo = holo;
  }

  _nearestSignal() {
    let best = null;
    for (const s of this.values.signals) {
      const d = Math.abs(s.freq - this.values.waveFreq);
      if (d <= LOCK_TOL && (!best || d < Math.abs(best.freq - this.values.waveFreq))) best = s;
    }
    return best;
  }

  _lock() {
    const s = this._nearestSignal();
    if (!s) {
      sfx.error();
      this.lockLight.set('red');
      this._lockFlash = 0.8;
      return;
    }
    this.values.lockedFreq = s.freq;
    this.lockLight.set('green');
    this._lockFlash = 3;
    this.decoded.invalidate();
    this.ship.logEvent(this.engine?.timer.t ?? 0, `SENSOR LOCK: ${s.label} @ ${s.freq} MHz`, 'ok');
  }

  setSignal(sig) {
    this.values.signals = this.values.signals.filter((s) => s.label !== sig.label);
    this.values.signals.push({ ...sig, born: this.engine?.timer.t ?? 0 });
    if (this.values.signals.length > 3) this.values.signals.shift();
    this.values.lockedFreq = null;
    this.decoded.invalidate();
    this.analyzer.invalidate();
  }

  setThreat() {}
  clearThreat() {}

  update(dt) {
    super.update(dt);
    this._t = (this._t ?? 0) + dt;
    if (this._lockFlash > 0) {
      this._lockFlash -= dt;
      if (this._lockFlash <= 0) this.lockLight.set('off');
    }
    // Wave hologram: target vs tuned; beat pattern collapses when matched
    const target = this.values.signals.at(-1);
    const tf = target ? target.freq : 0;
    const wf = this.values.waveFreq;
    const diff = Math.abs(tf - wf);
    const matched = target && diff <= LOCK_TOL;
    for (let k = 0; k < 2; k++) {
      const attr = this.waveLines[k].geometry.attributes.position;
      const f = k === 0 ? tf : wf;
      for (let i = 0; i < this.waveN; i++) {
        const u = i / (this.waveN - 1);
        const x = (u - 0.5) * 0.19;
        const phase = this._t * (2 + f * 0.01) * 2;
        const y = target ? Math.sin(u * Math.PI * (2 + f * 0.02) + phase) * 0.05 : 0;
        const z = Math.cos(u * Math.PI * 4 + phase * 0.5) * 0.015 * (k === 0 ? 1 : -1);
        attr.setXYZ(i, x, y, z);
      }
      attr.needsUpdate = true;
    }
    this.waveLines[1].material.color.setHex(matched ? 0x7dff9a : 0xffb347);
    this.holoLight.color.setHex(matched ? 0x7dff9a : 0xffb347);
    this.holoLight.intensity = matched ? 1.2 : 0.5 + Math.sin(this._t * 6) * 0.1;

    this._clock = (this._clock ?? 0) + dt;
    if (this._clock > 1 / 15) {
      this._clock = 0;
      this.analyzer.invalidate();
    }
  }

  _drawAnalyzer(ctx, w, h, p) {
    p.header('SPECTRUM ANALYZER · 0–500 MHz', this.tintHex());
    const x0 = 40;
    const x1 = w - 20;
    const y0 = 60;
    const y1 = h - 50;
    const fx = (f) => x0 + (f / 500) * (x1 - x0);
    ctx.strokeStyle = PALETTE.screenDim;
    ctx.lineWidth = 1;
    for (let f = 0; f <= 500; f += 50) {
      ctx.beginPath();
      ctx.moveTo(fx(f), y1);
      ctx.lineTo(fx(f), y1 + (f % 100 === 0 ? 8 : 4));
      ctx.stroke();
      if (f % 100 === 0) p.text(String(f), fx(f), y1 + 12, { size: 12, align: 'center', color: PALETTE.screenDim });
    }
    // Noise floor + peaks
    const t = this._t ?? 0;
    ctx.strokeStyle = this.tintHex();
    ctx.lineWidth = 1.5;
    ctx.beginPath();
    for (let px = x0; px <= x1; px += 2) {
      const f = ((px - x0) / (x1 - x0)) * 500;
      let a = 0.06 + 0.04 * Math.abs(Math.sin(f * 0.37 + t * 7) * Math.sin(f * 0.11 - t * 3));
      for (const s of this.values.signals) {
        const d = (f - s.freq) / s.width;
        a += Math.exp(-d * d) * (0.75 + 0.1 * Math.sin(t * 9 + s.freq));
      }
      const y = y1 - Math.min(1, a) * (y1 - y0);
      px === x0 ? ctx.moveTo(px, y) : ctx.lineTo(px, y);
    }
    ctx.stroke();
    for (const s of this.values.signals) p.text(s.label, fx(s.freq), y0 - 4, { size: 12, align: 'center', color: PALETTE.amber });

    // Tuning cursor
    const cf = this.values.waveFreq;
    const near = this._nearestSignal();
    ctx.strokeStyle = near ? PALETTE.green : PALETTE.white;
    ctx.lineWidth = 2;
    ctx.setLineDash([6, 4]);
    ctx.beginPath();
    ctx.moveTo(fx(cf), y0 - 10);
    ctx.lineTo(fx(cf), y1);
    ctx.stroke();
    ctx.setLineDash([]);
    p.text(`${cf} MHz`, fx(cf), y1 + 26, { size: 15, align: 'center', color: ctx.strokeStyle, weight: 'bold' });
    if (near) p.text('▲ TRACE LOCKED — PRESS SENSOR LOCK', w / 2, h - 22, { size: 14, align: 'center', color: PALETTE.green, weight: 'bold' });
    else if (this.values.signals.length) {
      const s = this.values.signals.at(-1);
      const dir = s.freq > cf ? 'TUNE UP' : 'TUNE DOWN';
      p.text(`${dir}  Δ ${Math.abs(s.freq - cf)} MHz`, w / 2, h - 22, { size: 14, align: 'center', color: PALETTE.amber });
    }
  }
}
