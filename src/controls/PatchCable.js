import * as THREE from 'three';
import { Interactable } from '../core/Interaction.js';
import { MAT } from './Materials.js';
import { makeLabel } from './Label.js';
import { IndicatorLight } from './IndicatorLight.js';
import { sfx } from '../core/Audio.js';

/** A wall socket a PatchCable plug can be seated into. */
export class Socket {
  constructor({ id, label, color = 0x8fd3ff }) {
    this.id = id;
    this.plug = null;
    this.group = new THREE.Group();
    this.group.name = `socket-${id}`;
    const ring = new THREE.Mesh(new THREE.TorusGeometry(0.03, 0.007, 12, 32), MAT.brushed);
    ring.userData.hittable = false;
    this.group.add(ring);
    const hole = new THREE.Mesh(new THREE.CylinderGeometry(0.024, 0.024, 0.03, 24), MAT.rubber);
    hole.rotation.x = Math.PI / 2;
    hole.position.z = -0.012;
    hole.userData.hittable = false;
    this.group.add(hole);
    this.indicator = new IndicatorLight({ radius: 0.008, light: true, lightRange: 0.3, lightIntensity: 0.3 });
    this.indicator.group.position.set(0, 0.05, 0.004);
    this.indicator.set('off');
    this.group.add(this.indicator.group);
    const lbl = makeLabel(label, { size: 0.013, color: '#e6f7ff', width: 0.14 });
    lbl.position.set(0, -0.055, 0.004);
    this.group.add(lbl);
    this.color = color;
  }

  getWorldPosition(out = new THREE.Vector3()) {
    return this.group.getWorldPosition(out);
  }

  getWorldQuaternion(out = new THREE.Quaternion()) {
    return this.group.getWorldQuaternion(out);
  }

  update(dt) {
    this.indicator.update(dt);
  }
}

/**
 * A heavy power patch cable. One end is fixed to a bus bar; the plug end is
 * grabbable and can be seated into any Socket. The cable itself is a live
 * TubeGeometry that sags between the two ends.
 */
export class PatchCable extends Interactable {
  constructor({ id, anchor, sockets, initialSocket = null, color = 0xffa14a, onPlug = null, onUnplug = null, name = 'cable' }) {
    const group = new THREE.Group();
    group.name = `${name}-${id}`;
    super(group);
    this.id = id;
    this.anchor = anchor.clone(); // local (parent) space
    this.sockets = sockets;
    this.socket = null;
    this.onPlug = onPlug;
    this.onUnplug = onUnplug;
    this.color = color;
    this._tmp = new THREE.Vector3();
    this._restPos = anchor.clone().add(new THREE.Vector3(0, -0.25, 0.08));

    this.plug = new THREE.Group();
    const body = new THREE.Mesh(new THREE.CylinderGeometry(0.02, 0.022, 0.09, 20), new THREE.MeshStandardMaterial({ color, roughness: 0.5, metalness: 0.4, emissive: color, emissiveIntensity: 0 }));
    body.rotation.x = Math.PI / 2;
    this.plug.add(body);
    this.plugMat = body.material;
    const tip = new THREE.Mesh(new THREE.CylinderGeometry(0.014, 0.014, 0.04, 16), MAT.brushed);
    tip.rotation.x = Math.PI / 2;
    tip.position.z = -0.06;
    tip.userData.hittable = false;
    this.plug.add(tip);
    const collar = new THREE.Mesh(new THREE.TorusGeometry(0.02, 0.005, 10, 24), MAT.rubber);
    collar.position.z = 0.03;
    collar.userData.hittable = false;
    this.plug.add(collar);
    group.add(this.plug);
    this.plug.position.copy(this._restPos);

    this.cableMat = new THREE.MeshStandardMaterial({ color: 0x111316, roughness: 0.9, metalness: 0.1 });
    this.cableMesh = new THREE.Mesh(new THREE.BufferGeometry(), this.cableMat);
    this.cableMesh.userData.hittable = false;
    group.add(this.cableMesh);

    const anchorMesh = new THREE.Mesh(new THREE.CylinderGeometry(0.025, 0.025, 0.03, 16), MAT.brushed);
    anchorMesh.position.copy(anchor);
    anchorMesh.rotation.x = Math.PI / 2;
    anchorMesh.userData.hittable = false;
    group.add(anchorMesh);

    this._rebuildCable();
    if (initialSocket) this.plugInto(initialSocket, true);
  }

  get hitObjects() {
    return [this.plug.children[0]];
  }

  plugInto(socket, silent = false) {
    if (socket.plug && socket.plug !== this) return false;
    if (this.socket) this.unplug(true);
    this.socket = socket;
    socket.plug = this;
    socket.indicator.set('green');
    // seat into the socket: convert the socket's world pose into cable-group space
    this.root.updateWorldMatrix(true, false);
    const wp = socket.getWorldPosition(new THREE.Vector3());
    const wq = socket.getWorldQuaternion(new THREE.Quaternion());
    const rootInv = this.root.getWorldQuaternion(new THREE.Quaternion()).invert();
    const localQ = rootInv.clone().multiply(wq);
    this.root.worldToLocal(wp);
    this.plug.position.copy(wp).add(new THREE.Vector3(0, 0, 0.045).applyQuaternion(localQ));
    this.plug.quaternion.copy(localQ);
    this._rebuildCable();
    if (!silent) {
      sfx.confirm();
      this.onPlug?.(socket, this);
    }
    return true;
  }

  unplug(silent = false) {
    const s = this.socket;
    if (!s) return;
    s.plug = null;
    s.indicator.set('off');
    this.socket = null;
    if (!silent) this.onUnplug?.(s, this);
  }

  onHoverStart() {
    this.plugMat.emissiveIntensity = 0.35;
  }
  onHoverEnd() {
    if (!this.pressedBy) this.plugMat.emissiveIntensity = 0;
  }

  onPressStart(pointer) {
    this.plugMat.emissiveIntensity = 0.7;
    if (this.socket) {
      sfx.click();
      this.unplug();
    }
    const wp = this.plug.getWorldPosition(new THREE.Vector3());
    this._grabDist = pointer.hasTip ? 0 : wp.distanceTo(pointer.origin);
  }

  onDrag(pointer) {
    if (pointer.hasTip) this._tmp.copy(pointer.tip);
    else this._tmp.copy(pointer.origin).addScaledVector(pointer.direction, this._grabDist);
    this.root.worldToLocal(this._tmp);
    this.plug.position.copy(this._tmp);
    const rootInv = this.root.getWorldQuaternion(new THREE.Quaternion()).invert();
    this.plug.quaternion.copy(rootInv).multiply(pointer.quaternion);
    this._rebuildCable();
    // proximity glow on candidate socket
    const near = this._nearestSocket(0.09);
    for (const s of this.sockets) if (!s.plug) s.indicator.set(s === near ? 'amber' : 'off');
  }

  _nearestSocket(maxDist) {
    let best = null;
    let bd = maxDist;
    const wp = this.plug.getWorldPosition(new THREE.Vector3());
    for (const s of this.sockets) {
      if (s.plug && s.plug !== this) continue;
      const d = s.getWorldPosition(this._tmp).distanceTo(wp);
      if (d < bd) {
        bd = d;
        best = s;
      }
    }
    return best;
  }

  onPressEnd() {
    this.plugMat.emissiveIntensity = 0;
    const near = this._nearestSocket(0.09);
    for (const s of this.sockets) if (!s.plug) s.indicator.set('off');
    if (near) this.plugInto(near);
    else {
      this.plug.position.copy(this._restPos);
      this.plug.quaternion.identity();
      this._rebuildCable();
    }
  }

  _rebuildCable() {
    const a = this.anchor;
    const b = this.plug.position;
    const mid = a.clone().lerp(b, 0.5);
    mid.y -= 0.12 + a.distanceTo(b) * 0.15;
    const q1 = a.clone().lerp(mid, 0.5);
    q1.y -= 0.03;
    const curve = new THREE.CatmullRomCurve3([a, q1, mid, b.clone().add(new THREE.Vector3(0, 0, 0.05).applyQuaternion(this.plug.quaternion))]);
    const geo = new THREE.TubeGeometry(curve, 20, 0.011, 8, false);
    this.cableMesh.geometry.dispose();
    this.cableMesh.geometry = geo;
  }
}
