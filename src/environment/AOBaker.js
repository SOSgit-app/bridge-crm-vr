import * as THREE from 'three';
import { BAKE_LIGHTS, AMBIENT_BAKE } from './BridgeGeometry.js';

/**
 * Per-vertex ambient-occlusion + static direct-light baker.
 *
 * Every static bridge part is a box, so occlusion is evaluated against a list
 * of analytic oriented bounding boxes (slab test) instead of triangle soup.
 * That keeps the offline bake (tools/bake-ao.mjs) to seconds and lets the
 * headset fall back to a coarse on-device bake if the baked file is missing.
 *
 * Output per mesh: Uint8 RGB per vertex = AO x (ambient + shadowed direct).
 * The runtime multiplies this into the PBR base colour via vertexColors.
 */

class OBB {
  constructor(mesh) {
    const p = mesh.geometry.parameters;
    this.half = new THREE.Vector3(p.width / 2, p.height / 2, p.depth / 2);
    this.center = new THREE.Vector3();
    this.quat = new THREE.Quaternion();
    this.scale = new THREE.Vector3();
    mesh.matrixWorld.decompose(this.center, this.quat, this.scale);
    this.half.multiply(this.scale);
    this.invQuat = this.quat.clone().invert();
    this.mesh = mesh;
    this.radius = this.half.length();
  }

  /** Returns hit distance along the ray or Infinity. */
  intersect(origin, dir, maxDist, o = _o, d = _d) {
    // quick sphere reject
    const cx = this.center.x - origin.x;
    const cy = this.center.y - origin.y;
    const cz = this.center.z - origin.z;
    const t = cx * dir.x + cy * dir.y + cz * dir.z;
    if (t < -this.radius || t - this.radius > maxDist) return Infinity;
    const px = cx - t * dir.x;
    const py = cy - t * dir.y;
    const pz = cz - t * dir.z;
    if (px * px + py * py + pz * pz > this.radius * this.radius) return Infinity;

    o.set(-cx, -cy, -cz).applyQuaternion(this.invQuat);
    d.copy(dir).applyQuaternion(this.invQuat);
    let tmin = -Infinity;
    let tmax = Infinity;
    for (const axis of ['x', 'y', 'z']) {
      const h = this.half[axis];
      const od = o[axis];
      const dd = d[axis];
      if (Math.abs(dd) < 1e-9) {
        if (od < -h || od > h) return Infinity;
        continue;
      }
      let t1 = (-h - od) / dd;
      let t2 = (h - od) / dd;
      if (t1 > t2) [t1, t2] = [t2, t1];
      if (t1 > tmin) tmin = t1;
      if (t2 < tmax) tmax = t2;
      if (tmin > tmax) return Infinity;
    }
    if (tmax < 0) return Infinity;
    const hit = tmin > 0 ? tmin : tmax;
    return hit <= maxDist ? hit : Infinity;
  }
}
const _o = new THREE.Vector3();
const _d = new THREE.Vector3();

/** Deterministic RNG so bakes are reproducible across machines. */
function mulberry32(seed) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function hemisphereSamples(n, rng) {
  const out = [];
  for (let i = 0; i < n; i++) {
    // cosine-weighted, stratified in a spiral
    const u = (i + rng()) / n;
    const v = rng();
    const r = Math.sqrt(u);
    const phi = 2 * Math.PI * v;
    out.push(new THREE.Vector3(r * Math.cos(phi), r * Math.sin(phi), Math.sqrt(Math.max(0, 1 - u))));
  }
  return out;
}

export function bakeVertexLighting(meshes, { samples = 48, maxDist = 1.8, onProgress = null } = {}) {
  const occluders = meshes.filter((m) => m.userData.occluder !== false && m.geometry.parameters?.width !== undefined).map((m) => new OBB(m));
  const rng = mulberry32(1337);
  const sampleDirs = hemisphereSamples(samples, rng);
  const results = {};

  const pos = new THREE.Vector3();
  const nrm = new THREE.Vector3();
  const dir = new THREE.Vector3();
  const tangent = new THREE.Vector3();
  const bitangent = new THREE.Vector3();
  const toLight = new THREE.Vector3();
  const normalMatrix = new THREE.Matrix3();
  const lights = BAKE_LIGHTS.map((l) => ({ ...l, pos: new THREE.Vector3().fromArray(l.position) }));

  meshes.forEach((mesh, mi) => {
    const geo = mesh.geometry;
    const posAttr = geo.attributes.position;
    const nrmAttr = geo.attributes.normal;
    const count = posAttr.count;
    const out = new Uint8Array(count * 3);
    normalMatrix.getNormalMatrix(mesh.matrixWorld);
    const selfObb = occluders.find((o) => o.mesh === mesh);

    for (let i = 0; i < count; i++) {
      pos.fromBufferAttribute(posAttr, i).applyMatrix4(mesh.matrixWorld);
      nrm.fromBufferAttribute(nrmAttr, i).applyMatrix3(normalMatrix).normalize();
      pos.addScaledVector(nrm, 0.012);

      // tangent frame
      tangent.set(1, 0, 0);
      if (Math.abs(nrm.x) > 0.9) tangent.set(0, 1, 0);
      tangent.cross(nrm).normalize();
      bitangent.crossVectors(nrm, tangent);

      let occ = 0;
      for (const s of sampleDirs) {
        dir.copy(tangent).multiplyScalar(s.x).addScaledVector(bitangent, s.y).addScaledVector(nrm, s.z).normalize();
        let nearest = Infinity;
        for (const ob of occluders) {
          if (ob === selfObb) continue;
          const t = ob.intersect(pos, dir, maxDist);
          if (t < nearest) nearest = t;
        }
        if (nearest < Infinity) occ += 1 - nearest / maxDist;
      }
      const ao = 1 - occ / sampleDirs.length;

      let r = AMBIENT_BAKE[0];
      let g = AMBIENT_BAKE[1];
      let b = AMBIENT_BAKE[2];
      for (const L of lights) {
        toLight.copy(L.pos).sub(pos);
        const dist = toLight.length();
        if (dist > L.radius) continue;
        toLight.multiplyScalar(1 / dist);
        const lambert = nrm.dot(toLight);
        if (lambert <= 0) continue;
        let blocked = false;
        for (const ob of occluders) {
          if (ob === selfObb) continue;
          if (ob.intersect(pos, toLight, dist - 0.02) < Infinity) {
            blocked = true;
            break;
          }
        }
        if (blocked) continue;
        const fall = 1 - dist / L.radius;
        const k = lambert * L.intensity * fall * fall;
        r += L.color[0] * k;
        g += L.color[1] * k;
        b += L.color[2] * k;
      }
      // Compress so lit, unoccluded surfaces sit near 1.0 and multiply cleanly into base colour.
      const tone = (c) => Math.min(1, (0.25 + 0.75 * ao) * (0.45 + c * 0.9));
      out[i * 3] = Math.round(tone(r) * 255);
      out[i * 3 + 1] = Math.round(tone(g) * 255);
      out[i * 3 + 2] = Math.round(tone(b) * 255);
    }
    results[mesh.name] = { count, rgb: out };
    onProgress?.(mi + 1, meshes.length, mesh.name);
  });
  return results;
}

export function applyBakedColors(meshes, baked) {
  let applied = 0;
  for (const m of meshes) {
    const entry = baked[m.name];
    if (!entry || entry.count !== m.geometry.attributes.position.count) continue;
    const rgb = entry.rgb instanceof Uint8Array ? entry.rgb : decodeBase64(entry.rgb);
    m.geometry.setAttribute('color', new THREE.BufferAttribute(rgb, 3, true));
    applied++;
  }
  return applied;
}

export function encodeBase64(u8) {
  if (typeof Buffer !== 'undefined') return Buffer.from(u8).toString('base64');
  let s = '';
  for (let i = 0; i < u8.length; i += 0x8000) s += String.fromCharCode.apply(null, u8.subarray(i, i + 0x8000));
  return btoa(s);
}

export function decodeBase64(str) {
  if (typeof Buffer !== 'undefined') return new Uint8Array(Buffer.from(str, 'base64'));
  const bin = atob(str);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}
