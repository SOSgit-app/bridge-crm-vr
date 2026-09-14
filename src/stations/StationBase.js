import * as THREE from 'three';
import { STATION_SEATS, ROLE_META, PALETTE } from '../core/Constants.js';
import { ScreenPanel } from '../controls/ScreenPanel.js';
import { PushButton } from '../controls/PushButton.js';
import { IndicatorLight } from '../controls/IndicatorLight.js';
import { DamageFX } from '../environment/Particles.js';
import { TimerManager } from '../sim/TimerManager.js';
import { sfx } from '../core/Audio.js';
import { bus } from '../core/EventBus.js';

/**
 * Common station plumbing: operator-local coordinate frame at the seat,
 * an ORDERS/STATUS screen fed by the scenario engine, the STANDBY-ACK
 * closed-loop button, lockout handling and damage FX.
 *
 * Operator-local frame: origin at the seat, +x right, +y up, -z forward.
 */
export class StationBase {
  constructor({ role, interaction, ship, spaceScape, bridge }) {
    this.role = role;
    this.meta = ROLE_META[role];
    this.interaction = interaction;
    this.ship = ship;
    this.space = spaceScape;
    this.bridge = bridge;
    this.seat = STATION_SEATS[role];
    this.group = new THREE.Group();
    this.group.name = `Station-${role}`;
    this.group.position.copy(this.seat.position);
    this.group.rotation.y = this.seat.yaw;
    this.values = { acceptedKeys: new Set() };
    this.standbyAckAt = null;
    this.engine = null;
    this.locked = false;
    this.controls = [];
    this.screens = [];
    this.indicators = [];
    this.updaters = [];
    this.impactBanner = null;
    this.impactTimer = 0;
    this._alertPulse = 0;

    this.damage = new DamageFX();
    this.group.add(this.damage.group);
  }

  /** Register an interactable so lockout and updates cover it. */
  addControl(ctrl, parent = this.group) {
    parent.add(ctrl.root);
    this.interaction.add(ctrl);
    this.controls.push(ctrl);
    return ctrl;
  }

  addScreen(screen, parent = this.group) {
    parent.add(screen.group);
    this.screens.push(screen);
    return screen;
  }

  addIndicator(ind, parent = this.group) {
    parent.add(ind.group);
    this.indicators.push(ind);
    return ind;
  }

  /**
   * A mount frame on a tilted panel. `center` is the panel centre in
   * operator-local space, `rotX` its tilt; (u,v) are offsets across the panel
   * face; the returned Group's +z points out of the panel toward the operator.
   */
  panelMount(center, rotX, u = 0, v = 0, depth = 0.052) {
    const g = new THREE.Group();
    g.rotation.x = rotX;
    const local = new THREE.Vector3(u, v, depth).applyEuler(new THREE.Euler(rotX, 0, 0));
    g.position.copy(center).add(local);
    this.group.add(g);
    return g;
  }

  /** Horizontal desk mount: +z up, so controls built "facing +z" lie flat. */
  deskMount(x, y, z, yaw = 0) {
    const g = new THREE.Group();
    g.position.set(x, y, z);
    g.rotation.set(-Math.PI / 2, 0, 0);
    g.rotateZ(yaw);
    this.group.add(g);
    return g;
  }

  /** Upright vertical mount facing the operator (+z toward operator). */
  uprightMount(x, y, z) {
    const g = new THREE.Group();
    g.position.set(x, y, z);
    this.group.add(g);
    return g;
  }

  buildCommon({ statusMount, ackMount, statusSize = { width: 0.42, height: 0.26 } }) {
    this.status = new ScreenPanel({ ...statusSize, px: 640, name: `${this.role}-status`, tint: PALETTE.screenFg });
    this.status.setDraw((ctx, w, h, p) => this._drawStatus(ctx, w, h, p));
    this.addScreen(this.status, statusMount);

    this.ackButton = new PushButton({
      width: 0.09, height: 0.036, depth: 0.018, color: 0x3a3320, glow: 0xffb347, label: 'ACK STANDBY', labelSize: 0.011,
      name: `${this.role}-ack`,
      onPress: () => {
        this.standbyAckAt = this.engine?.timer.t ?? null;
        this.ackLight.set('amber');
        this._ackFlash = 1.2;
        bus.emit('station:ack', { role: this.role, t: this.standbyAckAt });
      },
    });
    this.addControl(this.ackButton, ackMount);
    this.ackLight = new IndicatorLight({ radius: 0.008, light: true, lightRange: 0.3, lightIntensity: 0.5 });
    this.ackLight.group.position.set(0.065, 0, 0.004);
    this.addIndicator(this.ackLight, ackMount);

    // Master alarm indicator with a real strobe light on every console.
    this.alarmLight = new IndicatorLight({ radius: 0.014, light: true, lightRange: 1.4, lightIntensity: 1.6, label: 'MASTER ALARM' });
    this.alarmLight.group.position.set(-0.065, 0, 0.004);
    this.addIndicator(this.alarmLight, ackMount);
  }

  attachEngine(engine) {
    this.engine = engine;
    engine.events.on('inject', (e) => {
      this.status.invalidate();
      if (e.level === 'critical') {
        sfx.inject();
        this.alarmLight.set('red', true);
        this._alertPulse = 6;
      } else if (e.level === 'warn') sfx.inject();
      else sfx.tick();
      this.onInject?.(e);
    });
    engine.events.on('task', (task) => {
      this.status.invalidate();
      if (task.state === 'success') {
        sfx.confirm();
        this.onTaskSuccess?.(task);
      } else if (task.state === 'failed') sfx.error();
    });
    this.ship.events.on('lockout', ({ role }) => {
      if (role === this.role) this.setLockout(true, 'CRITICAL FAILURE');
    });
    this.ship.events.on('restore', ({ role }) => {
      if (role === this.role) this.setLockout(false);
    });
    this.ship.events.on('damage', ({ toHull }) => {
      this.bridge?.flash(toHull > 0 ? 0xff6a3a : 0x5ad0ff, toHull > 0 ? 40 : 18, 3);
      sfx.impact();
      this.damage.setLevel(Math.max(this.damage.level, this.ship.hull < 60 ? 1 : 0));
    });
  }

  onImpact(text) {
    this.impactBanner = text;
    this.impactTimer = 4;
    this.status.invalidate();
  }

  setLockout(v, reason = '') {
    this.locked = v;
    for (const c of this.controls) if (c !== this.ackButton) c.setEnabled(!v);
    this.damage.setLevel(v ? 2 : 0);
    this.alarmLight.set(v ? 'red' : 'off', v);
    sfx.alarm(v);
    this.lockReason = reason;
    this.status.invalidate();
    this.onLockoutChanged?.(v);
  }

  _drawStatus(ctx, w, h, p) {
    const color = this.locked ? PALETTE.red : this.tintHex();
    p.header(`${this.meta.label} · ${this.meta.sub}`, color);
    const t = this.engine?.timer.t ?? 0;
    p.text(`T+${TimerManager.format(t)}`, w - 14, 10, { size: 22, align: 'right', color: PALETTE.white, weight: 'bold' });

    if (this.locked) {
      ctx.fillStyle = 'rgba(255,60,80,0.18)';
      ctx.fillRect(0, 46, w, h - 46);
      p.text('CRITICAL LOCKOUT', w / 2, h * 0.32, { size: 34, align: 'center', color: PALETTE.red, weight: 'bold' });
      p.text(this.lockReason || 'STATION OFFLINE', w / 2, h * 0.32 + 42, { size: 18, align: 'center', color: PALETTE.white });
      p.text('Adjacent operator: take over secondary inputs', w / 2, h * 0.32 + 72, { size: 15, align: 'center', color: PALETTE.amber });
      return;
    }

    if (this.impactBanner && this.impactTimer > 0) {
      ctx.fillStyle = 'rgba(255,60,80,0.25)';
      ctx.fillRect(0, 46, w, 34);
      p.text(this.impactBanner, w / 2, 52, { size: 20, align: 'center', color: PALETTE.red, weight: 'bold' });
    }

    let y = 90;
    p.text('ACTIVE TASKS', 14, y, { size: 14, color: PALETTE.screenDim });
    y += 20;
    const tasks = (this.engine?.tasks ?? []).filter((tk) => tk.state !== 'idle').slice(-4);
    if (!tasks.length) {
      p.text('— none —', 14, y, { size: 17, color: PALETTE.screenDim });
      y += 24;
    }
    for (const tk of tasks) {
      const col = tk.state === 'success' ? PALETTE.green : tk.state === 'failed' ? PALETTE.red : PALETTE.amber;
      const mark = tk.state === 'success' ? '■' : tk.state === 'failed' ? '✕' : '▶';
      const remain = tk.state === 'active' ? ` ${Math.max(0, Math.ceil(tk.until - t))}s` : '';
      p.text(`${mark} ${tk.title}${remain}`, 14, y, { size: 17, color: col, weight: tk.state === 'active' ? 'bold' : 'normal' });
      if (tk.state === 'active' && tk.hint) p.text(tk.hint, 34, y + 19, { size: 13, color: PALETTE.screenDim });
      y += tk.state === 'active' ? 40 : 22;
    }

    y = Math.max(y + 6, h * 0.62);
    p.text('ORDERS / ALERTS', 14, y, { size: 14, color: PALETTE.screenDim });
    y += 20;
    const msgs = this.engine?.messages.slice(0, 2) ?? [];
    for (const m of msgs) {
      const col = m.level === 'critical' ? PALETTE.red : m.level === 'warn' ? PALETTE.amber : m.level === 'ok' ? PALETTE.green : PALETTE.screenFg;
      p.text(`${TimerManager.format(m.t)}  ${m.title}`, 14, y, { size: 15, color: col, weight: 'bold' });
      wrapText(p, m.message, 14, y + 18, w - 28, 13, PALETTE.white, 2);
      y += 52;
    }
  }

  tintHex() {
    return '#' + this.meta.color.toString(16).padStart(6, '0');
  }

  update(dt) {
    // Interactables are stepped by the InteractionManager; only composites here.
    for (const i of this.indicators) i.update(dt);
    for (const u of this.updaters) u(dt);
    this.damage.update(dt);
    if (this._ackFlash > 0) {
      this._ackFlash -= dt;
      if (this._ackFlash <= 0) this.ackLight.set('off');
    }
    if (this._alertPulse > 0) {
      this._alertPulse -= dt;
      if (this._alertPulse <= 0 && !this.locked) this.alarmLight.set('off');
    }
    if (this.impactTimer > 0) {
      this.impactTimer -= dt;
      if (this.impactTimer <= 0) this.status.invalidate();
    }
    // Status screen refreshes at ~4 Hz for the timer readout.
    this._statusClock = (this._statusClock ?? 0) + dt;
    if (this._statusClock > 0.25) {
      this._statusClock = 0;
      this.status.invalidate();
    }
    for (const s of this.screens) s.render();
  }

  dispose() {
    for (const c of this.controls) this.interaction.remove(c);
    this.group.parent?.remove(this.group);
    sfx.alarm(false);
  }
}

export function wrapText(p, text, x, y, maxWidth, size, color, maxLines = 3) {
  const ctx = p.ctx;
  ctx.font = `${size}px Consolas, Menlo, monospace`;
  const words = String(text ?? '').split(' ');
  let line = '';
  let lines = 0;
  for (const word of words) {
    const test = line ? `${line} ${word}` : word;
    if (ctx.measureText(test).width > maxWidth && line) {
      p.text(line, x, y + lines * (size + 3), { size, color });
      line = word;
      if (++lines >= maxLines) return;
    } else line = test;
  }
  if (line && lines < maxLines) p.text(line, x, y + lines * (size + 3), { size, color });
}
