import { ROLES } from '../core/Constants.js';
import { verifyDial, verifyHeading, verifyVector } from '../sim/Verification.js';

const { CAPTAIN, HELM, TACTICAL, SCIENCE, ENGINEERING } = ROLES;

// Expected values exchanged verbally. Displayed ONLY on the station that
// owns them; verified on the station that must act on them.
export const KEYS = Object.freeze({
  BUOY_FREQ: 100,
  ASTEROID_KEY: 'ALPHA-1',
  ASTEROID_VECTOR: 180,
  ASTEROID_RETURN_FREQ: 215,
  ASTEROID_BEARING: 10,
  ASTEROID_PITCH: -5,
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

// Phase 1 (pre-flight) has no clock. Each station configures for its check,
// reads its CONFIG CODE to the Captain, and the Captain verifies all four.
// Only then does the Captain's ENGAGE button arm; the mission clock starts
// when the crew presses ENGAGE together on the Captain's count.
const PREFLIGHT_READBACK = 'systems-check';

export const shakedown = {
  id: 'shakedown',
  title: 'MIDSHIPMEN SHAKEDOWN CRUISE',
  duration: 135,

  preflight: {
    readback: PREFLIGHT_READBACK,
    injects: [
      {
        id: 'pre-checklist', to: [CAPTAIN], title: 'PRE-FLIGHT CHECK-OFF', level: 'info',
        message: 'Read each station\'s check aloud. When they report set, they read their CONFIG CODE — type it on the readback keypad. ENGAGE arms once all four verify.',
        action: (ctx) =>
          ctx.station.showChecklist?.([
            { role: SCIENCE, call: 'Science — tune the wave dial to the navigation buoy carrier and call out the frequency.', verify: 'They call "100 MHz" and read their CONFIG CODE.' },
            { role: TACTICAL, call: 'Tactical — set laser modulation to the buoy frequency Science just called.', verify: 'They confirm laser matched and read their CONFIG CODE.' },
            { role: HELM, call: 'Helm — put the nose on the calibration marker, X:050 Y:000, and hold it.', verify: 'They confirm aligned and read their CONFIG CODE.' },
            { role: ENGINEERING, call: 'Engineering — move the Auxiliary patch cable to Thrusters and confirm the breaker holds.', verify: 'They confirm Thrusters bus live and read their CONFIG CODE.' },
          ]),
      },
      {
        id: 'pre-buoy', to: [SCIENCE], title: 'PRE-FLIGHT · RAW SIGNAL', level: 'info',
        message: 'Navigation buoy carrier on the analyzer. Tune the wave dial until the trace locks, call the frequency, then read your CONFIG CODE to the Captain.',
        action: (ctx) => ctx.station.setSignal?.({ freq: KEYS.BUOY_FREQ, label: 'NAV BUOY', width: 6 }),
      },
      { id: 'pre-laser', to: [TACTICAL], title: 'PRE-FLIGHT · LASER CALIBRATION', level: 'info', message: 'Set laser modulation to the buoy frequency Science calls out, then read your CONFIG CODE to the Captain.' },
      {
        id: 'pre-helm', to: [HELM], title: 'PRE-FLIGHT · ALIGNMENT', level: 'info', message: 'Align the nose with the static marker at X:050 Y:000, hold steady, then read your CONFIG CODE to the Captain.',
        action: (ctx) => ctx.station.setMarker?.({ bearing: KEYS.MARKER.bearing, pitch: KEYS.MARKER.pitch, label: 'CAL MARKER' }),
      },
      { id: 'pre-eng', to: [ENGINEERING], title: 'PRE-FLIGHT · BREAKER CHECK', level: 'info', message: 'Move the AUXILIARY patch cable to the THRUSTERS bus, confirm the breaker holds, then read your CONFIG CODE to the Captain.' },
    ],
    tasks: [
      { id: 'pre-sci-buoy', role: SCIENCE, title: 'TUNE BUOY CARRIER', hint: 'Wave dial → lock · read CONFIG CODE', check: (c) => verifyDial(c.values.waveFreq, KEYS.BUOY_FREQ, 2) },
      { id: 'pre-tac-laser', role: TACTICAL, title: 'MATCH LASER TO BUOY', hint: 'Laser dial to Science\'s frequency · read CONFIG CODE', check: (c) => verifyDial(c.values.laserFreq, KEYS.BUOY_FREQ, 2) },
      { id: 'pre-helm-marker', role: HELM, title: 'NOSE ON MARKER X:050 Y:000', hint: 'Bearing 050, pitch 0 · hold · read CONFIG CODE', check: (c) => verifyVector(c.ship.attitude, KEYS.MARKER, { bearingTol: 4, pitchTol: 4 }) },
      { id: 'pre-eng-thrusters', role: ENGINEERING, title: 'AUX CABLE → THRUSTERS', hint: 'Re-seat cable, breaker must hold · read CONFIG CODE', check: (c) => c.values.cableMoved === true && c.ship.power.THRUSTERS && c.ship.breakers.THRUSTERS },
      { id: 'pre-cap-verify', role: CAPTAIN, title: 'VERIFY ALL 4 STATION CODES', hint: 'Type each CONFIG CODE · ENGAGE arms when all verify', check: (c) => c.readback.allVerified(PREFLIGHT_READBACK, c) },
    ],
    expect: () => ({
      [SCIENCE]: { waveFreq: { value: KEYS.BUOY_FREQ, tol: 2, hint: `Wave dial must sit on the buoy carrier at ${KEYS.BUOY_FREQ} MHz — tune until the trace peaks.` } },
      [TACTICAL]: { laserFreq: { value: KEYS.BUOY_FREQ, tol: 2, hint: `Laser/torpedo mod dial to ${KEYS.BUOY_FREQ} MHz, the frequency Science called.` } },
      [HELM]: {
        bearing: { value: KEYS.MARKER.bearing, tol: 4, wrap: true, hint: 'Yaw the nose onto the CAL MARKER — bearing 050 — and hold it while reading.' },
        pitch: { value: KEYS.MARKER.pitch, tol: 4, hint: 'Level the pitch — marker is at Y:000.' },
      },
      [ENGINEERING]: {
        power: { includes: ['THRUSTERS'], hint: 'Patch cable must be seated in the THRUSTERS socket.' },
        breakers: { includes: ['MAIN', 'THRUSTERS'], hint: 'MAIN and THRUSTERS breakers must be closed (reset if tripped).' },
      },
    }),
  },

  injects: [
    { t: 0, id: 'engage', title: 'ENGAGE — SHAKEDOWN CRUISE UNDERWAY', message: 'Pre-flight complete. Stations hold configuration and stand by for events.', level: 'ok' },

    {
      t: 15, id: 'asteroid', title: 'ROGUE ASTEROID — COLLISION COURSE', level: 'critical',
      message: 'Impact in 45 seconds. Await the Captain\'s directive, then read back your CONFIG CODE.',
      action: (ctx) => {
        ctx.station.setThreat?.({ kind: 'asteroid', bearing: KEYS.ASTEROID_BEARING, pitch: KEYS.ASTEROID_PITCH, eta: 45 });
        ctx.station.setSignal?.({ freq: KEYS.ASTEROID_RETURN_FREQ, label: 'ASTEROID RETURN', width: 5 });
        // Helm: diamond at bearing 180 so "VECTOR 180" is something to put the nose on
        // (same idea as the pre-flight CAL MARKER). For BLAST, put the red ASTEROID box in the reticle instead.
        ctx.station.setMarker?.({ bearing: KEYS.ASTEROID_VECTOR, pitch: 0, label: `VECTOR ${KEYS.ASTEROID_VECTOR}` });
      },
    },
    {
      t: 15, id: 'asteroid-helm', to: [HELM], title: 'HELM — NAV MARKERS UP', level: 'warn',
      message: `Red ASTEROID box = the rock (BLAST → put it in the reticle). Amber VECTOR ${KEYS.ASTEROID_VECTOR} diamond = evade heading (EVADE → nose on the diamond).`,
    },
    {
      t: 60, id: 'asteroid-window', title: 'ASTEROID EXECUTION WINDOW CLOSED', level: 'warn', message: 'Outcome determined by station actions.',
      action: (ctx) => {
        ctx.station.clearThreat?.();
        ctx.station.clearMarker?.();
      },
    },

    {
      t: 75, id: 'drone-lock', title: 'ARMED DRONE — TARGET LOCK ON US', level: 'critical',
      message: 'Hostile drone has acquired a weapons lock. Captain to select combat route.',
      action: (ctx) => {
        ctx.station.setThreat?.({ kind: 'drone', bearing: KEYS.DRONE_BEARING, pitch: KEYS.DRONE_PITCH, eta: 60, lock: true });
        ctx.station.setSignal?.({ freq: KEYS.DRONE_SHIELD_FREQ, label: 'DRONE SHIELD MOD', width: 4 });
        // Escape heading diamond — fly to it only if Cap orders route C.
        ctx.station.setMarker?.({ bearing: KEYS.DRONE_ESCAPE_VECTOR, pitch: 0, label: `VECTOR ${KEYS.DRONE_ESCAPE_VECTOR}` });
      },
    },
    {
      t: 75, id: 'drone-helm', to: [HELM], title: 'HELM — NAV MARKERS UP', level: 'warn',
      message: `Red DRONE box = put in reticle for kinetic. Amber VECTOR ${KEYS.DRONE_ESCAPE_VECTOR} diamond = escape heading for route C. Route B → ACK STANDBY.`,
    },
    { t: 85, id: 'drone-route', to: [CAPTAIN], title: 'SELECT COMBAT ROUTE', level: 'warn', message: 'Three routes on the Holo-Table. Choose, then issue directives with the embedded key.' },
    { t: 105, id: 'drone-exec', title: 'EXECUTE', level: 'warn', message: 'Execution window open. Stations: read your CONFIG CODE to the Captain for verification.' },
    { t: 120, id: 'drone-fire', to: [TACTICAL], title: 'FIRE WHEN READY', level: 'critical', message: 'Pull the launch handle once torpedoes are armed and modulated.' },
    {
      t: 135, id: 'complete', title: 'MISSION COMPLETE', level: 'ok', message: 'Shakedown cruise concluded. Stand down from stations.',
      action: (ctx) => {
        ctx.station.clearThreat?.();
        ctx.station.clearMarker?.();
      },
    },
  ],

  decisions: [
    {
      id: 'asteroid', t: 15, until: 60, title: 'ROGUE ASTEROID',
      situation: 'Asteroid on collision course, impact T+45s.',
      options: [
        {
          id: 'blast', label: 'BLAST IT', style: 'A', code: KEYS.ASTEROID_KEY,
          intent: 'Clear the rock with point-defense.',
          directives: {
            TACTICAL: `Unlock point-defense with ${KEYS.ASTEROID_KEY}, pull PD handle`,
            SCIENCE: `Lock sensors on asteroid return (${KEYS.ASTEROID_RETURN_FREQ} MHz)`,
            HELM: 'Put the ASTEROID box in the reticle and hold it',
            ENGINEERING: 'Hold power — ACK STANDBY',
          },
        },
        {
          id: 'evade', label: 'EVADE IT', style: 'C', code: `VECTOR ${KEYS.ASTEROID_VECTOR}`,
          intent: 'Break hard away from the rock.',
          directives: {
            HELM: `Put the nose on the VECTOR ${KEYS.ASTEROID_VECTOR} marker (bearing ${KEYS.ASTEROID_VECTOR}) and hold it`,
            ENGINEERING: 'Cable to THRUSTERS + BOOST breaker on',
            TACTICAL: 'Stand by',
            SCIENCE: 'Stand by',
          },
        },
      ],
    },
    {
      id: 'drone', t: 85, until: 120, title: 'ARMED DRONE — COMBAT ROUTE',
      situation: 'Drone has weapons lock. Plasma strike expected T+50s.',
      options: [
        {
          id: 'kinetic', label: 'A · OFFENSIVE / KINETIC', style: 'A', code: KEYS.DRONE_ARM_KEY,
          intent: 'Kill the drone with a modulated torpedo.',
          directives: { TACTICAL: `Unlock torpedoes with ${KEYS.DRONE_ARM_KEY}, match modulation to Science, pull launch`, SCIENCE: 'Get me their shield frequency', ENGINEERING: 'Weapons maximum power', HELM: 'Put the DRONE box in the reticle' },
        },
        {
          id: 'ewar', label: 'B · ELECTRONIC / STEALTH', style: 'B', code: KEYS.DRONE_ECM_KEY,
          intent: 'Jam the lock and slip away.',
          directives: { SCIENCE: 'Get me their shield frequency', TACTICAL: `ECM protocol ${KEYS.DRONE_ECM_KEY}, jam on their frequency`, ENGINEERING: 'Power to SENSORS', HELM: 'Hold steady — ACK STANDBY' },
        },
        {
          id: 'escape', label: 'C · EVASIVE / ESCAPE', style: 'C', code: `${KEYS.DRONE_WARP_KEY} · VECTOR ${KEYS.DRONE_ESCAPE_VECTOR}`,
          intent: 'Warp out before the strike.',
          directives: {
            HELM: `Put the nose on the VECTOR ${KEYS.DRONE_ESCAPE_VECTOR} marker, full throttle`,
            ENGINEERING: 'Cable to THRUSTERS, BOOST on',
            TACTICAL: `Warp override ${KEYS.DRONE_WARP_KEY}`,
            SCIENCE: 'Stand by',
          },
        },
      ],
    },
  ],

  // Readback verification windows. Each crew station shows a live CONFIG
  // CODE; the operator reads it to the Captain, who types it on the
  // Holo-Table keypad. The Captain's headset decodes the exact configuration
  // and compares it with what the chosen route requires. Roles marked
  // `standby` have nothing to verify on that route.
  readbacks: [
    {
      id: 'asteroid', from: 15, until: 60, title: 'PHASE 2 · ASTEROID',
      expect: (c) => {
        if (c.choices.asteroid === 'blast') {
          return {
            [TACTICAL]: {
              keys: { includes: [KEYS.ASTEROID_KEY], hint: `Enter ${KEYS.ASTEROID_KEY} on the auth keypad to unlock point-defense.` },
              pdFired: { equals: true, hint: 'Pull the POINT DEFENSE handle after the key is accepted.' },
            },
            [SCIENCE]: { lockedFreq: { value: KEYS.ASTEROID_RETURN_FREQ, tol: 3, hint: `Tune to the asteroid return (${KEYS.ASTEROID_RETURN_FREQ} MHz) and press SENSOR LOCK.` } },
            [HELM]: {
              bearing: { value: KEYS.ASTEROID_BEARING, tol: 5, wrap: true, hint: `Put the ASTEROID box in the reticle — bearing ${String(KEYS.ASTEROID_BEARING).padStart(3, '0')}.` },
              pitch: { value: KEYS.ASTEROID_PITCH, tol: 5, hint: `Pitch to ${KEYS.ASTEROID_PITCH}° so the rock sits in the reticle.` },
            },
            [ENGINEERING]: { standby: true },
          };
        }
        if (c.choices.asteroid === 'evade') {
          return {
            [HELM]: { bearing: { value: KEYS.ASTEROID_VECTOR, tol: 5, wrap: true, hint: `Put the nose on the VECTOR ${KEYS.ASTEROID_VECTOR} marker (amber diamond) and hold it.` } },
            [ENGINEERING]: {
              power: { includes: ['THRUSTERS'], hint: 'Patch cable into the THRUSTERS socket.' },
              breakers: { includes: ['MAIN', 'BOOST'], hint: 'Close the BOOST breaker (and MAIN must be up).' },
            },
            [TACTICAL]: { standby: true },
            [SCIENCE]: { standby: true },
          };
        }
        return null;
      },
    },
    {
      id: 'drone', from: 85, until: 130, title: 'PHASE 3 · DRONE',
      expect: (c) => {
        const sci = { lockedFreq: { value: KEYS.DRONE_SHIELD_FREQ, tol: 3, hint: `Lock the DRONE SHIELD MOD signal at ${KEYS.DRONE_SHIELD_FREQ} MHz.` } };
        if (c.choices.drone === 'kinetic') {
          return {
            [SCIENCE]: sci,
            [TACTICAL]: {
              keys: { includes: [KEYS.DRONE_ARM_KEY], hint: `Enter ${KEYS.DRONE_ARM_KEY} on the auth keypad to arm torpedoes.` },
              laserFreq: { value: KEYS.DRONE_SHIELD_FREQ, tol: 3, hint: `Torpedo modulation dial to Science's frequency (${KEYS.DRONE_SHIELD_FREQ} MHz).` },
            },
            [ENGINEERING]: {
              power: { includes: ['WEAPONS'], hint: 'Patch cable into the WEAPONS socket.' },
              breakers: { includes: ['MAIN', 'WEAPONS'], hint: 'WEAPONS breaker must be closed — reset it if it tripped.' },
              thermal: { max: 95, hint: 'Reactor is running hot — vent / cut BOOST before launch.' },
            },
            [HELM]: {
              bearing: { value: KEYS.DRONE_BEARING, tol: 5, wrap: true, hint: `Put the drone in the reticle — bearing ${KEYS.DRONE_BEARING}.` },
              pitch: { value: KEYS.DRONE_PITCH, tol: 5, hint: `Pitch up to +${KEYS.DRONE_PITCH}° to centre the drone.` },
            },
          };
        }
        if (c.choices.drone === 'ewar') {
          return {
            [SCIENCE]: sci,
            [TACTICAL]: {
              keys: { includes: [KEYS.DRONE_ECM_KEY], hint: `Enter ${KEYS.DRONE_ECM_KEY} on the auth keypad for ECM protocol.` },
              ecmFreq: { value: KEYS.DRONE_SHIELD_FREQ, tol: 3, hint: `ECM jam dial to Science's frequency (${KEYS.DRONE_SHIELD_FREQ} MHz).` },
              jamming: { equals: true, hint: 'Throw the ECM JAM switch on.' },
            },
            [ENGINEERING]: {
              power: { includes: ['SENSORS'], hint: 'Patch cable into the SENSORS socket.' },
              breakers: { includes: ['MAIN'], hint: 'MAIN breaker must be closed.' },
            },
            [HELM]: { standby: true },
          };
        }
        if (c.choices.drone === 'escape') {
          return {
            [HELM]: {
              bearing: { value: KEYS.DRONE_ESCAPE_VECTOR, tol: 5, wrap: true, hint: `Put the nose on the VECTOR ${KEYS.DRONE_ESCAPE_VECTOR} marker.` },
              throttle: { value: 1, tol: 0.1, hint: 'Throttle to the stop — full power.' },
            },
            [ENGINEERING]: {
              power: { includes: ['THRUSTERS'], hint: 'Patch cable into the THRUSTERS socket.' },
              breakers: { includes: ['MAIN', 'BOOST'], hint: 'Close the BOOST breaker for warp.' },
            },
            [TACTICAL]: { keys: { includes: [KEYS.DRONE_WARP_KEY], hint: `Enter warp override ${KEYS.DRONE_WARP_KEY} on the auth keypad.` } },
            [SCIENCE]: { standby: true },
          };
        }
        return null;
      },
    },
  ],

  debriefs: [
    {
      id: 'asteroid-report', t: 61, until: 74, title: 'CREW REPORT — ASTEROID', readback: 'asteroid', autoSuccess: 'cleared',
      prompt: 'Ask the crew: was the directive executed in the window?',
      options: [
        { id: 'cleared', label: 'CLEARED', effect: (ctx) => ctx.ship.logEvent(ctx.t, 'Asteroid cleared per crew report', 'ok') },
        { id: 'impact', label: 'IMPACT', effect: asteroidPenalty },
      ],
    },
    {
      id: 'drone-report', t: 127, until: 135, title: 'CREW REPORT — DRONE', readback: 'drone', autoSuccess: 'destroyed',
      prompt: 'Ask Tactical: did the shot connect?',
      options: [
        { id: 'destroyed', label: 'DRONE DESTROYED', effect: (ctx) => ctx.ship.logEvent(ctx.t, 'Drone destroyed per crew report', 'ok') },
        { id: 'hit', label: 'WE TOOK THE HIT', effect: dronePenalty },
      ],
    },
  ],

  tasks: [
    // ---- Phase 2: asteroid (branch alternatives, 10% shield penalty) ------
    { id: 'tac-pd', role: TACTICAL, from: 15, until: 60, title: 'UNLOCK POINT-DEFENSE', groupTitle: 'ASTEROID — AWAIT DIRECTIVE', groupHint: 'PD key + handle, or ACK STANDBY', branch: { decisionId: 'asteroid', optionId: 'blast' }, allowStandby: true, penalty: asteroidPenalty,
      check: (c) => c.values.acceptedKeys?.has(KEYS.ASTEROID_KEY) && c.values.pdFired === true },
    { id: 'sci-asteroid', role: SCIENCE, from: 15, until: 60, title: 'SENSOR LOCK ON ASTEROID', groupTitle: 'ASTEROID — AWAIT DIRECTIVE', groupHint: 'Lock asteroid return, or ACK STANDBY', branch: { decisionId: 'asteroid', optionId: 'blast' }, allowStandby: true, penalty: asteroidPenalty,
      check: (c) => c.values.lockedFreq != null && verifyDial(c.values.lockedFreq, KEYS.ASTEROID_RETURN_FREQ, 3) },
    { id: 'helm-blast', role: HELM, from: 15, until: 60, title: 'ASTEROID IN RETICLE', groupTitle: 'ASTEROID — AWAIT DIRECTIVE', groupHint: 'BLAST → red box in reticle · EVADE → VECTOR 180 diamond', branch: { decisionId: 'asteroid', optionId: 'blast' }, allowStandby: true, penalty: asteroidPenalty,
      check: (c) => verifyVector(c.ship.attitude, { bearing: KEYS.ASTEROID_BEARING, pitch: KEYS.ASTEROID_PITCH }, { bearingTol: 5, pitchTol: 5 }) },
    { id: 'helm-evade', role: HELM, from: 15, until: 60, title: 'NOSE ON VECTOR 180 MARKER', groupTitle: 'ASTEROID — AWAIT DIRECTIVE', groupHint: 'BLAST → red box in reticle · EVADE → VECTOR 180 diamond', branch: { decisionId: 'asteroid', optionId: 'evade' }, allowStandby: true, penalty: asteroidPenalty,
      check: (c) => verifyHeading(c.ship.attitude.bearing, KEYS.ASTEROID_VECTOR, 5) },
    { id: 'eng-boost', role: ENGINEERING, from: 15, until: 60, title: 'BOOST THRUSTERS', groupTitle: 'ASTEROID — AWAIT DIRECTIVE', groupHint: 'Thrusters powered + BOOST, or ACK STANDBY', branch: { decisionId: 'asteroid', optionId: 'evade' }, allowStandby: true, penalty: asteroidPenalty,
      check: (c) => c.ship.power.THRUSTERS && c.ship.breakers.BOOST && c.ship.breakers.MAIN },
    { id: 'cap-asteroid', role: CAPTAIN, from: 15, until: 60, title: 'SELECT ASTEROID ROUTE', hint: 'Tap a route node, issue the directive', check: (c) => !!c.choices.asteroid },
    { id: 'cap-readback-asteroid', role: CAPTAIN, from: 15, until: 60, title: 'VERIFY ASTEROID READBACKS', hint: 'Collect CONFIG CODES from the tasked stations', check: (c) => c.readback.allVerified('asteroid', c) },

    // ---- Phase 3: drone (branch alternatives, hull damage penalty) --------
    { id: 'sci-drone', role: SCIENCE, from: 85, until: 130, title: 'DECODE DRONE SHIELD FREQUENCY', groupTitle: 'DRONE — AWAIT DIRECTIVE', groupHint: 'Decode shield modulation, or ACK STANDBY', branch: { decisionId: 'drone', optionId: 'kinetic' }, allowStandby: true, penalty: dronePenalty,
      check: (c) => c.values.lockedFreq != null && verifyDial(c.values.lockedFreq, KEYS.DRONE_SHIELD_FREQ, 3) },
    { id: 'sci-drone-b', role: SCIENCE, from: 85, until: 130, title: 'DECODE DRONE SHIELD FREQUENCY', branch: { decisionId: 'drone', optionId: 'ewar' }, allowStandby: true, penalty: dronePenalty,
      check: (c) => c.values.lockedFreq != null && verifyDial(c.values.lockedFreq, KEYS.DRONE_SHIELD_FREQ, 3) },
    { id: 'tac-torpedo', role: TACTICAL, from: 85, until: 130, title: 'ARM + MODULATE + LAUNCH', groupTitle: 'DRONE — AWAIT DIRECTIVE', groupHint: 'Key on keypad, dial to Science freq, pull launch', branch: { decisionId: 'drone', optionId: 'kinetic' }, allowStandby: true, penalty: dronePenalty,
      check: (c) => c.values.acceptedKeys?.has(KEYS.DRONE_ARM_KEY) && verifyDial(c.values.laserFreq, KEYS.DRONE_SHIELD_FREQ, 3) && c.values.launchedAt != null && c.values.launchedAt >= 105,
      onSuccess: (c) => c.station.onKill?.('DRONE DESTROYED') },
    { id: 'tac-ecm', role: TACTICAL, from: 85, until: 130, title: 'ECM JAM ON DRONE FREQUENCY', branch: { decisionId: 'drone', optionId: 'ewar' }, allowStandby: true, penalty: dronePenalty,
      check: (c) => c.values.acceptedKeys?.has(KEYS.DRONE_ECM_KEY) && verifyDial(c.values.ecmFreq, KEYS.DRONE_SHIELD_FREQ, 3) && c.values.jamming === true },
    { id: 'tac-warp', role: TACTICAL, from: 85, until: 130, title: 'WARP OVERRIDE KEY', branch: { decisionId: 'drone', optionId: 'escape' }, allowStandby: true, penalty: dronePenalty,
      check: (c) => c.values.acceptedKeys?.has(KEYS.DRONE_WARP_KEY) },
    { id: 'eng-weapons', role: ENGINEERING, from: 85, until: 130, title: 'WEAPONS MAXIMUM POWER', groupTitle: 'DRONE — AWAIT DIRECTIVE', groupHint: 'Route the ordered bus, manage thermal', branch: { decisionId: 'drone', optionId: 'kinetic' }, allowStandby: true, penalty: dronePenalty,
      check: (c) => c.ship.power.WEAPONS && c.ship.breakers.WEAPONS && c.ship.breakers.MAIN && c.ship.thermal < 100 },
    { id: 'eng-sensors', role: ENGINEERING, from: 85, until: 130, title: 'POWER TO SENSORS', branch: { decisionId: 'drone', optionId: 'ewar' }, allowStandby: true, penalty: dronePenalty,
      check: (c) => c.ship.power.SENSORS && c.ship.breakers.MAIN },
    { id: 'eng-warp', role: ENGINEERING, from: 85, until: 130, title: 'THRUSTERS + BOOST FOR WARP', branch: { decisionId: 'drone', optionId: 'escape' }, allowStandby: true, penalty: dronePenalty,
      check: (c) => c.ship.power.THRUSTERS && c.ship.breakers.BOOST && c.ship.breakers.MAIN },
    { id: 'helm-reticle', role: HELM, from: 85, until: 130, title: 'DRONE IN RETICLE', groupTitle: 'DRONE — AWAIT DIRECTIVE', groupHint: 'Put DRONE box in reticle, or fly VECTOR 270 diamond if ordered to escape', branch: { decisionId: 'drone', optionId: 'kinetic' }, allowStandby: true, penalty: dronePenalty,
      check: (c) => verifyVector(c.ship.attitude, { bearing: KEYS.DRONE_BEARING, pitch: KEYS.DRONE_PITCH }, { bearingTol: 5, pitchTol: 5 }) },
    { id: 'helm-escape', role: HELM, from: 85, until: 130, title: 'NOSE ON VECTOR 270 · FULL THROTTLE', branch: { decisionId: 'drone', optionId: 'escape' }, allowStandby: true, penalty: dronePenalty,
      check: (c) => verifyHeading(c.ship.attitude.bearing, KEYS.DRONE_ESCAPE_VECTOR, 5) && c.ship.throttle > 0.9 },
    { id: 'cap-drone', role: CAPTAIN, from: 85, until: 120, title: 'SELECT COMBAT ROUTE', hint: 'Choose A / B / C and issue directives', check: (c) => !!c.choices.drone },
    { id: 'cap-readback-drone', role: CAPTAIN, from: 85, until: 130, title: 'VERIFY COMBAT READBACKS', hint: 'Collect CONFIG CODES before FIRE / EXECUTE', check: (c) => c.readback.allVerified('drone', c) },
  ],

  step: (ctx, dt) => {
    // Engineering must actively manage thermal once weapons are hot.
    const armed = ctx.values.acceptedKeys?.has(KEYS.DRONE_ARM_KEY) ?? false;
    ctx.ship.step(dt, ctx.t, { weaponsArmed: armed, firing: false });
  },

  end: { t: 135, success: (ctx) => ctx.ship.alive },
};
