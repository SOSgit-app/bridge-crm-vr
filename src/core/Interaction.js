import * as THREE from 'three';
import { bus } from './EventBus.js';

/**
 * Base class for every physical control on the bridge. A control is a Group
 * of meshes; the manager raycasts against `hitObjects` and drives the
 * hover / press / drag / release lifecycle with a unified `pointer` record
 * that is identical for XR controllers, tracked hands and the desktop mouse.
 */
export class Interactable {
  constructor(root) {
    this.root = root;
    this.enabled = true;
    this.hovered = false;
    this.pressedBy = null;
    this.pokeable = false; // fingertip poke (hand tracking) triggers press
    root.userData.interactable = this;
    this._hitObjects = null;
  }

  get hitObjects() {
    if (!this._hitObjects) {
      const list = [];
      this.root.traverse((o) => {
        if (o.isMesh && o.userData.hittable !== false) list.push(o);
      });
      this._hitObjects = list;
    }
    return this._hitObjects;
  }

  invalidateHitCache() {
    this._hitObjects = null;
  }

  setEnabled(v) {
    this.enabled = v;
    if (!v && this.pressedBy) this.onPressEnd(this.pressedBy);
    this.pressedBy = null;
    this.onEnabledChanged?.(v);
  }

  onHoverStart() {}
  onHoverEnd() {}
  onPressStart() {}
  onDrag() {}
  onPressEnd() {}
  update() {}
}

export class InteractionManager {
  constructor(xrRig) {
    this.xr = xrRig;
    this.interactables = new Set();
    this.pointers = [];
    this._raycaster = new THREE.Raycaster();
    this._raycaster.far = 3.5;
    this._tmpV = new THREE.Vector3();
    this._tmpQ = new THREE.Quaternion();
    this._ndc = new THREE.Vector2();
    this._mouseDown = false;
    this._mouseNdc = new THREE.Vector2(0, 0);

    for (const c of xrRig.controllers) {
      const p = this._makePointer(`controller${c.userData.index}`, c);
      c.addEventListener('selectstart', () => this._press(p));
      c.addEventListener('selectend', () => this._release(p));
      c.addEventListener('squeezestart', () => this._press(p));
      c.addEventListener('squeezeend', () => this._release(p));
      c.addEventListener('connected', (e) => (p.inputSource = e.data));
      c.addEventListener('disconnected', () => (p.inputSource = null));
    }
    for (const h of xrRig.hands) {
      const p = this._makePointer(`hand${h.userData.index}`, h);
      p.isHand = true;
      h.addEventListener('pinchstart', () => this._press(p));
      h.addEventListener('pinchend', () => this._release(p));
    }
    const mouse = this._makePointer('mouse', null);
    mouse.isMouse = true;
    this._mouse = mouse;

    const dom = xrRig.renderer.domElement;
    dom.addEventListener('pointermove', (e) => {
      this._mouseNdc.set((e.clientX / window.innerWidth) * 2 - 1, -(e.clientY / window.innerHeight) * 2 + 1);
    });
    dom.addEventListener('pointerdown', (e) => {
      if (e.button !== 0 || xrRig.inXR) return;
      this._mouseNdc.set((e.clientX / window.innerWidth) * 2 - 1, -(e.clientY / window.innerHeight) * 2 + 1);
      this._updateMousePointer();
      this._hoverTest(mouse);
      if (mouse.hovered) {
        xrRig.desktop.lookLocked = true;
        this._press(mouse);
      }
    });
    window.addEventListener('pointerup', () => {
      if (mouse.active) this._release(mouse);
      xrRig.desktop.lookLocked = false;
    });
  }

  _makePointer(id, object) {
    const p = {
      id,
      object,
      origin: new THREE.Vector3(),
      direction: new THREE.Vector3(0, 0, -1),
      quaternion: new THREE.Quaternion(),
      hovered: null,
      active: null,
      hit: null,
      inputSource: null,
      isHand: false,
      isMouse: false,
      tip: new THREE.Vector3(),
      hasTip: false,
    };
    this.pointers.push(p);
    return p;
  }

  add(interactable) {
    this.interactables.add(interactable);
    return interactable;
  }

  remove(interactable) {
    if (interactable.pressedBy) this._release(interactable.pressedBy);
    this.interactables.delete(interactable);
  }

  clear() {
    for (const i of this.interactables) if (i.pressedBy) this._release(i.pressedBy);
    this.interactables.clear();
  }

  haptic(pointer, intensity = 0.4, ms = 30) {
    const act = pointer.inputSource?.gamepad?.hapticActuators?.[0];
    act?.pulse?.(intensity, ms);
  }

  _press(p) {
    if (p.active) return;
    const target = p.hovered;
    if (!target || !target.enabled) return;
    p.active = target;
    target.pressedBy = p;
    this.haptic(p, 0.6, 40);
    target.onPressStart(p, p.hit);
    bus.emit('ui:press', { pointer: p.id, control: target.root.name });
  }

  _release(p) {
    const target = p.active;
    if (!target) return;
    p.active = null;
    p.pokePressed = false;
    if (target.pressedBy === p) target.pressedBy = null;
    target.onPressEnd(p);
  }

  _updateXRPointer(p) {
    const o = p.object;
    if (p.isHand) {
      const tip = o.joints?.['index-finger-tip'];
      const wrist = o.joints?.['wrist'];
      if (!tip || !wrist || !o.visible) {
        p.hasTip = false;
        return false;
      }
      tip.getWorldPosition(p.tip);
      p.hasTip = true;
      wrist.getWorldPosition(this._tmpV);
      p.origin.copy(p.tip);
      p.direction.copy(p.tip).sub(this._tmpV).normalize();
      tip.getWorldQuaternion(p.quaternion);
      return true;
    }
    if (!o.visible) return false;
    o.getWorldPosition(p.origin);
    o.getWorldQuaternion(p.quaternion);
    p.direction.set(0, 0, -1).applyQuaternion(p.quaternion);
    return true;
  }

  _updateMousePointer() {
    const cam = this.xr.camera;
    this._raycaster.setFromCamera(this._mouseNdc, cam);
    this._mouse.origin.copy(this._raycaster.ray.origin);
    this._mouse.direction.copy(this._raycaster.ray.direction);
    cam.getWorldQuaternion(this._mouse.quaternion);
  }

  _hoverTest(p) {
    this._raycaster.set(p.origin, p.direction);
    let best = null;
    let bestDist = Infinity;
    let bestHit = null;
    for (const it of this.interactables) {
      if (!it.enabled || !it.root.visible) continue;
      const hits = this._raycaster.intersectObjects(it.hitObjects, false);
      if (hits.length && hits[0].distance < bestDist) {
        bestDist = hits[0].distance;
        best = it;
        bestHit = hits[0];
      }
    }
    // Hand poke: fingertip within 2 cm of a pokeable surface counts as a hover+press.
    if (p.isHand && p.hasTip) {
      for (const it of this.interactables) {
        if (!it.enabled || !it.pokeable || !it.root.visible) continue;
        for (const m of it.hitObjects) {
          m.getWorldPosition(this._tmpV);
          const d = this._tmpV.distanceTo(p.tip);
          if (d < 0.02 && d < bestDist) {
            best = it;
            bestDist = d;
            bestHit = { object: m, point: p.tip.clone(), distance: d, poke: true };
          }
        }
      }
    }
    if (p.hovered !== best) {
      if (p.hovered) {
        p.hovered.hovered = false;
        p.hovered.onHoverEnd(p);
      }
      p.hovered = best;
      if (best) {
        best.hovered = true;
        best.onHoverStart(p);
        this.haptic(p, 0.15, 12);
      }
    }
    p.hit = bestHit;
    if (p.object?.userData.ray) p.object.userData.ray.scale.z = best ? bestDist : 1.5;
    if (p.isHand && bestHit?.poke && !p.active) {
      this._press(p);
      p.pokePressed = true;
    }
  }

  /** Poke presses end when the fingertip withdraws from the surface. */
  _checkPokeRelease(p) {
    if (!p.isHand || !p.active || !p.pokePressed) return;
    const m = p.active.hitObjects[0];
    if (!m) return;
    m.getWorldPosition(this._tmpV);
    if (this._tmpV.distanceTo(p.tip) > 0.035) {
      p.pokePressed = false;
      this._release(p);
    }
  }

  update(dt) {
    for (const p of this.pointers) {
      let valid = false;
      if (p.isMouse) {
        if (!this.xr.inXR) {
          this._updateMousePointer();
          valid = true;
        }
      } else if (this.xr.inXR) {
        valid = this._updateXRPointer(p);
      }
      if (!valid) {
        if (p.hovered) {
          p.hovered.hovered = false;
          p.hovered.onHoverEnd(p);
          p.hovered = null;
        }
        if (p.active) this._release(p);
        continue;
      }
      if (!p.active) this._hoverTest(p);
      else {
        p.active.onDrag(p, dt);
        this._checkPokeRelease(p);
      }
    }
    for (const it of this.interactables) it.update(dt);
  }
}
