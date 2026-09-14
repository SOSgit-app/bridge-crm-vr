import * as THREE from 'three';
import { XRRig } from './XRRig.js';
import { InteractionManager } from './Interaction.js';
import { APP_PHASE, ROLES, ROLE_ORDER, STATION_SEATS } from './Constants.js';
import { bus } from './EventBus.js';
import { sfx } from './Audio.js';
import { Bridge } from '../environment/Bridge.js';
import { SpaceScape } from '../environment/SpaceScape.js';
import { ShipState } from '../sim/ShipState.js';
import { TimerManager } from '../sim/TimerManager.js';
import { ScenarioEngine } from '../sim/ScenarioEngine.js';
import { shakedown, KEYS } from '../scenario/shakedown.js';
import { RoleSelectPodium, PODIUM_SEAT } from '../ui/RoleSelectPodium.js';
import { StandbyPedestal } from '../ui/StandbyPedestal.js';
import { PauseMenu } from '../ui/PauseMenu.js';
import { CaptainStation } from '../stations/CaptainStation.js';
import { HelmStation } from '../stations/HelmStation.js';
import { TacticalStation } from '../stations/TacticalStation.js';
import { ScienceStation } from '../stations/ScienceStation.js';
import { EngineeringStation } from '../stations/EngineeringStation.js';

const STATION_CLASSES = {
  [ROLES.CAPTAIN]: CaptainStation,
  [ROLES.HELM]: HelmStation,
  [ROLES.TACTICAL]: TacticalStation,
  [ROLES.SCIENCE]: ScienceStation,
  [ROLES.ENGINEERING]: EngineeringStation,
};

const LOCKOUT_RESTORE_SECONDS = 25;

/**
 * Top-level state machine:
 *   ROLE_SELECT → CALIBRATE → PREFLIGHT → RUNNING → COMPLETE → ROLE_SELECT
 * One headset, one role, one local ship model. Synchronisation with the
 * other four headsets is purely human: the Captain's verbal "ENGAGE".
 */
export class App {
  constructor(container) {
    this.xr = new XRRig(container);
    this.scene = this.xr.scene;
    this.interaction = new InteractionManager(this.xr);
    this.clock = new THREE.Clock();
    this.phase = APP_PHASE.ROLE_SELECT;
    this.role = null;
    this.station = null;
    this.engine = null;
    this.pedestal = null;
    this.paused = false;

    this.space = new SpaceScape(this.scene);
    this.bridge = new Bridge(this.scene);
    this.ship = new ShipState();
    this.timer = new TimerManager();

    this.pauseMenu = new PauseMenu({
      interaction: this.interaction,
      onResume: () => this.resume(),
      onMainMenu: () => this.returnToMainMenu(),
    });
    // Sit in front of the camera so it stays readable in seated VR.
    this.pauseMenu.root.position.set(0, 0, -0.85);
    this.xr.camera.add(this.pauseMenu.root);

    this._buildPodium();
    this.xr.recenter(PODIUM_SEAT);
    this._bindDom();

    bus.on('xr:sessionstart', () => {
      sfx.unlock();
      this.xr.recenter(this.role ? STATION_SEATS[this.role] : PODIUM_SEAT);
    });
    bus.on('station:engage', () => this.engage());
    this.ship.events.on('lockout', ({ role }) => {
      // "Adjacent operator takes over": the frozen station comes back after a
      // fixed interval so the drill can continue.
      this.timer.at(this.timer.t + LOCKOUT_RESTORE_SECONDS, (t) => this.ship.restore(role, t), `restore:${role}`);
    });

    this.bridge.loadBakedLighting().then((r) => console.info(`[Bridge] baked lighting: ${r.source} (${r.applied} meshes)`));
    this.xr.setAnimationLoop(() => this._frame());
  }

  // ---- phases ------------------------------------------------------------

  _buildPodium() {
    this.podium = new RoleSelectPodium({
      interaction: this.interaction,
      onSelect: (role) => this.selectRole(role),
      onRecenter: () => this.xr.recenter(PODIUM_SEAT),
    });
    this.scene.add(this.podium.group);
  }

  selectRole(role) {
    if (this.phase !== APP_PHASE.ROLE_SELECT) return;
    sfx.unlock();
    sfx.confirm();
    this.role = role;
    this.phase = APP_PHASE.CALIBRATE;
    this.podium?.dispose();
    this.podium = null;

    const Station = STATION_CLASSES[role];
    this.station = new Station({ role, interaction: this.interaction, ship: this.ship, spaceScape: this.space, bridge: this.bridge });
    this.station.build();
    this.station.setAuthKeys?.([KEYS.ASTEROID_KEY, KEYS.DRONE_ARM_KEY, KEYS.DRONE_ECM_KEY, KEYS.DRONE_WARP_KEY]);
    this.scene.add(this.station.group);

    const seat = STATION_SEATS[role];
    this.xr.recenter(seat);

    this.pedestal = new StandbyPedestal({
      role,
      interaction: this.interaction,
      seated: seat.seated,
      onRecenter: () => this.xr.recenter(seat),
      onReady: () => this._onReady(),
    });
    this.station.group.add(this.pedestal.group);
    bus.emit('app:phase', this.phase);
  }

  /**
   * STATION READY → pre-flight. The pedestal drops, the console goes live and
   * pre-flight orders go out. No clock runs: the Captain verifies every
   * station's CONFIG CODE, which arms ENGAGE on the Captain's console.
   */
  _onReady() {
    if (this.phase !== APP_PHASE.CALIBRATE) return;
    this.phase = APP_PHASE.PREFLIGHT;
    this.pedestal.hide();
    this.engine = new ScenarioEngine({ scenario: shakedown, timer: this.timer, ship: this.ship, role: this.role, station: this.station });
    this.station.attachEngine(this.engine);
    this.engine.events.on('complete', (summary) => this._complete(summary));
    this.engine.startPreflight();
    this.station.setPreflight(true);
    bus.emit('app:phase', this.phase);
  }

  /** ENGAGE on the Captain's spoken count: every headset starts its clock at 00:00. */
  engage() {
    if (this.phase !== APP_PHASE.PREFLIGHT || !this.engine) return;
    if (!this.station.canEngage()) return;
    this.phase = APP_PHASE.RUNNING;
    this.station.setPreflight(false);
    this.engine.start(); // t = 00:00
    bus.emit('app:phase', this.phase);
  }

  _complete(summary) {
    this.phase = APP_PHASE.COMPLETE;
    this.bridge.flash(summary.success ? 0x6dff9c : 0xff4c5b, 30, 2);
    summary.success ? sfx.engage() : sfx.error();
    this.pedestal.showResult(summary, () => this.standDown());
    bus.emit('app:phase', this.phase);
  }

  standDown() {
    this._closePauseMenu();
    this.engine?.dispose();
    this.engine = null;
    this.pedestal?.dispose();
    this.pedestal = null;
    this.station?.dispose();
    this.station = null;
    this.space.removeMarker('threat');
    this.space.removeMarker('helm-marker');
    this.space.setAttitude(new THREE.Quaternion());
    this.ship.reset();
    this.role = null;
    this.phase = APP_PHASE.ROLE_SELECT;
    this._buildPodium();
    this.xr.recenter(PODIUM_SEAT);
    bus.emit('app:phase', this.phase);
  }

  /** Pause menu → role select (main menu / change stations). */
  returnToMainMenu() {
    this.standDown();
  }

  togglePauseMenu() {
    if (this.phase === APP_PHASE.ROLE_SELECT) return;
    if (this.paused) this.resume();
    else this.pause();
  }

  pause() {
    if (this.phase === APP_PHASE.ROLE_SELECT || this.paused) return;
    this.paused = true;
    this._setStationInteractive(false);
    const labels = {
      [APP_PHASE.CALIBRATE]: 'Calibrating view',
      [APP_PHASE.PREFLIGHT]: 'Pre-flight check-off',
      [APP_PHASE.RUNNING]: `Mission paused · T+${TimerManager.format(this.timer.t)}`,
      [APP_PHASE.COMPLETE]: 'Mission complete',
    };
    this.pauseMenu.setContext({ role: this.role, phaseLabel: labels[this.phase] ?? this.phase });
    this.pauseMenu.show();
  }

  resume() {
    if (!this.paused) return;
    this.paused = false;
    this.pauseMenu.hide();
    this._setStationInteractive(true);
  }

  _closePauseMenu() {
    if (!this.paused) return;
    this.paused = false;
    this.pauseMenu.hide();
  }

  _setStationInteractive(enabled) {
    if (this.station) {
      for (const c of this.station.controls) {
        if (typeof c.setEnabled !== 'function') continue;
        if (!enabled) {
          c.setEnabled(false);
          continue;
        }
        // ENGAGE is only live while shown in pre-flight (and armed).
        if (c === this.station.engageButton) {
          c.setEnabled(c.root.visible && this.station.canEngage());
          continue;
        }
        // Preserve lockout: only ACK stays live when the station is frozen.
        if (this.station.locked && c !== this.station.ackButton) c.setEnabled(false);
        else c.setEnabled(true);
      }
    }
    if (!this.pedestal) return;
    if (!enabled) {
      for (const c of this.pedestal.controls) c.setEnabled?.(false);
      return;
    }
    if (this.phase === APP_PHASE.CALIBRATE) this.pedestal.setPhase('CALIBRATE');
    else if (this.phase === APP_PHASE.COMPLETE) {
      for (const c of this.pedestal.controls) c.setEnabled?.(c === this.pedestal.ready);
    } else {
      for (const c of this.pedestal.controls) c.setEnabled?.(false);
    }
  }

  // ---- frame -------------------------------------------------------------

  _frame() {
    const dt = Math.min(0.1, this.clock.getDelta());
    if (this.xr.pollMenuButton()) this.togglePauseMenu();
    this.interaction.update(dt);
    if (this.phase === APP_PHASE.RUNNING && !this.paused) this.timer.advance(dt);
    if (this.phase === APP_PHASE.PREFLIGHT && !this.paused) this.engine?.tickPreflight(dt);
    this.podium?.update(dt);
    if (!this.paused) this.pedestal?.update(dt);
    if (!this.paused) this.station?.update(dt);
    this.pauseMenu.update(dt);
    this.bridge.update(dt);
    this.space.update(dt);
    this.xr.render();
  }

  // ---- DOM ---------------------------------------------------------------

  _bindDom() {
    const boot = document.getElementById('boot');
    if (boot) {
      boot.style.opacity = '0';
      setTimeout(() => boot.remove(), 700);
    }
    const btn = document.createElement('button');
    btn.id = 'xr-button';
    document.body.appendChild(btn);
    const supported = navigator.xr?.isSessionSupported?.('immersive-vr') ?? Promise.resolve(false);
    supported.then((ok) => {
      if (!ok) {
        btn.textContent = 'VR NOT AVAILABLE · DESKTOP TEST MODE';
        btn.disabled = true;
        return;
      }
      btn.textContent = 'ENTER VR';
      btn.onclick = async () => {
        btn.disabled = true;
        try {
          const session = await this.xr.requestSession();
          btn.textContent = 'IN VR';
          session.addEventListener('end', () => {
            btn.disabled = false;
            btn.textContent = 'ENTER VR';
          });
        } catch (err) {
          console.error(err);
          btn.disabled = false;
          btn.textContent = 'ENTER VR (retry)';
        }
      };
    });

    // Desktop test shortcuts
    window.addEventListener('keydown', (e) => {
      sfx.unlock();
      if (e.key === 'Escape') {
        this.togglePauseMenu();
        return;
      }
      if (this.paused) return;
      const idx = Number(e.key) - 1;
      if (idx >= 0 && idx < ROLE_ORDER.length && this.phase === APP_PHASE.ROLE_SELECT) this.selectRole(ROLE_ORDER[idx]);
      if (e.key === 'r' || e.key === 'R') this.xr.recenter(this.role ? STATION_SEATS[this.role] : PODIUM_SEAT);
      if (e.key === 'Enter' && this.phase === APP_PHASE.CALIBRATE) this._onReady();
      else if (e.key === 'Enter' && this.phase === APP_PHASE.PREFLIGHT) this.engage();
    });
    window.addEventListener('pointerdown', () => sfx.unlock(), { once: true });
  }
}
