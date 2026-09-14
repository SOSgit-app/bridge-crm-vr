import { EventBus } from '../core/EventBus.js';
import { ROLES } from '../core/Constants.js';
import { gradeFromTasks } from './Verification.js';

/**
 * Runs a time-coded scenario against the local ShipState and the local
 * station. It fires injects, opens/closes task windows, evaluates station
 * verification checks each deterministic step, and applies consequences.
 *
 * Branching: only the Captain's headset knows which decision option was
 * chosen. On crew headsets, all branch alternatives for a decision are
 * merged into one task group that succeeds when ANY alternative is verified
 * or the operator acknowledges STANDBY inside the window (closed-loop CRM).
 */
export class ScenarioEngine {
  constructor({ scenario, timer, ship, role, station }) {
    this.scenario = scenario;
    this.timer = timer;
    this.ship = ship;
    this.role = role;
    this.station = station;
    this.events = new EventBus();
    this.choices = {}; // decisionId -> optionId (Captain only)
    this.tasks = [];
    this.activeDecision = null;
    this.activeDebrief = null;
    this.finished = false;
    this.messages = []; // recent alerts for this station
    this._unsubStep = null;
  }

  get ctx() {
    return {
      t: this.timer.t,
      role: this.role,
      ship: this.ship,
      station: this.station,
      values: this.station?.values ?? {},
      choices: this.choices,
      engine: this,
      chose: (decisionId, optionId) => this.choices[decisionId] === optionId,
    };
  }

  start() {
    const s = this.scenario;
    this.timer.clearSchedule();
    this._buildTasks();

    for (const inj of s.injects) {
      this.timer.at(inj.t, () => this._fireInject(inj), inj.id);
    }
    for (const d of s.decisions ?? []) {
      if (this.role !== ROLES.CAPTAIN) continue;
      this.timer.at(d.t, () => this._openDecision(d), d.id);
      this.timer.at(d.until, () => this._closeDecision(d), `${d.id}:close`);
    }
    for (const db of s.debriefs ?? []) {
      if (this.role !== ROLES.CAPTAIN) continue;
      this.timer.at(db.t, () => this._openDebrief(db), db.id);
      if (db.until) this.timer.at(db.until, () => this._closeDebrief(db), `${db.id}:close`);
    }
    for (const task of this.tasks) {
      this.timer.at(task.from, () => this._activateTask(task), `${task.id}:open`);
      this.timer.at(task.until, () => this._resolveTask(task), `${task.id}:close`);
    }
    if (s.end) this.timer.at(s.end.t, () => this._end(), 'end');

    this._unsubStep = this.timer.onStep((dt, t) => this._step(dt, t));
    this.timer.engage();
    this.events.emit('started');
  }

  dispose() {
    this._unsubStep?.();
    this.timer.stop();
  }

  _buildTasks() {
    const mine = this.scenario.tasks.filter((t) => t.role === this.role);
    const groups = new Map();
    for (const t of mine) {
      const key = t.branch ? `${t.branch.decisionId}:${t.from}` : t.id;
      if (!groups.has(key)) groups.set(key, []);
      groups.get(key).push(t);
    }
    this.tasks = [...groups.entries()].map(([key, alts]) => {
      const first = alts[0];
      return {
        id: key,
        role: this.role,
        from: first.from,
        until: first.until,
        title: alts.length > 1 ? first.groupTitle ?? 'AWAIT CAPTAIN DIRECTIVE' : first.title,
        hint: alts.length > 1 ? first.groupHint ?? 'Execute ordered action or ACK STANDBY' : first.hint ?? '',
        alternatives: alts,
        allowStandby: alts.some((a) => a.allowStandby),
        penalty: first.penalty ?? null,
        state: 'idle', // idle | active | success | failed
        matched: null,
      };
    });
  }

  _activateTask(task) {
    task.state = 'active';
    this.events.emit('task', task);
  }

  _resolveTask(task) {
    if (task.state !== 'active') return;
    task.state = 'failed';
    this.ship.logEvent(this.timer.t, `TASK FAILED: ${task.title}`, 'warn');
    task.penalty?.(this.ctx, task);
    for (const a of task.alternatives) a.onFail?.(this.ctx, task);
    this.events.emit('task', task);
  }

  _step(dt, t) {
    if (this.finished) return;
    for (const task of this.tasks) {
      if (task.state !== 'active') continue;
      let matched = null;
      for (const alt of task.alternatives) {
        // Captain-known branch gating: skip alternatives that were not chosen
        if (this.role === ROLES.CAPTAIN && alt.branch && this.choices[alt.branch.decisionId] !== alt.branch.optionId) continue;
        try {
          if (alt.check(this.ctx)) {
            matched = alt;
            break;
          }
        } catch (err) {
          console.error('task check error', alt.id, err);
        }
      }
      if (!matched && task.allowStandby && this.station?.standbyAckAt != null) {
        const ack = this.station.standbyAckAt;
        if (ack >= task.from && ack <= task.until) matched = { id: 'standby', title: 'STANDBY ACKNOWLEDGED', standby: true };
      }
      if (matched) {
        task.state = 'success';
        task.matched = matched;
        this.ship.logEvent(t, `VERIFIED: ${matched.title}`, 'ok');
        matched.onSuccess?.(this.ctx, task);
        this.events.emit('task', task);
      }
    }
    this.scenario.step?.(this.ctx, dt);
  }

  _fireInject(inj) {
    const to = inj.to ?? ['ALL'];
    if (!to.includes('ALL') && !to.includes(this.role)) return;
    const message = typeof inj.message === 'function' ? inj.message(this.ctx) : inj.message;
    const entry = { id: inj.id, t: inj.t, title: inj.title, message, level: inj.level ?? 'info' };
    this.messages.unshift(entry);
    if (this.messages.length > 6) this.messages.pop();
    inj.action?.(this.ctx);
    this.ship.logEvent(inj.t, `${inj.title}`, inj.level ?? 'info');
    this.events.emit('inject', entry);
  }

  _openDecision(d) {
    this.activeDecision = { ...d, chosen: null };
    this.events.emit('decision', this.activeDecision);
  }

  choose(decisionId, optionId) {
    const d = this.activeDecision;
    if (!d || d.id !== decisionId || d.chosen) return false;
    const opt = d.options.find((o) => o.id === optionId);
    if (!opt) return false;
    d.chosen = optionId;
    this.choices[decisionId] = optionId;
    this.ship.logEvent(this.timer.t, `DECISION ${decisionId}: ${opt.label}`, 'ok');
    opt.onChoose?.(this.ctx);
    this.events.emit('decision', d);
    return true;
  }

  _closeDecision(d) {
    if (this.activeDecision?.id === d.id) {
      if (!this.activeDecision.chosen) this.ship.logEvent(this.timer.t, `DECISION ${d.id}: no route selected`, 'warn');
      this.activeDecision = null;
      this.events.emit('decision', null);
    }
  }

  _openDebrief(db) {
    this.activeDebrief = { ...db, chosen: null };
    this.events.emit('debrief', this.activeDebrief);
  }

  debrief(debriefId, optionId) {
    const db = this.activeDebrief;
    if (!db || db.id !== debriefId || db.chosen) return false;
    const opt = db.options.find((o) => o.id === optionId);
    if (!opt) return false;
    db.chosen = optionId;
    opt.effect?.(this.ctx);
    this.ship.logEvent(this.timer.t, `CREW REPORT ${debriefId}: ${opt.label}`, 'info');
    this.events.emit('debrief', db);
    setTimeout(() => {
      if (this.activeDebrief?.id === debriefId) {
        this.activeDebrief = null;
        this.events.emit('debrief', null);
      }
    }, 1500);
    return true;
  }

  _closeDebrief(db) {
    if (this.activeDebrief?.id === db.id) {
      this.activeDebrief = null;
      this.events.emit('debrief', null);
    }
  }

  _end() {
    this.finished = true;
    for (const t of this.tasks) if (t.state === 'active') this._resolveTask(t);
    const grade = gradeFromTasks(this.tasks);
    const summary = {
      grade,
      tasks: this.tasks.map((t) => ({ title: t.title, state: t.state })),
      hull: this.ship.hull,
      shields: this.ship.shieldAverage,
      success: this.ship.alive && this.scenario.end?.success?.(this.ctx) !== false,
    };
    this.ship.logEvent(this.timer.t, `SCENARIO COMPLETE — ${grade}`, 'ok');
    this.events.emit('complete', summary);
  }
}
