import * as THREE from 'three';
import { BRIDGE } from './BridgeGeometry.js';

/**
 * Everything visible through the viewport: a volumetric FBM nebula dome,
 * a starfield, streaming space dust and ion-trail streaks.
 *
 * Far sky (nebula + stars + markers) counter-rotates with ship attitude.
 * Near FX (dust + ion trails) stay ship-fixed and are hard-culled outside
 * the viewport glass so they never stream through the cabin.
 */
export class SpaceScape {
  constructor(scene) {
    this.group = new THREE.Group();
    this.group.name = 'Space';
    scene.add(this.group);

    // Ship-fixed streaming FX — never rotates with attitude, never enters cabin.
    this.fx = new THREE.Group();
    this.fx.name = 'SpaceFX';
    scene.add(this.fx);

    // Keep all streaming particles beyond the outer face of the viewport glass.
    this.viewportCullZ = BRIDGE.frontZ - 0.35;

    this.speed = 0.35; // 0..1 from Helm throttle
    this.time = 0;
    this.attitude = new THREE.Quaternion();
    this._transients = new Set();

    this._buildNebula();
    this._buildStars();
    this._buildDust();
    this._buildTrails();
    this.markers = new Map();
    this.markerGroup = new THREE.Group();
    this.group.add(this.markerGroup);
  }

  /** Universe-frame direction for a ship-relative bearing/pitch (deg). */
  static direction(bearing, pitch, out = new THREE.Vector3()) {
    const e = new THREE.Euler(THREE.MathUtils.degToRad(pitch), -THREE.MathUtils.degToRad(bearing), 0, 'YXZ');
    return out.set(0, 0, -1).applyEuler(e);
  }

  static attitudeQuaternion({ bearing, pitch, roll }, out = new THREE.Quaternion()) {
    return out.setFromEuler(new THREE.Euler(THREE.MathUtils.degToRad(pitch), -THREE.MathUtils.degToRad(bearing), THREE.MathUtils.degToRad(roll), 'YXZ'));
  }

  /**
   * Place or update a physical object out in space at a bearing/pitch.
   * kind: 'marker' (nav diamond) | 'asteroid' | 'drone'
   */
  setMarker(id, { bearing, pitch, kind = 'marker', distance = 60, color = 0x5ad0ff }) {
    let m = this.markers.get(id);
    if (!m) {
      m = buildMarker(kind, color);
      m.userData.kind = kind;
      this.markers.set(id, m);
      this.markerGroup.add(m);
    }
    m.position.copy(SpaceScape.direction(bearing, pitch)).multiplyScalar(distance);
    m.userData.distance = distance;
    m.userData.dir = SpaceScape.direction(bearing, pitch);
    return m;
  }

  removeMarker(id) {
    const m = this.markers.get(id);
    if (!m) return;
    this.markerGroup.remove(m);
    this.markers.delete(id);
  }

  /** Explosion burst at a marker, then remove it. */
  destroyMarker(id) {
    const m = this.markers.get(id);
    if (!m) return;
    const burst = new THREE.PointLight(0xffb060, 400, 200, 1.2);
    burst.position.copy(m.position);
    this.markerGroup.add(burst);
    this.flash();
    this.removeMarker(id);
    const fade = (dt) => {
      burst.intensity -= dt * 500;
      if (burst.intensity <= 0) {
        this.markerGroup.remove(burst);
        this._transients.delete(fade);
      }
    };
    this._transients.add(fade);
  }

  _buildNebula() {
    this.nebulaMat = new THREE.ShaderMaterial({
      side: THREE.BackSide,
      depthWrite: false,
      depthTest: true,
      uniforms: {
        uTime: { value: 0 },
        // Deep space is black. The nebula is kept as a barely-there haze so
        // weapon flashes still have something to light up.
        uColorA: { value: new THREE.Color(0x060a14) },
        uColorB: { value: new THREE.Color(0x0c0a16) },
        uColorC: { value: new THREE.Color(0x0a1220) },
        uDensity: { value: 0.35 },
      },
      vertexShader: /* glsl */ `
        varying vec3 vDir;
        void main() {
          vDir = normalize(position);
          gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
        }`,
      fragmentShader: /* glsl */ `
        precision highp float;
        varying vec3 vDir;
        uniform float uTime; uniform vec3 uColorA; uniform vec3 uColorB; uniform vec3 uColorC; uniform float uDensity;
        vec3 hash3(vec3 p){ p = fract(p*vec3(443.897,441.423,437.195)); p += dot(p,p.yzx+19.19); return fract((p.xxy+p.yzz)*p.zyx); }
        float noise(vec3 p){
          vec3 i=floor(p); vec3 f=fract(p); f=f*f*(3.0-2.0*f);
          float n = mix(mix(mix(hash3(i).x,hash3(i+vec3(1,0,0)).x,f.x),mix(hash3(i+vec3(0,1,0)).x,hash3(i+vec3(1,1,0)).x,f.x),f.y),
                        mix(mix(hash3(i+vec3(0,0,1)).x,hash3(i+vec3(1,0,1)).x,f.x),mix(hash3(i+vec3(0,1,1)).x,hash3(i+vec3(1,1,1)).x,f.x),f.y),f.z);
          return n;
        }
        float fbm(vec3 p){ float a=0.5; float s=0.0; for(int i=0;i<5;i++){ s+=a*noise(p); p=p*2.02+vec3(1.7,9.2,3.1); a*=0.5;} return s; }
        void main(){
          vec3 d = vDir;
          // Cheap volumetric feel: march 4 slices along the view dir through a drifting density field.
          float acc = 0.0; vec3 col = vec3(0.0);
          for(int i=0;i<4;i++){
            float t = 1.0 + float(i)*0.6;
            vec3 p = d * t * 1.8 + vec3(uTime*0.012, 0.0, uTime*0.02);
            float n = fbm(p);
            float dens = smoothstep(0.36, 0.72, n) * uDensity;
            vec3 c = mix(uColorA, uColorB, smoothstep(0.3,0.8,n));
            c = mix(c, uColorC, smoothstep(0.62,0.92,n)*0.9);
            col += c * dens * (1.0 - acc) * 0.85;
            acc += dens * 0.35;
          }
          // Black sky with the faintest galactic band
          float band = exp(-abs(d.y)*7.0) * 0.03;
          vec3 base = vec3(0.0, 0.0, 0.002) + band*vec3(0.5,0.5,0.6);
          gl_FragColor = vec4(base + col, 1.0);
        }`,
    });
    const dome = new THREE.Mesh(new THREE.SphereGeometry(180, 48, 32), this.nebulaMat);
    dome.name = 'nebula';
    dome.renderOrder = -3;
    this.group.add(dome);
  }

  _buildStars() {
    // Real-sky look: a dense field of faint pinpoints, a sparse scatter of
    // medium stars and a handful of bright ones. Neutral white, hard edges,
    // no bloom. Stars only move with ship attitude (they are at infinity).
    const n = 7000;
    const pos = new Float32Array(n * 3);
    const size = new Float32Array(n);
    const bright = new Float32Array(n);
    const v = new THREE.Vector3();
    for (let i = 0; i < n; i++) {
      v.randomDirection().multiplyScalar(150);
      pos.set([v.x, v.y, v.z], i * 3);
      const r = Math.random();
      if (r < 0.78) {
        size[i] = 1.2 + Math.random() * 0.6;
        bright[i] = 0.45 + Math.random() * 0.35;
      } else if (r < 0.97) {
        size[i] = 1.9 + Math.random() * 0.8;
        bright[i] = 0.75 + Math.random() * 0.2;
      } else {
        size[i] = 2.8 + Math.random() * 1.1;
        bright[i] = 1.0;
      }
    }
    const geo = new THREE.BufferGeometry();
    geo.setAttribute('position', new THREE.BufferAttribute(pos, 3));
    geo.setAttribute('aSize', new THREE.BufferAttribute(size, 1));
    geo.setAttribute('aBright', new THREE.BufferAttribute(bright, 1));
    const mat = new THREE.ShaderMaterial({
      transparent: true,
      depthWrite: false,
      depthTest: true,
      uniforms: { uPixelRatio: { value: Math.min(2, (typeof window !== 'undefined' && window.devicePixelRatio) || 1) } },
      vertexShader: /* glsl */ `
        attribute float aSize; attribute float aBright; uniform float uPixelRatio; varying float vBright;
        void main(){ vBright = aBright; vec4 mv = modelViewMatrix*vec4(position,1.0); gl_PointSize = aSize*uPixelRatio; gl_Position = projectionMatrix*mv; }`,
      fragmentShader: /* glsl */ `
        varying float vBright;
        void main(){
          float d = length(gl_PointCoord-0.5);
          float a = (1.0 - smoothstep(0.32, 0.5, d)) * vBright;
          if (a < 0.02) discard;
          gl_FragColor = vec4(vec3(0.94, 0.96, 1.0), a);
        }`,
    });
    this.stars = new THREE.Points(geo, mat);
    this.stars.renderOrder = -2;
    this.group.add(this.stars);
  }

  _buildDust() {
    // Dust streams toward the ship from far ahead (-Z) in ship-local space,
    // wrapped so particles never cross the viewport plane into the cabin.
    // Sparse, dim, slow: just enough drifting motes to read the ship's
    // speed at the viewport without looking like a warp tunnel.
    this.dustCount = 160;
    this.dustBox = new THREE.Vector3(28, 14, 70);
    const pos = new Float32Array(this.dustCount * 3);
    for (let i = 0; i < this.dustCount; i++) this._spawnDust(pos, i, true);
    const geo = new THREE.BufferGeometry();
    geo.setAttribute('position', new THREE.BufferAttribute(pos, 3));
    this.dustMat = new THREE.ShaderMaterial({
      transparent: true,
      depthWrite: false,
      depthTest: true,
      uniforms: { uSpeed: { value: 0.3 }, uColor: { value: new THREE.Color(0xcfd6e0) } },
      vertexShader: /* glsl */ `
        uniform float uSpeed; varying float vFade;
        void main(){
          vec4 mv = modelViewMatrix*vec4(position,1.0);
          float dist = -mv.z;
          gl_PointSize = clamp(40.0/dist, 1.0, 2.5);
          vFade = smoothstep(70.0, 10.0, dist) * (0.10 + uSpeed*0.25);
          gl_Position = projectionMatrix*mv;
        }`,
      fragmentShader: /* glsl */ `
        uniform vec3 uColor; varying float vFade;
        void main(){ float d = length(gl_PointCoord-0.5); float a = smoothstep(0.5,0.0,d)*vFade; gl_FragColor = vec4(uColor, a); }`,
    });
    this.dust = new THREE.Points(geo, this.dustMat);
    this.dust.frustumCulled = false;
    this.dust.renderOrder = -1;
    this.fx.add(this.dust);
  }

  _spawnDust(pos, i, initial = false) {
    // Confine to a corridor roughly matching the viewport opening so walls
    // don't need to occlude stray particles at the edges.
    const halfW = 2.6;
    const halfH = 0.85;
    pos[i * 3] = (Math.random() - 0.5) * halfW * 2;
    pos[i * 3 + 1] = 1.85 + (Math.random() - 0.5) * halfH * 2;
    pos[i * 3 + 2] = initial
      ? this.viewportCullZ - Math.random() * this.dustBox.z
      : this.viewportCullZ - this.dustBox.z - Math.random() * 8;
  }

  _buildTrails() {
    // Ion trails: long thin streaks as LineSegments, re-spawned ahead.
    this.trailCount = 60;
    const pos = new Float32Array(this.trailCount * 2 * 3);
    this.trailSpeeds = new Float32Array(this.trailCount);
    for (let i = 0; i < this.trailCount; i++) this._spawnTrail(pos, i, true);
    const geo = new THREE.BufferGeometry();
    geo.setAttribute('position', new THREE.BufferAttribute(pos, 3));
    // Ion trails only appear when the throttle is pushed toward the stop
    // (boost / warp); at cruise, deep space is still.
    this.trailMat = new THREE.LineBasicMaterial({
      color: 0x9fc4e0,
      transparent: true,
      opacity: 0,
      depthWrite: false,
      depthTest: true,
    });
    const mat = this.trailMat;
    this.trails = new THREE.LineSegments(geo, mat);
    this.trails.visible = false;
    this.trails.frustumCulled = false;
    this.trails.renderOrder = -1;
    this.fx.add(this.trails);
  }

  _spawnTrail(pos, i, initial = false) {
    const halfW = 2.6;
    const halfH = 0.85;
    const x = (Math.random() - 0.5) * halfW * 2;
    const y = 1.85 + (Math.random() - 0.5) * halfH * 2;
    const z = initial
      ? this.viewportCullZ - Math.random() * 90 - 2
      : this.viewportCullZ - 95 - Math.random() * 20;
    const len = 1.5 + Math.random() * 5;
    pos.set([x, y, z, x, y, z - len], i * 6);
    this.trailSpeeds[i] = 25 + Math.random() * 40;
  }

  setAttitude(quat) {
    this.attitude.copy(quat);
  }

  /** Brief bright pulse in the nebula (weapon discharge / explosion). */
  flash() {
    this._flash = 1;
  }

  update(dt) {
    this.time += dt;
    this.nebulaMat.uniforms.uTime.value = this.time;
    if (this._flash) {
      this._flash = Math.max(0, this._flash - dt * 3);
      this.nebulaMat.uniforms.uDensity.value = 1.0 + this._flash * 0.8;
    }
    // Counter-rotate the universe by the ship's attitude.
    this.group.quaternion.copy(this.attitude).invert();
    for (const fn of this._transients) fn(dt);
    for (const m of this.markers.values()) {
      const spin = m.userData.kind === 'marker' ? m.children[0] : m;
      spin.rotation.y += dt * (m.userData.kind === 'asteroid' ? 0.4 : 1.2);
      spin.rotation.x += dt * (m.userData.kind === 'asteroid' ? 0.25 : 0);
      if (m.userData.approach) {
        m.userData.distance = Math.max(8, m.userData.distance - m.userData.approach * dt);
        m.position.copy(m.userData.dir).multiplyScalar(m.userData.distance);
      }
    }

    // Cruise is slow; only the top of the throttle reads as fast.
    const speed = 1.2 + this.speed * this.speed * 22;
    this.dustMat.uniforms.uSpeed.value = this.speed;
    const dp = this.dust.geometry.attributes.position;
    const cull = this.viewportCullZ;
    for (let i = 0; i < this.dustCount; i++) {
      let z = dp.getZ(i) + speed * dt;
      // Never let a particle cross the viewport glass into the cabin.
      if (z >= cull) this._spawnDust(dp.array, i, false);
      else dp.setZ(i, z);
    }
    dp.needsUpdate = true;

    const boost = THREE.MathUtils.clamp((this.speed - 0.75) / 0.25, 0, 1);
    this.trailMat.opacity = boost * 0.3;
    this.trails.visible = boost > 0.01;
    if (this.trails.visible) {
      const tp = this.trails.geometry.attributes.position;
      for (let i = 0; i < this.trailCount; i++) {
        const v = (this.trailSpeeds[i] * 0.5 + this.speed * 40) * dt;
        const z0 = tp.getZ(i * 2) + v;
        if (z0 >= cull) this._spawnTrail(tp.array, i);
        else {
          tp.setZ(i * 2, z0);
          tp.setZ(i * 2 + 1, tp.getZ(i * 2 + 1) + v);
        }
      }
      tp.needsUpdate = true;
    }
  }
}

function buildMarker(kind, color) {
  const g = new THREE.Group();
  if (kind === 'asteroid') {
    const geo = new THREE.DodecahedronGeometry(3.2, 1);
    const pos = geo.attributes.position;
    for (let i = 0; i < pos.count; i++) {
      const s = 0.75 + Math.random() * 0.5;
      pos.setXYZ(i, pos.getX(i) * s, pos.getY(i) * s, pos.getZ(i) * s);
    }
    geo.computeVertexNormals();
    const rock = new THREE.Mesh(geo, new THREE.MeshStandardMaterial({ color: 0x5a5148, roughness: 0.95, metalness: 0.05, flatShading: true }));
    g.add(rock);
    const rim = new THREE.PointLight(0xffa060, 60, 40, 1.5);
    rim.position.set(4, 3, 4);
    g.add(rim);
    return g;
  }
  if (kind === 'drone') {
    const body = new THREE.Mesh(new THREE.OctahedronGeometry(1.6, 0), new THREE.MeshStandardMaterial({ color: 0x2a2f3a, roughness: 0.4, metalness: 0.9 }));
    body.scale.set(1, 0.5, 1.6);
    g.add(body);
    const eye = new THREE.Mesh(new THREE.SphereGeometry(0.45, 12, 10), new THREE.MeshStandardMaterial({ color: 0x000000, emissive: 0xff2a3a, emissiveIntensity: 4 }));
    eye.position.z = 1.6;
    g.add(eye);
    const ring = new THREE.Mesh(new THREE.TorusGeometry(2.4, 0.08, 8, 40), new THREE.MeshStandardMaterial({ color: 0x000000, emissive: 0xff2a3a, emissiveIntensity: 2 }));
    g.add(ring);
    g.add(new THREE.PointLight(0xff2a3a, 40, 30, 1.6));
    return g;
  }
  // nav marker: emissive diamond + halo
  const diamond = new THREE.Mesh(new THREE.OctahedronGeometry(1.4, 0), new THREE.MeshStandardMaterial({ color: 0x000000, emissive: color, emissiveIntensity: 3, wireframe: true }));
  g.add(diamond);
  const halo = new THREE.Mesh(new THREE.RingGeometry(2.6, 2.9, 32), new THREE.MeshBasicMaterial({ color, transparent: true, opacity: 0.5, side: THREE.DoubleSide }));
  g.add(halo);
  halo.userData.billboard = true;
  return g;
}
