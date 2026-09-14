# BRIDGE // CRM Simulator

A 5-player, asymmetric, cooperative WebXR bridge simulator. Five standalone headsets, **zero networking**. The only "sync" between headsets is the crew's voices: the Captain reads keys, vectors and frequencies off the Holo-Table, the crew verifies them on physical 3D controls, and everyone starts the deterministic scenario clock together on a spoken "3, 2, 1... ENGAGE!".

Built with Three.js + Vite. Runs on Meta Quest (Browser), any WebXR headset, or a desktop browser in test mode.

---

## Quick start

```bash
npm install
npm run bake      # offline AO / lightmap bake -> public/baked/bridge-ao.json (already committed)
npm run dev       # https://<your-lan-ip>:5173  (self-signed cert; accept it once per headset)
npm test          # deterministic sim + scenario unit tests (Node)
npm run build     # static production build in dist/
npm run preview   # serve dist/ over https
```

WebXR requires a secure context, so both `dev` and `preview` serve over HTTPS via `@vitejs/plugin-basic-ssl`.

### Deploying fully offline

The game never contacts a server at runtime. Two ways to run it with no network at all:

1. **Local https server on any machine in the room** (a laptop, a Pi): `npm run build && npm run preview --host`. Each headset loads the page once; the service worker (`public/sw.js`) caches every asset, so subsequent launches work even with Wi-Fi off. On Quest, "Add to Home" installs it as a PWA.
2. **Sideload**: copy `dist/` onto each headset and serve it locally with any static https server app. Same result.

### Desktop test mode

Open the page in a desktop browser. Drag to look, click to press, drag on dials / levers / joysticks / cables. Shortcuts: `1`–`5` pick a role, `R` recenters, `Enter` advances READY → ENGAGE, `Esc` opens the pause menu (Resume / Main Menu · Change Role). In VR, the Quest **B** (right) or **Y** (left) button toggles the same menu.

---

## Session flow (what the players do)

```
Room (no headsets)   Assign 1 Captain + Helm, Tactical, Science, Engineering. Sit at physical stations.
Role select          Briefing podium: tap your pre-assigned role plate.        (RoleSelectPodium)
Calibrate            The station loads; tap RECENTER SEATED VIEW until the console is square in front of you,
                     then STATION READY.                                       (StandbyPedestal, XRRig.recenter)
Standby              High-contrast STANDBY / WAITING FOR ENGAGE display + ENGAGE button.
ENGAGE               Captain counts aloud. All 5 tap together. Each headset's TimerManager starts at t = 00:00.
Running              Scenario injects fire at exact timestamps. Captain speaks Situation / Intent / Directives with
                     embedded keys; crew executes on physical controls; stations verify locally.
                     B / Y (Quest) or Esc opens pause → Resume or Main Menu / Change Role.
Complete             MISSION SUCCESS / FAILED banner + per-station grade. STAND DOWN returns to role select.
```

---

## Architecture

```
src/
  main.js                       entry, service worker registration
  core/
    App.js                      phase state machine ROLE_SELECT → CALIBRATE → STANDBY → RUNNING → COMPLETE
    XRRig.js                    renderer, XR session, camera rig, recenter, FFR, desktop mouse-look
    Interaction.js              InteractionManager + Interactable base (controllers, hand pinch/poke, mouse)
    Constants.js                roles, seat positions, palette
    Audio.js                    procedural SFX / alarm (no asset downloads)
    EventBus.js
  sim/                          DOM-free, unit-tested
    TimerManager.js             fixed-step deterministic clock (1/60 s), time-ordered inject schedule
    ScenarioEngine.js           injects, decisions, debriefs, task windows, branch grouping, consequences
    ShipState.js                local ship truth: hull, shield arcs, power buses, breakers, thermal, attitude, lockouts
    Verification.js             verifyCode / verifyDial / verifyHeading / verifyVector / routing / grading
  scenario/
    shakedown.js                "Midshipmen Shakedown Cruise" — 3 phases, 00:00 → 03:00
  controls/                     diegetic 3D controls (no 2D overlay anywhere)
    PushButton, RotaryDial, Lever, Keypad, Joystick, PatchCable(+Socket), BreakerSwitch, IndicatorLight,
    HoloNode, ScreenPanel (canvas texture inside a physical bezel), Label, Materials
  stations/
    StationBase.js              seat frame, status/orders screen, ACK STANDBY, master alarm, lockout, damage FX
    CaptainStation.js           Holo-Table theater, decision / debrief / checklist nodes, command key display
    HelmStation.js              dual sticks, throttle, flight HUD, markers & threats through the viewport
    TacticalStation.js          keypad, modulation dials, shield arcs, PD handle, torpedo launch, reticle
    ScienceStation.js           wave dial, holographic beat display, spectrum analyzer, SENSOR LOCK, decoded readout
    EngineeringStation.js       power wall: 5 sockets, 2 cables, 5 breakers, vent lever, coolant valve, thermal
  environment/
    BridgeGeometry.js           DOM-free static bridge (all boxes → analytic occluders), console shells, seats
    AOBaker.js                  per-vertex AO + shadowed static direct light against OBB occluders
    Bridge.js                   runtime assembly, baked colour application, viewport glass, cove strips, key lights
    SpaceScape.js               FBM nebula dome, starfield, streaming dust, ion trails, markers/threats
    Particles.js                pooled emitters: sparks, steam, smoke, holo static; DamageFX bundle
  ui/
    RoleSelectPodium.js         role plates + recenter
    StandbyPedestal.js          calibrate → standby/ENGAGE → result
tools/bake-ao.mjs               `npm run bake` (Node) → public/baked/bridge-ao.json
tests/sim.test.mjs              `npm test`
```

### Zero locomotion, 1:1 seated alignment

`XRRig` uses the `local-floor` reference space. The camera lives in a rig `Group`; `recenter(seat)` moves the rig so the operator's current head XZ and yaw land exactly on the station seat while hands stay 1:1 tracked. Nothing in the game moves the rig otherwise.

### Deterministic clock

`TimerManager` accumulates real frame time and consumes it in fixed 1/60 s steps. Injects, task windows, decisions and debriefs are scheduled at absolute scenario times and fire in strict order inside the step. Five headsets ENGAGEd on the same spoken cue therefore run identical timelines regardless of individual frame rate (72 vs 90 Hz makes no difference to *when* anything happens). `tests/sim.test.mjs` asserts this.

### Local truth + closed-loop CRM

Each headset runs its own `ShipState` and only sees its own console. Three mechanics make cross-station consequences work with no data link:

- **Branch grouping.** Only the Captain's headset knows which route was chosen. On crew headsets, all alternatives for a decision are merged into one task ("ASTEROID — AWAIT DIRECTIVE"). It succeeds when *any* alternative verifies (the operator did what the Captain actually ordered) **or** when the operator presses **ACK STANDBY** inside the window (the Captain told them to stand by). Failing to do either applies the penalty locally.
- **Readback verification (`src/sim/Readback.js`).** Every crew console has a live **CONFIG CODE** readout (e.g. `T-034000-L`) that losslessly encodes its current configuration: auth keys accepted, dial frequencies, heading/pitch/throttle, cable routing, breakers, thermal. When a station has executed a directive the operator reads the code to the Captain, who types it on the base-32 keypad at the Holo-Table. The Captain's headset decodes the exact configuration and compares it with what the *chosen route* requires. The verification screen shows **VERIFIED**, or **CORRECTION NEEDED** with the offending field, its actual vs. required value, and a hint to relay ("Tell them: enter ALPHA-1 on the auth keypad…"). A weighted checksum catches misheard characters (**GARBLED — REPEAT**) instead of producing a false correction; the alphabet omits I and O. Roles with no task on the chosen route report **STANDBY · N/A**. Each phase has a Captain task to verify all tasked stations before the window closes.
- **Captain debrief nodes.** After each execution window the Holo-Table raises CREW REPORT nodes (CLEARED / IMPACT, DRONE DESTROYED / WE TOOK THE HIT). If every tasked station was verified by readback, the report auto-resolves to the success option; otherwise the Captain asks the crew, taps the answer, and the Captain's global ship health reflects the room's reality.

### Rendering budget (standalone headsets)

- **Baked lighting.** `npm run bake` computes per-vertex AO (cosine-weighted hemisphere, 128 samples) plus shadowed direct light from six static bridge lights, against the bridge treated as a list of oriented boxes. Result is multiplied into the PBR base colour via `vertexColors`. No lightmap textures, no shadow maps at runtime. If the baked file is missing, the headset does a 10-sample bake on device.
- **Dynamic lights are local and few.** Screens, indicators, sockets, strobes and the holo-table carry small-radius `PointLight`s so hands and consoles are lit by the state of the ship. Only the selected station's controls exist in the scene.
- **Fixed Foveated Rendering** at maximum (`renderer.xr.setFoveation(1.0)`), ACES tone mapping, no MSAA beyond default.
- **Particles** are single-draw-call `Points` pools. **Nebula** is one dome with a 4-slice FBM march. Dust / ion trails are `Points` / `LineSegments`.

---

## Stations and controls

| Station | Physical controls | Exclusive telemetry | Verified values |
|---|---|---|---|
| **Command** | Holo-Table decision / debrief / checklist hex nodes, ACK | Theater map, global hull & shields, component status, Situation / Intent / Directives, **command keys** | Route chosen in window, checklist complete |
| **Helm** | Left stick (pitch/yaw), right stick (roll/trim), throttle lever | Bearing tape, pitch ladder, roll, target reticle, debris/collision lights | `ship.attitude` vs ordered vector (±4–5°) |
| **Tactical** | Alnum keypad, LASER/TORPEDO dial, ECM dial, 4 shield-arc buttons, ECM JAM, POINT DEFENSE spring handle, TORPEDO LAUNCH latch handle | Target lock reticle, shield arc strengths, INBOUND LOCK, arming lights | `acceptedKeys`, `laserFreq`/`ecmFreq` (±3 MHz), `pdFired`, `launchedAt`, `jamming` |
| **Science** | WAVE TUNING dial, SENSOR LOCK button, holographic beat display | Spectrum analyzer with raw signal peaks, decoded frequency readout | `lockedFreq` == signal (±3 MHz) |
| **Engineering** | 2 patch cables × 5 sockets (WEAPONS, THRUSTERS, SHIELDS, SENSORS, AUXILIARY), breakers MAIN/WEAPONS/THRUSTERS/SHIELDS/BOOST, THERMAL VENT lever, COOLANT valve | Reactor thermal gauge & rate, bus voltages, breaker states | `ship.power[bus]`, breakers, `thermal < 100` |

Keys typed on the keypad accept the full form (`DELTA-9`), spaced (`delta 9`) or shorthand (`D9`).

### Consequences

- **Asteroid window missed** → 10% shield drain on all arcs.
- **Drone window missed** → 18% plasma hit on the FORE arc. If shields are unpowered (Engineering moved the SHIELDS cable) or facing the wrong arc (Tactical), the hull takes it directly.
- **Reactor thermal ≥ 100% for 6 s** → Engineering **CRITICAL LOCKOUT**: controls frozen, red strobe, sparks, smoke, steam, alarm; MAIN breaker trips. The station comes back after 25 s ("adjacent operator takes over").
- **Thermal ≥ 112%** → WEAPONS relay blows.

---

## Scenario: Midshipmen Shakedown Cruise (`src/scenario/shakedown.js`)

| t | Event | Who acts | Verified value |
|---|---|---|---|
| 00:10 | Crew diagnostic checklist on Holo-Table | Captain | taps 4 nodes as crew reports |
| 00:20 | Raw buoy signal | Science | wave dial → **100 MHz**, calls it out |
| 00:30 | Laser calibration | Tactical | LASER dial → 100 MHz |
| 00:40 | Alignment marker X:050 Y:000 | Helm | bearing 050, pitch 0 |
| 00:50 | Breaker stability | Engineering | AUX cable → THRUSTERS |
| 01:00 | **Rogue asteroid** | Captain picks BLAST IT (key **ALPHA-1**: Tactical PD + Science lock 215 MHz) or EVADE IT (**VECTOR 180**: Helm turn + Engineering BOOST) | window closes 01:45, else −10% shields |
| 01:46 | Crew report | Captain | CLEARED / IMPACT |
| 02:00 | **Armed drone lock** | all alerted | |
| 02:10 | Combat route | Captain: A kinetic **DELTA-9** / B electronic **ECHO-3** / C escape **WARP-7 · VECTOR 270** | |
| 02:30 | Execute | Science decodes **340 MHz**; Tactical keys DELTA-9, dial 340; Engineering cable → WEAPONS; Helm reticle 320/+10 | |
| 02:45 | Fire | Tactical pulls launch handle → drone destroyed | window closes 02:55 |
| 02:52 | Crew report | Captain | DESTROYED / WE TOOK THE HIT |
| 03:00 | Mission complete | all | grade per station |

Codes and frequencies live in `KEYS` at the top of the scenario file and are displayed only on the station that owns them. Adding a scenario means adding another file with the same shape (`injects`, `decisions`, `debriefs`, `tasks`, `step`, `end`) and pointing `App.js` at it.

---

## Adding a control or a station

- Subclass `Interactable`, build meshes under `this.root`, mark decorative meshes `userData.hittable = false`, implement `onPressStart / onDrag / onPressEnd`. Pointers are uniform records (`origin`, `direction`, `quaternion`, `tip`, `hasTip`) so one implementation serves controllers, hands and the mouse.
- Register through `station.addControl(ctrl, mount)`; `panelMount / deskMount / uprightMount` give you correctly oriented frames on the console shell.
- Expose what the scenario should verify on `station.values`; write `check(ctx)` predicates in the scenario.
- If you add static geometry to `BridgeGeometry.js`, keep it as boxes and run `npm run bake`.
