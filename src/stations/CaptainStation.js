import * as THREE from 'three';
import { StationBase, wrapText } from './StationBase.js';
import { HoloNode } from '../controls/HoloNode.js';
import { ScreenPanel } from '../controls/ScreenPanel.js';
import { Keypad } from '../controls/Keypad.js';
import { ParticleEmitter } from '../environment/Particles.js';
import { PALETTE, ROLE_META, ROLES } from '../core/Constants.js';
import { SpaceScape } from '../environment/SpaceScape.js';
import { TimerManager } from '../sim/TimerManager.js';
import { sfx } from '../core/Audio.js';

const CREW = [ROLES.HELM, ROLES.TACTICAL, ROLES.SCIENCE, ROLES.ENGINEERING];
const roleHex = (role) => '#' + ROLE_META[role].color.toString(16).padStart(6, '0');

// Holo-table top in operator-local space (world table top y=1.01, seat y=0.45)
const TABLE = new THREE.Vector3(0, 0.56, -1.05);
const BRANCH_COLORS = { A: 0xff5a6a, B: 0xffb347, C: 0x5ad0ff };

/**
 * Command. The Captain's Holo-Table shows the tactical theater, global ship
 * health and — when an inject fires — 3 strategic routes as spatial nodes.
 * Verification keys are generated here and only here; the Captain speaks
 * them to the crew as part of Situation / Intent / Directives.
 */
export class CaptainStation extends StationBase {
  build() {
    Object.assign(this.values, { checklist: [], checklistDone: false, threat: null });
    this.nodes = [];
    this.checklistNodes = [];

    this._buildHoloTheater();

    // Command screens float as angled wings over the near corners of the
    // table, ~0.9 m from the seated eye, so the text is readable without leaning.
    const wing = { x: 0.6, y: TABLE.y + 0.44, z: TABLE.z + 0.15, pitch: -0.18, yaw: 0.62 };
    this.sitrep = new ScreenPanel({ width: 0.56, height: 0.4, px: 640, name: 'cap-sitrep', tint: '#ffc85a' });
    this.sitrep.setDraw((ctx, w, h, p) => this._drawSitrep(ctx, w, h, p));
    const sitrepMount = this.uprightMount(wing.x, wing.y, wing.z);
    sitrepMount.rotation.set(wing.pitch, -wing.yaw, 0);
    this.addScreen(this.sitrep, sitrepMount);

    const statusMount = this.uprightMount(-wing.x, wing.y, wing.z);
    statusMount.rotation.set(wing.pitch, wing.yaw, 0);
    this.buildCommon({ statusMount, ackMount: this.deskMount(-0.42, 0.675, 0.0), statusSize: { width: 0.56, height: 0.4 } });

    // Command key display on the right armrest
    this.keyScreen = new ScreenPanel({ width: 0.13, height: 0.075, px: 384, name: 'cap-key', tint: '#ffc85a' });
    this.keyScreen.setDraw((ctx, w, h, p) => {
      const d = this.engine?.activeDecision;
      const opt = d?.chosen ? d.options.find((o) => o.id === d.chosen) : null;
      p.text('COMMAND KEY', 8, 6, { size: 20, color: PALETTE.screenDim });
      p.text(opt ? opt.code : '— — —', w / 2, h * 0.42, { size: opt && opt.code.length > 10 ? 34 : 48, align: 'center', color: opt ? PALETTE.white : PALETTE.screenDim, weight: 'bold' });
    });
    this.addScreen(this.keyScreen, this.deskMount(0.42, 0.675, 0.0));

    // Readback verification: keypad on the table's near edge, results screen
    // centred above the far edge.
    this.readbackPad = new Keypad({
      interaction: this.interaction, keys: 'base32', maxLength: 10, buttonSize: 0.03, name: 'cap-readback',
      title: 'STATION CODE', okText: 'VERIFIED', badText: 'SEE SCREEN',
      onEnter: (code) => this._submitReadback(code),
    });
    const padMount = new THREE.Group();
    padMount.position.set(0, 0.57, -0.52);
    padMount.rotation.x = -0.95;
    this.group.add(padMount);
    padMount.add(this.readbackPad.group);
    this.readbackPad.buttons.forEach((b) => this.controls.push(b));
    this.updaters.push((dt) => this.readbackPad.update(dt));

    // Verification screen hangs above the holo column, centred, tilted to the seat.
    this.verify = new ScreenPanel({ width: 0.56, height: 0.26, px: 768, name: 'cap-verify', tint: '#7dff9a' });
    this.verify.setDraw((ctx, w, h, p) => this._drawVerify(ctx, w, h, p));
    const verifyMount = this.uprightMount(0, TABLE.y + 0.56, TABLE.z + 0.22);
    verifyMount.rotation.x = -0.42;
    this.addScreen(this.verify, verifyMount);

    this.damage.group.position.set(0.4, 0.5, -0.4);
  }

  _submitReadback(code) {
    if (!this.engine) return false;
    const res = this.engine.submitReadback(code);
    this.verify.invalidate();
    return res.state === 'verified';
  }

  _buildHoloTheater() {
    const holo = new THREE.Group();
    holo.position.copy(TABLE);
    this.group.add(holo);
    this.holo = holo;

    // Emitter ring flush with the table
    const ring = new THREE.Mesh(new THREE.TorusGeometry(0.42, 0.006, 8, 64), new THREE.MeshStandardMaterial({ color: 0x000000, emissive: 0xffc85a, emissiveIntensity: 1.8 }));
    ring.rotation.x = Math.PI / 2;
    ring.position.y = 0.004;
    holo.add(ring);

    // Volumetric column (faint additive cylinder + range rings)
    const col = new THREE.Mesh(
      new THREE.CylinderGeometry(0.4, 0.4, 0.32, 48, 1, true),
      new THREE.MeshBasicMaterial({ color: 0xffc85a, transparent: true, opacity: 0.035, side: THREE.DoubleSide, depthWrite: false, blending: THREE.AdditiveBlending })
    );
    col.position.y = 0.16;
    col.userData.hittable = false;
    holo.add(col);
    this.theater = new THREE.Group();
    this.theater.position.y = 0.16;
    holo.add(this.theater);
    const ringMat = new THREE.LineBasicMaterial({ color: 0xffc85a, transparent: true, opacity: 0.35 });
    [0.12, 0.24, 0.36].forEach((r) => {
      const pts = [];
      for (let i = 0; i <= 64; i++) pts.push(new THREE.Vector3(Math.cos((i / 64) * Math.PI * 2) * r, 0, Math.sin((i / 64) * Math.PI * 2) * r));
      this.theater.add(new THREE.Line(new THREE.BufferGeometry().setFromPoints(pts), ringMat));
    });
    // Ship wedge at centre
    this.shipIcon = new THREE.Mesh(new THREE.ConeGeometry(0.02, 0.06, 4), new THREE.MeshBasicMaterial({ color: 0xffffff }));
    this.shipIcon.rotation.x = -Math.PI / 2;
    this.theater.add(this.shipIcon);
    // Sweep
    this.sweep = new THREE.Mesh(new THREE.CircleGeometry(0.38, 24, 0, 0.5), new THREE.MeshBasicMaterial({ color: 0xffc85a, transparent: true, opacity: 0.12, side: THREE.DoubleSide, depthWrite: false }));
    this.sweep.rotation.x = -Math.PI / 2;
    this.theater.add(this.sweep);
    // Threat icon
    this.threatIcon = new THREE.Group();
    const threatMesh = new THREE.Mesh(new THREE.OctahedronGeometry(0.02, 0), new THREE.MeshBasicMaterial({ color: 0xff5a6a }));
    this.threatIcon.add(threatMesh);
    const threatLight = new THREE.PointLight(0xff5a6a, 0.6, 0.4, 2);
    this.threatIcon.add(threatLight);
    this.threatIcon.visible = false;
    this.theater.add(this.threatIcon);

    this.holoStatic = new ParticleEmitter('holoStatic', { radius: 0.35 });
    this.holoStatic.points.position.y = 0.05;
    holo.add(this.holoStatic.points);
    this.holoStatic.start();
    this.holoLight = new THREE.PointLight(0xffc85a, 1.2, 1.6, 2);
    this.holoLight.position.y = 0.25;
    holo.add(this.holoLight);
  }

  attachEngine(engine) {
    super.attachEngine(engine);
    engine.events.on('decision', (d) => {
      this._onDecision(d);
      this.verify.invalidate();
    });
    engine.events.on('debrief', (d) => this._onDebrief(d));
    engine.events.on('readback', (e) => {
      this.verify.invalidate();
      if (e.type === 'open') sfx.tick();
      else if (e.type === 'result') {
        if (e.result.state === 'correction') sfx.error();
        // Pre-flight check-off: a verified code ticks that station's item.
        if (e.result.state === 'verified' && engine.preflight) {
          const item = this.values.checklist.find((c) => c.role === e.result.role);
          if (item && !item.done) {
            item.done = true;
            this.values.checklistDone = this.values.checklist.every((x) => x.done);
          }
        }
        this.sitrep.invalidate();
        this.status.invalidate();
      }
    });
    engine.events.on('preflight', (e) => {
      if (e.verified) {
        sfx.confirm();
        this.bridge?.flash(0x6dff9c, 12, 1.5);
      }
      this.sitrep.invalidate();
      this.verify.invalidate();
      this.status.invalidate();
    });
  }

  canEngage() {
    return !!this.engine?.readyToEngage;
  }

  _drawVerify(ctx, w, h, p) {
    const eng = this.engine;
    const rb = eng?.readback;
    const win = rb?.active;
    const t = eng?.timer.t ?? 0;
    p.header('READBACK VERIFICATION', '#7dff9a');

    if (!win) {
      p.text('NO READBACK WINDOW OPEN', 14, 60, { size: 20, color: PALETTE.screenDim, weight: 'bold' });
      wrapText(p, 'When a window opens, have each tasked station read its CONFIG CODE. Type it on the keypad and press ENT.', 14, 90, w - 28, 14, PALETTE.screenFg, 3);
      this._drawLastReadback(p, w, h, 150);
      return;
    }

    p.text(win.title, 14, 52, { size: 18, color: PALETTE.amber, weight: 'bold' });
    if (win.until == null) p.text('NO TIME LIMIT', w - 14, 54, { size: 14, align: 'right', color: PALETTE.screenFg });
    else p.text(`CLOSES ${TimerManager.format(win.until)}  ·  ${Math.max(0, Math.ceil(win.until - t))}s`, w - 14, 54, { size: 14, align: 'right', color: t > win.until - 15 ? PALETTE.red : PALETTE.screenFg });

    const exp = rb.expectations(eng.ctx);
    if (!exp) {
      p.text('SELECT A ROUTE ON THE HOLO-TABLE FIRST', 14, 84, { size: 16, color: PALETTE.red, weight: 'bold' });
      p.text('Codes cannot be verified until the route sets the required configuration.', 14, 108, { size: 13, color: PALETTE.screenFg });
      this._drawLastReadback(p, w, h, 150);
      return;
    }

    let y = 82;
    const colW = (w - 28) / 2;
    CREW.forEach((role, i) => {
      const x = 14 + (i % 2) * colW;
      const yy = y + Math.floor(i / 2) * 40;
      const rule = exp[role];
      const st = rb.roleStatus(win.id, role);
      const standby = !rule || rule.standby;
      const state = standby ? 'standby' : st.state;
      const col = state === 'verified' ? PALETTE.green : state === 'correction' || state === 'garbled' ? PALETTE.red : state === 'standby' ? PALETTE.screenDim : PALETTE.amber;
      const label = { verified: 'VERIFIED', correction: 'CORRECTION NEEDED', garbled: 'GARBLED — REPEAT', standby: 'STANDBY · N/A', pending: 'AWAITING CODE' }[state] ?? state.toUpperCase();
      p.text(role, x, yy, { size: 14, color: roleHex(role), weight: 'bold' });
      p.text(label, x + 118, yy, { size: 14, color: col, weight: 'bold' });
      const detail = state === 'correction' ? st.hints[0]?.label : state === 'verified' ? st.code : standby ? 'no task on this route' : '';
      if (detail) p.text(detail, x + 118, yy + 17, { size: 12, color: PALETTE.screenDim });
    });
    if (win.until == null && rb.allVerified(win.id, eng.ctx)) {
      const yy = y + 86;
      ctx.fillStyle = 'rgba(109,255,156,0.10)';
      ctx.fillRect(8, yy - 6, w - 16, h - yy);
      p.text('ALL STATIONS VERIFIED — ENGAGE ARMED', 14, yy, { size: 17, color: PALETTE.green, weight: 'bold' });
      p.text('Count the crew in: "3, 2, 1, ENGAGE" — all consoles press together.', 14, yy + 24, { size: 13, color: PALETTE.white });
      return;
    }
    this._drawLastReadback(p, w, h, y + 86);
  }

  _drawLastReadback(p, w, h, y) {
    const res = this.engine?.lastReadback;
    if (!res) return;
    const ctx = p.ctx;
    ctx.fillStyle = res.state === 'verified' ? 'rgba(125,255,154,0.08)' : res.state === 'correction' || res.state === 'garbled' ? 'rgba(255,90,106,0.10)' : 'rgba(255,255,255,0.05)';
    ctx.fillRect(8, y - 6, w - 16, h - y);
    const who = res.role ?? 'UNKNOWN';
    if (res.state === 'verified') {
      p.text(`${who} · VERIFIED  ${res.code}`, 14, y, { size: 15, color: PALETTE.green, weight: 'bold' });
      p.text('Tell them: "Verified, stand by." Move to the next station.', 14, y + 20, { size: 13, color: PALETTE.screenFg });
      return;
    }
    if (res.state === 'correction') {
      p.text(`${who} · CORRECTION NEEDED  (${res.hints.length} item${res.hints.length > 1 ? 's' : ''})`, 14, y, { size: 15, color: PALETTE.red, weight: 'bold' });
      let yy = y + 20;
      for (const m of res.hints.slice(0, 2)) {
        p.text(`${m.label}: reads ${m.actual} — needs ${m.expected}`, 14, yy, { size: 13, color: PALETTE.white });
        wrapText(p, `Tell them: ${m.hint}`, 14, yy + 16, w - 28, 12, PALETTE.amber, 2);
        yy += 46;
      }
      return;
    }
    p.text(`${who} · ${res.state.toUpperCase().replace('-', ' ')}`, 14, y, { size: 15, color: PALETTE.amber, weight: 'bold' });
    wrapText(p, res.reason ?? '', 14, y + 20, w - 28, 13, PALETTE.screenFg, 2);
  }

  _clearNodes() {
    for (const n of this.nodes) n.show(false);
    this._retired = (this._retired ?? []).concat(this.nodes);
    this.nodes = [];
  }

  _spawnNodes(items, { arcZ = 0.3, spread = 0.26 }) {
    this._clearNodes();
    const n = items.length;
    items.forEach((item, i) => {
      const x = (i - (n - 1) / 2) * spread;
      const node = new HoloNode({ id: item.id, label: item.label, sub: item.sub, color: item.color, radius: n > 3 ? 0.055 : 0.075, onSelect: () => item.onSelect(node) });
      node.root.position.set(x, 0.006, arcZ);
      node.baseY = 0.006;
      this.addControl(node, this.holo);
      node.show(true);
      this.nodes.push(node);
    });
  }

  _onDecision(d) {
    this.sitrep.invalidate();
    this.keyScreen.invalidate();
    if (!d) {
      this._clearNodes();
      return;
    }
    if (d.chosen) {
      for (const n of this.nodes) n.setSelected(n.id === d.chosen);
      return;
    }
    this._spawnNodes(
      d.options.map((o) => ({
        id: o.id, label: o.label.replace(/^[ABC] · /, ''), sub: o.style ? `ROUTE ${o.style}` : '', color: BRANCH_COLORS[o.style] ?? 0xffc85a,
        onSelect: () => this.engine.choose(d.id, o.id),
      })),
      { arcZ: 0.3, spread: d.options.length > 2 ? 0.24 : 0.3 }
    );
  }

  _onDebrief(db) {
    this.sitrep.invalidate();
    if (!db) {
      this._clearNodes();
      return;
    }
    if (db.chosen) {
      for (const n of this.nodes) n.setSelected(n.id === db.chosen);
      return;
    }
    this._spawnNodes(
      db.options.map((o) => ({ id: o.id, label: o.label, sub: 'CREW REPORT', color: o.id.match(/impact|hit/) ? 0xff5a6a : 0x7dff9a, onSelect: () => this.engine.debrief(db.id, o.id) })),
      { arcZ: 0.3, spread: 0.3 }
    );
  }

  showChecklist(items) {
    this.values.checklist = items.map((item, i) => {
      if (typeof item === 'string') {
        return { id: `chk${i}`, role: null, label: item.split(':')[0]?.trim() ?? `#${i + 1}`, call: item, verify: 'Reports ready.', done: false };
      }
      const meta = ROLE_META[item.role];
      return {
        id: `chk${i}`,
        role: item.role,
        label: meta?.label ?? item.role ?? `#${i + 1}`,
        call: item.call,
        verify: item.verify ?? 'Reports ready.',
        done: false,
      };
    });
    this.values.checklistDone = false;
    // Items are checked off by verified CONFIG CODEs, not by tapping nodes.
    this.sitrep.invalidate();
  }

  setThreat(t) {
    this.values.threat = t;
    this.threatIcon.visible = true;
    this.space.setMarker('threat', { bearing: t.bearing, pitch: t.pitch, kind: t.kind, distance: t.kind === 'asteroid' ? 140 : 90 });
    this.sitrep.invalidate();
  }

  clearThreat() {
    this.values.threat = null;
    this.threatIcon.visible = false;
    this.space.removeMarker('threat');
    this.sitrep.invalidate();
  }

  update(dt) {
    super.update(dt);
    this.holoStatic.update(dt);
    if (this._retired?.length) {
      // Nodes finish their sink animation via the InteractionManager, then get freed.
      this._retired = this._retired.filter((n) => {
        if (n.root.visible) return true;
        this.interaction.remove(n);
        this.holo.remove(n.root);
        this.controls = this.controls.filter((c) => c !== n);
        return false;
      });
    }
    this._t = (this._t ?? 0) + dt;
    this.sweep.rotation.z = -this._t * 1.1;
    this.holoLight.intensity = 1.1 + Math.sin(this._t * 3) * 0.1;
    const th = this.values.threat;
    if (th) {
      const dir = SpaceScape.direction(th.bearing, th.pitch);
      this.threatIcon.position.set(dir.x * 0.3, dir.y * 0.12, dir.z * 0.3);
      this.threatIcon.rotation.y += dt * 2;
    }
    this._clock = (this._clock ?? 0) + dt;
    if (this._clock > 0.5) {
      this._clock = 0;
      this.sitrep.invalidate();
      if (this.engine?.readback.active) this.verify.invalidate();
    }
  }

  _drawSitrep(ctx, w, h, p) {
    const s = this.ship;
    p.header('SITREP · GLOBAL SHIP STATUS', this.tintHex());
    // Health block
    p.bar(14, 50, w / 2 - 24, 18, s.hull / 100, { color: s.hull > 50 ? PALETTE.green : PALETTE.red, label: `HULL ${s.hull.toFixed(0)}%` });
    p.bar(w / 2 + 6, 50, w / 2 - 20, 18, s.shieldAverage / 100, { color: PALETTE.screenFg, label: `SHIELDS ${s.shieldAverage.toFixed(0)}%` });
    const comps = ['WEAPONS', 'THRUSTERS', 'SHIELDS', 'SENSORS'];
    comps.forEach((c, i) => {
      const ok = s.power[c] && (s.breakers[c] ?? true) && s.breakers.MAIN;
      p.text(`${ok ? '●' : '○'} ${c}`, 14 + i * (w - 28) / 4, 76, { size: 12, color: ok ? PALETTE.green : PALETTE.red });
    });
    const lock = [...s.lockouts];
    if (lock.length) p.text(`LOCKOUT: ${lock.join(', ')}`, w - 14, 76, { size: 12, align: 'right', color: PALETTE.red, weight: 'bold' });

    let y = 100;
    const d = this.engine?.activeDecision;
    const db = this.engine?.activeDebrief;
    if (d) {
      ctx.fillStyle = 'rgba(255,200,90,0.08)';
      ctx.fillRect(8, y - 4, w - 16, h - y - 6);
      p.text(`DECISION · ${d.title}`, 14, y, { size: 16, color: PALETTE.amber, weight: 'bold' });
      y += 22;
      p.text('SITUATION', 14, y, { size: 12, color: PALETTE.screenDim });
      wrapText(p, d.situation, 100, y, w - 120, 13, PALETTE.white, 2);
      y += 36;
      const opt = d.chosen ? d.options.find((o) => o.id === d.chosen) : null;
      if (!opt) {
        p.text('Tap a route node on the table. Each route embeds a different key.', 14, y, { size: 13, color: PALETTE.screenFg });
        y += 22;
        d.options.forEach((o) => {
          p.text(`${o.style ? o.style + ' · ' : ''}${o.label.replace(/^[ABC] · /, '')}`, 22, y, { size: 13, color: '#' + (BRANCH_COLORS[o.style] ?? 0xffc85a).toString(16).padStart(6, '0') });
          y += 18;
        });
      } else {
        p.text('INTENT', 14, y, { size: 12, color: PALETTE.screenDim });
        wrapText(p, opt.intent, 100, y, w - 120, 13, PALETTE.white, 2);
        y += 30;
        p.text('KEY', 14, y, { size: 12, color: PALETTE.screenDim });
        p.text(opt.code, 100, y - 4, { size: 22, color: PALETTE.white, weight: 'bold' });
        y += 30;
        p.text('DIRECTIVES — speak these, with the key:', 14, y, { size: 12, color: PALETTE.screenDim });
        y += 18;
        for (const [role, text] of Object.entries(opt.directives)) {
          const col = '#' + ROLE_META[role].color.toString(16).padStart(6, '0');
          p.text(role, 14, y, { size: 12, color: col, weight: 'bold' });
          wrapText(p, text, 110, y, w - 124, 12, PALETTE.white, 2);
          y += 30;
        }
      }
      return;
    }
    if (db) {
      p.text(db.title, 14, y, { size: 16, color: PALETTE.amber, weight: 'bold' });
      wrapText(p, db.prompt, 14, y + 22, w - 28, 13, PALETTE.white, 2);
      p.text('Tap the matching node on the table.', 14, y + 60, { size: 13, color: PALETTE.screenFg });
      return;
    }
    if (this.values.checklist.length && this.engine?.preflight && this.values.checklistDone) {
      ctx.fillStyle = 'rgba(109,255,156,0.10)';
      ctx.fillRect(8, y - 4, w - 16, h - y - 6);
      p.text('ALL STATIONS VERIFIED', 14, y, { size: 18, color: PALETTE.green, weight: 'bold' });
      y += 26;
      wrapText(p, 'ENGAGE is armed on your console. Tell the crew: "All stations verified. Hands on ENGAGE. 3… 2… 1… ENGAGE." Everyone presses together.', 14, y, w - 28, 14, PALETTE.white, 4);
      y += 80;
      for (const c of this.values.checklist) p.text(`■ ${c.label}`, 14, (y += 17) - 17, { size: 13, color: PALETTE.green });
      return;
    }
    if (this.values.checklist.length && !this.values.checklistDone) {
      p.text('PRE-FLIGHT CHECK-OFF', 14, y, { size: 16, color: PALETTE.amber, weight: 'bold' });
      p.text('NO CLOCK · CODES CHECK OFF ITEMS', w - 14, y + 2, { size: 11, align: 'right', color: PALETTE.screenDim });
      y += 22;

      const current = this.values.checklist.find((c) => !c.done);
      if (current) {
        const col = current.role && ROLE_META[current.role] ? '#' + ROLE_META[current.role].color.toString(16).padStart(6, '0') : PALETTE.white;
        p.text(`NOW → ${current.label}`, 14, y, { size: 15, color: col, weight: 'bold' });
        y += 20;
        wrapText(p, current.call, 14, y, w - 28, 14, PALETTE.white, 3);
        y += 48;
        p.text(`LISTEN FOR: ${current.verify}`, 14, y, { size: 12, color: PALETTE.amber });
        y += 22;
      }

      for (const c of this.values.checklist) {
        const col = c.done ? PALETTE.green : PALETTE.screenDim;
        const mark = c.done ? '■' : '□';
        p.text(`${mark} ${c.label}`, 14, y, { size: 13, color: col, weight: c.done ? 'normal' : 'bold' });
        y += 17;
      }
      return;
    }
    const th = this.values.threat;
    if (th) {
      p.text(`THREAT: ${th.kind.toUpperCase()}  BRG ${String(th.bearing).padStart(3, '0')}  PITCH ${th.pitch}`, 14, y, { size: 15, color: PALETTE.red, weight: 'bold' });
      y += 24;
    }
    p.text('SHIP LOG', 14, y, { size: 12, color: PALETTE.screenDim });
    y += 18;
    for (const e of s.log.slice(-6).reverse()) {
      const col = e.level === 'critical' ? PALETTE.red : e.level === 'warn' ? PALETTE.amber : e.level === 'ok' ? PALETTE.green : PALETTE.screenFg;
      p.text(`${String(Math.floor(e.t / 60)).padStart(2, '0')}:${String(Math.floor(e.t % 60)).padStart(2, '0')} ${e.text}`, 14, y, { size: 12, color: col });
      y += 17;
    }
  }
}
