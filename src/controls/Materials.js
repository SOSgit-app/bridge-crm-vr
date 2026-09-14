import * as THREE from 'three';

// Shared PBR materials. Static bridge geometry uses vertexColors so baked AO
// can be multiplied in without extra texture memory.
// Base colours are kept mid-tone because the baked vertex lighting (AO x
// light) multiplies them down; the bake carries the actual darkness.
export const MAT = {
  hull: new THREE.MeshStandardMaterial({ color: 0x6b7a8f, roughness: 0.55, metalness: 0.55, vertexColors: true }),
  hullDark: new THREE.MeshStandardMaterial({ color: 0x46505e, roughness: 0.7, metalness: 0.45, vertexColors: true }),
  trim: new THREE.MeshStandardMaterial({ color: 0x9aa7b8, roughness: 0.35, metalness: 0.8, vertexColors: true }),
  panel: new THREE.MeshStandardMaterial({ color: 0x5a6676, roughness: 0.45, metalness: 0.5, vertexColors: true }),
  brushed: new THREE.MeshStandardMaterial({ color: 0x8a94a3, roughness: 0.3, metalness: 1.0 }),
  rubber: new THREE.MeshStandardMaterial({ color: 0x141618, roughness: 0.95, metalness: 0.0 }),
  knob: new THREE.MeshStandardMaterial({ color: 0x2a3140, roughness: 0.4, metalness: 0.7 }),
  glassDark: new THREE.MeshPhysicalMaterial({
    color: 0x0a1420, roughness: 0.08, metalness: 0.1, transmission: 0.0, clearcoat: 1, clearcoatRoughness: 0.1,
  }),
  floorGrate: new THREE.MeshStandardMaterial({ color: 0x4a5560, roughness: 0.8, metalness: 0.35, vertexColors: true }),
};

export function emissive(hex, intensity = 1.5) {
  return new THREE.MeshStandardMaterial({
    color: 0x000000,
    emissive: new THREE.Color(hex),
    emissiveIntensity: intensity,
    roughness: 0.4,
    metalness: 0.0,
  });
}

export function colorMat(hex, roughness = 0.5, metalness = 0.5) {
  return new THREE.MeshStandardMaterial({ color: hex, roughness, metalness });
}
