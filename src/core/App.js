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
 *   ROLE_SELECT → CALIBRATE → STANDBY → RUNNING → COMPLETE → ROLE_SELECT
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

    this.space = new SpaceScape(this.scene);
    this.bridge = new Bridge(this.scene);
    this.ship = new ShipState();
    this.timer = new TimerManager();

    this._buildPodium();
    this.xr.recenter(PODIUM_SEAT);
    this._bindDom();

    bus.on('xr:sessionstart', () => {
      sfx.unlock();
      this.xr.recenter(this.role ? STATION_SEATS[this.role] : PODIUM_SEAT);
    });
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
      onEngage: () => this.engage(),
    });
    this.station.group.add(this.pedestal.group);
    bus.emit('app:phase', this.phase);
  }

  _onReady() {
    this.phase = APP_PHASE.STANDBY;
    bus.emit('app:phase', this.phase);
  }

  engage() {
    if (this.phase !== APP_PHASE.STANDBY) return;
    this.phase = APP_PHASE.RUNNING;
    this.pedestal.hide();
    this.engine = new ScenarioEngine({ scenario: shakedown, timer: this.timer, ship: this.ship, role: this.role, station: this.station });
    this.station.attachEngine(this.engine);
    this.engine.events.on('complete', (summary) => this._complete(summary));
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

  // ---- frame -------------------------------------------------------------

  _frame() {
    const dt = Math.min(0.1, this.clock.getDelta());
    this.interaction.update(dt);
    if (this.phase === APP_PHASE.RUNNING) this.timer.advance(dt);
    this.podium?.update(dt);
    this.pedestal?.update(dt);
    this.station?.update(dt);
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
      const idx = Number(e.key) - 1;
      if (idx >= 0 && idx < ROLE_ORDER.length && this.phase === APP_PHASE.ROLE_SELECT) this.selectRole(ROLE_ORDER[idx]);
      if (e.key === 'r' || e.key === 'R') this.xr.recenter(this.role ? STATION_SEATS[this.role] : PODIUM_SEAT);
      if (e.key === 'Enter' && this.phase === APP_PHASE.CALIBRATE) {
        this.pedestal.setPhase('STANDBY');
        this._onReady();
      } else if (e.key === 'Enter' && this.phase === APP_PHASE.STANDBY) this.engage();
    });
    window.addEventListener('pointerdown', () => sfx.unlock(), { once: true });
  }
}
