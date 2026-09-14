import * as THREE from 'three';
import { StationBase } from './StationBase.js';
import { RotaryDial } from '../controls/RotaryDial.js';
import { Lever } from '../controls/Lever.js';
import { Keypad } from '../controls/Keypad.js';
import { PushButton } from '../controls/PushButton.js';
import { ScreenPanel } from '../controls/ScreenPanel.js';
import { IndicatorLight } from '../controls/IndicatorLight.js';
import { PALETTE } from '../core/Constants.js';
import { ARCS } from '../sim/ShipState.js';
import { verifyCode, headingError } from '../sim/Verification.js';
import { sfx } from '../core/Audio.js';

const PANEL = { center: new THREE.Vector3(0, 1.08, -1.05), rotX: -0.42 };

/**
 * Tactical / Electronic Warfare. Authorization keys arrive verbally from
 * the Captain and are typed on the physical keypad; frequencies arrive from
 * Science and are dialled in; physical handles fire point-defense and
 * torpedoes.
 */
export class TacticalStation extends StationBase {
  build() {
    Object.assign(this.values, {
      laserFreq: 0, ecmFreq: 0, pdFired: false, launchedAt: null, jamming: false, shieldArc: 'FORE', threat: null, authKeys: [],
    });

    // Modulation dials (far row, flat on desk)
    this.laserDial = this.addControl(
      new RotaryDial({ min: 0, max: 500, value: 0, perTurn: 100, step: 1, unit: 'MHz', label: 'LASER / TORPEDO MOD', name: 'laser-dial', glow: 0xff5a6a, onChange: (v) => (this.values.laserFreq = v) }),
      this.deskMount(-0.5, 0.782, -0.82)
    );
    this.ecmDial = this.addControl(
      new RotaryDial({ min: 0, max: 500, value: 0, perTurn: 100, step: 1, unit: 'MHz', label: 'ECM JAM FREQ', name: 'ecm-dial', glow: 0xffb347, onChange: (v) => (this.values.ecmFreq = v) }),
      this.deskMount(-0.28, 0.782, -0.82)
    );

    // Point-defense handle (spring) and torpedo launch handle (latch)
    this.pdLever = this.addControl(
      new Lever({ length: 0.12, mode: 'spring', minAngle: -0.55, maxAngle: 0.55, label: 'POINT DEFENSE', color: 0xffb347, name: 'pd-lever', onPull: () => this._firePD() })
    );
    this.pdLever.root.position.set(0.0, 0.79, -0.82);
    this.launchLever = this.addControl(
      new Lever({ length: 0.17, mode: 'latch', minAngle: -0.6, maxAngle: 0.6, label: 'TORPEDO LAUNCH', color: 0xc7362f, grip: 'bar', handleRadius: 0.024, name: 'launch-lever', onPull: () => this._launch() })
    );
    this.launchLever.root.position.set(0.55, 0.79, -0.8);

    // Shield arc selector (near row, left)
    this.arcButtons = {};
    ARCS.forEach((arc, i) => {
      const b = new PushButton({
        width: 0.05, height: 0.03, depth: 0.016, label: arc, labelSize: 0.009, color: 0x203a4c, glow: 0x5ad0ff, name: `arc-${arc}`,
        onPress: () => this._selectArc(arc),
      });
      this.addControl(b, this.deskMount(-0.6 + i * 0.062, 0.782, -0.55));
      this.arcButtons[arc] = b;
    });
    this.arcButtons.FORE.setLit(true);

    // ECM jam engage
    this.jamButton = this.addControl(
      new PushButton({ width: 0.07, height: 0.034, depth: 0.018, latching: true, label: 'ECM JAM', labelSize: 0.01, color: 0x3a3320, glow: 0xffb347, name: 'jam', onPress: (b) => this._setJam(b.latched) }),
      this.deskMount(-0.3, 0.782, -0.55)
    );

    // Keypad, tilted toward the operator
    const kpMount = new THREE.Group();
    kpMount.position.set(0.22, 0.83, -0.58);
    kpMount.rotation.x = -1.05;
    this.group.add(kpMount);
    this.keypad = new Keypad({ interaction: this.interaction, maxLength: 8, name: 'tac-keypad', onEnter: (code) => this._enterKey(code) });
    this.keypad.buttons.forEach((b) => this.controls.push(b));
    kpMount.add(this.keypad.group);
    this.updaters.push((dt) => this.keypad.update(dt));

    // Screens
    this.reticle = new ScreenPanel({ width: 0.56, height: 0.36, px: 768, name: 'tac-reticle', tint: '#ff5a6a' });
    this.reticle.setDraw((ctx, w, h, p) => this._drawReticle(ctx, w, h, p));
    this.addScreen(this.reticle, this.panelMount(PANEL.center, PANEL.rotX, -0.33, 0.02));
    this.buildCommon({
      statusMount: this.panelMount(PANEL.center, PANEL.rotX, 0.4, 0.02),
      ackMount: this.deskMount(0.55, 0.782, -0.5),
      statusSize: { width: 0.42, height: 0.3 },
    });

    // Arming indicator cluster on the right pod
    this.ind = {};
    [['PD', 'PD UNLOCK'], ['ARM', 'TORP ARMED'], ['ECM', 'ECM ACTIVE'], ['LOCK', 'INBOUND']].forEach(([key, label], i) => {
      const ind = new IndicatorLight({ radius: 0.011, light: true, lightRange: 0.5, lightIntensity: 0.9, label });
      ind.group.position.set(0.5 + (i % 2) * 0.07, 0.755, -0.3 - Math.floor(i / 2) * 0.06);
      ind.group.rotation.x = -Math.PI / 2;
      ind.group.rotation.z = -0.35;
      this.addIndicator(ind);
      this.ind[key] = ind;
    });

    this.damage.group.position.set(-0.5, 0.6, -0.75);
  }

  setAuthKeys(keys) {
    this.values.authKeys = keys;
  }

  _enterKey(code) {
    const match = this.values.authKeys.find((k) => verifyCode(code, k));
    if (!match) return false;
    this.values.acceptedKeys.add(match);
    this.ship.logEvent(this.engine?.timer.t ?? 0, `KEY ACCEPTED: ${match}`, 'ok');
    this.reticle.invalidate();
    return true;
  }

  _selectArc(arc) {
    this.values.shieldArc = arc;
    this.ship.shieldFacing = arc;
    for (const [k, b] of Object.entries(this.arcButtons)) b.setLit(k === arc);
    this.reticle.invalidate();
  }

  _setJam(on) {
    this.values.jamming = on;
    this.ind.ECM.set(on ? 'amber' : 'off');
  }

  _firePD() {
    const unlocked = [...this.values.acceptedKeys].some((k) => /^ALPHA/.test(k));
    if (!unlocked) {
      sfx.error();
      this.ship.logEvent(this.engine?.timer.t ?? 0, 'POINT DEFENSE LOCKED — key required', 'warn');
      return;
    }
    this.values.pdFired = true;
    sfx.launch();
    this.space.flash();
    this.bridge.flash(0xffb347, 20, 5);
    if (this.values.threat?.kind === 'asteroid') this.space.destroyMarker('threat');
  }

  _launch() {
    const t = this.engine?.timer.t ?? 0;
    // Tactical cannot see Engineering's grid; weapon power is a verbal call-out.
    const armed = [...this.values.acceptedKeys].some((k) => /^DELTA/.test(k));
    if (!armed) {
      sfx.error();
      this.ship.logEvent(t, 'TORPEDO MISFIRE — not armed', 'critical');
      this.onImpact('MISFIRE — ARMING KEY REQUIRED');
      setTimeout(() => this.launchLever.setValue(0, true), 600);
      return;
    }
    this.values.launchedAt = t;
    sfx.launch();
    this.space.flash();
    this.bridge.flash(0xffe0a0, 45, 3);
    setTimeout(() => this.launchLever.setValue(0, true), 1200);
  }

  onKill(text) {
    this.space.destroyMarker('threat');
    this.onImpact(text);
    this.ind.LOCK.set('off');
    this.values.threat = null;
  }

  setThreat(t) {
    this.values.threat = t;
    const m = this.space.setMarker('threat', { bearing: t.bearing, pitch: t.pitch, kind: t.kind, distance: t.kind === 'asteroid' ? 140 : 90 });
    if (t.kind === 'asteroid') m.userData.approach = 130 / t.eta;
    if (t.lock) this.ind.LOCK.set('red', true);
    this.reticle.invalidate();
  }

  clearThreat() {
    this.values.threat = null;
    this.space.removeMarker('threat');
    this.ind.LOCK.set('off');
  }

  update(dt) {
    super.update(dt);
    const keys = this.values.acceptedKeys;
    this.ind.PD.set([...keys].some((k) => /^ALPHA/.test(k)) ? 'green' : 'off');
    this.ind.ARM.set([...keys].some((k) => /^DELTA/.test(k)) ? (this.values.launchedAt ? 'amber' : 'green') : 'off');
    this._clock = (this._clock ?? 0) + dt;
    if (this._clock > 1 / 12) {
      this._clock = 0;
      this.reticle.invalidate();
    }
  }

  _drawReticle(ctx, w, h, p) {
    p.header('TARGETING / EW', this.tintHex());
    const a = this.ship.attitude;
    const cx = w * 0.36;
    const cy = h / 2 + 22;

    // Reticle rings
    ctx.strokeStyle = PALETTE.screenDim;
    ctx.lineWidth = 1;
    [28, 60, 95].forEach((r) => {
      ctx.beginPath();
      ctx.arc(cx, cy, r, 0, Math.PI * 2);
      ctx.stroke();
    });
    ctx.beginPath();
    ctx.moveTo(cx - 110, cy);
    ctx.lineTo(cx + 110, cy);
    ctx.moveTo(cx, cy - 110);
    ctx.lineTo(cx, cy + 110);
    ctx.stroke();

    const th = this.values.threat;
    if (th) {
      const db = ((th.bearing - a.bearing + 540) % 360) - 180;
      const dp = th.pitch - a.pitch;
      const x = cx + THREE.MathUtils.clamp(db, -45, 45) * 2.3;
      const y = cy - THREE.MathUtils.clamp(dp, -35, 35) * 2.6;
      const inArc = headingError(a.bearing, th.bearing) <= 5 && Math.abs(dp) <= 5;
      ctx.strokeStyle = inArc ? PALETTE.green : PALETTE.red;
      ctx.lineWidth = 2;
      ctx.strokeRect(x - 18, y - 18, 36, 36);
      ctx.beginPath();
      ctx.moveTo(x - 26, y);
      ctx.lineTo(x - 18, y);
      ctx.moveTo(x + 18, y);
      ctx.lineTo(x + 26, y);
      ctx.stroke();
      p.text(th.kind.toUpperCase(), x, y + 22, { size: 13, align: 'center', color: ctx.strokeStyle });
      p.text(inArc ? 'IN FIRING ARC' : 'HELM: ALIGN', x, y - 34, { size: 13, align: 'center', color: ctx.strokeStyle, weight: 'bold' });
      if (th.lock) {
        const blink = Math.floor(performance.now() / 300) % 2 === 0;
        if (blink) p.text('⚠ INCOMING LOCK', cx, 50, { size: 18, align: 'center', color: PALETTE.red, weight: 'bold' });
      }
    } else p.text('NO TARGET', cx, cy - 8, { size: 15, align: 'center', color: PALETTE.screenDim });

    // Shield arcs
    const sx = w * 0.8;
    const sy = cy;
    const arcs = { FORE: [-Math.PI * 0.75, -Math.PI * 0.25], STARBOARD: [-Math.PI * 0.25, Math.PI * 0.25], AFT: [Math.PI * 0.25, Math.PI * 0.75], PORT: [Math.PI * 0.75, Math.PI * 1.25] };
    for (const [arc, [s0, s1]] of Object.entries(arcs)) {
      const v = this.ship.shields[arc] / 100;
      ctx.strokeStyle = arc === this.values.shieldArc ? PALETTE.screenFg : PALETTE.screenDim;
      ctx.lineWidth = arc === this.values.shieldArc ? 10 : 6;
      ctx.globalAlpha = 0.25 + v * 0.75;
      ctx.beginPath();
      ctx.arc(sx, sy, 62, s0 + 0.06, s1 - 0.06);
      ctx.stroke();
      ctx.globalAlpha = 1;
      const mid = (s0 + s1) / 2;
      p.text(`${Math.round(this.ship.shields[arc])}`, sx + Math.cos(mid) * 84, sy + Math.sin(mid) * 84 - 7, { size: 13, align: 'center', color: PALETTE.white });
    }
    p.text('SHIELD FACING', sx, sy - 10, { size: 12, align: 'center', color: PALETTE.screenDim });
    p.text(this.values.shieldArc, sx, sy + 4, { size: 16, align: 'center', color: PALETTE.white, weight: 'bold' });

    // Arming & keys
    const keys = [...this.values.acceptedKeys];
    p.text(`KEYS: ${keys.length ? keys.join('  ') : '—'}`, 14, h - 46, { size: 14, color: PALETTE.green });
    p.text(`LASER ${this.values.laserFreq} MHz   ECM ${this.values.ecmFreq} MHz ${this.values.jamming ? '· JAMMING' : ''}`, 14, h - 26, { size: 14, color: PALETTE.white });
    if (this.values.launchedAt != null) p.text('TORPEDO AWAY', w - 14, h - 26, { size: 14, align: 'right', color: PALETTE.amber, weight: 'bold' });
  }
}
