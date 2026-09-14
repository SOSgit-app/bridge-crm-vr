import * as THREE from 'three';

const cache = new Map();

/**
 * Engraved / silkscreened text on console geometry. Rendered as a thin
 * emissive-less plane with alpha so it reads as paint, not a floating HUD.
 */
export function makeLabel(text, { size = 0.014, color = '#dfe9f3', width = null, align = 'center', px = 64, bg = null } = {}) {
  const key = `${text}|${color}|${align}|${px}|${bg}`;
  let tex = cache.get(key);
  let aspect;
  if (!tex) {
    const canvas = document.createElement('canvas');
    const ctx = canvas.getContext('2d');
    ctx.font = `bold ${px}px Consolas, Menlo, monospace`;
    const w = Math.ceil(ctx.measureText(text).width) + px * 0.4;
    canvas.width = Math.max(4, w);
    canvas.height = Math.round(px * 1.3);
    ctx.font = `bold ${px}px Consolas, Menlo, monospace`;
    if (bg) {
      ctx.fillStyle = bg;
      ctx.fillRect(0, 0, canvas.width, canvas.height);
    }
    ctx.fillStyle = color;
    ctx.textBaseline = 'middle';
    ctx.textAlign = 'center';
    ctx.fillText(text, canvas.width / 2, canvas.height / 2);
    tex = new THREE.CanvasTexture(canvas);
    tex.colorSpace = THREE.SRGBColorSpace;
    tex.minFilter = THREE.LinearFilter;
    tex.userData.aspect = canvas.width / canvas.height;
    cache.set(key, tex);
  }
  aspect = tex.userData.aspect;
  const h = size;
  let w = h * aspect;
  if (width && w > width) w = width;
  const mat = new THREE.MeshBasicMaterial({ map: tex, transparent: true, depthWrite: false, opacity: 0.95 });
  const mesh = new THREE.Mesh(new THREE.PlaneGeometry(w, h), mat);
  mesh.name = `label:${text}`;
  mesh.userData.hittable = false;
  mesh.renderOrder = 2;
  return mesh;
}
