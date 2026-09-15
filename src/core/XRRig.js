import * as THREE from 'three';
import { XRControllerModelFactory } from 'three/addons/webxr/XRControllerModelFactory.js';
import { XRHandModelFactory } from 'three/addons/webxr/XRHandModelFactory.js';
import { bus } from './EventBus.js';

/**
 * Owns the renderer, the camera rig and the XR session lifecycle.
 *
 * Locomotion is intentionally absent. The rig is a Group that the camera
 * lives in; "recentering" moves the rig so that the operator's current head
 * position lands exactly in the station's seat, keeping 1:1 room-scale
 * tracking for the hands while the body stays put.
 */
export class XRRig {
  constructor(container) {
    this.renderer = new THREE.WebGLRenderer({ antialias: true, powerPreference: 'high-performance' });
    this.renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
    this.renderer.setSize(window.innerWidth, window.innerHeight);
    this.renderer.outputColorSpace = THREE.SRGBColorSpace;
    this.renderer.toneMapping = THREE.ACESFilmicToneMapping;
    this.renderer.toneMappingExposure = 1.05;
    this.renderer.shadowMap.enabled = false;
    this.renderer.xr.enabled = true;
    this.renderer.xr.setReferenceSpaceType('local-floor');
    // Fixed Foveated Rendering: 1.0 = maximum peripheral reduction. Standalone
    // headsets keep 72-90 fps far more reliably with this on.
    this.renderer.xr.setFoveation(1.0);
    this.renderer.xr.setFramebufferScaleFactor(1.0);
    container.appendChild(this.renderer.domElement);

    this.scene = new THREE.Scene();
    this.camera = new THREE.PerspectiveCamera(70, window.innerWidth / window.innerHeight, 0.02, 400);
    this.camera.position.set(0, 1.25, 0);

    this.rig = new THREE.Group();
    this.rig.name = 'CameraRig';
    this.rig.add(this.camera);
    this.scene.add(this.rig);

    this.controllers = [];
    this.hands = [];
    this._buildControllers();

    this.desktop = new DesktopLook(this.camera, this.renderer.domElement);
    this.desktop.enabled = true;

    this.renderer.xr.addEventListener('sessionstart', () => {
      this.desktop.enabled = false;
      bus.emit('xr:sessionstart');
    });
    this.renderer.xr.addEventListener('sessionend', () => {
      this.desktop.enabled = true;
      bus.emit('xr:sessionend');
    });

    window.addEventListener('resize', () => this._onResize());
  }

  _buildControllers() {
    const controllerModelFactory = new XRControllerModelFactory();
    const handModelFactory = new XRHandModelFactory();

    for (let i = 0; i < 2; i++) {
      const controller = this.renderer.xr.getController(i);
      controller.name = `Controller${i}`;
      controller.userData.index = i;
      const ray = buildRay();
      controller.add(ray);
      controller.userData.ray = ray;
      controller.addEventListener('connected', (e) => {
        controller.userData.inputSource = e.data;
        controller.userData.handedness = e.data?.handedness ?? null;
      });
      controller.addEventListener('disconnected', () => {
        controller.userData.inputSource = null;
      });
      this.rig.add(controller);
      this.controllers.push(controller);

      const grip = this.renderer.xr.getControllerGrip(i);
      grip.add(controllerModelFactory.createControllerModel(grip));
      this.rig.add(grip);

      const hand = this.renderer.xr.getHand(i);
      hand.add(handModelFactory.createHandModel(hand, 'mesh'));
      hand.userData.index = i;
      this.rig.add(hand);
      this.hands.push(hand);
    }

    // Rising-edge latch for Quest B (right) / Y (left) — xr-standard buttons[5].
    this._menuHeld = false;
  }

  _onResize() {
    this.camera.aspect = window.innerWidth / window.innerHeight;
    this.camera.updateProjectionMatrix();
    this.renderer.setSize(window.innerWidth, window.innerHeight);
  }

  get inXR() {
    return this.renderer.xr.isPresenting;
  }

  /**
   * True once when B (right Quest) or Y (left Quest) is freshly pressed.
   * xr-standard gamepad: buttons[5] is the secondary face button.
   */
  pollMenuButton() {
    let down = false;
    for (const c of this.controllers) {
      const pad = c.userData.inputSource?.gamepad;
      if (!pad?.buttons?.[5]) continue;
      if (pad.buttons[5].pressed) down = true;
    }
    const edge = down && !this._menuHeld;
    this._menuHeld = down;
    return edge;
  }

  /**
   * Per-hand Quest / xr-standard flight pad sample.
   * Thumbstick is axes[2]/[3]; grip is buttons[1]; trigger value is buttons[0].
   * Hands that haven't reported yet are left at zero / unarmed.
   */
  pollFlightPads() {
    const out = {
      left: { x: 0, y: 0, grip: false, trigger: 0 },
      right: { x: 0, y: 0, grip: false, trigger: 0 },
    };
    if (!this.inXR) return out;
    for (const c of this.controllers) {
      const hand = c.userData.handedness;
      if (hand !== 'left' && hand !== 'right') continue;
      const pad = c.userData.inputSource?.gamepad;
      if (!pad) continue;
      const slot = out[hand];
      const ax = pad.axes;
      // xr-standard: [0,1] touchpad, [2,3] thumbstick. Quest uses the latter.
      if (ax.length >= 4) {
        slot.x = ax[2] || 0;
        slot.y = ax[3] || 0;
      } else {
        slot.x = ax[0] || 0;
        slot.y = ax[1] || 0;
      }
      slot.grip = !!pad.buttons?.[1]?.pressed;
      slot.trigger = pad.buttons?.[0]?.value ?? 0;
    }
    return out;
  }

  /** Short rumble on a handed controller (left / right). */
  pulseHand(handedness, intensity = 0.4, ms = 30) {
    for (const c of this.controllers) {
      if (c.userData.handedness !== handedness) continue;
      c.userData.inputSource?.gamepad?.hapticActuators?.[0]?.pulse?.(intensity, ms);
    }
  }

  /** Head pose in world space (works both in XR and on desktop). */
  getHeadPose(outPos = new THREE.Vector3(), outQuat = new THREE.Quaternion()) {
    const cam = this.inXR ? this.renderer.xr.getCamera() : this.camera;
    cam.getWorldPosition(outPos);
    cam.getWorldQuaternion(outQuat);
    return { position: outPos, quaternion: outQuat };
  }

  /**
   * Recentre the operator into a station seat. The head's XZ position and yaw
   * are re-aligned onto the seat; floor height is preserved from local-floor
   * tracking so the console sits at the correct physical height for a seated
   * or standing operator.
   */
  recenter(seat) {
    const head = new THREE.Vector3();
    const headQuat = new THREE.Quaternion();
    this.getHeadPose(head, headQuat);

    const headLocal = this.rig.worldToLocal(head.clone());
    const forward = new THREE.Vector3(0, 0, -1).applyQuaternion(headQuat);
    const headYaw = Math.atan2(-forward.x, -forward.z);
    const rigYaw = this.rig.rotation.y;
    const localHeadYaw = headYaw - rigYaw;

    this.rig.rotation.y = seat.yaw - localHeadYaw;
    const rotated = headLocal.clone().applyAxisAngle(new THREE.Vector3(0, 1, 0), this.rig.rotation.y);
    this.rig.position.set(seat.position.x - rotated.x, seat.position.y, seat.position.z - rotated.z);

    if (!this.inXR) {
      this.camera.position.set(0, seat.seated ? 1.2 : 1.65, 0);
      this.desktop.reset(seat.pitch ?? -0.25);
    }
    bus.emit('xr:recentered', seat);
  }

  async requestSession() {
    if (!navigator.xr) throw new Error('WebXR not available');
    const session = await navigator.xr.requestSession('immersive-vr', {
      optionalFeatures: ['local-floor', 'bounded-floor', 'hand-tracking', 'layers'],
    });
    await this.renderer.xr.setSession(session);
    return session;
  }

  setAnimationLoop(fn) {
    this.renderer.setAnimationLoop(fn);
  }

  render() {
    this.renderer.render(this.scene, this.camera);
  }
}

function buildRay() {
  const geo = new THREE.BufferGeometry().setFromPoints([new THREE.Vector3(0, 0, 0), new THREE.Vector3(0, 0, -1)]);
  const mat = new THREE.LineBasicMaterial({ color: 0x8fd3ff, transparent: true, opacity: 0.35 });
  const line = new THREE.Line(geo, mat);
  line.scale.z = 1.5;
  line.name = 'ray';
  return line;
}

/** Mouse-look for desktop testing. No translation, ever. */
class DesktopLook {
  constructor(camera, dom) {
    this.camera = camera;
    this.dom = dom;
    this.enabled = false;
    this.yaw = 0;
    this.pitch = 0;
    this._dragging = false;
    this._last = { x: 0, y: 0 };
    this._moved = 0;

    dom.addEventListener('pointerdown', (e) => {
      if (!this.enabled || e.button !== 0) return;
      this._dragging = true;
      this._moved = 0;
      this._last = { x: e.clientX, y: e.clientY };
    });
    window.addEventListener('pointerup', () => (this._dragging = false));
    window.addEventListener('pointermove', (e) => {
      if (!this.enabled || !this._dragging || this.lookLocked) return;
      const dx = e.clientX - this._last.x;
      const dy = e.clientY - this._last.y;
      this._moved += Math.abs(dx) + Math.abs(dy);
      this._last = { x: e.clientX, y: e.clientY };
      this.yaw -= dx * 0.0035;
      this.pitch = THREE.MathUtils.clamp(this.pitch - dy * 0.0035, -1.4, 1.4);
      this.apply();
    });
  }

  /** True when the last drag moved enough to count as a look, not a click. */
  get draggedSignificantly() {
    return this._moved > 6;
  }

  reset(pitch = -0.25) {
    this.yaw = 0;
    this.pitch = pitch;
    this.apply();
  }

  apply() {
    this.camera.rotation.set(this.pitch, this.yaw, 0, 'YXZ');
  }
}
