import * as THREE from 'three';
import { ROLES, STATION_SEATS } from '../core/Constants.js';

/**
 * Static bridge geometry. DOM-free so it can be built inside Node for the
 * offline AO / lightmap bake. Every static part is a (possibly rotated) box
 * so the baker can treat the whole bridge as a list of analytic OBB
 * occluders and stay fast without a BVH.
 *
 * Materials are referenced by key; the runtime swaps in real PBR materials.
 * Geometry is subdivided so per-vertex baked lighting reads as a dense
 * lightmap on the large surfaces.
 */

export const BRIDGE = Object.freeze({
  width: 8.4,
  depth: 7.6,
  height: 3.3,
  frontZ: -3.8,
  backZ: 3.8,
});

// Static cove lights used by the baker for direct-light shadows. The
// runtime does not create these as real lights; their contribution is baked.
export const BAKE_LIGHTS = [
  { position: [-2.4, 3.1, -1.5], color: [0.55, 0.7, 1.0], intensity: 1.2, radius: 5.0 },
  { position: [2.4, 3.1, -1.5], color: [0.55, 0.7, 1.0], intensity: 1.2, radius: 5.0 },
  { position: [-2.4, 3.1, 1.8], color: [0.55, 0.7, 1.0], intensity: 1.0, radius: 5.0 },
  { position: [2.4, 3.1, 1.8], color: [0.55, 0.7, 1.0], intensity: 1.0, radius: 5.0 },
  { position: [0, 2.2, -3.6], color: [0.5, 0.65, 1.0], intensity: 1.6, radius: 6.0 }, // viewport nebula glow
  { position: [0, 1.3, 1.7], color: [1.0, 0.8, 0.45], intensity: 0.5, radius: 2.5 }, // holo-table
];

export const AMBIENT_BAKE = [0.26, 0.29, 0.34];

function segsFor(w, h, d, density) {
  const s = (v) => Math.max(1, Math.min(24, Math.round(v * density)));
  return [s(w), s(h), s(d)];
}

/**
 * Box primitive. `density` = subdivisions per metre. Returns a Mesh with
 * userData.matKey and userData.static for the runtime + baker.
 */
export function box(name, [w, h, d], position, { rotation = [0, 0, 0], matKey = 'hull', density = 6, hittable = false } = {}) {
  const [sx, sy, sz] = segsFor(w, h, d, density);
  const geo = new THREE.BoxGeometry(w, h, d, sx, sy, sz);
  const mesh = new THREE.Mesh(geo);
  mesh.name = name;
  mesh.position.fromArray(position);
  mesh.rotation.set(rotation[0], rotation[1], rotation[2]);
  mesh.userData.matKey = matKey;
  mesh.userData.static = true;
  mesh.userData.occluder = true;
  mesh.userData.hittable = hittable;
  return mesh;
}

export function buildBridgeStatic() {
  const g = new THREE.Group();
  g.name = 'BridgeStatic';
  const { width: W, depth: D, height: H, frontZ, backZ } = BRIDGE;
  const midZ = (frontZ + backZ) / 2;

  // Floor & ceiling
  g.add(box('floor', [W, 0.1, D], [0, -0.05, midZ], { matKey: 'floorGrate', density: 4 }));
  g.add(box('ceiling', [W, 0.1, D], [0, H + 0.05, midZ], { matKey: 'hullDark', density: 4 }));

  // Side walls with angled (chamfered) upper sections
  g.add(box('wall-left', [0.15, H * 0.7, D], [-W / 2 - 0.075, H * 0.35, midZ], { matKey: 'hull', density: 4 }));
  g.add(box('wall-right', [0.15, H * 0.7, D], [W / 2 + 0.075, H * 0.35, midZ], { matKey: 'hull', density: 4 }));
  g.add(box('wall-left-upper', [0.15, H * 0.36, D], [-W / 2 + 0.16, H * 0.85, midZ], { rotation: [0, 0, -0.32], matKey: 'hullDark', density: 4 }));
  g.add(box('wall-right-upper', [0.15, H * 0.36, D], [W / 2 - 0.16, H * 0.85, midZ], { rotation: [0, 0, 0.32], matKey: 'hullDark', density: 4 }));

  // Wall ribs (structural frames) every 1.5m
  for (let i = 0; i < 5; i++) {
    const z = frontZ + 0.8 + i * 1.5;
    g.add(box(`rib-left-${i}`, [0.12, H * 0.72, 0.18], [-W / 2 + 0.07, H * 0.36, z], { matKey: 'trim', density: 6 }));
    g.add(box(`rib-right-${i}`, [0.12, H * 0.72, 0.18], [W / 2 - 0.07, H * 0.36, z], { matKey: 'trim', density: 6 }));
    g.add(box(`rib-top-${i}`, [W - 0.4, 0.14, 0.18], [0, H - 0.08, z], { matKey: 'trim', density: 4 }));
  }

  // Ceiling light coves (recessed troughs). Emissive strips added at runtime.
  g.add(box('cove-left', [0.5, 0.12, D - 1], [-2.4, H - 0.06, midZ], { matKey: 'trim', density: 4 }));
  g.add(box('cove-right', [0.5, 0.12, D - 1], [2.4, H - 0.06, midZ], { matKey: 'trim', density: 4 }));

  // Back wall (aft) with door frame
  g.add(box('wall-back-left', [W / 2 - 0.7, H, 0.15], [-(W / 4 + 0.35), H / 2, backZ + 0.075], { matKey: 'hull', density: 4 }));
  g.add(box('wall-back-right', [W / 2 - 0.7, H, 0.15], [W / 4 + 0.35, H / 2, backZ + 0.075], { matKey: 'hull', density: 4 }));
  g.add(box('door-lintel', [1.4, H - 2.3, 0.15], [0, H - (H - 2.3) / 2, backZ + 0.075], { matKey: 'hull', density: 4 }));
  g.add(box('door', [1.4, 2.3, 0.08], [0, 1.15, backZ + 0.12], { matKey: 'hullDark', density: 6 }));
  g.add(box('door-frame-l', [0.12, 2.4, 0.22], [-0.76, 1.2, backZ + 0.06], { matKey: 'trim', density: 6 }));
  g.add(box('door-frame-r', [0.12, 2.4, 0.22], [0.76, 1.2, backZ + 0.06], { matKey: 'trim', density: 6 }));

  // Front wall: viewport frame. The glass itself is added at runtime (non-occluding).
  const vpW = 5.6;
  const vpH = 1.7;
  const vpY = 1.85;
  g.add(box('front-lower', [W, vpY - vpH / 2, 0.2], [0, (vpY - vpH / 2) / 2, frontZ - 0.1], { matKey: 'hull', density: 4 }));
  g.add(box('front-upper', [W, H - (vpY + vpH / 2), 0.2], [0, (H + vpY + vpH / 2) / 2, frontZ - 0.1], { matKey: 'hull', density: 4 }));
  g.add(box('front-left', [(W - vpW) / 2, vpH, 0.2], [-(vpW / 2 + (W - vpW) / 4), vpY, frontZ - 0.1], { matKey: 'hull', density: 4 }));
  g.add(box('front-right', [(W - vpW) / 2, vpH, 0.2], [vpW / 2 + (W - vpW) / 4, vpY, frontZ - 0.1], { matKey: 'hull', density: 4 }));
  g.add(box('viewport-sill', [vpW + 0.3, 0.12, 0.35], [0, vpY - vpH / 2 - 0.06, frontZ + 0.08], { matKey: 'trim', density: 6 }));
  g.add(box('viewport-header', [vpW + 0.3, 0.12, 0.35], [0, vpY + vpH / 2 + 0.06, frontZ + 0.08], { matKey: 'trim', density: 6 }));
  g.add(box('viewport-mullion', [0.1, vpH, 0.3], [0, vpY, frontZ + 0.05], { matKey: 'trim', density: 6 }));

  // Captain's raised platform & steps
  const cap = STATION_SEATS[ROLES.CAPTAIN].position;
  g.add(box('platform', [3.0, 0.45, 2.2], [cap.x, 0.225, cap.z + 0.1], { matKey: 'hullDark', density: 5 }));
  g.add(box('platform-step', [3.0, 0.22, 0.4], [cap.x, 0.11, cap.z - 1.2], { matKey: 'trim', density: 6 }));
  g.add(box('platform-rail-l', [0.05, 0.9, 2.2], [cap.x - 1.5, 0.9, cap.z + 0.1], { matKey: 'trim', density: 6 }));
  g.add(box('platform-rail-r', [0.05, 0.9, 2.2], [cap.x + 1.5, 0.9, cap.z + 0.1], { matKey: 'trim', density: 6 }));

  // Holo-table pedestal (top surface hosts the volumetric display)
  g.add(box('holotable-base', [1.1, 0.5, 0.8], [cap.x, 0.7, cap.z - 1.05], { matKey: 'trim', density: 8 }));
  g.add(box('holotable-top', [1.3, 0.06, 0.95], [cap.x, 0.98, cap.z - 1.05], { matKey: 'panel', density: 10 }));

  // Station console shells + chairs
  for (const role of Object.values(ROLES)) {
    const shell = buildConsoleShell(role);
    if (shell) g.add(shell);
  }
  return g;
}

/**
 * Console shell in operator-local space (x right, -z forward, y up) placed
 * at the seat. Mount points are documented so stations can attach controls.
 */
export function buildConsoleShell(role) {
  const seat = STATION_SEATS[role];
  const g = new THREE.Group();
  g.name = `shell-${role}`;
  g.position.copy(seat.position);
  g.rotation.y = seat.yaw;
  // Prefix ensures unique mesh names across shells.
  const add = (name, size, pos, opts = {}) => {
    const m = box(`${role}:${name}`, size, pos, opts);
    g.add(m);
    return m;
  };

  if (role === ROLES.CAPTAIN) {
    // Command chair: broad seat, tall back, armrests with control pods
    add('chair-base', [0.5, 0.35, 0.5], [0, 0.175, 0.1], { matKey: 'trim', density: 8 });
    add('chair-seat', [0.7, 0.12, 0.7], [0, 0.41, 0.1], { matKey: 'hullDark', density: 8 });
    add('chair-back', [0.7, 0.9, 0.14], [0, 0.9, 0.5], { matKey: 'hullDark', density: 8 });
    add('arm-l', [0.14, 0.1, 0.55], [-0.42, 0.62, 0.15], { matKey: 'panel', density: 10 });
    add('arm-r', [0.14, 0.1, 0.55], [0.42, 0.62, 0.15], { matKey: 'panel', density: 10 });
    return g;
  }

  if (role === ROLES.HELM || role === ROLES.TACTICAL) {
    // Cockpit style: wrap-around desk, sloped upper panel, side pods
    add('desk', [1.5, 0.12, 0.55], [0, 0.72, -0.72], { matKey: 'panel', density: 8 });
    add('desk-front', [1.5, 0.66, 0.1], [0, 0.33, -0.95], { matKey: 'hullDark', density: 6 });
    add('desk-leg-l', [0.1, 0.66, 0.45], [-0.7, 0.33, -0.72], { matKey: 'hullDark', density: 6 });
    add('desk-leg-r', [0.1, 0.66, 0.45], [0.7, 0.33, -0.72], { matKey: 'hullDark', density: 6 });
    add('upper-panel', [1.5, 0.55, 0.1], [0, 1.08, -1.05], { rotation: [-0.42, 0, 0], matKey: 'panel', density: 8 });
    add('pod-l', [0.3, 0.1, 0.4], [-0.62, 0.7, -0.35], { rotation: [0, 0.35, 0], matKey: 'panel', density: 10 });
    add('pod-r', [0.3, 0.1, 0.4], [0.62, 0.7, -0.35], { rotation: [0, -0.35, 0], matKey: 'panel', density: 10 });
    add('chair-base', [0.3, 0.4, 0.3], [0, 0.2, 0.1], { matKey: 'trim', density: 8 });
    add('chair-seat', [0.52, 0.08, 0.52], [0, 0.44, 0.1], { matKey: 'hullDark', density: 8 });
    add('chair-back', [0.52, 0.6, 0.08], [0, 0.78, 0.36], { matKey: 'hullDark', density: 8 });
    return g;
  }

  if (role === ROLES.SCIENCE) {
    // Sensor lab: desk plus tall analyzer bank behind it
    add('desk', [1.6, 0.1, 0.6], [0, 0.74, -0.7], { matKey: 'panel', density: 8 });
    add('desk-front', [1.6, 0.69, 0.08], [0, 0.345, -0.96], { matKey: 'hullDark', density: 6 });
    add('desk-leg-l', [0.08, 0.69, 0.5], [-0.76, 0.345, -0.7], { matKey: 'hullDark', density: 6 });
    add('desk-leg-r', [0.08, 0.69, 0.5], [0.76, 0.345, -0.7], { matKey: 'hullDark', density: 6 });
    add('bank', [1.7, 1.1, 0.25], [0, 1.4, -1.1], { rotation: [-0.15, 0, 0], matKey: 'panel', density: 6 });
    add('bank-top', [1.8, 0.08, 0.35], [0, 1.98, -1.05], { matKey: 'trim', density: 8 });
    add('chair-base', [0.3, 0.4, 0.3], [0, 0.2, 0.1], { matKey: 'trim', density: 8 });
    add('chair-seat', [0.52, 0.08, 0.52], [0, 0.44, 0.1], { matKey: 'hullDark', density: 8 });
    add('chair-back', [0.52, 0.6, 0.08], [0, 0.78, 0.36], { matKey: 'hullDark', density: 8 });
    return g;
  }

  if (role === ROLES.ENGINEERING) {
    // Standing power-grid wall: big vertical panel + waist-height shelf
    add('wall', [2.2, 2.1, 0.2], [0, 1.35, -0.95], { matKey: 'panel', density: 5 });
    add('wall-frame-l', [0.12, 2.3, 0.3], [-1.12, 1.35, -0.95], { matKey: 'trim', density: 6 });
    add('wall-frame-r', [0.12, 2.3, 0.3], [1.12, 1.35, -0.95], { matKey: 'trim', density: 6 });
    add('wall-header', [2.4, 0.15, 0.3], [0, 2.47, -0.95], { matKey: 'trim', density: 6 });
    add('shelf', [2.2, 0.08, 0.35], [0, 0.95, -0.72], { matKey: 'trim', density: 8 });
    add('shelf-under', [2.2, 0.85, 0.28], [0, 0.48, -0.78], { matKey: 'hullDark', density: 6 });
    add('bus-bar', [1.9, 0.08, 0.1], [0, 2.2, -0.82], { matKey: 'brushed', density: 8 });
    return g;
  }
  return null;
}

/** Collect all occluder meshes (world matrices updated) for the baker. */
export function collectStatic(group) {
  group.updateMatrixWorld(true);
  const list = [];
  group.traverse((o) => {
    if (o.isMesh && o.userData.static) list.push(o);
  });
  return list;
}
