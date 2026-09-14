import { ROLES } from '../core/Constants.js';
import { verifyCode, verifyDial, verifyHeading, verifyVector } from '../sim/Verification.js';

const { CAPTAIN, HELM, TACTICAL, SCIENCE, ENGINEERING } = ROLES;

// Expected values exchanged verbally. Displayed ONLY on the station that
// owns them; verified on the station that must act on them.
export const KEYS = Object.freeze({
  BUOY_FREQ: 100,
  ASTEROID_KEY: 'ALPHA-1',
  ASTEROID_VECTOR: 180,
  ASTEROID_RETURN_FREQ: 215,
  DRONE_ARM_KEY: 'DELTA-9',
  DRONE_ECM_KEY: 'ECHO-3',
  DRONE_WARP_KEY: 'WARP-7',
  DRONE_SHIELD_FREQ: 340,
  DRONE_ESCAPE_VECTOR: 270,
  DRONE_BEARING: 320,
  DRONE_PITCH: 10,
  MARKER: { bearing: 50, pitch: 0 },
});

const asteroidPenalty = (ctx) => {
  ctx.ship.drainShields(10, ctx.t, 'ASTEROID SCRAPE');
  ctx.station?.onImpact?.('ASTEROID SCRAPE — SHIELDS -10%');
};

const dronePenalty = (ctx) => {
  ctx.ship.applyDamage(18, { arc: 'FORE', source: 'DRONE PLASMA HIT', t: ctx.t });
  ctx.station?.onImpact?.('DRONE HIT — TAKING FIRE');
};

export const shakedown = {
  id: 'shakedown',
  title: 'MIDSHIPMEN SHAKEDOWN CRUISE',
  duration: 180,

  injects: [
    { t: 0, id: 'engage', title: 'ENGAGE — SHAKEDOWN CRUISE UNDERWAY', message: 'All stations: run Phase 1 systems check.', level: 'ok' },
    {
      t: 10, id: 'checklist', to: [CAPTAIN], title: 'CREW DIAGNOSTIC CHECKLIST', level: 'info',
      message: 'Read each station\'s check aloud in order. Tap the Holo-Table node when that station reports ready.',
      action: (ctx) =>
        ctx.station.showChecklist?.([
          {
            role: SCIENCE,
            call: 'Science — tune the wave dial to the navigation buoy and call out the frequency.',
            verify: 'They call "100 MHz" (or lock confirmed).',
          },
          {
            role: TACTICAL,
            call: 'Tactical — set laser modulation to the buoy frequency Science just called.',
            verify: 'They confirm laser matched to buoy.',
          },
          {
            role: HELM,
            call: 'Helm — put the nose on the calibration marker, X:050 Y:000.',
            verify: 'They confirm aligned on marker.',
          },
          {
            role: ENGINEERING,
            call: 'Engineering — move the Auxiliary patch cable to Thrusters and confirm the breaker holds.',
            verify: 'They confirm Thrusters bus live.',
          },
        ]),
    },
    {
      t: 20, id: 'buoy-signal', to: [SCIENCE], title: 'RAW SIGNAL DETECTED', level: 'info',
      message: 'Navigation buoy carrier on the analyzer. Tune the wave dial until the trace locks, then call the frequency to the bridge.',
      action: (ctx) => ctx.station.setSignal?.({ freq: KEYS.BUOY_FREQ, label: 'NAV BUOY', width: 6 }),
    },
    { t: 30, id: 'laser-cal', to: [TACTICAL], title: 'LASER CALIBRATION', level: 'info', message: 'Set laser modulation to the buoy frequency called out by Science.' },
    {
      t: 40, id: 'helm-align', to: [HELM], title: 'ALIGNMENT MARKER', level: 'info', message: 'Align the nose with the static marker at X:050 Y:000.',
      action: (ctx) => ctx.station.setMarker?.({ bearing: KEYS.MARKER.bearing, pitch: KEYS.MARKER.pitch, label: 'CAL MARKER' }),
    },
    { t: 50, id: 'eng-breaker', to: [ENGINEERING], title: 'BREAKER STABILITY CHECK', level: 'info', message: 'Move the AUXILIARY patch cable to the THRUSTERS bus and confirm the breaker holds.' },

    {
      t: 60, id: 'asteroid', title: 'ROGUE ASTEROID — COLLISION COURSE', level: 'critical',
      message: 'Impact in 45 seconds. Await the Captain\'s directive.',
      action: (ctx) => {
        ctx.station.setThreat?.({ kind: 'asteroid', bearing: 10, pitch: -5, eta: 45 });
        ctx.station.setSignal?.({ freq: KEYS.ASTEROID_RETURN_FREQ, label: 'ASTEROID RETURN', width: 5 });
      },
    },
    { t: 105, id: 'asteroid-window', title: 'ASTEROID EXECUTION WINDOW CLOSED', level: 'warn', message: 'Outcome determined by station actions.', action: (ctx) => ctx.station.clearThreat?.() },

    {
      t: 120, id: 'drone-lock', title: 'ARMED DRONE — TARGET LOCK ON US', level: 'critical',
      message: 'Hostile drone has acquired a weapons lock. Captain to select combat route.',
      action: (ctx) => {
        ctx.station.setThreat?.({ kind: 'drone', bearing: KEYS.DRONE_BEARING, pitch: KEYS.DRONE_PITCH, eta: 60, lock: true });
        ctx.station.setSignal?.({ freq: KEYS.DRONE_SHIELD_FREQ, label: 'DRONE SHIELD MOD', width: 4 });
      },
    },
    { t: 130, id: 'drone-route', to: [CAPTAIN], title: 'SELECT COMBAT ROUTE', level: 'warn', message: 'Three routes on the Holo-Table. Choose, then issue directives with the embedded key.' },
    { t: 150, id: 'drone-exec', title: 'EXECUTE', level: 'warn', message: 'Execution window open. Verify all called values now.' },
    { t: 165, id: 'drone-fire', to: [TACTICAL], title: 'FIRE WHEN READY', level: 'critical', message: 'Pull the launch handle once torpedoes are armed and modulated.' },
    { t: 180, id: 'complete', title: 'MISSION COMPLETE', level: 'ok', message: 'Shakedown cruise concluded. Stand down from stations.' },
  ],

  decisions: [
    {
      id: 'asteroid', t: 60, until: 105, title: 'ROGUE ASTEROID',
      situation: 'Asteroid on collision course, impact T+45s.',
      options: [
        {
          id: 'blast', label: 'BLAST IT', style: 'A', code: KEYS.ASTEROID_KEY,
          intent: 'Clear the rock with point-defense.',
          directives: { TACTICAL: `Unlock point-defense with ${KEYS.ASTEROID_KEY}, pull PD handle`, SCIENCE: `Lock sensors on asteroid return (${KEYS.ASTEROID_RETURN_FREQ} MHz)`, HELM: 'Hold course', ENGINEERING: 'Hold power' },
        },
        {
          id: 'evade', label: 'EVADE IT', style: 'C', code: `VECTOR ${KEYS.ASTEROID_VECTOR}`,
          intent: 'Break hard away from the rock.',
          directives: { HELM: `Come hard to bearing ${KEYS.ASTEROID_VECTOR}`, ENGINEERING: 'Cable to THRUSTERS + BOOST breaker on', TACTICAL: 'Stand by', SCIENCE: 'Stand by' },
        },
      ],
    },
    {
      id: 'drone', t: 130, until: 165, title: 'ARMED DRONE — COMBAT ROUTE',
      situation: 'Drone has weapons lock. Plasma strike expected T+50s.',
      options: [
        {
          id: 'kinetic', label: 'A · OFFENSIVE / KINETIC', style: 'A', code: KEYS.DRONE_ARM_KEY,
          intent: 'Kill the drone with a modulated torpedo.',
          directives: { TACTICAL: `Unlock torpedoes with ${KEYS.DRONE_ARM_KEY}, match modulation to Science, pull launch`, SCIENCE: 'Get me their shield frequency', ENGINEERING: 'Weapons maximum power', HELM: 'Put the drone in the reticle' },
        },
        {
          id: 'ewar', label: 'B · ELECTRONIC / STEALTH', style: 'B', code: KEYS.DRONE_ECM_KEY,
          intent: 'Jam the lock and slip away.',
          directives: { SCIENCE: 'Get me their shield frequency', TACTICAL: `ECM protocol ${KEYS.DRONE_ECM_KEY}, jam on their frequency`, ENGINEERING: 'Power to SENSORS', HELM: 'Hold steady' },
        },
        {
          id: 'escape', label: 'C · EVASIVE / ESCAPE', style: 'C', code: `${KEYS.DRONE_WARP_KEY} · VECTOR ${KEYS.DRONE_ESCAPE_VECTOR}`,
          intent: 'Warp out before the strike.',
          directives: { HELM: `Vector ${KEYS.DRONE_ESCAPE_VECTOR}, full throttle`, ENGINEERING: 'Cable to THRUSTERS, BOOST on', TACTICAL: `Warp override ${KEYS.DRONE_WARP_KEY}`, SCIENCE: 'Stand by' },
        },
      ],
    },
  ],

  debriefs: [
    {
      id: 'asteroid-report', t: 106, until: 119, title: 'CREW REPORT — ASTEROID',
      prompt: 'Ask the crew: was the directive executed in the window?',
      options: [
        { id: 'cleared', label: 'CLEARED', effect: (ctx) => ctx.ship.logEvent(ctx.t, 'Asteroid cleared per crew report', 'ok') },
        { id: 'impact', label: 'IMPACT', effect: asteroidPenalty },
      ],
    },
    {
      id: 'drone-report', t: 172, until: 180, title: 'CREW REPORT — DRONE',
      prompt: 'Ask Tactical: did the shot connect?',
      options: [
        { id: 'destroyed', label: 'DRONE DESTROYED', effect: (ctx) => ctx.ship.logEvent(ctx.t, 'Drone destroyed per crew report', 'ok') },
        { id: 'hit', label: 'WE TOOK THE HIT', effect: dronePenalty },
      ],
    },
  ],

  tasks: [
    // ---- Phase 1: systems check (no penalty) -----------------------------
    { id: 'sci-buoy', role: SCIENCE, from: 20, until: 60, title: 'TUNE BUOY CARRIER', hint: `Wave dial → lock, then call it out`, check: (c) => verifyDial(c.values.waveFreq, KEYS.BUOY_FREQ, 2) },
    { id: 'tac-laser-cal', role: TACTICAL, from: 30, until: 60, title: 'MATCH LASER TO BUOY', hint: 'Laser dial to Science\'s frequency', check: (c) => verifyDial(c.values.laserFreq, KEYS.BUOY_FREQ, 2) },
    { id: 'helm-marker', role: HELM, from: 40, until: 60, title: 'NOSE ON MARKER X:050 Y:000', hint: 'Bearing 050, pitch 0', check: (c) => verifyVector(c.ship.attitude, KEYS.MARKER, { bearingTol: 4, pitchTol: 4 }) },
    { id: 'eng-thrusters', role: ENGINEERING, from: 50, until: 60, title: 'AUX CABLE → THRUSTERS', hint: 'Re-seat cable, breaker must hold', check: (c) => c.values.cableMoved === true && c.ship.power.THRUSTERS && c.ship.breakers.THRUSTERS },
    { id: 'cap-checklist', role: CAPTAIN, from: 10, until: 60, title: 'COMPLETE CREW CHECKLIST', hint: 'Read each call aloud; tap the node when they report ready', check: (c) => c.values.checklistDone === true },

    // ---- Phase 2: asteroid (branch alternatives, 10% shield penalty) ------
    { id: 'tac-pd', role: TACTICAL, from: 60, until: 105, title: 'UNLOCK POINT-DEFENSE', groupTitle: 'ASTEROID — AWAIT DIRECTIVE', groupHint: 'PD key + handle, or ACK STANDBY', branch: { decisionId: 'asteroid', optionId: 'blast' }, allowStandby: true, penalty: asteroidPenalty,
      check: (c) => c.values.acceptedKeys?.has(KEYS.ASTEROID_KEY) && c.values.pdFired === true },
    { id: 'sci-asteroid', role: SCIENCE, from: 60, until: 105, title: 'SENSOR LOCK ON ASTEROID', groupTitle: 'ASTEROID — AWAIT DIRECTIVE', groupHint: 'Lock asteroid return, or ACK STANDBY', branch: { decisionId: 'asteroid', optionId: 'blast' }, allowStandby: true, penalty: asteroidPenalty,
      check: (c) => c.values.lockedFreq != null && verifyDial(c.values.lockedFreq, KEYS.ASTEROID_RETURN_FREQ, 3) },
    { id: 'helm-evade', role: HELM, from: 60, until: 105, title: 'HARD TURN TO VECTOR 180', groupTitle: 'ASTEROID — AWAIT DIRECTIVE', groupHint: 'Turn to ordered vector, or ACK STANDBY', branch: { decisionId: 'asteroid', optionId: 'evade' }, allowStandby: true, penalty: asteroidPenalty,
      check: (c) => verifyHeading(c.ship.attitude.bearing, KEYS.ASTEROID_VECTOR, 5) },
    { id: 'eng-boost', role: ENGINEERING, from: 60, until: 105, title: 'BOOST THRUSTERS', groupTitle: 'ASTEROID — AWAIT DIRECTIVE', groupHint: 'Thrusters powered + BOOST, or ACK STANDBY', branch: { decisionId: 'asteroid', optionId: 'evade' }, allowStandby: true, penalty: asteroidPenalty,
      check: (c) => c.ship.power.THRUSTERS && c.ship.breakers.BOOST && c.ship.breakers.MAIN },
    { id: 'cap-asteroid', role: CAPTAIN, from: 60, until: 105, title: 'SELECT ASTEROID ROUTE', hint: 'Tap a route node, issue the directive', check: (c) => !!c.choices.asteroid },

    // ---- Phase 3: drone (branch alternatives, hull damage penalty) --------
    { id: 'sci-drone', role: SCIENCE, from: 130, until: 175, title: 'DECODE DRONE SHIELD FREQUENCY', groupTitle: 'DRONE — AWAIT DIRECTIVE', groupHint: 'Decode shield modulation, or ACK STANDBY', branch: { decisionId: 'drone', optionId: 'kinetic' }, allowStandby: true, penalty: dronePenalty,
      check: (c) => c.values.lockedFreq != null && verifyDial(c.values.lockedFreq, KEYS.DRONE_SHIELD_FREQ, 3) },
    { id: 'sci-drone-b', role: SCIENCE, from: 130, until: 175, title: 'DECODE DRONE SHIELD FREQUENCY', branch: { decisionId: 'drone', optionId: 'ewar' }, allowStandby: true, penalty: dronePenalty,
      check: (c) => c.values.lockedFreq != null && verifyDial(c.values.lockedFreq, KEYS.DRONE_SHIELD_FREQ, 3) },
    { id: 'tac-torpedo', role: TACTICAL, from: 130, until: 175, title: 'ARM + MODULATE + LAUNCH', groupTitle: 'DRONE — AWAIT DIRECTIVE', groupHint: 'Key on keypad, dial to Science freq, pull launch', branch: { decisionId: 'drone', optionId: 'kinetic' }, allowStandby: true, penalty: dronePenalty,
      check: (c) => c.values.acceptedKeys?.has(KEYS.DRONE_ARM_KEY) && verifyDial(c.values.laserFreq, KEYS.DRONE_SHIELD_FREQ, 3) && c.values.launchedAt != null && c.values.launchedAt >= 150,
      onSuccess: (c) => c.station.onKill?.('DRONE DESTROYED') },
    { id: 'tac-ecm', role: TACTICAL, from: 130, until: 175, title: 'ECM JAM ON DRONE FREQUENCY', branch: { decisionId: 'drone', optionId: 'ewar' }, allowStandby: true, penalty: dronePenalty,
      check: (c) => c.values.acceptedKeys?.has(KEYS.DRONE_ECM_KEY) && verifyDial(c.values.ecmFreq, KEYS.DRONE_SHIELD_FREQ, 3) && c.values.jamming === true },
    { id: 'tac-warp', role: TACTICAL, from: 130, until: 175, title: 'WARP OVERRIDE KEY', branch: { decisionId: 'drone', optionId: 'escape' }, allowStandby: true, penalty: dronePenalty,
      check: (c) => c.values.acceptedKeys?.has(KEYS.DRONE_WARP_KEY) },
    { id: 'eng-weapons', role: ENGINEERING, from: 130, until: 175, title: 'WEAPONS MAXIMUM POWER', groupTitle: 'DRONE — AWAIT DIRECTIVE', groupHint: 'Route the ordered bus, manage thermal', branch: { decisionId: 'drone', optionId: 'kinetic' }, allowStandby: true, penalty: dronePenalty,
      check: (c) => c.ship.power.WEAPONS && c.ship.breakers.WEAPONS && c.ship.breakers.MAIN && c.ship.thermal < 100 },
    { id: 'eng-sensors', role: ENGINEERING, from: 130, until: 175, title: 'POWER TO SENSORS', branch: { decisionId: 'drone', optionId: 'ewar' }, allowStandby: true, penalty: dronePenalty,
      check: (c) => c.ship.power.SENSORS && c.ship.breakers.MAIN },
    { id: 'eng-warp', role: ENGINEERING, from: 130, until: 175, title: 'THRUSTERS + BOOST FOR WARP', branch: { decisionId: 'drone', optionId: 'escape' }, allowStandby: true, penalty: dronePenalty,
      check: (c) => c.ship.power.THRUSTERS && c.ship.breakers.BOOST && c.ship.breakers.MAIN },
    { id: 'helm-reticle', role: HELM, from: 130, until: 175, title: 'DRONE IN RETICLE', groupTitle: 'DRONE — AWAIT DIRECTIVE', groupHint: 'Put the target in the reticle or fly the ordered vector', branch: { decisionId: 'drone', optionId: 'kinetic' }, allowStandby: true, penalty: dronePenalty,
      check: (c) => verifyVector(c.ship.attitude, { bearing: KEYS.DRONE_BEARING, pitch: KEYS.DRONE_PITCH }, { bearingTol: 5, pitchTol: 5 }) },
    { id: 'helm-escape', role: HELM, from: 130, until: 175, title: 'ESCAPE VECTOR 270 FULL THROTTLE', branch: { decisionId: 'drone', optionId: 'escape' }, allowStandby: true, penalty: dronePenalty,
      check: (c) => verifyHeading(c.ship.attitude.bearing, KEYS.DRONE_ESCAPE_VECTOR, 5) && c.ship.throttle > 0.9 },
    { id: 'cap-drone', role: CAPTAIN, from: 130, until: 165, title: 'SELECT COMBAT ROUTE', hint: 'Choose A / B / C and issue directives', check: (c) => !!c.choices.drone },
  ],

  step: (ctx, dt) => {
    // Engineering must actively manage thermal once weapons are hot.
    const armed = ctx.values.acceptedKeys?.has(KEYS.DRONE_ARM_KEY) ?? false;
    ctx.ship.step(dt, ctx.t, { weaponsArmed: armed, firing: false });
  },

  end: { t: 180, success: (ctx) => ctx.ship.alive },
};
