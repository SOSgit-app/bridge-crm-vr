import * as THREE from 'three';
import { buildBridgeStatic, collectStatic, BRIDGE } from './BridgeGeometry.js';
import { bakeVertexLighting, applyBakedColors } from './AOBaker.js';
import { MAT } from '../controls/Materials.js';

/**
 * Runtime bridge: static baked geometry + non-occluding dressing (viewport
 * glass, cove strips) + the minimal set of real-time lights. Baked vertex
 * lighting carries the interior ambience so the GPU only pays for the
 * localised dynamic console lights.
 */
export class Bridge {
  constructor(scene) {
    this.scene = scene;
    this.group = new THREE.Group();
    this.group.name = 'Bridge';
    scene.add(this.group);

    this.static = buildBridgeStatic();
    this.meshes = collectStatic(this.static);
    for (const m of this.meshes) {
      const mat = MAT[m.userData.matKey] ?? MAT.hull;
      m.material = mat;
      m.matrixAutoUpdate = false;
      m.updateMatrix();
    }
    this.group.add(this.static);

    this._addDressing();
    this._addLights();
  }

  async loadBakedLighting() {
    try {
      const res = await fetch(`${import.meta.env.BASE_URL}baked/bridge-ao.json`, { cache: 'force-cache' });
      if (!res.ok) throw new Error(res.statusText);
      const data = await res.json();
      const applied = applyBakedColors(this.meshes, data.meshes);
      if (applied < this.meshes.length * 0.9) throw new Error(`bake mismatch (${applied}/${this.meshes.length})`);
      return { source: 'file', applied };
    } catch (err) {
      console.warn('[Bridge] baked lighting unavailable, baking on device:', err.message);
      const baked = bakeVertexLighting(this.meshes, { samples: 10, maxDist: 1.4 });
      const applied = applyBakedColors(this.meshes, baked);
      return { source: 'device', applied };
    }
  }

  _addDressing() {
    const { frontZ } = BRIDGE;
    // Viewport glass: physically thin, slightly tinted, catches nebula light
    const glass = new THREE.Mesh(
      new THREE.PlaneGeometry(5.6, 1.7),
      new THREE.MeshPhysicalMaterial({
        color: 0x86b8ff, transparent: true, opacity: 0.08, roughness: 0.05, metalness: 0, clearcoat: 1, side: THREE.DoubleSide, depthWrite: false,
      })
    );
    glass.position.set(0, 1.85, frontZ + 0.02);
    glass.name = 'viewport-glass';
    this.group.add(glass);

    // Emissive cove strips (the baked lights' visible sources)
    const stripMat = new THREE.MeshStandardMaterial({ color: 0x000000, emissive: 0x8fb7ff, emissiveIntensity: 2.2 });
    for (const x of [-2.4, 2.4]) {
      const strip = new THREE.Mesh(new THREE.BoxGeometry(0.06, 0.02, BRIDGE.depth - 1.2), stripMat);
      strip.position.set(x, BRIDGE.height - 0.13, (frontZ + BRIDGE.backZ) / 2);
      this.group.add(strip);
    }
    // Floor edge guide lights
    const guideMat = new THREE.MeshStandardMaterial({ color: 0x000000, emissive: 0x3f8fc7, emissiveIntensity: 1.6 });
    for (const x of [-BRIDGE.width / 2 + 0.3, BRIDGE.width / 2 - 0.3]) {
      const g = new THREE.Mesh(new THREE.BoxGeometry(0.03, 0.01, BRIDGE.depth - 0.6), guideMat);
      g.position.set(x, 0.006, (frontZ + BRIDGE.backZ) / 2);
      this.group.add(g);
    }
  }

  _addLights() {
    // One hemisphere light for base shading direction; the baked vertex
    // colours carry the actual ambience.
    this.hemi = new THREE.HemisphereLight(0x8fb7ff, 0x2a2018, 1.1);
    this.group.add(this.hemi);
    // Cool key from the viewport so metals have something to reflect.
    this.viewportLight = new THREE.PointLight(0x7aa7ff, 8, 10, 1.6);
    this.viewportLight.position.set(0, 2.0, BRIDGE.frontZ + 0.6);
    this.group.add(this.viewportLight);
  }

  /** Pulse the viewport light for shield impacts / explosions outside. */
  flash(color = 0xffffff, intensity = 30, decay = 4) {
    this._flash = { color: new THREE.Color(color), intensity, decay, t: 1 };
  }

  update(dt) {
    if (this._flash) {
      const f = this._flash;
      f.t = Math.max(0, f.t - dt * f.decay);
      this.viewportLight.color.lerpColors(new THREE.Color(0x7aa7ff), f.color, f.t);
      this.viewportLight.intensity = 8 + f.intensity * f.t;
      if (f.t <= 0) this._flash = null;
    }
  }
}
