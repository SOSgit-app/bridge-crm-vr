import * as THREE from 'three';

/**
 * Everything visible through the viewport: a volumetric FBM nebula dome,
 * a starfield, streaming space dust and ion-trail streaks. The whole group
 * counter-rotates with the ship's attitude so Helm inputs are felt visually
 * even though no player ever moves.
 */
export class SpaceScape {
  constructor(scene) {
    this.group = new THREE.Group();
    this.group.name = 'Space';
    scene.add(this.group);
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
      uniforms: {
        uTime: { value: 0 },
        uColorA: { value: new THREE.Color(0x12305c) },
        uColorB: { value: new THREE.Color(0x5a2c93) },
        uColorC: { value: new THREE.Color(0x2f8fd0) },
        uDensity: { value: 1.0 },
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
          // Deep-space base gradient with a faint galactic band
          float band = exp(-abs(d.y)*6.0) * 0.12;
          vec3 base = vec3(0.004,0.008,0.02) + band*vec3(0.35,0.4,0.6);
          gl_FragColor = vec4(base + col, 1.0);
        }`,
    });
    const dome = new THREE.Mesh(new THREE.SphereGeometry(180, 48, 32), this.nebulaMat);
    dome.name = 'nebula';
    this.group.add(dome);
  }

  _buildStars() {
    const n = 2500;
    const pos = new Float32Array(n * 3);
    const size = new Float32Array(n);
    const col = new Float32Array(n * 3);
    for (let i = 0; i < n; i++) {
      const v = new THREE.Vector3().randomDirection().multiplyScalar(150);
      pos.set([v.x, v.y, v.z], i * 3);
      size[i] = 0.6 + Math.random() * 2.2;
      const warm = Math.random();
      col.set([0.8 + warm * 0.2, 0.85 + Math.random() * 0.15, 1.0 - warm * 0.3], i * 3);
    }
    const geo = new THREE.BufferGeometry();
    geo.setAttribute('position', new THREE.BufferAttribute(pos, 3));
    geo.setAttribute('aSize', new THREE.BufferAttribute(size, 1));
    geo.setAttribute('color', new THREE.BufferAttribute(col, 3));
    const mat = new THREE.ShaderMaterial({
      transparent: true,
      depthWrite: false,
      vertexColors: true,
      uniforms: { uScale: { value: 1 } },
      vertexShader: /* glsl */ `
        attribute float aSize; varying vec3 vColor;
        void main(){ vColor = color; vec4 mv = modelViewMatrix*vec4(position,1.0); gl_PointSize = aSize*2.2; gl_Position = projectionMatrix*mv; }`,
      fragmentShader: /* glsl */ `
        varying vec3 vColor;
        void main(){ float d = length(gl_PointCoord-0.5); float a = smoothstep(0.5,0.1,d); gl_FragColor = vec4(vColor, a); }`,
    });
    this.stars = new THREE.Points(geo, mat);
    this.group.add(this.stars);
  }

  _buildDust() {
    // Dust streams toward the ship from far ahead (-Z), speed-scaled, wrapping
    // in a box volume centred a little in front of the viewport.
    this.dustCount = 900;
    this.dustBox = new THREE.Vector3(30, 18, 60);
    const pos = new Float32Array(this.dustCount * 3);
    for (let i = 0; i < this.dustCount; i++) {
      pos[i * 3] = (Math.random() - 0.5) * this.dustBox.x;
      pos[i * 3 + 1] = (Math.random() - 0.5) * this.dustBox.y;
      pos[i * 3 + 2] = -Math.random() * this.dustBox.z - 4;
    }
    const geo = new THREE.BufferGeometry();
    geo.setAttribute('position', new THREE.BufferAttribute(pos, 3));
    this.dustMat = new THREE.ShaderMaterial({
      transparent: true,
      depthWrite: false,
      blending: THREE.AdditiveBlending,
      uniforms: { uSpeed: { value: 0.3 }, uColor: { value: new THREE.Color(0x9fd0ff) } },
      vertexShader: /* glsl */ `
        uniform float uSpeed; varying float vFade;
        void main(){
          vec4 mv = modelViewMatrix*vec4(position,1.0);
          float dist = -mv.z;
          gl_PointSize = clamp(90.0/dist, 1.0, 6.0) * (1.0 + uSpeed*1.5);
          vFade = smoothstep(70.0, 10.0, dist) * (0.35 + uSpeed*0.65);
          gl_Position = projectionMatrix*mv;
        }`,
      fragmentShader: /* glsl */ `
        uniform vec3 uColor; varying float vFade;
        void main(){ float d = length(gl_PointCoord-0.5); float a = smoothstep(0.5,0.0,d)*vFade; gl_FragColor = vec4(uColor, a); }`,
    });
    this.dust = new THREE.Points(geo, this.dustMat);
    this.dust.frustumCulled = false;
    this.group.add(this.dust);
  }

  _buildTrails() {
    // Ion trails: long thin streaks as LineSegments, re-spawned ahead.
    this.trailCount = 60;
    const pos = new Float32Array(this.trailCount * 2 * 3);
    this.trailSpeeds = new Float32Array(this.trailCount);
    for (let i = 0; i < this.trailCount; i++) this._spawnTrail(pos, i, true);
    const geo = new THREE.BufferGeometry();
    geo.setAttribute('position', new THREE.BufferAttribute(pos, 3));
    const mat = new THREE.LineBasicMaterial({ color: 0x5ad0ff, transparent: true, opacity: 0.35, blending: THREE.AdditiveBlending, depthWrite: false });
    this.trails = new THREE.LineSegments(geo, mat);
    this.trails.frustumCulled = false;
    this.group.add(this.trails);
  }

  _spawnTrail(pos, i, initial = false) {
    const x = (Math.random() - 0.5) * 40;
    const y = (Math.random() - 0.5) * 24;
    const z = initial ? -Math.random() * 90 - 5 : -95 - Math.random() * 20;
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

    const speed = 6 + this.speed * 60;
    this.dustMat.uniforms.uSpeed.value = this.speed;
    const dp = this.dust.geometry.attributes.position;
    for (let i = 0; i < this.dustCount; i++) {
      let z = dp.getZ(i) + speed * dt;
      if (z > 6) {
        z = -this.dustBox.z - 4;
        dp.setX(i, (Math.random() - 0.5) * this.dustBox.x);
        dp.setY(i, (Math.random() - 0.5) * this.dustBox.y);
      }
      dp.setZ(i, z);
    }
    dp.needsUpdate = true;

    const tp = this.trails.geometry.attributes.position;
    for (let i = 0; i < this.trailCount; i++) {
      const v = (this.trailSpeeds[i] + this.speed * 60) * dt;
      const z0 = tp.getZ(i * 2) + v;
      if (z0 > 10) this._spawnTrail(tp.array, i);
      else {
        tp.setZ(i * 2, z0);
        tp.setZ(i * 2 + 1, tp.getZ(i * 2 + 1) + v);
      }
    }
    tp.needsUpdate = true;
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
