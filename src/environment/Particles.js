import * as THREE from 'three';

/**
 * Lightweight pooled particle emitter (single draw call per emitter) with
 * presets for the damage states: electrical sparks, coolant steam, smoke,
 * plus a holographic "static" for the Holo-Table.
 */
export const PRESETS = {
  sparks: {
    count: 120, rate: 90, life: [0.25, 0.7], speed: [1.2, 3.2], spread: 0.9, gravity: -9.0, size: [3, 6],
    colorA: 0xfff2b0, colorB: 0xff7a1a, additive: true, drag: 0.5, growth: 0.2,
  },
  steam: {
    count: 90, rate: 30, life: [1.2, 2.2], speed: [0.4, 0.9], spread: 0.35, gravity: 0.6, size: [14, 30],
    colorA: 0xdfe9f3, colorB: 0x9fb4c8, additive: false, drag: 1.4, growth: 2.2,
  },
  smoke: {
    count: 80, rate: 18, life: [2.0, 3.5], speed: [0.25, 0.5], spread: 0.3, gravity: 0.35, size: [18, 40],
    colorA: 0x3a3a3f, colorB: 0x0e0e12, additive: false, drag: 1.0, growth: 2.6, alpha: 0.55,
  },
  holoStatic: {
    count: 60, rate: 25, life: [0.4, 0.9], speed: [0.05, 0.15], spread: 1.0, gravity: 0.1, size: [2, 4],
    colorA: 0xffd27a, colorB: 0xffa14a, additive: true, drag: 0, growth: 0,
  },
  shieldSpark: {
    count: 200, rate: 0, life: [0.4, 1.0], speed: [4, 9], spread: 1.0, gravity: 0, size: [4, 9],
    colorA: 0x8fd3ff, colorB: 0x2f7fc7, additive: true, drag: 2.0, growth: 0.5,
  },
};

export class ParticleEmitter {
  constructor(preset, { direction = new THREE.Vector3(0, 1, 0), radius = 0.02 } = {}) {
    const p = typeof preset === 'string' ? PRESETS[preset] : preset;
    this.p = p;
    this.direction = direction.clone().normalize();
    this.radius = radius;
    this.active = false;
    this._spawnAcc = 0;
    this.count = p.count;

    this.positions = new Float32Array(this.count * 3);
    this.velocities = new Float32Array(this.count * 3);
    this.ages = new Float32Array(this.count).fill(Infinity);
    this.lives = new Float32Array(this.count).fill(1);
    this.sizes = new Float32Array(this.count);
    this.alphas = new Float32Array(this.count);

    const geo = new THREE.BufferGeometry();
    geo.setAttribute('position', new THREE.BufferAttribute(this.positions, 3));
    geo.setAttribute('aSize', new THREE.BufferAttribute(this.sizes, 1));
    geo.setAttribute('aAlpha', new THREE.BufferAttribute(this.alphas, 1));
    this.mat = new THREE.ShaderMaterial({
      transparent: true,
      depthWrite: false,
      blending: p.additive ? THREE.AdditiveBlending : THREE.NormalBlending,
      uniforms: { uColorA: { value: new THREE.Color(p.colorA) }, uColorB: { value: new THREE.Color(p.colorB) } },
      vertexShader: /* glsl */ `
        attribute float aSize; attribute float aAlpha; varying float vAlpha;
        void main(){ vec4 mv = modelViewMatrix*vec4(position,1.0); gl_PointSize = aSize * (1.2 / max(0.2,-mv.z)); vAlpha = aAlpha; gl_Position = projectionMatrix*mv; }`,
      fragmentShader: /* glsl */ `
        uniform vec3 uColorA; uniform vec3 uColorB; varying float vAlpha;
        void main(){ float d = length(gl_PointCoord-0.5); if(d>0.5) discard; float soft = smoothstep(0.5,0.05,d);
          vec3 c = mix(uColorA, uColorB, 1.0-vAlpha); gl_FragColor = vec4(c, soft*vAlpha); }`,
    });
    this.points = new THREE.Points(geo, this.mat);
    this.points.frustumCulled = false;
    this.points.name = 'particles';
    this.points.userData.hittable = false;
  }

  start() {
    this.active = true;
  }
  stop() {
    this.active = false;
  }

  /** Emit N particles instantly (for one-shot bursts). */
  burst(n) {
    for (let i = 0; i < n; i++) this._spawn();
  }

  _spawn() {
    let idx = -1;
    for (let i = 0; i < this.count; i++) {
      if (this.ages[i] >= this.lives[i]) {
        idx = i;
        break;
      }
    }
    if (idx < 0) return;
    const p = this.p;
    const r = this.radius;
    this.positions.set([(Math.random() - 0.5) * r * 2, (Math.random() - 0.5) * r * 2, (Math.random() - 0.5) * r * 2], idx * 3);
    const dir = new THREE.Vector3().randomDirection().multiplyScalar(p.spread).add(this.direction).normalize();
    const sp = THREE.MathUtils.lerp(p.speed[0], p.speed[1], Math.random());
    this.velocities.set([dir.x * sp, dir.y * sp, dir.z * sp], idx * 3);
    this.ages[idx] = 0;
    this.lives[idx] = THREE.MathUtils.lerp(p.life[0], p.life[1], Math.random());
    this.sizes[idx] = THREE.MathUtils.lerp(p.size[0], p.size[1], Math.random());
    this.alphas[idx] = p.alpha ?? 1;
  }

  update(dt) {
    const p = this.p;
    if (this.active && p.rate > 0) {
      this._spawnAcc += dt * p.rate;
      while (this._spawnAcc >= 1) {
        this._spawn();
        this._spawnAcc -= 1;
      }
    }
    const drag = Math.max(0, 1 - p.drag * dt);
    let any = false;
    for (let i = 0; i < this.count; i++) {
      if (this.ages[i] >= this.lives[i]) {
        this.alphas[i] = 0;
        continue;
      }
      any = true;
      this.ages[i] += dt;
      const t = this.ages[i] / this.lives[i];
      const i3 = i * 3;
      this.velocities[i3 + 1] += p.gravity * dt;
      this.velocities[i3] *= drag;
      this.velocities[i3 + 1] *= drag;
      this.velocities[i3 + 2] *= drag;
      this.positions[i3] += this.velocities[i3] * dt;
      this.positions[i3 + 1] += this.velocities[i3 + 1] * dt;
      this.positions[i3 + 2] += this.velocities[i3 + 2] * dt;
      this.sizes[i] += p.growth * dt * 10;
      this.alphas[i] = (p.alpha ?? 1) * (1 - t) * (t < 0.1 ? t / 0.1 : 1);
    }
    this.points.visible = any || this.active;
    const g = this.points.geometry;
    g.attributes.position.needsUpdate = true;
    g.attributes.aSize.needsUpdate = true;
    g.attributes.aAlpha.needsUpdate = true;
  }
}

/**
 * Damage state bundle for a station: sparks + smoke + steam emitters, a red
 * strobe light and an alarm loop. Attached at a console's damage point.
 */
export class DamageFX {
  constructor() {
    this.group = new THREE.Group();
    this.group.name = 'DamageFX';
    this.sparks = new ParticleEmitter('sparks', { direction: new THREE.Vector3(0, 1, 0.4), radius: 0.03 });
    this.smoke = new ParticleEmitter('smoke', { direction: new THREE.Vector3(0, 1, 0), radius: 0.06 });
    this.steam = new ParticleEmitter('steam', { direction: new THREE.Vector3(0.3, 1, 0), radius: 0.02 });
    this.steam.points.position.set(0.25, -0.1, 0);
    this.group.add(this.sparks.points, this.smoke.points, this.steam.points);

    this.strobe = new THREE.PointLight(0xff2a3a, 0, 3.5, 1.5);
    this.strobe.position.set(0, 0.6, 0.3);
    this.group.add(this.strobe);
    this.sparkLight = new THREE.PointLight(0xffa040, 0, 1.2, 2);
    this.group.add(this.sparkLight);

    this.level = 0; // 0 off, 1 warning, 2 critical
    this._t = 0;
    this._sparkTimer = 0;
  }

  setLevel(level) {
    this.level = level;
    if (level >= 2) {
      this.sparks.start();
      this.smoke.start();
      this.steam.start();
    } else if (level === 1) {
      this.sparks.stop();
      this.smoke.stop();
      this.steam.start();
    } else {
      this.sparks.stop();
      this.smoke.stop();
      this.steam.stop();
      this.strobe.intensity = 0;
      this.sparkLight.intensity = 0;
    }
  }

  update(dt) {
    this._t += dt;
    this.sparks.update(dt);
    this.smoke.update(dt);
    this.steam.update(dt);
    if (this.level >= 1) {
      const rate = this.level >= 2 ? 6 : 2.5;
      const on = Math.sin(this._t * rate) > 0.2;
      this.strobe.intensity = on ? (this.level >= 2 ? 8 : 3) : 0;
    }
    if (this.level >= 2) {
      this._sparkTimer -= dt;
      if (this._sparkTimer <= 0) {
        this.sparks.burst(25);
        this.sparkLight.intensity = 5;
        this._sparkTimer = 0.5 + Math.random() * 1.8;
      }
      this.sparkLight.intensity = Math.max(0, this.sparkLight.intensity - dt * 14);
    }
  }
}
