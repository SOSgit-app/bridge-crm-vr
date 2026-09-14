import * as THREE from 'three';

export const ROLES = Object.freeze({
  CAPTAIN: 'CAPTAIN',
  HELM: 'HELM',
  TACTICAL: 'TACTICAL',
  SCIENCE: 'SCIENCE',
  ENGINEERING: 'ENGINEERING',
});

export const ROLE_ORDER = [ROLES.CAPTAIN, ROLES.HELM, ROLES.TACTICAL, ROLES.SCIENCE, ROLES.ENGINEERING];

export const ROLE_META = Object.freeze({
  [ROLES.CAPTAIN]: { label: 'COMMAND', sub: 'Captain · Holo-Table', color: 0xffc85a },
  [ROLES.HELM]: { label: 'HELM', sub: 'Flight Operations', color: 0x5ad0ff },
  [ROLES.TACTICAL]: { label: 'TACTICAL', sub: 'Electronic Warfare', color: 0xff5a6a },
  [ROLES.SCIENCE]: { label: 'SCIENCE', sub: 'Sensors · ISR', color: 0x7dff9a },
  [ROLES.ENGINEERING]: { label: 'ENGINEERING', sub: 'Power Systems', color: 0xffa14a },
});

// Seat / stand positions on the bridge. Headset origin is recentred onto
// these so every operator faces their own console with zero locomotion.
// Bridge coordinate system: +Z is aft (toward the captain), -Z is forward
// (toward the main viewport). y = floor height of the player's eye reference.
export const STATION_SEATS = Object.freeze({
  [ROLES.CAPTAIN]: { position: new THREE.Vector3(0, 0.45, 2.6), yaw: 0, seated: true },
  [ROLES.HELM]: { position: new THREE.Vector3(-1.1, 0, -0.4), yaw: 0, seated: true },
  [ROLES.TACTICAL]: { position: new THREE.Vector3(1.1, 0, -0.4), yaw: 0, seated: true },
  [ROLES.SCIENCE]: { position: new THREE.Vector3(-2.6, 0, 1.6), yaw: Math.PI / 2, seated: true },
  [ROLES.ENGINEERING]: { position: new THREE.Vector3(2.6, 0, 1.6), yaw: -Math.PI / 2, seated: false, pitch: -0.05 },
});

export const APP_PHASE = Object.freeze({
  ROLE_SELECT: 'ROLE_SELECT',
  CALIBRATE: 'CALIBRATE',
  STANDBY: 'STANDBY',
  RUNNING: 'RUNNING',
  COMPLETE: 'COMPLETE',
});

export const PALETTE = Object.freeze({
  hull: 0x1c2330,
  hullDark: 0x0f141d,
  trim: 0x3a4658,
  panel: 0x151b26,
  screenBg: '#04101c',
  screenFg: '#8fd3ff',
  screenDim: '#2c5f86',
  amber: '#ffb347',
  red: '#ff4c5b',
  green: '#6dff9c',
  white: '#e6f7ff',
});

export const LAYERS = Object.freeze({
  DEFAULT: 0,
  INTERACTABLE: 1,
});
