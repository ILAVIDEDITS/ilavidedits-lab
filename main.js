// ILAVIDEDITS short-video lab: scroll-driven 3D portfolio.
// Everything is procedural (no external models), so the page is tiny and the scene can be
// exported to .glb with named stage groups (press G, or window.exportGLB()).
import * as THREE from 'three';
import { Reflector } from 'three/addons/objects/Reflector.js';
import { FontLoader } from 'three/addons/loaders/FontLoader.js';
import { TextGeometry } from 'three/addons/geometries/TextGeometry.js';
import { GLTFExporter } from 'three/addons/exporters/GLTFExporter.js';

const CFG = window.LAB_CONFIG || {};
// real clips: put 1.mp4 ... 6.mp4 in ./clips and they replace the drawn placeholders (or list URLs in LAB_CONFIG.clips)
if (!(CFG.clips && CFG.clips.length)) {
  CFG.clips = [];
  for (let i = 1; i <= 6; i++) {            // stop at the first missing file: one quiet 404 at most
    const url = `./clips/${i}.mp4`, ok = await fetch(url, { method: 'HEAD' }).then((r) => r.ok && /video/.test(r.headers.get('content-type') || '')).catch(() => false);
    if (!ok) break; CFG.clips.push(url);
  }
}
const params = new URLSearchParams(location.search);
let FORM = null;   // the contact form on the last desk (set up in the contact stage)
const LITE = params.has('quality')
  ? params.get('quality') === 'low'
  : matchMedia('(pointer:coarse)').matches || Math.min(innerWidth, innerHeight) < 700;
const FORCE_S = params.has('stop') ? parseFloat(params.get('stop')) : null;
const REDUCED = matchMedia('(prefers-reduced-motion: reduce)').matches;

const clamp = (x, a = 0, b = 1) => Math.min(b, Math.max(a, x));
const lerp = (a, b, t) => a + (b - a) * t;
const sstep = (x) => { x = clamp(x); return x * x * (3 - 2 * x); };
const easeOutBack = (x) => { x = clamp(x); const c1 = 1.70158, c3 = c1 + 1; return 1 + c3 * Math.pow(x - 1, 3) + c1 * Math.pow(x - 1, 2); };
const easeInOut = (x) => { x = clamp(x); return x < .5 ? 4 * x * x * x : 1 - Math.pow(-2 * x + 2, 3) / 2; };
let seed = 7;
const rnd = () => { seed = (seed * 16807) % 2147483647; return (seed - 1) / 2147483646; };

// ---------------------------------------------------------------- renderer / scene
const canvas = document.getElementById('lab');
const renderer = new THREE.WebGLRenderer({ canvas, antialias: !LITE, powerPreference: 'high-performance' });
let pixelRatio = Math.min(devicePixelRatio, LITE ? 1.25 : 2);
renderer.setPixelRatio(pixelRatio);
renderer.setSize(innerWidth, innerHeight);
renderer.toneMapping = THREE.ACESFilmicToneMapping;
renderer.toneMappingExposure = 1.3;
renderer.shadowMap.enabled = !LITE;
renderer.shadowMap.type = THREE.PCFSoftShadowMap;

const scene = new THREE.Scene();
scene.background = new THREE.Color(0x060a12);
scene.fog = new THREE.FogExp2(0x080d15, LITE ? 0.024 : 0.019); // cheap haze; the light shafts add the volume on desktop
const camera = new THREE.PerspectiveCamera(50, innerWidth / innerHeight, 0.1, 140);

// tiny environment so metal and the glossy floor have something to reflect
{
  const pm = new THREE.PMREMGenerator(renderer);
  const es = new THREE.Scene();
  es.background = new THREE.Color(0x020203);
  const add = (w, h, d, x, y, z, c, i) => {
    const m = new THREE.Mesh(new THREE.BoxGeometry(w, h, d), new THREE.MeshBasicMaterial({ color: new THREE.Color(c).multiplyScalar(i) }));
    m.position.set(x, y, z); es.add(m);
  };
  add(10, .3, 2, 0, 8, -3, 0xffe2c0, 6);
  add(.4, 6, 6, -9, 3, 0, 0x2ad8ff, 3);
  add(.4, 6, 6, 9, 3, 0, 0xff8a3a, 3);
  add(8, .2, .4, 0, 6, 8, 0xffffff, 2);
  scene.environment = pm.fromScene(es, 0.03).texture;
  scene.environmentIntensity = 0.05;
  pm.dispose();
}

let reflector = null;

// ---------------------------------------------------------------- helpers
const POWER_T0 = {}; // staged power-on
const ramps = [];    // lights
const glows = [];    // emissive materials
function power(T, t0, dur = 0.8) {
  const v = clamp((T - t0) / dur);
  return v < 1 ? v * (0.55 + 0.45 * Math.abs(Math.sin(T * 47 + t0))) * (v > 0 ? 1 : 0) : 1;
}
function addLight(parent, l, x, y, z, t0, skipLite = false) {
  if (LITE && (skipLite || ramps.length >= 10)) return null;   // phones: few lights keeps shader compile and fill rate down
  l.position.set(x, y, z);
  parent.add(l);
  ramps.push({ l, base: l.intensity * 1.6, t0 });
  l.intensity = 0;
  return l;
}
function glowMat(color, k = 1, t0 = null) {
  const base = new THREE.Color(color).multiplyScalar(k);
  const m = new THREE.MeshBasicMaterial({ color: base.clone(), toneMapped: false });
  if (t0 !== null) glows.push({ m, base, t0 });
  return m;
}
const std = (c, r = 0.6, m = 0.2, extra = {}) => new THREE.MeshStandardMaterial({ color: c, roughness: r, metalness: m, ...extra });
const B = (w, h, d) => new THREE.BoxGeometry(w, h, d);
function mk(parent, geo, mat, x = 0, y = 0, z = 0, name) {
  const m = new THREE.Mesh(geo, mat);
  m.position.set(x, y, z);
  if (name) m.name = name;
  parent.add(m);
  return m;
}
function canvasTex(w, h) {
  const cv = document.createElement('canvas');
  cv.width = w; cv.height = h;
  const ctx = cv.getContext('2d');
  const tex = new THREE.CanvasTexture(cv);
  tex.colorSpace = THREE.SRGBColorSpace;
  tex.anisotropy = 4;
  return { cv, ctx, tex };
}
function radialTex(stops) {
  const c = canvasTex(128, 128);
  const g = c.ctx.createRadialGradient(64, 64, 0, 64, 64, 64);
  stops.forEach(([o, col]) => g.addColorStop(o, col));
  c.ctx.fillStyle = g; c.ctx.fillRect(0, 0, 128, 128);
  return c.tex;
}
// ---------------------------------------------------------------- procedural PBR textures
// Albedo + normal + roughness, generated once on a canvas. Tileable, so they repeat without seams.
function hash(x, y) { let h = Math.imul(x, 374761393) + Math.imul(y, 668265263); h = Math.imul(h ^ (h >>> 13), 1274126177); return ((h ^ (h >>> 16)) >>> 0) / 4294967295; }
function vn(x, y, P) {
  const xi = Math.floor(x), yi = Math.floor(y), xf = x - xi, yf = y - yi, u = xf * xf * (3 - 2 * xf), v = yf * yf * (3 - 2 * yf);
  const m = (a) => ((a % P) + P) % P, h = (a, b) => hash(m(a), m(b));
  return lerp(lerp(h(xi, yi), h(xi + 1, yi), u), lerp(h(xi, yi + 1), h(xi + 1, yi + 1), u), v);
}
function fbm(x, y, P, o = 4) { let a = 0.5, s = 0, f = 1, n = 0; for (let i = 0; i < o; i++) { s += a * vn(x * f, y * f, P * f); n += a; f *= 2; a *= 0.5; } return s / n; }
const fr = (x) => x - Math.floor(x);
const TEXN = LITE ? 128 : 256;
function makePBR(fn, strength = 3) {
  const N = TEXN, H = new Float32Array(N * N), out = { r: 0.5, g: 0.5, b: 0.5, h: 0, rough: 0.8 };
  const A = canvasTex(N, N), Rg = canvasTex(N, N), Nm = canvasTex(N, N);
  const ad = A.ctx.createImageData(N, N), rd = Rg.ctx.createImageData(N, N), nd = Nm.ctx.createImageData(N, N);
  for (let y = 0; y < N; y++) for (let x = 0; x < N; x++) {
    fn(x / N, y / N, out); const i = y * N + x; H[i] = out.h;
    ad.data[i * 4] = clamp(out.r) * 255; ad.data[i * 4 + 1] = clamp(out.g) * 255; ad.data[i * 4 + 2] = clamp(out.b) * 255; ad.data[i * 4 + 3] = 255;
    const r = clamp(out.rough) * 255; rd.data[i * 4] = r; rd.data[i * 4 + 1] = r; rd.data[i * 4 + 2] = r; rd.data[i * 4 + 3] = 255;
  }
  for (let y = 0; y < N; y++) for (let x = 0; x < N; x++) {
    const xl = (x + N - 1) % N, xr = (x + 1) % N, yu = (y + N - 1) % N, yd = (y + 1) % N;
    const dx = (H[y * N + xr] - H[y * N + xl]) * strength * N / 64, dy = (H[yd * N + x] - H[yu * N + x]) * strength * N / 64;
    const l = Math.hypot(dx, dy, 1), i = (y * N + x) * 4;
    nd.data[i] = (-dx / l * 0.5 + 0.5) * 255; nd.data[i + 1] = (dy / l * 0.5 + 0.5) * 255; nd.data[i + 2] = (1 / l * 0.5 + 0.5) * 255; nd.data[i + 3] = 255;
  }
  A.ctx.putImageData(ad, 0, 0); Rg.ctx.putImageData(rd, 0, 0); Nm.ctx.putImageData(nd, 0, 0);
  Rg.tex.colorSpace = THREE.NoColorSpace; Nm.tex.colorSpace = THREE.NoColorSpace;
  return { map: A.tex, rough: Rg.tex, normal: Nm.tex };
}
const TX = {
  concrete: makePBR((u, v, o) => {
    const n = fbm(u * 6, v * 6, 6, 5), f = fbm(u * 64, v * 64, 64, 2), st = fbm(u * 3, v * 3, 3, 3);
    let h = n * 0.5 + f * 0.5, k = 0.17 + 0.09 * n + 0.03 * f - 0.05 * Math.max(0, st - 0.55);
    const sx = Math.min(fr(u * 2), 1 - fr(u * 2)), sy = Math.min(fr(v * 2), 1 - fr(v * 2));
    if (sx < 0.006 || sy < 0.006) { h -= 0.8; k *= 0.45; }
    const hx = fr(u * 4) - 0.5, hy = fr(v * 4) - 0.5; if (Math.hypot(hx, hy) < 0.012) { h -= 0.6; k *= 0.5; }
    o.h = h; o.r = k * 0.97; o.g = k; o.b = k * 1.05; o.rough = 0.82 + 0.15 * f;
  }),
  floor: makePBR((u, v, o) => {
    const n = fbm(u * 4, v * 4, 4, 5), f = hash(Math.floor(u * 512), Math.floor(v * 512)), w = fbm(u * 2, v * 2, 2, 3);
    let k = 0.07 + 0.05 * n + 0.015 * f, h = n * 0.3 + f * 0.1, rough = 0.2 + 0.5 * w + 0.15 * f;
    const j = Math.min(fr(u * 2), 1 - fr(u * 2), fr(v * 2), 1 - fr(v * 2)); if (j < 0.0025) { h -= 0.5; k *= 0.7; rough = 0.7; }
    o.h = h; o.r = k; o.g = k * 1.02; o.b = k * 1.08; o.rough = rough;
  }, 2),
  wood: makePBR((u, v, o) => {
    const w = fbm(u * 8, v * 8, 8, 4), g = Math.sin((v * 40 + w * 6 + fbm(u * 2, v * 16, 16, 2) * 3) * Math.PI), pore = hash(Math.floor(u * 256), Math.floor(v * 512));
    const t = clamp(0.5 + 0.35 * g + 0.4 * (w - 0.5));
    o.r = lerp(0.075, 0.2, t) * (0.9 + 0.2 * pore); o.g = lerp(0.04, 0.11, t) * (0.9 + 0.2 * pore); o.b = lerp(0.02, 0.06, t);
    o.h = g * 0.15 + (pore - 0.5) * 0.2; o.rough = 0.42 + 0.2 * (1 - t) + 0.1 * pore;
  }, 2),
  metal: makePBR((u, v, o) => {
    const row = hash(Math.floor(v * 512), 7), row2 = hash(Math.floor(v * 256), 3), n = fbm(u * 4, v * 4, 4, 3);
    const k = 0.6 + 0.12 * (row - 0.5) + 0.08 * (row2 - 0.5) + 0.06 * (n - 0.5);
    o.r = k; o.g = k * 1.01; o.b = k * 1.04; o.h = (row - 0.5) * 0.15; o.rough = 0.32 + 0.22 * row2 + 0.1 * n;
  }, 1.5),
  fabric: makePBR((u, v, o) => {
    const x = Math.floor(u * 128), y = Math.floor(v * 128), wv = ((x + y) & 1) ? 1 : 0, n = fbm(u * 8, v * 8, 8, 3), fz = hash(x, y);
    const k = 0.045 + 0.03 * n + 0.012 * fz + 0.012 * wv;
    o.r = k; o.g = k * 1.04; o.b = k * 1.18; o.h = wv * 0.4 + fz * 0.2; o.rough = 0.96;
  }, 2.5),
  lam: makePBR((u, v, o) => {
    const n = fbm(u * 16, v * 16, 16, 3), k = 0.07 + 0.02 * n;
    o.r = k; o.g = k; o.b = k * 1.06; o.h = n * 0.1; o.rough = 0.5 + 0.2 * n;
  }, 1),
  ceiling: makePBR((u, v, o) => {
    const n = fbm(u * 6, v * 6, 6, 4), f = fbm(u * 64, v * 64, 64, 2);
    const g = Math.min(fr(u * 4), 1 - fr(u * 4), fr(v * 4), 1 - fr(v * 4));
    let k = 0.07 + 0.04 * n + 0.015 * f, h = n * 0.3 + f * 0.2; if (g < 0.012) { h -= 0.9; k *= 0.35; }
    o.h = h; o.r = k; o.g = k * 1.02; o.b = k * 1.08; o.rough = 0.9;
  }, 2.5),
};
function pbr(kind, rx, ry, { color = 0xffffff, metalness = 0, rough = 1, normal = 1, ...extra } = {}) {
  const t = TX[kind], c = (tx) => { const q = tx.clone(); q.repeat.set(rx, ry); q.wrapS = q.wrapT = THREE.RepeatWrapping; q.anisotropy = 8; q.needsUpdate = true; return q; };
  return new THREE.MeshStandardMaterial({ map: c(t.map), normalMap: c(t.normal), roughnessMap: c(t.rough), color, metalness, roughness: rough, normalScale: new THREE.Vector2(normal, normal), ...extra });
}
const woodMat = (w, d) => pbr('wood', Math.max(1, w / 1.4), Math.max(1, d / 1.4), { color: 0xd8d0c8 });
const MAT = {
  wall: pbr('concrete', 10, 2.3, { color: 0xc9ccd2 }),
  slat: pbr('wood', 0.3, 1.2, { color: 0xc8beb2 }),
  dark: pbr('lam', 1, 1, { color: 0xb0b4ba, metalness: 0.4 }),
  metal: pbr('metal', 1.5, 1.5, { color: 0xb4b9c2, metalness: 0.95 }),
  panel: pbr('lam', 1, 1, { color: 0xc0c4cc, metalness: 0.3 }),
  fabric: pbr('fabric', 2, 1, { color: 0xffffff }),
  light: std(0xc9ced6, 0.4, 0.35),
  black: std(0x06070a, 0.35, 0.4),
  rubber: std(0x0a0b0d, 0.85, 0.05),
};
// dark glass layer over screens: adds only the room's reflection, never hides the picture
const glassMat = new THREE.MeshStandardMaterial({ color: 0x000000, roughness: 0.05, metalness: 0, transparent: true, blending: THREE.AdditiveBlending, depthWrite: false, envMapIntensity: 3.2 });
const D = new THREE.Object3D();
const ST = {}; // stage groups by name
const stageGroup = (i, name, x, z) => {
  const g = new THREE.Group();
  g.name = `stage_${String(i + 1).padStart(2, '0')}_${name}`;
  g.position.set(x, 0, z);
  scene.add(g);
  ST[name] = g;
  return g;
};
const updates = [];       // updates[k](T, dt)
const act = new Array(11).fill(false);

// ---------------------------------------------------------------- procedural "videos"
const WORDS = [['STOP', 'SCROLLING', 'THIS IS', 'THE HOOK'], ['WAIT', 'FOR IT', 'NO WAY', 'WATCH'], ['3 TIPS', 'THAT WORK', 'EVERY', 'TIME'],
  ['BEFORE', 'AFTER', 'SAME DAY', 'BIG CHANGE'], ['THE SECRET', 'NOBODY', 'TELLS YOU', 'ABOUT'], ['LOOK', 'AT THIS', 'CLEAN', 'CUT']];
function drawClip(c, w, h, t, v, o = {}) {
  const hue = [195, 24, 268, 150, 330, 45][v % 6];
  const g = c.createLinearGradient(0, 0, w * 0.3, h);
  g.addColorStop(0, `hsl(${hue + 12 * Math.sin(t * 0.5)},62%,${24 + 6 * Math.sin(t * 0.9)}%)`);
  g.addColorStop(1, `hsl(${hue + 50},55%,9%)`);
  c.fillStyle = g; c.fillRect(0, 0, w, h);
  for (let i = 0; i < 4; i++) {
    const x = w * (0.5 + 0.42 * Math.sin(t * 0.5 + i * 1.9 + v)), y = h * (0.38 + 0.28 * Math.cos(t * 0.4 + i * 2.3)), r = w * (0.35 + 0.1 * Math.sin(t + i));
    const rg = c.createRadialGradient(x, y, 0, x, y, r);
    rg.addColorStop(0, `hsla(${hue + 30 * i},90%,60%,.32)`); rg.addColorStop(1, 'hsla(0,0%,0%,0)');
    c.fillStyle = rg; c.fillRect(0, 0, w, h);
  }
  const bob = Math.sin(t * 2.2) * h * 0.006, cx = w * 0.5 + Math.sin(t * 0.7) * w * 0.03;
  c.fillStyle = 'rgba(8,10,14,.82)';
  c.beginPath(); c.ellipse(cx, h * 0.47 + bob, w * 0.095, w * 0.115, 0, 0, 7); c.fill();
  c.beginPath(); c.moveTo(cx - w * 0.3, h * 0.72); c.quadraticCurveTo(cx - w * 0.27, h * 0.57 + bob, cx, h * 0.57 + bob);
  c.quadraticCurveTo(cx + w * 0.27, h * 0.57 + bob, cx + w * 0.3, h * 0.72); c.lineTo(cx + w * 0.3, h); c.lineTo(cx - w * 0.3, h); c.closePath(); c.fill();
  if (o.caption !== false) {
    const W = WORDS[v % 6], idx = Math.floor(t / 0.65) % W.length, ph = (t / 0.65) % 1, sc = 1 + 0.3 * Math.exp(-ph * 9);
    c.save(); c.translate(w / 2, h * 0.78); c.scale(sc, sc);
    c.font = `900 ${w * 0.13}px Inter, Helvetica, Arial, sans-serif`; c.textAlign = 'center'; c.textBaseline = 'middle';
    c.lineWidth = w * 0.03; c.strokeStyle = '#000'; c.lineJoin = 'round';
    c.strokeText(W[idx], 0, 0, w * 0.86);
    c.fillStyle = idx % 2 ? '#ffd24a' : '#fff'; c.fillText(W[idx], 0, 0, w * 0.86);
    c.restore();
  }
  c.fillStyle = 'rgba(255,255,255,.25)'; c.fillRect(w * 0.06, h * 0.03, w * 0.88, h * 0.008);
  c.fillStyle = '#fff'; c.fillRect(w * 0.06, h * 0.03, w * 0.88 * ((t * 0.12) % 1), h * 0.008);
}
const clipCache = [];
function getClip(v) {
  if (clipCache[v]) return clipCache[v];
  let o;
  const url = (CFG.clips || [])[v];
  if (url) {
    const vid = document.createElement('video');
    Object.assign(vid, { src: url, muted: true, loop: true, playsInline: true, crossOrigin: 'anonymous' });
    vid.play().catch(() => {});
    const tex = new THREE.VideoTexture(vid); tex.colorSpace = THREE.SRGBColorSpace;
    o = { tex, tick() {} };
  } else {
    const c = canvasTex(216, 384);
    o = { tex: c.tex, tick(t) { drawClip(c.ctx, 216, 384, t + v * 3.1, v); c.tex.needsUpdate = true; } };
  }
  return (clipCache[v] = o);
}
const screenMat = (tex) => new THREE.MeshBasicMaterial({ map: tex, toneMapped: false });

// ---------------------------------------------------------------- font
const font = await new Promise((res, rej) => new FontLoader().load('./vendor/fonts/helvetiker_bold.typeface.json', res, undefined, rej));
const fontThin = await new Promise((res, rej) => new FontLoader().load('./vendor/fonts/helvetiker_regular.typeface.json', res, undefined, rej));

// ---------------------------------------------------------------- room
const room = new THREE.Group(); room.name = 'room'; scene.add(room);
{
  // floor: soft reflection (desktop) under a dark glossy layer
  const floorGeo = new THREE.PlaneGeometry(40, 34);
  if (!LITE) {
    reflector = new Reflector(floorGeo, { color: 0x888888, textureWidth: 1024, textureHeight: 768, clipBias: 0.003 });
    reflector.rotation.x = -Math.PI / 2; reflector.position.set(0, 0, 0); reflector.name = 'floor_reflection';
    room.add(reflector);
  }
  const floorMat = pbr('floor', 10, 8.5, { color: 0xffffff, metalness: 0.35, normal: 0.25, transparent: !LITE, opacity: LITE ? 1 : 0.82 });
  const over = mk(room, floorGeo, floorMat, 0, 0.004, 0, 'floor');
  over.rotation.x = -Math.PI / 2;

  const plane = (w, h, mat, pos, rot, name) => {
    const m = new THREE.Mesh(new THREE.PlaneGeometry(w, h), mat); m.position.set(...pos); m.rotation.set(...rot); m.name = name; room.add(m); return m;
  };
  plane(40, 9.2, MAT.wall, [0, 4.6, -15], [0, 0, 0], 'wall_back');
  plane(34, 9.2, pbr('concrete', 8.5, 2.3, { color: 0xc9ccd2 }), [-18, 4.6, 0], [0, Math.PI / 2, 0], 'wall_left');
  plane(34, 9.2, pbr('concrete', 8.5, 2.3, { color: 0xc9ccd2 }), [18, 4.6, 0], [0, -Math.PI / 2, 0], 'wall_right');
  plane(40, 34, pbr('ceiling', 10, 8.5, { color: 0xffffff }), [0, 9.2, 0], [Math.PI / 2, 0, 0], 'ceiling');

  // oak slat wall behind the sign (dark felt backing + real wood slats)
  mk(room, B(21, 8.4, 0.05), MAT.fabric, 1, 4.9, -14.94, 'slat_backing');
  const NS = 86, slats = new THREE.InstancedMesh(B(0.11, 8.4, 0.09), MAT.slat, NS);
  slats.name = 'wall_slats';
  for (let i = 0; i < NS; i++) { D.position.set(-9.3 + i * 0.245, 4.9, -14.86); D.updateMatrix(); slats.setMatrixAt(i, D.matrix); }
  room.add(slats);
  mk(room, B(21.6, 0.18, 0.14), MAT.metal, 1, 0.7, -14.85, 'slat_trim_bottom');
  mk(room, B(21.6, 0.18, 0.14), MAT.metal, 1, 9.0, -14.85, 'slat_trim_top');

  // steel columns, cable trays and acoustic panels on the side walls
  [-12, -4, 4, 12].forEach((z) => [-17.8, 17.8].forEach((x) => { if (x < 0 && z > -3) return; /* phone wall lives there */ mk(room, B(0.45, 9.2, 0.45), MAT.metal, x, 4.6, z, 'column'); }));
  [-17.9, 17.9].forEach((x) => {
    mk(room, B(0.34, 0.06, 30), MAT.metal, x, 6.6, 0, 'cable_tray');
    for (let i = 0; i < 6; i++) mk(room, new THREE.CylinderGeometry(0.012, 0.012, 30, 6), MAT.rubber, x, 6.64 + (i % 3) * 0.012, (i - 2.5) * 0.04).rotation.x = Math.PI / 2;
  });
  [[-17.93, -12.3], [-17.93, -9.3], [17.93, -10], [17.93, -6.8], [17.93, 6], [17.93, 9.2], [-17.93, -6.3]].forEach(([x, z], i) => {
    const m = mk(room, B(0.08, 1.3, 2.5), MAT.fabric, x, 3.2, z, 'acoustic_panel'); m.rotation.y = 0;
    mk(room, B(0.1, 1.36, 2.56), MAT.black, x + Math.sign(x) * -0.01, 3.2, z);
    mk(room, B(0.095, 1.28, 2.48), MAT.fabric, x - Math.sign(x) * 0.004, 3.2, z);
  });
  // exposed ceiling: ducts, pipes, trusses
  [-10, 1, 10].forEach((z, i) => {
    const d = mk(room, new THREE.CylinderGeometry(0.34, 0.34, 36, 24), MAT.metal, 0, 8.15, z, 'duct'); d.rotation.z = Math.PI / 2;
    for (let k = -3; k <= 3; k++) mk(room, B(0.12, 0.72, 0.72), MAT.metal, k * 5.2 + i, 8.15, z, 'duct_clamp');
  });
  for (let i = -3; i <= 3; i++) mk(room, B(0.22, 0.3, 33), MAT.metal, i * 5.6, 8.95, 0, 'truss');
  [-14, 14].forEach((z) => { const pp = mk(room, new THREE.CylinderGeometry(0.07, 0.07, 36, 12), MAT.metal, 0, 8.65, z, 'pipe'); pp.rotation.z = Math.PI / 2; });

  // trim light lines + ceiling bars (power on one by one)
  const cyanStrip = glowMat(0x2ad8ff, 1.1, 1.0);
  mk(room, B(36, 0.04, 0.04), cyanStrip, 0, 0.12, -14.9, 'strip_back_floor');
  mk(room, B(0.04, 0.04, 30), cyanStrip, -17.95, 0.12, 0, 'strip_left_floor');
  mk(room, B(0.04, 0.04, 30), cyanStrip, 17.95, 0.12, 0, 'strip_right_floor');
  for (let i = 0; i < 5; i++) {
    const bar = mk(room, B(0.14, 0.05, 7), glowMat(0xfff0dd, 1.6, 0.6 + i * 0.45), -12 + i * 6, 9.05, -2, `lightbar_${i + 1}`);
    bar.position.z = i % 2 ? 4 : -4;
  }
}

// dust motes
const dust = (() => {
  const n = LITE ? 140 : 520, p = new Float32Array(n * 3);
  for (let i = 0; i < n; i++) { p[i * 3] = (rnd() - 0.5) * 34; p[i * 3 + 1] = 0.3 + rnd() * 8; p[i * 3 + 2] = (rnd() - 0.5) * 28; }
  const g = new THREE.BufferGeometry(); g.setAttribute('position', new THREE.BufferAttribute(p, 3));
  const pts = new THREE.Points(g, new THREE.PointsMaterial({ size: 0.04, color: 0x9fdcff, transparent: true, opacity: 0.5, depthWrite: false, blending: THREE.AdditiveBlending }));
  pts.name = 'dust'; pts.frustumCulled = false; scene.add(pts); return pts;
})();

// light shafts (the desktop "volumetric haze")
const shafts = [];
function shaft(x, y, z, h, r, color, op) {
  if (LITE) return;
  const m = new THREE.ShaderMaterial({
    transparent: true, depthWrite: false, blending: THREE.AdditiveBlending, side: THREE.DoubleSide,
    uniforms: { c: { value: new THREE.Color(color) }, o: { value: op } },
    vertexShader: 'varying vec2 vUv; varying vec3 vN; varying vec3 vV; void main(){ vUv=uv; vN=normalize(normalMatrix*normal); vec4 mv=modelViewMatrix*vec4(position,1.); vV=normalize(-mv.xyz); gl_Position=projectionMatrix*mv; }',
    fragmentShader: 'uniform vec3 c; uniform float o; varying vec2 vUv; varying vec3 vN; varying vec3 vV; void main(){ float e=pow(abs(dot(normalize(vN),normalize(vV))),2.2); gl_FragColor=vec4(c, pow(vUv.y,1.4)*e*o); }',
  });
  const cone = new THREE.Mesh(new THREE.ConeGeometry(r, h, 32, 1, true), m);
  cone.userData.o = op; cone.position.set(x, y - h / 2, z); cone.name = 'shaft'; scene.add(cone); shafts.push(cone);
}

// ---------------------------------------------------------------- lights
scene.add(new THREE.HemisphereLight(0x3a5070, 0x080808, 0.5));
{
  const hemi = scene.children[scene.children.length - 1];
  ramps.push({ l: hemi, base: LITE ? 3.2 : 0.9, t0: 0.15 }); hemi.intensity = 0;   // phones run few lights, so the ambient carries more
  const key = new THREE.SpotLight(0xffc58a, 520, 45, 0.75, 1, 2);
  key.target.position.set(3, 0, -4); scene.add(key.target);
  if (!LITE) {
    key.castShadow = true; key.shadow.mapSize.set(2048, 2048); key.shadow.bias = -0.0004; key.shadow.normalBias = 0.04; key.shadow.camera.near = 2; key.shadow.camera.far = 40; key.shadow.radius = 4;
  }
  addLight(scene, key, -6, 8.6, 2, 0.8);
  const back = new THREE.SpotLight(0xffd7aa, 300, 40, 1.0, 1, 2);
  back.target.position.set(1, 0, -9.5); scene.add(back.target);
  if (!LITE) { back.castShadow = true; back.shadow.mapSize.set(1536, 1536); back.shadow.bias = -0.0004; back.shadow.normalBias = 0.04; back.shadow.camera.near = 2; back.shadow.camera.far = 30; back.shadow.radius = 4; }
  addLight(scene, back, 1, 8.7, -3, 1.0);
}
addLight(scene, new THREE.PointLight(0x4fd8ff, 55, 14, 2), 11.5, 3.5, -10, 2.5);
addLight(scene, new THREE.PointLight(0xffb070, 45, 12, 2), -12, 3.2, -6.5, 1.2, true);
addLight(scene, new THREE.PointLight(0x4fd8ff, 50, 12, 2), -6, 3.4, -6.3, 1.6);
addLight(scene, new THREE.PointLight(0xff9a50, 50, 12, 2), 8, 3.2, -6.3, 2.0);
addLight(scene, new THREE.PointLight(0x9fdcff, 40, 11, 2), 12.5, 3.1, 0.5, 2.4, true);
addLight(scene, new THREE.PointLight(0xffa860, 45, 11, 2), 12, 3.6, 6.5, 2.8);
addLight(scene, new THREE.PointLight(0x4fd8ff, 55, 12, 2), 3, 3.4, 6.5, 3.2, true);
addLight(scene, new THREE.PointLight(0xdfe8ff, 70, 14, 2), -13, 5.5, 5, 3.6);
addLight(scene, new THREE.PointLight(0xffc890, 60, 12, 2), 1.2, 3.4, -10, 3.9);
shaft(-6, 9, -8, 9, 2.6, 0x4fd8ff, 0.07);
shaft(8, 9, -8, 9, 2.4, 0xff9a50, 0.06);
shaft(1.2, 9, -11, 9, 2.8, 0xffc890, 0.06);

// ---------------------------------------------------------------- sign
{
  const sign = new THREE.Group(); sign.name = 'sign_ilavidedits'; sign.position.set(1.2, 6.6, -14.75); scene.add(sign);
  const geo = new TextGeometry('ILAVIDEDITS', { font: fontThin, size: 0.78, depth: 0.025, curveSegments: 6, bevelEnabled: false });
  geo.computeBoundingBox(); geo.translate(-(geo.boundingBox.max.x + geo.boundingBox.min.x) / 2, -0.39, 0);
  const m = glowMat(0xffe6c4, 1.7, 3.0);
  const letters = new THREE.Mesh(geo, m); letters.name = 'sign_letters'; sign.add(letters);
  const halo = new THREE.Mesh(new THREE.PlaneGeometry(11, 2.6), new THREE.MeshBasicMaterial({
    map: radialTex([[0, 'rgba(255,190,120,.5)'], [1, 'rgba(255,190,120,0)']]), transparent: true, depthWrite: false, blending: THREE.AdditiveBlending, opacity: 0.35, toneMapped: false,
  }));
  halo.position.z = -0.1; halo.name = 'sign_halo'; sign.add(halo);
  glows.push({ halo: halo.material, t0: 3.0 });
  addLight(sign, new THREE.PointLight(0xffd9a8, 22, 10, 2), 0, -0.6, 1.4, 3.0, true);
}

// ---------------------------------------------------------------- set dressing helpers
const blobTex = radialTex([[0, 'rgba(0,0,0,.85)'], [0.6, 'rgba(0,0,0,.4)'], [1, 'rgba(0,0,0,0)']]);
function blob(parent, x, z, w, d, op = 0.8) {
  const m = new THREE.Mesh(new THREE.PlaneGeometry(w, d), new THREE.MeshBasicMaterial({ map: blobTex, transparent: true, opacity: op, depthWrite: false, toneMapped: false, fog: false }));
  m.rotation.x = -Math.PI / 2; m.position.set(x, 0.008, z); m.name = 'contact_shadow'; m.userData.noShadow = true; parent.add(m); return m;
}
function glassOver(parent, w, h, x, y, z) { const m = new THREE.Mesh(new THREE.PlaneGeometry(w, h), glassMat); m.position.set(x, y, z); m.name = 'screen_glass'; m.userData.noShadow = true; parent.add(m); return m; }
function cable(parent, pts, r = 0.012) {
  const curve = new THREE.CatmullRomCurve3(pts.map((p) => new THREE.Vector3(...p)));
  const m = new THREE.Mesh(new THREE.TubeGeometry(curve, 28, r, 6, false), MAT.rubber); m.name = 'cable'; parent.add(m); return m;
}
function chair(parent, x, z, ry) {
  const c = new THREE.Group(); c.name = 'chair'; c.position.set(x, 0, z); c.rotation.y = ry; parent.add(c);
  mk(c, B(0.58, 0.1, 0.56), MAT.fabric, 0, 0.52, 0);
  const back = mk(c, B(0.52, 0.62, 0.08), MAT.fabric, 0, 0.9, -0.27); back.rotation.x = -0.12;
  mk(c, B(0.44, 0.5, 0.03), MAT.black, 0, 0.9, -0.31).rotation.x = -0.12;
  mk(c, new THREE.CylinderGeometry(0.03, 0.04, 0.34, 10), MAT.metal, 0, 0.3, 0);
  [-1, 1].forEach((sd) => { mk(c, B(0.05, 0.03, 0.34), MAT.black, sd * 0.31, 0.7, 0); mk(c, B(0.03, 0.18, 0.04), MAT.metal, sd * 0.31, 0.6, 0.02); });
  for (let i = 0; i < 5; i++) {
    const a = (i / 5) * Math.PI * 2, arm = mk(c, B(0.33, 0.035, 0.05), MAT.black, Math.cos(a) * 0.165, 0.12, Math.sin(a) * 0.165); arm.rotation.y = -a;
    mk(c, new THREE.SphereGeometry(0.04, 10, 8), MAT.rubber, Math.cos(a) * 0.32, 0.04, Math.sin(a) * 0.32);
  }
  return c;
}

// ================================================================ STAGE 0: THE DOOR (outside, before the lab)
const DOOR = { x: -4, w: 2.8, h: 3.3, bell: 1.6, open: 3.0, dur: 1.5, wall: 15, face: 15.35 };
let actx = null;
function audio() {
  if (!actx) { try { actx = new (window.AudioContext || window.webkitAudioContext)(); } catch (e) { return null; } }
  if (actx.state === 'suspended') actx.resume().catch(() => {});
  return actx.state === 'running' ? actx : null;
}
['pointerdown', 'keydown', 'touchstart'].forEach((ev) => addEventListener(ev, audio));
function chime() {
  const a = audio(); if (!a) return;
  [[659, 0], [523, 0.5]].forEach(([f, t]) => {
    const o = a.createOscillator(), g = a.createGain(), t0 = a.currentTime + t; o.type = 'sine'; o.frequency.value = f;
    g.gain.setValueAtTime(0, t0); g.gain.linearRampToValueAtTime(0.16, t0 + 0.02); g.gain.exponentialRampToValueAtTime(0.0001, t0 + 1.2);
    o.connect(g).connect(a.destination); o.start(t0); o.stop(t0 + 1.3);
  });
}
function hiss() {
  const a = audio(); if (!a) return;
  const len = Math.floor(a.sampleRate * 1.5), buf = a.createBuffer(1, len, a.sampleRate), d = buf.getChannelData(0);
  for (let i = 0; i < len; i++) d[i] = (Math.random() * 2 - 1) * Math.pow(1 - i / len, 1.5) * Math.min(1, i / (a.sampleRate * 0.05));
  const src = a.createBufferSource(); src.buffer = buf; const f = a.createBiquadFilter(); f.type = 'highpass'; f.frequency.value = 2200; const g = a.createGain(); g.gain.value = 0.22;
  src.connect(f).connect(g).connect(a.destination); src.start();
}
{
  const g = new THREE.Group(); g.name = 'stage_00_door'; scene.add(g); ST.door = g;
  const x0 = DOOR.x - DOOR.w / 2, x1 = DOOR.x + DOOR.w / 2, W = 40, H = 9.2, wallPlane = (w, h, mat, x, y, z, ry, name) => {
    const m = new THREE.Mesh(new THREE.PlaneGeometry(w, h), mat); m.position.set(x, y, z); m.rotation.y = ry; m.name = name; g.add(m); return m;
  };
  // wall with a door opening: inside face, outside face
  const inner = [[-W / 2, x0, 0, H, 'in_left'], [x1, W / 2, 0, H, 'in_right']];
  inner.forEach(([a, b, ya, hh, n]) => wallPlane(b - a, hh, pbr('concrete', (b - a) / 4, 2.3, { color: 0xc9ccd2 }), (a + b) / 2, hh / 2, DOOR.wall, Math.PI, 'wall_front_' + n));
  wallPlane(DOOR.w, H - DOOR.h, pbr('concrete', 0.7, 1.4, { color: 0xc9ccd2 }), DOOR.x, DOOR.h + (H - DOOR.h) / 2, DOOR.wall, Math.PI, 'wall_front_in_top');
  const ext = pbr('concrete', 1, 1, { color: 0x8c9199 });
  const extMat = (w, h) => pbr('concrete', w / 4, h / 4, { color: 0x8c9199 });
  [[-W / 2, x0], [x1, W / 2]].forEach(([a, b], i) => wallPlane(b - a, H, extMat(b - a, H), (a + b) / 2, H / 2, DOOR.face, 0, 'facade_' + i));
  wallPlane(DOOR.w, H - DOOR.h, extMat(DOOR.w, H - DOOR.h), DOOR.x, DOOR.h + (H - DOOR.h) / 2, DOOR.face, 0, 'facade_top');
  // door frame, threshold, canopy
  const fz = (DOOR.wall + DOOR.face) / 2, fd = DOOR.face - DOOR.wall + 0.1;
  [x0, x1].forEach((x) => mk(g, B(0.16, DOOR.h, fd), MAT.metal, x, DOOR.h / 2, fz, 'door_jamb'));
  mk(g, B(DOOR.w + 0.16, 0.18, fd), MAT.metal, DOOR.x, DOOR.h + 0.05, fz, 'door_lintel');
  mk(g, B(DOOR.w, 0.05, fd), MAT.metal, DOOR.x, 0.025, fz, 'door_threshold');
  mk(g, B(4.6, 0.14, 1.9), MAT.metal, DOOR.x, 4.0, DOOR.face + 0.95, 'door_canopy');
  mk(g, B(4.4, 0.03, 0.03), glowMat(0xffe2bd, 1.6), DOOR.x, 3.92, DOOR.face + 1.8, 'door_canopy_strip');
  // exterior sign: always on
  const sg = new TextGeometry('ILAVIDEDITS', { font: fontThin, size: 0.36, depth: 0.02, curveSegments: 5, bevelEnabled: false });
  sg.computeBoundingBox(); sg.translate(-(sg.boundingBox.max.x + sg.boundingBox.min.x) / 2, -0.18, 0);
  mk(g, sg, glowMat(0xdff4ff, 1.8), DOOR.x, 4.9, DOOR.face + 0.03, 'door_sign');
  mk(g, new THREE.PlaneGeometry(6, 1.6), new THREE.MeshBasicMaterial({ map: radialTex([[0, 'rgba(160,220,255,.5)'], [1, 'rgba(160,220,255,0)']]), transparent: true, depthWrite: false, blending: THREE.AdditiveBlending, opacity: 0.3, toneMapped: false }), DOOR.x, 4.9, DOOR.face + 0.01, 'door_sign_halo');
  // sliding glass leaves (they slide into the wall pocket)
  const paneM = new THREE.MeshStandardMaterial({ color: 0x9fd0e0, roughness: 0.04, metalness: 0.1, transparent: true, opacity: 0.2, envMapIntensity: 2.5, depthWrite: false });
  const frost = new THREE.MeshBasicMaterial({ color: 0xffffff, transparent: true, opacity: 0.16, depthWrite: false, toneMapped: false });
  const leaf = (cx, z, name) => {
    const l = new THREE.Group(); l.name = name; l.position.set(cx, 0, z); g.add(l);
    const w = DOOR.w / 2, h = DOOR.h;
    mk(l, B(w - 0.08, h - 0.1, 0.02), paneM, 0, h / 2, 0);
    mk(l, B(w, 0.1, 0.06), MAT.metal, 0, 0.1, 0); mk(l, B(w, 0.08, 0.06), MAT.metal, 0, h - 0.04, 0);
    [-1, 1].forEach((sd) => mk(l, B(0.06, h, 0.06), MAT.metal, sd * (w / 2 - 0.03), h / 2, 0));
    mk(l, B(w - 0.1, 0.2, 0.022), frost, 0, 1.55, 0.002);
    return l;
  };
  const leafA = leaf(DOOR.x - DOOR.w / 4, DOOR.wall + 0.12, 'door_leaf_left'), leafB = leaf(DOOR.x + DOOR.w / 4, DOOR.wall + 0.24, 'door_leaf_right');
  // doorbell
  const bell = new THREE.Group(); bell.name = 'door_bell'; bell.position.set(DOOR.x + 1.75, 1.35, DOOR.face + 0.03); g.add(bell);
  mk(bell, B(0.18, 0.3, 0.05), MAT.metal, 0, 0, 0);
  const btnM = glowMat(0xffa043, 1); const btn = mk(bell, new THREE.CylinderGeometry(0.04, 0.04, 0.03, 20), btnM, 0, 0.02, 0.03); btn.rotation.x = Math.PI / 2;
  mk(bell, new THREE.RingGeometry(0.048, 0.056, 24), glowMat(0xffa043, 1.4), 0, 0.02, 0.026);
  const ringM = new THREE.MeshBasicMaterial({ color: 0xffa043, transparent: true, depthWrite: false, blending: THREE.AdditiveBlending, toneMapped: false, opacity: 0 });
  const bring = mk(bell, new THREE.RingGeometry(0.92, 1, 40), ringM, 0, 0.02, 0.04, 'door_bell_wave');
  // outdoors: wet pavement, curb, road, lamp, bollards, distant city, stars
  const gm = pbr('floor', 12, 6, { color: 0xb8bec8, metalness: 0.15, normal: 0.15 });
  const ground = mk(g, new THREE.PlaneGeometry(90, 50), gm, 0, 0, 40, 'street'); ground.rotation.x = -Math.PI / 2;
  const walk = mk(g, new THREE.PlaneGeometry(90, 5.5), pbr('concrete', 22, 1.4, { color: 0xd0d4da, rough: 0.8 }), 0, 0.012, 18.1, 'sidewalk'); walk.rotation.x = -Math.PI / 2;
  mk(g, B(90, 0.16, 0.3), pbr('concrete', 20, 0.1, { color: 0xaeb2ba }), 0, 0.08, 21, 'curb');
  for (let i = -8; i <= 8; i++) { const ln = mk(g, new THREE.PlaneGeometry(2.2, 0.16), glowMat(0xdcd2b0, 0.55), i * 5, 0.02, 27, 'road_line'); ln.rotation.x = -Math.PI / 2; }
  const lamp = new THREE.Group(); lamp.name = 'street_lamp'; lamp.position.set(2.5, 0, 21.8); g.add(lamp);
  mk(lamp, new THREE.CylinderGeometry(0.09, 0.14, 7, 12), MAT.metal, 0, 3.5, 0);
  mk(lamp, B(0.08, 0.08, 1.8), MAT.metal, 0, 7, -0.9); mk(lamp, B(0.5, 0.1, 0.8), MAT.metal, 0, 6.95, -1.8);
  mk(lamp, B(0.4, 0.04, 0.65), glowMat(0xffd9a0, 2.4), 0, 6.88, -1.8, 'street_lamp_bulb');
  const lampLight = new THREE.SpotLight(0xffd0a0, 220, 22, 0.8, 0.9, 1.6); lampLight.position.set(2.5, 6.8, 20); lampLight.target.position.set(1.5, 0, 17.2); g.add(lampLight, lampLight.target);
  const fill = new THREE.SpotLight(0x8fb2ff, 260, 12.5, 0.75, 1, 1.5); fill.position.set(DOOR.x + 1, 2.6, 25); fill.target.position.set(DOOR.x, 3, DOOR.face); g.add(fill, fill.target);   // short range: stops at the wall, never lights the lab
  const porch = new THREE.SpotLight(0xffe6c8, 130, 14, 0.9, 0.85, 1.6); porch.position.set(DOOR.x, 3.85, DOOR.face + 1.3); porch.target.position.set(DOOR.x, 0, DOOR.face + 3.4); g.add(porch, porch.target);
  [-1, 1].forEach((sd) => { const b = mk(g, new THREE.CylinderGeometry(0.11, 0.11, 0.9, 14), MAT.metal, DOOR.x + sd * 2.8, 0.45, DOOR.face + 2.6, 'bollard'); mk(g, new THREE.TorusGeometry(0.11, 0.012, 6, 20), glowMat(0x4fd8ff, 2), DOOR.x + sd * 2.8, 0.8, DOOR.face + 2.6).rotation.x = Math.PI / 2; });
  // city backdrop with lit windows
  for (let i = 0; i < 9; i++) {
    const w = 5 + (i * 7) % 6, h = 14 + ((i * 13) % 20), win = canvasTex(128, 256), c = win.ctx;
    c.fillStyle = '#0b0f16'; c.fillRect(0, 0, 128, 256);
    for (let r = 0; r < 24; r++) for (let q = 0; q < 8; q++) if (hash(i * 31 + q, r + 5) > 0.55) { c.fillStyle = hash(q, r + i) > 0.5 ? '#ffd28a' : '#9fd8ff'; c.globalAlpha = 0.5 + 0.4 * hash(r, q); c.fillRect(q * 16 + 3, r * 10 + 2, 9, 6); }
    mk(g, B(w, h, 5), new THREE.MeshBasicMaterial({ map: win.tex }), -44 + i * 11 + (i % 2) * 2, h / 2, 58 + (i % 3) * 5, 'city_block');
  }
  const SPN = 260, sp = new Float32Array(SPN * 3);
  for (let i = 0; i < SPN; i++) { sp[i * 3] = (rnd() - 0.5) * 120; sp[i * 3 + 1] = 14 + rnd() * 40; sp[i * 3 + 2] = 55 + rnd() * 25; }
  const sgeo = new THREE.BufferGeometry(); sgeo.setAttribute('position', new THREE.BufferAttribute(sp, 3));
  const stars = new THREE.Points(sgeo, new THREE.PointsMaterial({ size: 1.6, sizeAttenuation: false, color: 0xcfe0ff, transparent: true, opacity: 0.8, fog: false, depthWrite: false })); stars.name = 'stars'; stars.frustumCulled = false; g.add(stars);
  mk(g, new THREE.CircleGeometry(2.2, 32), new THREE.MeshBasicMaterial({ color: 0xe8f0ff, fog: false, toneMapped: false }), -26, 34, 70, 'moon').rotation.y = Math.PI;
  // smoke: soft puffs, both sides of the door
  const smokeTex = canvasTex(128, 128);
  for (let i = 0; i < 9; i++) { const r = 18 + (i * 11) % 30, x = 64 + Math.cos(i * 2.1) * 26, y = 64 + Math.sin(i * 1.7) * 26, gr = smokeTex.ctx.createRadialGradient(x, y, 0, x, y, r); gr.addColorStop(0, 'rgba(255,255,255,.35)'); gr.addColorStop(1, 'rgba(255,255,255,0)'); smokeTex.ctx.fillStyle = gr; smokeTex.ctx.fillRect(0, 0, 128, 128); }
  const SN = LITE ? 90 : 240, sPos = new Float32Array(SN * 3), sVel = new Float32Array(SN * 3), sAge = new Float32Array(SN).fill(-1), sLife = new Float32Array(SN), sA = new Float32Array(SN), sSz = new Float32Array(SN), sTint = new Float32Array(SN);
  const smokeGeo = new THREE.BufferGeometry();
  smokeGeo.setAttribute('position', new THREE.BufferAttribute(sPos, 3)); smokeGeo.setAttribute('aAlpha', new THREE.BufferAttribute(sA, 1)); smokeGeo.setAttribute('aSize', new THREE.BufferAttribute(sSz, 1)); smokeGeo.setAttribute('aTint', new THREE.BufferAttribute(sTint, 1));
  const smoke = new THREE.Points(smokeGeo, new THREE.ShaderMaterial({
    transparent: true, depthWrite: false, uniforms: { map: { value: smokeTex.tex } },
    vertexShader: 'attribute float aAlpha; attribute float aSize; attribute float aTint; varying float vA; varying float vT; void main(){ vA=aAlpha; vT=aTint; vec4 mv=modelViewMatrix*vec4(position,1.); gl_PointSize=aSize*420./-mv.z; gl_Position=projectionMatrix*mv; }',
    fragmentShader: 'uniform sampler2D map; varying float vA; varying float vT; void main(){ vec4 t=texture2D(map,gl_PointCoord); gl_FragColor=vec4(mix(vec3(.38,.44,.52),vec3(.86,.9,.95),vT), t.a*vA); }',
  }));
  smoke.name = 'door_smoke'; smoke.frustumCulled = false; smoke.renderOrder = 5; g.add(smoke);
  let head = 0, fired = { bell: false, open: false }, emitAcc = 0;
  function spawn() {
    const i = head++ % SN, out = Math.random() < 0.5, z = out ? DOOR.face + 0.15 + Math.random() * 0.25 : DOOR.wall - 0.15 - Math.random() * 0.25;
    sPos.set([DOOR.x + (Math.random() - 0.5) * DOOR.w * 0.9, 0.05 + Math.random() * 0.5, z], i * 3);
    const sp = 0.5 + Math.random() * 1.3; sVel.set([(Math.random() - 0.5) * 1.1, 0.08 + Math.random() * 0.3, (out ? 1 : -1) * sp], i * 3);
    sAge[i] = 0; sLife[i] = 3.8 + Math.random() * 2.4; sSz[i] = 0.9; sTint[i] = out ? 1 : 0.35;
  }
  const clipEase = (x) => sstep(x);
  updates[0] = (T, dt) => {
    // bell: pulse, press, two shock rings
    const pressed = T >= DOOR.bell;
    if (pressed && !fired.bell) { fired.bell = true; chime(); }
    if (T >= DOOR.open && !fired.open) { fired.open = true; hiss(); }
    const pulse = pressed ? 0.35 : 0.7 + 0.6 * Math.sin(T * 5);
    btnM.color.setRGB(1.0 * 2 * pulse + (pressed && T < DOOR.bell + 0.5 ? 1.5 : 0), 0.63 * 2 * pulse, 0.26 * 2 * pulse);
    btn.position.z = 0.03 - (pressed && T < DOOR.bell + 0.3 ? 0.015 : 0);
    const rt = (T - DOOR.bell) / 0.9; ringM.opacity = rt > 0 && rt < 2.2 ? 0.8 * (1 - (rt % 1)) * (rt < 1.9 ? 1 : 0) : 0; bring.scale.setScalar(0.1 + (rt > 0 ? (rt % 1) * 0.9 : 0));
    // door
    const e = clipEase((T - DOOR.open) / DOOR.dur);
    leafA.position.x = DOOR.x - DOOR.w / 4 - (DOOR.w / 2 - 0.05) * e; leafB.position.x = DOOR.x + DOOR.w / 4 + (DOOR.w / 2 - 0.05) * e;
    // smoke
    if (T >= DOOR.open && T < DOOR.open + 2.0) { emitAcc += dt * (LITE ? 40 : 110) * (1 - (T - DOOR.open) / 2.4); while (emitAcc >= 1) { spawn(); emitAcc -= 1; } }
    for (let i = 0; i < SN; i++) {
      if (sAge[i] < 0) { sA[i] = 0; continue; }
      sAge[i] += dt; const f = sAge[i] / sLife[i]; if (f >= 1) { sAge[i] = -1; sA[i] = 0; continue; }
      const d = 1 - 0.55 * dt; sVel[i * 3] *= d; sVel[i * 3 + 2] *= d; sVel[i * 3 + 1] += (0.05 - sVel[i * 3 + 1] * 0.4) * dt;
      sPos[i * 3] += sVel[i * 3] * dt; sPos[i * 3 + 1] += sVel[i * 3 + 1] * dt; sPos[i * 3 + 2] += sVel[i * 3 + 2] * dt;
      sSz[i] = 0.9 + f * 2.6; sA[i] = 0.5 * Math.pow(Math.sin(Math.PI * Math.min(1, f * 1.15)), 0.8);
    }
    smokeGeo.attributes.position.needsUpdate = smokeGeo.attributes.aAlpha.needsUpdate = smokeGeo.attributes.aSize.needsUpdate = true;
  };
}

// ================================================================ STAGE 1: HERO
const hero = canvasTex(288, 512);
{
  const g = stageGroup(0, 'hero', 13.5, -13.5);
  mk(g, B(1.8, 0.08, 1.0), MAT.metal, 0, 0.04, 0.0, 'hero_base');
  mk(g, B(0.3, 0.55, 0.16), MAT.metal, 0, 0.32, -0.05);
  mk(g, B(3.5, 6.1, 0.18), MAT.black, 0, 3.5, 0, 'hero_bezel');
  mk(g, new THREE.PlaneGeometry(3.2, 5.69), screenMat(hero.tex), 0, 3.5, 0.1, 'hero_screen');
  glassOver(g, 3.2, 5.69, 0, 3.5, 0.104);
  blob(g, 0, 0.1, 3.4, 1.8);
  cable(g, [[0, 0.3, -0.12], [0.1, 0.05, -0.4], [0.9, 0.012, -0.9], [2.6, 0.012, -1.3]], 0.02);
  const halo = mk(g, new THREE.PlaneGeometry(9, 11), new THREE.MeshBasicMaterial({
    map: radialTex([[0, 'rgba(60,200,255,.55)'], [1, 'rgba(60,200,255,0)']]), transparent: true, depthWrite: false, blending: THREE.AdditiveBlending, opacity: 0, toneMapped: false,
  }), 0, 3.6, -1.2, 'hero_halo');
  mk(g, B(3.7, 0.04, 0.3), glowMat(0x4fd8ff, 1.3, 2.4), 0, 0.12, 0.35, 'hero_floor_bar');
  updates[1] = (T) => {
    const wake = (PT - 2.4) / 1.1;
    const c = hero.ctx, w = 288, h = 512;
    c.fillStyle = '#000'; c.fillRect(0, 0, w, h);
    if (wake > 0 && wake < 1) {
      const k = Math.min(1, wake * 3), hh = Math.max(2, h * sstep(wake) ** 2);
      c.globalAlpha = 1 - wake * 0.3; c.fillStyle = '#bfefff';
      c.fillRect(w * (0.5 - k / 2), h / 2 - hh / 2, w * k, hh); c.globalAlpha = 1;
    } else if (wake >= 1) {
      drawClip(c, w, h, T - 3.5, 0);
      c.fillStyle = 'rgba(255,255,255,.9)'; c.font = '700 13px Inter, Arial'; c.textAlign = 'left';
      c.fillText('9:16', 20, 44);
      c.fillStyle = '#ff4d4d'; c.beginPath(); c.arc(w - 30, 40, 5, 0, 7); c.fill();
    }
    hero.tex.needsUpdate = true;
    halo.material.opacity = 0.5 * sstep(wake);
  };
}

// ================================================================ STAGE 1b: THE PRODUCTION LINE (entrance demo)
// One clip travels a six-step belt along the entrance wall; each machine does its job as the clip passes. Numbers match the numbered stops.
function RB(w, h, d, r = 0.04) {                       // box with rounded corners and softly bevelled edges
  const b = Math.min(r * 0.6, d * 0.4, w * 0.2, h * 0.2), q = Math.max(0.001, Math.min(r - b, (w - 2 * b) / 2, (h - 2 * b) / 2)), sw = w - 2 * b, sh = h - 2 * b, x = -sw / 2, y = -sh / 2, sp = new THREE.Shape();
  sp.moveTo(x + q, y); sp.lineTo(x + sw - q, y); sp.quadraticCurveTo(x + sw, y, x + sw, y + q); sp.lineTo(x + sw, y + sh - q); sp.quadraticCurveTo(x + sw, y + sh, x + sw - q, y + sh);
  sp.lineTo(x + q, y + sh); sp.quadraticCurveTo(x, y + sh, x, y + sh - q); sp.lineTo(x, y + q); sp.quadraticCurveTo(x, y, x + q, y);
  const g = new THREE.ExtrudeGeometry(sp, { depth: Math.max(0.001, d - 2 * b), bevelEnabled: true, bevelThickness: b, bevelSize: b, bevelSegments: 3, curveSegments: 6 });
  g.translate(0, 0, -(d - 2 * b) / 2); return g;
}
{
  const g = new THREE.Group(); g.name = 'stage_02_production_line'; g.position.set(0, 0, 12.6); scene.add(g); ST.line = g;
  const X0 = 2.2, DX = 1.8, N = 6, X1 = X0 + DX * (N - 1), BY = 0.9, LEN = X1 - X0 + 3.4, CX = (X0 + X1) / 2;
  const paint = std(0xdfe3e8, 0.42, 0.25), paintDark = std(0x4b5058, 0.5, 0.35), steel = std(0xb9bec6, 0.32, 0.9);
  // belt: dark rubber with ridges that creep along, rounded ends, soft side rails
  const bt = canvasTex(64, 64); bt.ctx.fillStyle = '#1a1c20'; bt.ctx.fillRect(0, 0, 64, 64); bt.ctx.fillStyle = '#2b2e34'; bt.ctx.fillRect(0, 0, 4, 64);
  bt.tex.colorSpace = THREE.SRGBColorSpace; bt.tex.wrapS = THREE.RepeatWrapping; bt.tex.repeat.set(LEN / 0.3, 1); bt.tex.needsUpdate = true;
  mk(g, B(LEN, 0.07, 0.96), new THREE.MeshStandardMaterial({ map: bt.tex, roughness: 0.78, metalness: 0.05 }), CX, BY, 0, 'belt');
  [X0 - LEN / 2 + CX - X0 + 0.0, 0].length;
  [CX - LEN / 2, CX + LEN / 2].forEach((x) => mk(g, new THREE.CylinderGeometry(0.06, 0.06, 0.96, 20), std(0x1a1c20, 0.8, 0.05), x, BY, 0, 'belt_end').rotation.x = Math.PI / 2);
  [-1, 1].forEach((sd) => mk(g, RB(LEN + 0.12, 0.16, 0.07, 0.035), paint, CX, BY - 0.04, sd * 0.52, 'belt_rail'));
  for (let i = 0; i <= 4; i++) [-1, 1].forEach((sd) => mk(g, new THREE.CylinderGeometry(0.032, 0.04, BY - 0.12, 14), steel, CX - LEN / 2 + 0.3 + i * ((LEN - 0.6) / 4), (BY - 0.12) / 2, sd * 0.5, 'belt_leg'));
  mk(g, RB(LEN - 0.4, 0.05, 0.9, 0.025), paintDark, CX, 0.3, 0, 'belt_shelf');
  blob(g, CX, 0, LEN + 0.8, 2.0, 0.75);

  // drop box at the start of the line: the visitor's raw material goes in here
  {
    const bx = X0 - 2.6, d = new THREE.Group(); d.name = 'dropbox'; d.position.set(bx, 0, 0); g.add(d);
    mk(d, RB(0.95, 1.15, 0.85, 0.1), paint, 0, 0.575, 0, 'dropbox_body');
    mk(d, RB(1.0, 0.1, 0.9, 0.05), paintDark, 0, 1.16, 0, 'dropbox_lid');
    mk(d, RB(0.62, 0.05, 0.08, 0.02), MAT.black, 0, 1.225, 0, 'dropbox_slot');
    mk(d, RB(0.9, 0.12, 0.8, 0.05), paintDark, 0, 0.06, 0, 'dropbox_base');
    const pl = canvasTex(512, 400), c = pl.ctx;
    c.fillStyle = '#16181c'; c.beginPath(); c.roundRect(0, 0, 512, 400, 36); c.fill();
    c.strokeStyle = 'rgba(255,255,255,.5)'; c.lineWidth = 6; c.beginPath(); c.roundRect(14, 14, 484, 372, 26); c.stroke();
    c.fillStyle = '#fff'; c.textAlign = 'center'; c.textBaseline = 'middle'; c.font = '800 92px Inter, Arial, sans-serif';
    c.fillText('RAW', 256, 96); c.fillText('MATERIAL', 256, 190); c.fillText('HERE', 256, 284);
    c.beginPath(); c.moveTo(256, 380); c.lineTo(216, 340); c.lineTo(236, 340); c.lineTo(236, 322); c.lineTo(276, 322); c.lineTo(276, 340); c.lineTo(296, 340); c.closePath(); c.fill();
    pl.tex.needsUpdate = true;
    const face = mk(d, new THREE.PlaneGeometry(0.8, 0.625), new THREE.MeshBasicMaterial({ map: pl.tex, toneMapped: false }), 0, 0.62, -0.44, 'dropbox_sign'); face.rotation.y = Math.PI;
    mk(d, RB(0.5, 0.05, 0.8, 0.02), steel, 0.64, BY + 0.12, 0, 'dropbox_chute').rotation.z = -0.22;
    addLight(d, new THREE.PointLight(0xffffff, 12, 4, 2), 0, 1.6, -0.9, 2.6, true);
  }
  // six bridges + numbers
  for (let k = 0; k < N; k++) {
    const x = X0 + k * DX;
    [-1, 1].forEach((sd) => { mk(g, new THREE.CapsuleGeometry(0.045, 1.45, 4, 12), paint, x, BY + 0.8, sd * 0.72, 'bridge_post'); mk(g, new THREE.CylinderGeometry(0.1, 0.12, 0.04, 20), paintDark, x, 0.02, sd * 0.72, 'bridge_foot'); });
    mk(g, RB(0.46, 0.3, 1.66, 0.09), paint, x, BY + 1.62, 0, 'bridge_head');
    mk(g, new THREE.CapsuleGeometry(0.014, 1.0, 3, 8), glowMat(0xffffff, 1.3, 2.6 + k * 0.25), x, BY + 1.43, 0, 'bridge_light').rotation.x = Math.PI / 2;
    const ng = new TextGeometry(String(k + 1), { font, size: 0.5, depth: 0.05, curveSegments: 10, bevelEnabled: true, bevelThickness: 0.01, bevelSize: 0.01, bevelSegments: 2 });
    ng.computeBoundingBox(); ng.translate(-(ng.boundingBox.max.x + ng.boundingBox.min.x) / 2, 0, 0);
    mk(g, ng, glowMat(0xffffff, 1.5, 2.6 + k * 0.25), x, BY + 1.95, 0, 'number_' + (k + 1)).rotation.y = Math.PI;   // the line is seen from the hall side (-z)
  }
  // 1 hopper, 2 blade, 3 speakers, 4 colour sweep, 5 stamp, 6 output phone
  const dev = {};
  mk(g, RB(0.62, 0.34, 0.8, 0.12), paintDark, X0, BY + 1.2, 0, 'hopper'); mk(g, new THREE.CylinderGeometry(0.2, 0.26, 0.1, 22), steel, X0, BY + 0.98, 0, 'hopper_spout');
  dev.blade = mk(g, RB(0.03, 0.55, 0.9, 0.014), steel, X0 + DX, BY + 1.3, 0, 'blade');
  dev.spk = [-1, 1].map((sd) => { const m = mk(g, new THREE.CylinderGeometry(0.15, 0.15, 0.07, 28), paintDark, X0 + 2 * DX, BY + 0.62, sd * 0.64, 'speaker_pod'); m.rotation.x = Math.PI / 2; mk(g, new THREE.TorusGeometry(0.15, 0.015, 8, 28), steel, X0 + 2 * DX, BY + 0.62, sd * 0.64 + (sd < 0 ? 0.035 : -0.035)); return m; });
  const sweepM = new THREE.MeshBasicMaterial({ color: 0xffffff, toneMapped: false, transparent: true, opacity: 0.9 });
  dev.sweep = mk(g, new THREE.CapsuleGeometry(0.018, 0.85, 3, 8), sweepM, X0 + 3 * DX, BY + 0.55, 0, 'colour_sweep');
  dev.stamp = mk(g, RB(0.42, 0.14, 0.32, 0.06), steel, X0 + 4 * DX, BY + 1.15, 0, 'caption_stamp');
  const out = new THREE.Group(); out.position.set(X1 + 1.3, BY, 0); out.name = 'output_phone'; out.rotation.y = Math.PI; g.add(out);
  mk(out, RB(0.66, 1.22, 0.07, 0.1), MAT.black, 0, 0.66, 0); mk(out, new THREE.PlaneGeometry(0.58, 1.12), screenMat(getClip(0).tex), 0, 0.66, 0.042, 'output_screen');
  mk(out, new THREE.CylinderGeometry(0.26, 0.3, 0.06, 28), paintDark, 0, 0.03, 0.0);
  const flash = new THREE.MeshBasicMaterial({ map: radialTex([[0, 'rgba(255,255,255,.7)'], [1, 'rgba(255,255,255,0)']]), transparent: true, depthWrite: false, blending: THREE.AdditiveBlending, opacity: 0, toneMapped: false });
  mk(out, new THREE.PlaneGeometry(2.4, 2.8), flash, 0, 0.66, -0.05, 'output_glow');
  addLight(g, new THREE.PointLight(0xe6eeff, 45, 9, 2), CX - 2.5, 3.2, -1.6, 2.6);
  addLight(g, new THREE.PointLight(0xe6eeff, 45, 9, 2), CX + 2.5, 3.2, -1.6, 2.9, true);

  // the clips on the belt
  const BASE = [[0, 0.09, 1], [0.1, 0.07, 0], [0.19, 0.1, 1], [0.31, 0.06, 0], [0.39, 0.12, 1], [0.53, 0.05, 0], [0.6, 0.08, 1]];
  function drawCard(c, W, H, s, t, v) {
    const ph = (a, b) => sstep((s - a) / (b - a));
    c.clearRect(0, 0, W, H); c.save(); c.beginPath(); c.roundRect(0, 0, W, H, 16); c.clip();
    c.fillStyle = '#000'; c.fillRect(0, 0, W, H); c.save();
    const sh = 1 - ph(0.7, 1.15); c.translate(Math.sin(t * 41 + v) * 3 * sh, Math.cos(t * 33 + v) * 3 * sh);
    drawClip(c, W, H, t * 0.8 + v * 2.3, v, { caption: s > 3.85 }); c.restore();
    const gray = 1 - ph(2.75, 3.25); if (gray > 0) { c.fillStyle = `rgba(118,122,128,${0.62 * gray})`; c.fillRect(0, 0, W, H); }
    const warm = ph(2.75, 3.25) * 0.14; c.fillStyle = `rgba(255,170,90,${warm})`; c.fillRect(0, 0, W, H);
    const cp = ph(0.8, 1.2), y = H - 20; let pack = 0.04;
    BASE.forEach(([a, w, keep]) => {
      const x0 = 8 + a * (W - 16), w0 = w * (W - 16); let x = x0, ww = w0;
      if (keep) { x = lerp(x0, 8 + pack * (W - 16), cp); pack += w; } else ww = w0 * (1 - cp);
      c.fillStyle = keep ? 'rgba(255,255,255,.92)' : 'rgba(255,255,255,.32)'; if (ww > 0.5) { c.beginPath(); c.roundRect(x, y, ww, 7, 3); c.fill(); }
    });
    const sp = ph(1.8, 2.2); if (sp > 0.01) for (let i = 0; i < 22; i++) { const a = Math.abs(Math.sin(t * 5 + i * 0.7)) * sp; c.fillStyle = 'rgba(255,255,255,.85)'; c.fillRect(10 + i * 6, 34 - a * 12, 3.4, a * 24 + 2); }
    c.restore();
    const ex = ph(4.65, 5.0); if (ex > 0.01) { c.strokeStyle = `rgba(255,255,255,${ex})`; c.lineWidth = 5; c.beginPath(); c.roundRect(3, 3, W - 6, H - 6, 14); c.stroke(); }
  }
  const cards = [0, 1, 2].map((i) => {
    const cv = canvasTex(144, 256), grp = new THREE.Group(); grp.name = 'clip_card_' + (i + 1); grp.rotation.y = Math.PI; g.add(grp);
    mk(grp, RB(0.52, 0.93, 0.04, 0.07), MAT.black, 0, 0, 0);
    const face = mk(grp, new THREE.PlaneGeometry(0.49, 0.87), new THREE.MeshBasicMaterial({ map: cv.tex, toneMapped: false, transparent: true }), 0, 0, 0.022, 'clip_card_face');
    mk(grp, RB(0.3, 0.03, 0.16, 0.012), steel, 0, -0.48, 0);
    return { cv, grp, face, s: -0.9 + i * 2.1, v: [0, 2, 5][i] };
  });
  let acc = 0, fl = 0;
  const SPEED = 0.42;
  const lineU = (T, dt) => {
    bt.tex.offset.x -= dt * SPEED * DX / 0.3;
    const act = new Array(N).fill(0);
    cards.forEach((cd) => {
      cd.s += dt * SPEED; if (cd.s > 5.9) cd.s = -1.0;
      const vis = sstep((cd.s + 0.9) / 0.4) * (1 - sstep((cd.s - 5.15) / 0.5));
      cd.grp.position.set(X0 + cd.s * DX, BY + 0.52, 0); cd.grp.visible = vis > 0.01; cd.face.material.opacity = vis;
      for (let k = 0; k < N; k++) act[k] = Math.max(act[k], Math.exp(-Math.pow((cd.s - k) / 0.22, 2)));
      if (cd.s > 5.0 && cd.s < 5.0 + dt * SPEED * 2) fl = 1;
    });
    acc += dt;
    if (acc > (LITE ? 1 / 8 : 1 / 12)) { acc = 0; cards.forEach((cd) => { drawCard(cd.cv.ctx, 144, 256, cd.s, T, cd.v); cd.cv.tex.needsUpdate = true; }); }
    dev.blade.position.y = BY + 1.3 - act[1] * 1.12;
    dev.spk.forEach((m) => m.scale.set(1 + act[2] * 0.2 * Math.sin(T * 36), 1, 1 + act[2] * 0.2 * Math.sin(T * 36)));
    dev.sweep.position.z = Math.sin(T * 3.2) * 0.42 * (0.2 + act[3] * 0.8); sweepM.color.setHSL((T * 0.4) % 1, 0.8, 0.6); sweepM.opacity = 0.35 + 0.6 * act[3];
    dev.stamp.position.y = BY + 1.15 - act[4] * 0.72;
    fl = Math.max(0, fl - dt * 1.4); flash.opacity = fl * 0.8;
  };
  const prev = updates[1]; updates[1] = (T, dt) => { prev(T, dt); lineU(T, dt); };
  ST.hero.visible = false;   // the old big monitor would compete with the line
}

// ================================================================ STAGE 0b: BEFORE THE LINE (deal, strategy, signature, scripts, client films)
{
  const g = new THREE.Group(); g.name = 'stage_01_before_the_line'; g.position.set(0, 0, 14.45); scene.add(g); ST.prelude = g;
  const paint = std(0xdfe3e8, 0.42, 0.25), dark = std(0x23262b, 0.5, 0.3);
  const XS = [-7.3, -9.7, -12.1, -14.5, -16.9], PW = 256, PH = 340;   // seen from inside, -x is on the right: step 1 sits on the left of the view
  const ease2 = (x) => sstep(clamp(x));
  const strokeLine = (c) => { c.strokeStyle = '#fff'; c.fillStyle = '#fff'; c.lineWidth = 11; c.lineCap = 'round'; c.lineJoin = 'round'; };
  const icons = [
    (c, p, T) => {                                     // 1 the deal: two hands meet, check appears
      const k = ease2(p * 1.5); strokeLine(c);
      c.beginPath(); c.moveTo(18, 236); c.lineTo(lerp(50, 104, k), lerp(236, 190, k)); c.stroke();
      c.beginPath(); c.moveTo(238, 236); c.lineTo(lerp(206, 152, k), lerp(236, 190, k)); c.stroke();
      c.beginPath(); c.arc(128, 190, 24 * k + 4, 0, 7); c.stroke();
      const ck = ease2((p - 0.55) * 2.4); c.beginPath(); c.arc(128, 90, 52, 0, 7); c.globalAlpha = 0.35 + 0.65 * ck; c.stroke();
      c.beginPath(); c.moveTo(102, 92); c.lineTo(122 - 6, 112); c.lineTo(122 - 6 + (160 - 116) * ck, 112 - (112 - 70) * ck); c.globalAlpha = ck; c.stroke(); c.globalAlpha = 1;
    },
    (c, p, T) => {                                     // 2 analysis and strategy: bars grow, trend line, magnifier
      strokeLine(c); const hs = [60, 100, 82, 140, 190];
      hs.forEach((h, i) => { const k = ease2(p * 1.6 - i * 0.12); c.globalAlpha = 0.9; c.beginPath(); c.roundRect(30 + i * 40, 290 - h * k, 26, h * k + 2, 6); c.fill(); });
      c.globalAlpha = 1; c.lineWidth = 7; c.beginPath(); hs.forEach((h, i) => { const k = ease2(p * 1.6 - i * 0.12), x = 43 + i * 40, y = 290 - h * k - 22; i ? c.lineTo(x, y) : c.moveTo(x, y); }); c.stroke();
      const mx = lerp(80, 180, ease2(p)), my = 90 + Math.sin(T * 2) * 4; c.lineWidth = 9; c.beginPath(); c.arc(mx, my, 32, 0, 7); c.stroke(); c.beginPath(); c.moveTo(mx + 23, my + 23); c.lineTo(mx + 48, my + 48); c.stroke();
    },
    (c, p, T) => {                                     // 3 the signature: a contract gets signed
      strokeLine(c); c.lineWidth = 8; c.beginPath(); c.roundRect(48, 36, 160, 250, 14); c.stroke();
      c.lineWidth = 6; c.globalAlpha = 0.6; [90, 124, 158].forEach((y) => { c.beginPath(); c.moveTo(72, y); c.lineTo(184, y); c.stroke(); }); c.globalAlpha = 1;
      const N = 40, upto = Math.floor(ease2(p * 1.3) * N); c.lineWidth = 7; c.beginPath();
      let lx = 72, ly = 236; for (let i = 0; i <= upto; i++) { const x = 72 + i * (112 / N), y = 236 + Math.sin(i * 0.55) * 20 * Math.sin(i * 0.11 + 0.6) - i * 0.15; i ? c.lineTo(x, y) : c.moveTo(x, y); lx = x; ly = y; } c.stroke();
      if (p > 0.02 && p < 0.99) { c.beginPath(); c.moveTo(lx, ly); c.lineTo(lx + 34, ly - 54); c.stroke(); }
      const ck = ease2((p - 0.8) * 5); if (ck > 0) { c.globalAlpha = ck; c.beginPath(); c.arc(184, 274, 20, 0, 7); c.stroke(); c.beginPath(); c.moveTo(175, 274); c.lineTo(182, 282); c.lineTo(194, 266); c.stroke(); c.globalAlpha = 1; }
    },
    (c, p, T) => {                                     // 4 a month of scripts and shot lists
      strokeLine(c); const n = Math.floor(ease2(p * 1.2) * 30);
      for (let i = 0; i < 30; i++) { const x = 30 + (i % 6) * 36, y = 40 + Math.floor(i / 6) * 36; c.globalAlpha = i < n ? 0.95 : 0.25; if (i < n) { c.beginPath(); c.roundRect(x, y, 28, 28, 7); c.fill(); } else { c.lineWidth = 3; c.beginPath(); c.roundRect(x, y, 28, 28, 7); c.stroke(); } }
      c.globalAlpha = 1; c.lineWidth = 7; [236, 266, 296].forEach((y, i) => { const k = ease2(p * 1.5 - 0.2 - i * 0.15); c.globalAlpha = 0.85; c.beginPath(); c.moveTo(34, y); c.lineTo(34 + 170 * k * (i === 2 ? 0.6 : 1), y); c.stroke(); }); c.globalAlpha = 1;
    },
    (c, p, T) => {                                     // 5 you film: a phone records, footage heads for the drop box
      strokeLine(c); c.lineWidth = 9; c.beginPath(); c.roundRect(76, 34, 104, 190, 20); c.stroke();
      c.globalAlpha = 0.9; c.beginPath(); c.arc(128, 118, 20, 0, 7); c.fill(); c.beginPath(); c.ellipse(128, 180, 38, 26, 0, Math.PI, 0); c.fill(); c.globalAlpha = 1;
      if (Math.floor(T * 1.8) % 2 === 0) { c.fillStyle = '#ff4d4d'; c.beginPath(); c.arc(160, 60, 7, 0, 7); c.fill(); c.fillStyle = '#fff'; }
      const k = ease2((p - 0.35) * 2), bob = Math.sin(T * 5) * 4 * k; c.globalAlpha = k; c.lineWidth = 11;
      c.beginPath(); c.moveTo(128, 246 + bob); c.lineTo(128, 306 + bob); c.moveTo(96, 276 + bob); c.lineTo(128, 308 + bob); c.lineTo(160, 276 + bob); c.stroke(); c.globalAlpha = 1;
    },
  ];
  const panels = XS.map((x, i) => {
    const pg = new THREE.Group(); pg.position.set(x, 2.5, 0); pg.name = 'prelude_panel_' + (i + 1); g.add(pg);
    mk(pg, RB(2.0, 2.65, 0.14, 0.16), paint, 0, 0, 0.0, 'prelude_frame');
    const cv = canvasTex(PW, PH);
    const face = mk(pg, new THREE.PlaneGeometry(1.8, 2.4), new THREE.MeshBasicMaterial({ map: cv.tex, toneMapped: false }), 0, 0, -0.075, 'prelude_screen'); face.rotation.y = Math.PI;
    mk(pg, new THREE.CylinderGeometry(0.09, 0.09, 1.2, 12), std(0xb9bec6, 0.3, 0.9), 0, -1.9, 0.04).visible = false;
    mk(pg, RB(0.5, 0.6, 0.3, 0.07), dark, 0, -1.6, 0.05, 'prelude_bracket');
    return { cv, face };
  });
  // a light that travels the rail beneath, panel to panel, towards the door and the drop box
  mk(g, RB(12.2, 0.06, 0.1, 0.03), dark, -12.1, 0.55, -0.1, 'prelude_rail');
  const dot = mk(g, new THREE.SphereGeometry(0.07, 14, 10), glowMat(0xffffff, 2.2, 2.6), -17, 0.58, -0.12, 'prelude_dot'); dot.userData.noShadow = true;
  addLight(g, new THREE.PointLight(0xe8eeff, 40, 11, 2), -11.8, 3.6, -2.4, 2.6);
  const LOOP = 15; let acc = 0;
  const draw = (T) => {
    const tl = T % LOOP;
    panels.forEach((pn, i) => {
      const c = pn.cv.ctx, p = clamp((tl - i * 2.6) / 2.2), act = p > 0 && p < 1;
      c.clearRect(0, 0, PW, PH); c.fillStyle = '#101216'; c.beginPath(); c.roundRect(0, 0, PW, PH, 26); c.fill();
      c.save(); c.globalAlpha = p > 0 ? 1 : 0.28; icons[i](c, p, T); c.restore();
      c.fillStyle = act ? '#fff' : 'rgba(255,255,255,.3)'; c.beginPath(); c.arc(PW / 2, 22, 5, 0, 7); c.fill();
      pn.cv.tex.needsUpdate = true;
    });
    dot.position.x = lerp(-5.8, -17.4, clamp(tl / (4 * 2.6 + 2.2)));
  };
  draw(0);
  updates[10] = (T, dt) => { acc += dt; if (acc > (LITE ? 1 / 9 : 1 / 15)) { acc = 0; draw(T); } };
}

// ================================================================ STAGE 2: RAW FOOTAGE
{
  const g = stageGroup(1, 'raw', -12, -8);
  const tbl = new THREE.Group(); tbl.name = 'raw_table'; g.add(tbl);
  mk(tbl, B(3.4, 0.1, 1.5), woodMat(3.4, 1.5), 0, 0.95, 0, 'raw_table_top');
  [[-1.55, -.65], [1.55, -.65], [-1.55, .65], [1.55, .65]].forEach(([x, z]) => mk(tbl, B(0.08, 0.9, 0.08), MAT.metal, x, 0.45, z));
  mk(tbl, B(3.4, 0.02, 0.02), glowMat(0xffa860, 1.2, 1.2), 0, 0.93, 0.75, 'raw_table_edge');
  // camera
  const cam = new THREE.Group(); cam.name = 'raw_camera'; cam.position.set(-0.9, 1.15, 0.1); cam.rotation.y = 0.4; g.add(cam);
  mk(cam, B(0.42, 0.26, 0.24), MAT.dark, 0, 0, 0);
  mk(cam, B(0.12, 0.09, 0.1), MAT.dark, -0.1, 0.17, 0);
  const lens = mk(cam, new THREE.CylinderGeometry(0.1, 0.12, 0.18, 24), MAT.metal, 0.05, -0.01, 0.2); lens.rotation.x = Math.PI / 2;
  const glass = mk(cam, new THREE.CircleGeometry(0.085, 24), glowMat(0x2a6aff, 0.8, 1.2), 0.05, -0.01, 0.295);
  mk(cam, B(0.03, 0.03, 0.03), glowMat(0xff3b3b, 2, 1.2), 0.17, 0.1, 0.12);
  // SD cards
  const cards = new THREE.Group(); cards.name = 'raw_sdcards'; cards.position.set(0.1, 1.01, 0.45); g.add(cards);
  [0xff8a3a, 0x2f6bff, 0x111111, 0xff8a3a, 0x2f6bff].forEach((c, i) => {
    const sd = mk(cards, B(0.09, 0.012, 0.12), std(c, 0.4, 0.3), i * 0.14 - 0.28, i * 0.0005, Math.sin(i * 2) * 0.05);
    sd.rotation.y = (i - 2) * 0.25;
    mk(sd, B(0.07, 0.004, 0.03), std(0xd9b44a, 0.3, 1), 0, 0.007, 0.045);
  });
  // drive
  const drive = new THREE.Group(); drive.name = 'raw_drive'; drive.position.set(1.0, 1.1, -0.1); g.add(drive);
  mk(drive, B(0.55, 0.14, 0.36), std(0xaeb4bd, 0.35, 0.9), 0, 0, 0);
  mk(drive, B(0.5, 0.012, 0.02), glowMat(0x2ad8ff, 2, 1.2), 0, 0.075, 0.12);
  const ring = mk(drive, new THREE.RingGeometry(0.1, 0.12, 32), glowMat(0x2ad8ff, 1.8, 1.2), 0, 0.075, -0.03); ring.rotation.x = -Math.PI / 2;
  // shelf
  const sh = new THREE.Group(); sh.name = 'raw_shelf'; sh.position.set(0, 0, -1.4); g.add(sh);
  [-1.7, 1.7].forEach((x) => mk(sh, B(0.08, 3.4, 0.45), MAT.metal, x, 1.7, 0));
  [1.0, 1.9, 2.8].forEach((y) => mk(sh, B(3.4, 0.06, 0.45), MAT.panel, 0, y, 0));
  [1.0, 1.9, 2.8].forEach((y, r) => {
    let x = -1.55;
    while (x < 1.4) {
      const w = 0.14 + rnd() * 0.22, h = 0.2 + rnd() * 0.3;
      mk(sh, B(w, h, 0.3), std(rnd() > 0.7 ? 0x2c3a52 : 0x16181d, 0.6, 0.3), x + w / 2, y + 0.03 + h / 2, 0);
      x += w + 0.04 + rnd() * 0.12;
    }
    mk(sh, B(3.3, 0.015, 0.015), glowMat(r % 2 ? 0x2ad8ff : 0xffa860, 0.9, 1.4 + r * .2), 0, y + 0.04, 0.22);
  });
  // holographic clip stream
  const thumb = canvasTex(64, 36);
  {
    const c = thumb.ctx, gr = c.createLinearGradient(0, 0, 64, 36);
    gr.addColorStop(0, 'rgba(60,200,255,.55)'); gr.addColorStop(1, 'rgba(60,200,255,.12)');
    c.fillStyle = gr; c.fillRect(0, 0, 64, 36); c.strokeStyle = 'rgba(200,245,255,.95)'; c.lineWidth = 2; c.strokeRect(1, 1, 62, 34);
    c.fillStyle = 'rgba(200,245,255,.7)'; for (let i = 0; i < 4; i++) c.fillRect(6 + i * 14, 28, 9, 3);
    c.beginPath(); c.moveTo(26, 10); c.lineTo(26, 22); c.lineTo(38, 16); c.closePath(); c.fill();
  }
  const N = 28;
  const stream = new THREE.InstancedMesh(new THREE.PlaneGeometry(0.5, 0.28), new THREE.MeshBasicMaterial({
    map: thumb.tex, transparent: true, depthWrite: false, blending: THREE.AdditiveBlending, side: THREE.DoubleSide, toneMapped: false, opacity: 0.9,
  }), N);
  stream.name = 'raw_stream'; stream.frustumCulled = false; g.add(stream);
  const path = new THREE.CatmullRomCurve3([[1.0, 1.25, -0.1], [1.1, 2.1, 0], [2.4, 2.8, 0.1], [4.0, 2.95, 0], [5.8, 2.55, -0.3]].map((p) => new THREE.Vector3(...p)));
  const seeds = Array.from({ length: N }, (_, i) => ({ ph: i / N, ox: (rnd() - 0.5) * 0.35, oz: (rnd() - 0.5) * 0.4, sp: rnd() * 2 + 1, tint: new THREE.Color().setHSL(0.5 + rnd() * 0.08, 0.9, 0.7) }));
  seeds.forEach((s, i) => stream.setColorAt(i, s.tint));
  blob(g, 0, 0, 4.6, 2.6); blob(g, 0, -1.4, 4.2, 1.2);
  cable(g, [[0.9, 1.05, -0.25], [0.7, 0.96, -0.7], [0.6, 0.4, -0.76], [0.9, 0.012, -0.6], [1.6, 0.012, -0.4]], 0.012);
  updates[2] = (T) => {
    seeds.forEach((s, i) => {
      const u = (T * 0.09 + s.ph) % 1, p = path.getPoint(u);
      D.position.set(p.x + s.ox * Math.sin(u * Math.PI), p.y + s.oz * 0.4, p.z + s.oz * Math.sin(u * Math.PI));
      D.rotation.set(Math.sin(T * s.sp) * 0.15, -0.35 + u * 0.7, Math.sin(u * 5 + i) * 0.2);
      D.scale.setScalar(Math.pow(Math.sin(Math.PI * u), 0.5) * (0.8 + 0.3 * Math.sin(T * 3 + i)));
      D.updateMatrix(); stream.setMatrixAt(i, D.matrix);
    });
    stream.instanceMatrix.needsUpdate = true;
    ring.scale.setScalar(1 + 0.15 * Math.sin(T * 4));
  };
}

// ================================================================ STAGE 3: CUTTING
const tl = canvasTex(1384, 500);
{
  const g = stageGroup(2, 'cut', -6, -8);
  mk(g, B(6.2, 0.09, 1.6), woodMat(6.2, 1.6), 0, 0.95, 0, 'cut_desk');
  [-2.9, 2.9].forEach((x) => mk(g, B(0.1, 0.9, 1.5), MAT.metal, x, 0.45, 0));
  mk(g, B(5.8, 0.02, 0.02), glowMat(0x2ad8ff, 1.3, 1.6), 0, 0.93, 0.8, 'cut_desk_edge');
  const mon = new THREE.Group(); mon.name = 'cut_monitor'; mon.position.set(0, 0, -0.5); g.add(mon);
  mk(mon, B(0.4, 0.5, 0.2), MAT.metal, 0, 1.25, -0.05);
  mk(mon, B(0.9, 0.05, 0.5), MAT.metal, 0, 1.0, 0.05);
  mk(mon, B(4.5, 1.72, 0.14), MAT.black, 0, 2.05, 0);
  mk(mon, new THREE.PlaneGeometry(4.38, 1.58), screenMat(tl.tex), 0, 2.05, 0.075, 'cut_screen');
  glassOver(mon, 4.38, 1.58, 0, 2.05, 0.078);
  mk(g, B(1.3, 0.04, 0.4), std(0x0b0c0f, 0.5, 0.5), -0.5, 1.0, 0.45, 'cut_keyboard');
  {
    const kb = canvasTex(512, 160), c = kb.ctx; c.fillStyle = '#08090b'; c.fillRect(0, 0, 512, 160);
    for (let r = 0; r < 5; r++) for (let q = 0; q < 15; q++) { c.fillStyle = '#1b1e25'; c.beginPath(); c.roundRect(8 + q * 33.2, 8 + r * 29.4, 29, 25, 4); c.fill(); c.fillStyle = 'rgba(255,255,255,.08)'; c.fillRect(11 + q * 33.2, 10 + r * 29.4, 23, 3); }
    kb.tex.needsUpdate = true;
    mk(g, new THREE.PlaneGeometry(1.26, 0.37), new THREE.MeshStandardMaterial({ map: kb.tex, roughness: 0.45, metalness: 0.1 }), -0.5, 1.0205, 0.45, 'cut_keys').rotation.x = -Math.PI / 2;
  }
  mk(g, B(1.2, 0.005, 0.02), glowMat(0x4fd8ff, 1.2, 1.8), -0.5, 1.023, 0.42);
  mk(g, new THREE.CylinderGeometry(0.22, 0.22, 0.06, 32), MAT.metal, 1.4, 1.02, 0.4, 'cut_jog');
  const jr = mk(g, new THREE.TorusGeometry(0.2, 0.012, 8, 32), glowMat(0x2ad8ff, 2, 1.8), 1.4, 1.055, 0.4); jr.rotation.x = Math.PI / 2;
  mk(g, B(0.1, 0.05, 0.16), MAT.dark, 0.6, 1.0, 0.45, 'cut_mouse');

  // timeline UI
  const SEGS = (() => {
    const raw = [[.09, 0], [.06, 1], [.12, 0], [.05, 1], [.10, 0], [.07, 1], [.11, 0], [.04, 1], [.10, 0], [.06, 1], [.10, 0]];
    const sum = raw.reduce((a, b) => a + b[0], 0), cols = ['#2dd4ff', '#ff9a3c', '#8b5cf6'];
    let x = 0, ci = 0, cx = 0;
    return raw.map(([w, bad], i) => {
      const s = { w: w / sum, x, bad: !!bad, c: bad ? '#586070' : cols[ci++ % 3], i };
      if (!bad) { s.cx = cx; cx += s.w; }
      x += s.w; return s;
    });
  })();
  const GOOD = SEGS.filter((s) => !s.bad).reduce((a, s) => a + s.w, 0);
  const rr = (c, x, y, w, h, r) => { c.beginPath(); c.roundRect(x, y, Math.max(0, w), h, r); };
  function drawTimeline(T) {
    const c = tl.ctx, W = 1384, H = 500, x0 = 70, TW = 1284;
    c.fillStyle = '#0a0d12'; c.fillRect(0, 0, W, H);
    c.fillStyle = '#10151c'; c.fillRect(0, 0, W, 34);
    ['#ff5f57', '#febc2e', '#28c840'].forEach((col, i) => { c.fillStyle = col; c.beginPath(); c.arc(20 + i * 20, 17, 5, 0, 7); c.fill(); });
    c.fillStyle = '#7d8798'; c.font = '600 14px Inter, Arial'; c.textAlign = 'center'; c.fillText('reel_final_v3  ·  1080×1920  ·  30 fps', W / 2, 22);
    // media bin
    c.fillStyle = '#10151c'; rr(c, 24, 50, 410, 200, 8); c.fill();
    for (let i = 0; i < 8; i++) {
      const x = 40 + (i % 4) * 98, y = 66 + Math.floor(i / 4) * 86;
      const gr = c.createLinearGradient(x, y, x + 88, y + 74); gr.addColorStop(0, ['#1d6f8c', '#9a5a22', '#4b3a8c', '#1f6b4f'][i % 4]); gr.addColorStop(1, '#0d1118');
      c.fillStyle = gr; rr(c, x, y, 88, 74, 4); c.fill();
    }
    // preview
    c.save(); rr(c, W / 2 - 62, 50, 124, 210, 8); c.clip(); c.translate(W / 2 - 62, 50); drawClip(c, 124, 210, T * 0.8, 1, { caption: false }); c.restore();
    c.strokeStyle = '#2a3340'; c.lineWidth = 2; rr(c, W / 2 - 62, 50, 124, 210, 8); c.stroke();
    // inspector
    c.fillStyle = '#10151c'; rr(c, 950, 50, 410, 200, 8); c.fill();
    for (let i = 0; i < 6; i++) {
      c.fillStyle = '#27303c'; c.fillRect(978, 76 + i * 28, 300, 4);
      c.fillStyle = i % 2 ? '#ff9a3c' : '#2dd4ff'; c.fillRect(978, 76 + i * 28, 80 + ((i * 53 + Math.floor(T * 20)) % 200), 4);
    }
    // ruler
    c.fillStyle = '#10151c'; c.fillRect(0, 268, W, 24);
    c.fillStyle = '#4c5566'; for (let i = 0; i <= 64; i++) c.fillRect(x0 + (i / 64) * TW, i % 8 === 0 ? 270 : 280, 1.5, i % 8 === 0 ? 20 : 10);
    c.fillStyle = '#7d8798'; c.font = '600 13px Inter, Arial'; c.textAlign = 'left'; c.fillText('V1', 28, 340); c.fillText('A1', 28, 410);

    const ph = T % 9, blade = clamp((ph - 1) / 3), fall = clamp((ph - 4) / 1.2), snap = clamp((ph - 5.2) / 1.2);
    const fade = ph > 8.3 ? clamp((ph - 8.3) / 0.7) : 0, play = ph > 6.6 ? clamp((ph - 6.6) / 1.7) : 0;
    const eSnap = easeOutBack(snap);
    SEGS.forEach((s) => {
      const sl = clamp((blade - s.x) / 0.015), sr = clamp((blade - (s.x + s.w)) / 0.015);
      const gap = 3 * (1 - 0.4 * snap);
      let px = s.bad ? s.x : lerp(s.x, s.cx, eSnap);
      let dy = 0, alpha = 1, rot = 0;
      if (s.bad) { dy = fall * fall * 240; alpha = 1 - fall; rot = (s.i % 2 ? 1 : -1) * fall * 0.35; }
      const xx = x0 + px * TW + gap * sl, ww = s.w * TW - gap * sl - gap * sr;
      [[300, 66], [376, 56]].forEach(([y, hgt], tr) => {
        c.save(); c.globalAlpha = alpha * (1 - fade);
        c.translate(xx + ww / 2, y + hgt / 2 + dy); c.rotate(rot);
        if (tr === 0) {
          c.fillStyle = s.c; rr(c, -ww / 2, -hgt / 2, ww, hgt, 5); c.fill();
          c.fillStyle = 'rgba(255,255,255,.18)'; rr(c, -ww / 2, -hgt / 2, ww, 14, 5); c.fill();
          c.fillStyle = 'rgba(0,0,0,.28)'; for (let k = 0; k < ww / 46; k++) c.fillRect(-ww / 2 + 10 + k * 46, 2, 30, hgt / 2 - 8);
        } else {
          c.fillStyle = '#17202b'; rr(c, -ww / 2, -hgt / 2, ww, hgt, 5); c.fill();
          c.fillStyle = s.bad ? '#6b7587' : '#35e0b4';
          for (let k = 0; k < ww / 6; k++) { const a = (0.2 + 0.8 * Math.abs(Math.sin(k * 0.7 + s.i * 3))) * (s.bad ? 0.5 : 1); c.fillRect(-ww / 2 + 4 + k * 6, -a * 22, 3, a * 44); }
        }
        c.restore();
      });
    });
    // blade
    if (blade > 0 && blade < 1) {
      const bx = x0 + blade * TW;
      c.save(); c.shadowColor = '#2ad8ff'; c.shadowBlur = 28; c.fillStyle = '#e6fbff'; c.fillRect(bx - 1.5, 264, 3, 188);
      c.beginPath(); c.moveTo(bx - 9, 264); c.lineTo(bx + 9, 264); c.lineTo(bx, 280); c.fill(); c.restore();
    }
    // playhead
    if (play > 0) {
      const px = x0 + play * GOOD * TW;
      c.fillStyle = '#fff'; c.fillRect(px - 1, 268, 2, 184); c.beginPath(); c.moveTo(px - 8, 268); c.lineTo(px + 8, 268); c.lineTo(px, 282); c.fill();
    }
    if (snap > 0.55 && snap < 1) { c.fillStyle = `rgba(45,212,255,${(1 - snap) * 0.5})`; c.fillRect(0, 292, W, 150); }
    tl.tex.needsUpdate = true;
  }
  blob(g, 0, 0, 7.6, 3.2);
  chair(g, -1.2, 1.5, Math.PI + 0.25);
  cable(g, [[-0.3, 1.3, -0.62], [-0.3, 0.98, -0.8], [-0.35, 0.5, -0.85], [-0.6, 0.012, -0.7], [-1.8, 0.012, -0.2]], 0.014);
  cable(g, [[0.5, 1.3, -0.62], [0.5, 0.98, -0.8], [0.55, 0.5, -0.85], [0.9, 0.012, -0.7], [2.2, 0.012, -0.3]], 0.014);
  updates[3] = (T) => drawTimeline(T);
}

// ================================================================ STAGE 4: SOUND
{
  const g = stageGroup(3, 'sound', 8, -8);
  mk(g, B(5.2, 0.09, 1.6), woodMat(5.2, 1.6), 0, 0.95, 0, 'sound_desk');
  [-2.4, 2.4].forEach((x) => mk(g, B(0.1, 0.9, 1.5), MAT.metal, x, 0.45, 0));
  mk(g, B(4.8, 0.02, 0.02), glowMat(0xff9a50, 1.3, 2.0), 0, 0.93, 0.8, 'sound_desk_edge');
  const mix = new THREE.Group(); mix.name = 'sound_mixer'; mix.position.set(0, 1.08, 0.05); mix.rotation.x = 0.22; g.add(mix);
  mk(mix, B(3.4, 0.14, 1.1), MAT.dark, 0, 0, 0);
  const capMat = glowMat(0xffa860, 1.5, 2.0), faders = [];
  for (let i = 0; i < 8; i++) {
    const x = -1.4 + i * 0.4;
    mk(mix, B(0.03, 0.006, 0.55), MAT.black, x, 0.075, 0.12);
    faders.push(mk(mix, B(0.11, 0.05, 0.07), capMat, x, 0.1, 0.12, `sound_fader_${i + 1}`));
    [-0.3, -0.18].forEach((z) => { const k = mk(mix, new THREE.CylinderGeometry(0.035, 0.04, 0.045, 16), MAT.metal, x, 0.095, z); mk(k, B(0.006, 0.002, 0.03), glowMat(0xffffff, 2), 0, 0.024, -0.012); });
  }
  const vu = new THREE.InstancedMesh(B(0.07, 0.012, 0.03), new THREE.MeshBasicMaterial({ toneMapped: false }), 40);
  vu.name = 'sound_vu'; mix.add(vu);
  const vuCol = [new THREE.Color(0x35e08a).multiplyScalar(1.6), new THREE.Color(0xffc040).multiplyScalar(1.6), new THREE.Color(0xff4040).multiplyScalar(1.8), new THREE.Color(0x182028)];
  for (let ch = 0; ch < 8; ch++) for (let l = 0; l < 5; l++) { D.position.set(-1.4 + ch * 0.4, 0.078, -0.42 + l * 0.04); D.updateMatrix(); vu.setMatrixAt(ch * 5 + l, D.matrix); vu.setColorAt(ch * 5 + l, vuCol[3]); }
  // speakers
  const spk = [-1, 1].map((sd) => {
    const s = new THREE.Group(); s.name = sd < 0 ? 'sound_speaker_L' : 'sound_speaker_R'; s.position.set(sd * 2.95, 1.5, -0.2); s.rotation.y = -sd * 0.35; g.add(s);
    mk(s, B(0.55, 0.9, 0.46), std(0x15171b, 0.45, 0.4), 0, 0, 0);
    const wf = new THREE.Group(); wf.position.set(0, -0.13, 0.235); s.add(wf);
    const cone = mk(wf, new THREE.CylinderGeometry(0.19, 0.17, 0.05, 28), std(0x23262c, 0.5, 0.5), 0, 0, 0); cone.rotation.x = Math.PI / 2;
    const cap = mk(wf, new THREE.SphereGeometry(0.05, 12, 8, 0, Math.PI * 2, 0, Math.PI / 2), MAT.black, 0, 0, 0.03); cap.rotation.x = Math.PI / 2;
    const rim = mk(wf, new THREE.TorusGeometry(0.2, 0.008, 8, 32), glowMat(sd < 0 ? 0x2ad8ff : 0xff9a50, 1.5, 2.0), 0, 0, 0.02);
    mk(s, new THREE.SphereGeometry(0.05, 12, 8), MAT.metal, 0, 0.28, 0.235);
    mk(g, B(0.1, 0.9, 0.1), MAT.metal, sd * 2.95, 0.45, -0.2);
    mk(g, B(0.6, 0.04, 0.5), MAT.metal, sd * 2.95, 0.02, -0.2);
    const rings = [0, 1, 2].map(() => {
      const m = new THREE.Mesh(new THREE.RingGeometry(0.93, 1, 56), new THREE.MeshBasicMaterial({ color: sd < 0 ? 0x2ad8ff : 0xff9a50, transparent: true, depthWrite: false, blending: THREE.AdditiveBlending, toneMapped: false }));
      m.position.set(0, -0.13, 0.3); m.name = 'sound_ring'; s.add(m); return m;
    });
    return { wf, rings };
  });
  // floating waveform
  const NB = 56, bars = new THREE.InstancedMesh(B(0.05, 1, 0.05), new THREE.MeshBasicMaterial({ toneMapped: false }), NB);
  bars.name = 'sound_waveform'; bars.position.set(0, 3.15, -0.2); bars.frustumCulled = false; g.add(bars);
  for (let i = 0; i < NB; i++) bars.setColorAt(i, new THREE.Color().lerpColors(new THREE.Color(0x2ad8ff), new THREE.Color(0xff9a50), i / NB).multiplyScalar(1.7));
  mk(g, B(4.5, 0.012, 0.012), glowMat(0xffffff, 1.2, 2.0), 0, 3.15, -0.2, 'sound_waveform_base');
  blob(g, 0, -0.1, 6.6, 3.2);
  chair(g, 0.8, 1.55, Math.PI - 0.2);
  cable(g, [[-1.0, 1.1, -0.5], [-1.0, 0.96, -0.82], [-1.1, 0.4, -0.85], [-1.6, 0.012, -0.6], [-3.0, 0.012, -0.2]], 0.014);
  const BPM = 112;
  updates[4] = (T) => {
    const bp = (T * BPM / 60) % 1, env = Math.exp(-bp * 5), beat = T * BPM / 60;
    faders.forEach((f, i) => { f.position.z = 0.12 + Math.sin(T * (0.8 + i * 0.23) + i) * 0.19; });
    for (let ch = 0; ch < 8; ch++) {
      const lvl = clamp(0.25 + 0.55 * env * (0.6 + 0.4 * Math.sin(ch * 1.7 + T * 3)) + 0.15 * Math.sin(T * 2 + ch), 0, 1) * 5;
      for (let l = 0; l < 5; l++) vu.setColorAt(ch * 5 + l, l < lvl ? vuCol[l < 3 ? 0 : l < 4 ? 1 : 2] : vuCol[3]);
    }
    vu.instanceColor.needsUpdate = true;
    for (let i = 0; i < NB; i++) {
      const a = env * (0.45 + 0.55 * Math.abs(Math.sin(i * 0.7 + T * 3))) + 0.18 * Math.abs(Math.sin(i * 0.33 + T * 2)) + 0.05;
      D.position.set((i - NB / 2 + 0.5) * 0.08, 0, 0); D.rotation.set(0, 0, 0); D.scale.set(1, a * 1.4 + 0.02, 1); D.updateMatrix(); bars.setMatrixAt(i, D.matrix);
    }
    bars.instanceMatrix.needsUpdate = true;
    spk.forEach((s, si) => {
      s.wf.scale.set(1 + env * 0.05, 1 + env * 0.05, 1 + env * 0.5);
      s.rings.forEach((r, k) => {
        const u = ((beat * 0.5 + k / 3 + si * 0.15) % 1), sc = 0.15 + u * 2.3;
        r.scale.setScalar(sc); r.material.opacity = (1 - u) * (0.35 + 0.65 * env) * 0.8;
      });
    });
  };
}

// ================================================================ STAGE 5: COLOR + FX
{
  const g = stageGroup(4, 'color', 12.5, -1);
  mk(g, B(5.6, 0.9, 1.7), MAT.dark, 0, 0.45, 0, 'color_bench');
  blob(g, 0, 0, 6.8, 2.8);
  mk(g, B(5.4, 0.02, 0.02), glowMat(0x2ad8ff, 1.4, 2.2), 0, 0.9, 0.86, 'color_bench_edge');
  const ch = new THREE.Group(); ch.name = 'color_chamber'; ch.position.y = 1.85; g.add(ch);
  mk(ch, B(5, 1.9, 1.2), std(0x88ccff, 0.05, 0.1, { transparent: true, opacity: 0.07, depthWrite: false, side: THREE.DoubleSide }), 0, 0, 0, 'color_glass');
  const edges = new THREE.LineSegments(new THREE.EdgesGeometry(B(5, 1.9, 1.2)), new THREE.LineBasicMaterial({ color: 0x7fdcff, transparent: true, opacity: 0.55 }));
  ch.add(edges);
  mk(ch, B(5, 0.03, 0.05), MAT.metal, 0, -0.85, 0);
  // the test frame
  const fr = canvasTex(270, 480);
  {
    const c = fr.ctx, sk = c.createLinearGradient(0, 0, 0, 480);
    sk.addColorStop(0, '#5a8fa8'); sk.addColorStop(0.55, '#c9b28e'); sk.addColorStop(1, '#6d6258');
    c.fillStyle = sk; c.fillRect(0, 0, 270, 480);
    c.fillStyle = 'rgba(255,225,170,.9)'; c.beginPath(); c.arc(190, 190, 40, 0, 7); c.fill();
    c.fillStyle = '#4b4f57';
    for (let i = 0; i < 9; i++) { const w = 22 + (i * 17) % 26, h = 80 + ((i * 53) % 150); c.fillRect(i * 30 - 6, 330 - h, w, h + 150); }
    c.fillStyle = '#2f3138'; c.beginPath(); c.ellipse(135, 340, 34, 40, 0, 0, 7); c.fill();
    c.beginPath(); c.moveTo(60, 480); c.quadraticCurveTo(70, 390, 135, 385); c.quadraticCurveTo(200, 390, 210, 480); c.fill();
    c.fillStyle = '#c28f66'; c.beginPath(); c.arc(135, 318, 20, 0, 7); c.fill();
    for (let i = 0; i < 400; i++) { c.fillStyle = `rgba(${Math.random() > 0.5 ? 255 : 0},${Math.random() > 0.5 ? 255 : 0},255,.03)`; c.fillRect(Math.random() * 270, Math.random() * 480, 2, 2); }
  }
  const frameMat = new THREE.ShaderMaterial({
    transparent: true, depthWrite: false, side: THREE.DoubleSide,
    uniforms: { map: { value: fr.tex }, beams: { value: new THREE.Vector3() }, alpha: { value: 1 }, texel: { value: new THREE.Vector2(1 / 270, 1 / 480) } },
    vertexShader: 'varying vec2 vUv; varying float vWx; void main(){ vUv=uv; vWx=(modelMatrix*vec4(position,1.)).x; gl_Position=projectionMatrix*modelViewMatrix*vec4(position,1.); }',
    fragmentShader: `uniform sampler2D map; uniform vec3 beams; uniform float alpha; uniform vec2 texel; varying vec2 vUv; varying float vWx;
      vec3 sat(vec3 c,float s){ float l=dot(c,vec3(.299,.587,.114)); return mix(vec3(l),c,s); }
      void main(){
        vec3 c0=texture2D(map,vUv).rgb;
        vec3 bl=(texture2D(map,vUv+vec2(texel.x*3.,0.)).rgb+texture2D(map,vUv-vec2(texel.x*3.,0.)).rgb+texture2D(map,vUv+vec2(0.,texel.y*3.)).rgb+texture2D(map,vUv-vec2(0.,texel.y*3.)).rgb+c0)/5.;
        float p1=1.-smoothstep(beams.x-.05,beams.x+.05,vWx);
        float p2=1.-smoothstep(beams.y-.05,beams.y+.05,vWx);
        float p3=1.-smoothstep(beams.z-.05,beams.z+.05,vWx);
        vec3 c=sat(mix(bl,c0,.25),.4); c=(c-.5)*.7+.5+.05;
        c=mix(c,(c-.5)*1.45+.5,p1);
        float l=dot(c,vec3(.299,.587,.114));
        vec3 grade=sat(c,1.55)+vec3(-.05,.01,.07)*(1.-l)+vec3(.09,.03,-.05)*l;
        c=mix(c,grade,p2);
        c+=(c0-bl)*2.2*p3;
        float edge=1.-smoothstep(0.,.03,min(min(vUv.x,1.-vUv.x),min(vUv.y,1.-vUv.y)));
        c+=edge*.35;
        gl_FragColor=vec4(max(c,0.),alpha);
        #include <tonemapping_fragment>
        #include <colorspace_fragment>
      }`,
  });
  const frame = new THREE.Mesh(new THREE.PlaneGeometry(0.62, 1.1), frameMat); frame.name = 'color_frame'; frame.position.y = 0; ch.add(frame);
  const bx = [-0.9, 0.2, 1.3], bc = [0x2ad8ff, 0xff8a3a, 0xffffff];
  const beamGlow = [];
  bx.forEach((x, i) => {
    const bg = new THREE.Group(); bg.name = `color_beam_${i + 1}`; bg.position.set(x, 0, 0); ch.add(bg);
    const core = mk(bg, B(0.025, 1.85, 0.025), glowMat(bc[i], 2.2, 2.4), 0, 0, 0.3);
    const sheet = mk(bg, new THREE.PlaneGeometry(1.1, 1.85), new THREE.MeshBasicMaterial({
      map: radialTex([[0, 'rgba(255,255,255,.9)'], [1, 'rgba(255,255,255,0)']]), color: new THREE.Color(bc[i]).multiplyScalar(1.3), transparent: true, opacity: 0.28,
      depthWrite: false, blending: THREE.AdditiveBlending, side: THREE.DoubleSide, toneMapped: false,
    }));
    sheet.rotation.y = Math.PI / 2; beamGlow.push(sheet.material);
    mk(bg, B(0.14, 0.06, 0.14), glowMat(bc[i], 1.8, 2.4), 0, 0.95, 0);
    mk(bg, B(0.14, 0.06, 0.14), glowMat(bc[i], 1.8, 2.4), 0, -0.95, 0);
  });
  // particles + light leaks
  const PN = LITE ? 40 : 110, pp = new Float32Array(PN * 3);
  for (let i = 0; i < PN; i++) { pp[i * 3] = (rnd() - 0.5) * 4.8; pp[i * 3 + 1] = (rnd() - 0.5) * 1.7; pp[i * 3 + 2] = (rnd() - 0.5) * 1.0; }
  const pg = new THREE.BufferGeometry(); pg.setAttribute('position', new THREE.BufferAttribute(pp, 3));
  const parts = new THREE.Points(pg, new THREE.PointsMaterial({ size: 0.035, color: 0xcfeeff, transparent: true, opacity: 0.8, depthWrite: false, blending: THREE.AdditiveBlending })); parts.name = 'color_particles'; ch.add(parts);
  const leaks = [[-2.5, 0.5, 0xff7a30], [2.5, -0.2, 0x2ad8ff]].map(([x, y, col], i) => {
    const m = mk(ch, new THREE.PlaneGeometry(3, 3), new THREE.MeshBasicMaterial({
      map: radialTex([[0, 'rgba(255,255,255,.8)'], [1, 'rgba(255,255,255,0)']]), color: new THREE.Color(col), transparent: true, opacity: 0.2, depthWrite: false, blending: THREE.AdditiveBlending, toneMapped: false,
    }), x, y, 0.55, `color_leak_${i + 1}`); return m;
  });
  const wp = new THREE.Vector3();
  updates[5] = (T, dt) => {
    const u = T % 7;
    frame.position.x = -2.3 + 4.6 * clamp((u - 0.4) / 6);
    frame.position.y = Math.sin(T * 1.3) * 0.05; frame.rotation.y = Math.sin(T * 0.8) * 0.12;
    frameMat.uniforms.alpha.value = sstep(u / 0.5) * (1 - sstep((u - 6.3) / 0.6));
    ch.updateWorldMatrix(true, false);
    const bxw = bx.map((x) => g.position.x + x);
    frameMat.uniforms.beams.value.set(bxw[0], bxw[1], bxw[2]);
    beamGlow.forEach((m, i) => { m.opacity = 0.22 + 0.1 * Math.sin(T * 5 + i * 2); });
    leaks.forEach((l, i) => { l.material.opacity = 0.14 + 0.08 * Math.sin(T * 1.2 + i * 3); l.position.y = (i ? -0.2 : 0.5) + Math.sin(T * 0.7 + i) * 0.2; });
    const a = pg.attributes.position;
    for (let i = 0; i < PN; i++) {
      a.array[i * 3 + 1] += dt * (0.05 + (i % 5) * 0.015); if (a.array[i * 3 + 1] > 0.85) a.array[i * 3 + 1] = -0.85;
      a.array[i * 3] += Math.sin(T + i) * dt * 0.05;
    }
    a.needsUpdate = true;
  };
}

// ================================================================ STAGE 6: CAPTIONS + MOTION
{
  const g = stageGroup(5, 'captions', 12, 7);
  mk(g, B(3.4, 0.09, 1.4), woodMat(3.4, 1.4), 0, 0.95, 0, 'captions_desk');
  [-1.55, 1.55].forEach((x) => mk(g, B(0.1, 0.9, 1.3), MAT.metal, x, 0.45, 0));
  mk(g, B(3.2, 0.02, 0.02), glowMat(0xffa860, 1.3, 2.8), 0, 0.93, 0.7, 'captions_desk_edge');
  const root = new THREE.Group(); root.name = 'captions_root'; root.rotation.y = -0.6; g.add(root);
  const phoneTex = canvasTex(216, 384);
  const phone = new THREE.Group(); phone.name = 'captions_phone'; phone.position.set(0, 1.95, 0); root.add(phone);
  mk(phone, B(0.9, 1.58, 0.06), std(0x08090c, 0.3, 0.7), 0, 0, 0);
  mk(phone, new THREE.PlaneGeometry(0.82, 1.46), screenMat(phoneTex.tex), 0, 0, 0.034, 'captions_screen');
  glassOver(phone, 0.82, 1.46, 0, 0, 0.037);
  phone.add(new THREE.LineSegments(new THREE.EdgesGeometry(B(0.9, 1.58, 0.06)), new THREE.LineBasicMaterial({ color: 0xffa860, transparent: true, opacity: 0.7 })));
  mk(root, B(0.5, 0.06, 0.4), MAT.metal, 0, 1.0, -0.05);
  mk(root, B(0.06, 0.45, 0.06), MAT.metal, 0, 1.25, -0.1);
  // letters
  const S = 0.36, wordsDef = [['MAKE', 0xffffff], ['IT', 0xffffff], ['STICK', 0xffa43a]];
  const words = wordsDef.map(([txt, col], wi) => {
    const wg = new THREE.Group(); wg.name = `captions_word_${txt}`; root.add(wg);
    const m = new THREE.MeshStandardMaterial({ color: col, emissive: col, emissiveIntensity: 0.9, roughness: 0.4, metalness: 0.1 });
    let cur = 0; const letters = [];
    [...txt].forEach((chr) => {
      const geo = new TextGeometry(chr, { font, size: S, depth: 0.08, curveSegments: 3, bevelEnabled: false });
      geo.computeBoundingBox(); const w = geo.boundingBox.max.x - geo.boundingBox.min.x; geo.translate(-geo.boundingBox.min.x, -S * 0.36, 0);
      const l = new THREE.Mesh(geo, m); l.position.x = cur; l.userData.rest = new THREE.Vector3(cur, 0, 0); cur += w + S * 0.14;
      l.userData.from = new THREE.Vector3((rnd() - 0.5) * 3, (rnd() - 0.2) * 2.2, (rnd() - 0.2) * 2.5);
      l.userData.spin = new THREE.Vector3(rnd() * 6 - 3, rnd() * 6 - 3, rnd() * 4 - 2);
      wg.add(l); letters.push(l);
    });
    const width = cur - S * 0.14; letters.forEach((l) => { l.position.x -= width / 2; l.userData.rest.x -= width / 2; });
    return { wg, letters, width };
  });
  const gapW = 0.5, total = words.reduce((a, w) => a + w.width, 0) + gapW * 2; let cx = -total / 2;
  words.forEach((w, i) => { w.air = new THREE.Vector3(cx + w.width / 2, 3.45, 0.4); cx += w.width + gapW; w.slot = new THREE.Vector3(0, 1.95 - 0.22 - i * 0.2, 0.09); });
  blob(g, 0, 0, 4.6, 2.6);
  chair(g, 1.1, 1.4, Math.PI + 0.4);
  const CYC = 10;
  updates[6] = (T) => {
    const t = T % CYC;
    drawClip(phoneTex.ctx, 216, 384, T * 0.9, 2, { caption: false }); phoneTex.tex.needsUpdate = true;
    words.forEach((w, wi) => {
      const a0 = 0.3 + wi * 0.9, gather = easeInOut((t - (5.2 + wi * 0.55)) / 0.7), vanish = sstep((t - 8.8) / 0.5);
      w.wg.position.lerpVectors(w.air, w.slot, gather);
      w.wg.scale.setScalar(lerp(1, 0.38, gather) * (1 - vanish));
      w.letters.forEach((l, li) => {
        const p = easeOutBack((t - a0 - li * 0.07) / 0.5), q = 1 - clamp((t - a0 - li * 0.07) / 0.5);
        l.position.set(l.userData.rest.x + l.userData.from.x * q * (1 - gather), l.userData.rest.y + l.userData.from.y * q * (1 - gather) + Math.sin(T * 2 + li + wi) * 0.04 * (1 - gather), l.userData.rest.z + l.userData.from.z * q);
        l.rotation.set(l.userData.spin.x * q, l.userData.spin.y * q, l.userData.spin.z * q);
        l.scale.setScalar(Math.max(0.0001, p));
        l.visible = t > a0 + li * 0.07;
      });
    });
  };
}

// ================================================================ STAGE 7: EXPORT
const BELT_LEN = 17.2, SPACING = 2.15, SPEED = 1.5, NCARD = 8;
{
  const g = stageGroup(6, 'export', 3, 5);
  const mach = new THREE.Group(); mach.name = 'export_machine'; g.add(mach);
  mk(mach, B(2.6, 1.0, 2.0), MAT.metal, 0, 0.5, 0, 'export_base');
  mk(mach, B(2.7, 0.05, 2.1), glowMat(0x2ad8ff, 1.4, 3.2), 0, 1.02, 0, 'export_trim');
  for (let i = 0; i < 6; i++) mk(mach, B(0.9, 0.025, 0.02), MAT.black, -0.0, 0.15 + i * 0.1, 1.005);
  const glassM = mk(mach, B(2.2, 1.2, 1.7), std(0x0c1a24, 0.1, 0.2, { transparent: true, opacity: 0.55 }), 0, 1.65, 0, 'export_glass');
  const core = mk(mach, B(1.4, 0.7, 1.0), glowMat(0x2ad8ff, 0.9, 3.2), 0, 1.65, 0, 'export_core');
  // progress ring sits on the +x face so the scroll camera sees it head-on
  const face = new THREE.Group(); face.name = 'export_face'; face.position.set(1.16, 1.65, 0); face.rotation.y = Math.PI / 2; mach.add(face);
  mk(face, new THREE.RingGeometry(0.55, 0.6, 64), new THREE.MeshBasicMaterial({ color: new THREE.Color(0x2ad8ff).multiplyScalar(0.5), transparent: true, opacity: 0.35, toneMapped: false }), 0, 0, 0, 'export_ring_bg');
  const ringMat = new THREE.ShaderMaterial({
    uniforms: { p: { value: 0 }, c1: { value: new THREE.Color(0x2ad8ff) }, c2: { value: new THREE.Color(0xffa043) } }, side: THREE.DoubleSide,
    vertexShader: 'varying vec2 vUv; void main(){ vUv=uv; gl_Position=projectionMatrix*modelViewMatrix*vec4(position,1.); }',
    fragmentShader: `uniform float p; uniform vec3 c1; uniform vec3 c2; varying vec2 vUv;
      void main(){ vec2 q=vUv-.5; float a=atan(q.x,q.y)/6.2831853; a=a<0.?a+1.:a; if(a>p) discard;
        gl_FragColor=vec4(mix(c1,c2,a)*2.0,1.);
        #include <tonemapping_fragment>
        #include <colorspace_fragment>
      }`,
  });
  mk(face, new THREE.RingGeometry(0.5, 0.62, 64), ringMat, 0, 0, 0.01, 'export_ring');
  const pct = canvasTex(256, 128);
  mk(face, new THREE.PlaneGeometry(0.7, 0.35), new THREE.MeshBasicMaterial({ map: pct.tex, transparent: true, toneMapped: false }), 0, 0, 0.01, 'export_percent');
  mk(mach, B(0.05, 0.2, 0.9), glowMat(0xffa043, 1.8, 3.2), -1.31, 0.86, 0, 'export_slot');
  blob(g, 0, 0, 4.2, 3.6);
  // conveyor
  const conv = new THREE.Group(); conv.name = 'export_conveyor'; g.add(conv);
  const cx = -1.3 - BELT_LEN / 2;
  mk(conv, B(BELT_LEN, 0.62, 0.95), MAT.dark, cx, 0.31, 0);
  const beltTex = canvasTex(128, 64); beltTex.ctx.fillStyle = '#14171c'; beltTex.ctx.fillRect(0, 0, 128, 64); beltTex.ctx.fillStyle = '#242a33'; beltTex.ctx.fillRect(0, 0, 8, 64);
  beltTex.tex.wrapS = THREE.RepeatWrapping; beltTex.tex.repeat.set(BELT_LEN / 0.6, 1);
  const belt = mk(conv, new THREE.PlaneGeometry(BELT_LEN, 0.85), new THREE.MeshStandardMaterial({ map: beltTex.tex, roughness: 0.7, metalness: 0.2 }), cx, 0.635, 0, 'export_belt'); belt.rotation.x = -Math.PI / 2;
  [-0.46, 0.46].forEach((z) => mk(conv, B(BELT_LEN, 0.04, 0.03), glowMat(0x2ad8ff, 1.3, 3.4), cx, 0.66, z));
  for (let x = -3; x > -BELT_LEN; x -= 3) [-0.42, 0.42].forEach((z) => mk(conv, B(0.08, 0.62, 0.08), MAT.metal, x, 0.31 - 0.0, z * 1.1));
  // cards
  const cards = [];
  for (let k = 0; k < NCARD; k++) {
    const c = new THREE.Group(); c.name = `export_card_${k + 1}`; g.add(c);
    mk(c, B(0.92, 0.025, 0.52), MAT.black, 0, 0, 0);
    const scr = mk(c, new THREE.PlaneGeometry(0.46, 0.84), screenMat(getClip(k % 6).tex)); scr.rotation.set(-Math.PI / 2, 0, Math.PI / 2); scr.position.y = 0.014;
    mk(c, new THREE.PlaneGeometry(1.25, 0.85), new THREE.MeshBasicMaterial({ map: radialTex([[0, 'rgba(60,200,255,.7)'], [1, 'rgba(60,200,255,0)']]), transparent: true, depthWrite: false, blending: THREE.AdditiveBlending, toneMapped: false, opacity: 0.5 }), 0, -0.01, 0).rotation.x = -Math.PI / 2;
    cards.push(c);
  }
  let pctT = 0;
  updates[7] = (T) => {
    const dist = T * SPEED, prog = (dist % SPACING) / SPACING;
    ringMat.uniforms.p.value = prog;
    core.scale.set(1, 0.8 + 0.2 * Math.sin(T * 6), 1);
    beltTex.tex.offset.x = -(dist / 0.6) % 1; // belt moves the same speed as the cards
    cards.forEach((c, k) => {
      const d = (dist + k * SPACING) % (NCARD * SPACING), x = -1.45 - d;
      const grow = sstep(d / 0.5), shrink = 1 - sstep((d - (BELT_LEN - 1.4)) / 1.2);
      c.position.set(x, 0.665, 0); c.scale.setScalar(Math.max(0.001, grow * shrink));
    });
    if (T - pctT > 0.1) {
      pctT = T; const c = pct.ctx; c.clearRect(0, 0, 256, 128);
      c.fillStyle = '#e8fbff'; c.font = '800 54px Inter, Arial'; c.textAlign = 'center'; c.fillText(Math.floor(prog * 100) + '%', 128, 70);
      c.fillStyle = '#7bd8f0'; c.font = '700 20px Inter, Arial'; c.fillText('RENDER', 128, 104); pct.tex.needsUpdate = true;
    }
  };
}

// ================================================================ STAGE 8: RESULTS
{
  const g = stageGroup(7, 'results', -17.7, 5);
  mk(g, B(0.3, 9, 16), std(0x101216, 0.8, 0.2), -0.3, 4.5, 0, 'results_wall');
  mk(g, B(0.04, 0.05, 11), glowMat(0x2ad8ff, 1.4, 3.6), 0.2, 0.15, 0, 'results_strip_floor');
  mk(g, B(0.04, 0.05, 11), glowMat(0xffa860, 1.2, 3.6), 0.2, 7.0, 0, 'results_strip_top');
  const COLS = 7, ROWS = 3, bez = new THREE.InstancedMesh(B(0.07, 1.78, 1.0), std(0x08090c, 0.3, 0.7), COLS * ROWS);
  bez.name = 'results_bezels'; g.add(bez);
  const perV = [[], [], [], [], [], []]; let bi = 0;
  for (let r = 0; r < ROWS; r++) for (let c = 2; c < COLS; c++) {          // columns 0 and 1 are the stats panel
    const z = (c - (COLS - 1) / 2) * 1.2, y = 1.8 + r * 2.1;
    D.position.set(0, y, z); D.rotation.set(0, 0, 0); D.scale.setScalar(1); D.updateMatrix(); bez.setMatrixAt(bi++, D.matrix);
    perV[(c + r * 2) % 6].push([y, z]);
  }
  bez.count = bi;
  // numbers on the wall: set LAB_CONFIG.stats in index.html (views, likes ...)
  {
    const stats = (CFG.stats && CFG.stats.length ? CFG.stats : [{ n: '3M+', l: 'views generated' }]).slice(0, 3);
    const W = 512, H = Math.round(468 * stats.length), pn = canvasTex(W, H), c = pn.ctx;
    c.fillStyle = '#f3f5f8'; c.beginPath(); c.roundRect(2, 2, W - 4, H - 4, 44); c.fill();      // bright panel, dark type: readable from across the lab
    c.textAlign = 'center'; c.textBaseline = 'alphabetic';
    const slot = H / stats.length;
    stats.forEach((st, i) => {
      let fs = 250; c.font = `800 ${fs}px Inter, Arial, sans-serif`; while (c.measureText(st.n).width > W - 60 && fs > 60) { fs -= 8; c.font = `800 ${fs}px Inter, Arial, sans-serif`; }
      const cy = slot * i + slot / 2; c.fillStyle = '#0b0d10'; c.fillText(st.n, W / 2, cy + fs * 0.12 - 18);
      c.font = '600 58px Inter, Arial, sans-serif'; c.fillStyle = '#2d323b'; c.fillText(st.l, W / 2, cy + fs * 0.12 + 62);
      if (i) { c.fillStyle = 'rgba(11,13,16,.18)'; c.fillRect(60, slot * i - 1, W - 120, 3); }
    });
    pn.tex.needsUpdate = true;
    const m = mk(g, new THREE.PlaneGeometry(2.3, 2.1 * stats.length), new THREE.MeshBasicMaterial({ map: pn.tex, toneMapped: false, transparent: true, color: 0xffffff }), 0.12, 3.9, -3.0, 'results_stats');
    m.rotation.y = Math.PI / 2;
    const glow = mk(g, new THREE.PlaneGeometry(4.2, 2.1 * stats.length + 1.6), new THREE.MeshBasicMaterial({ map: radialTex([[0, 'rgba(255,255,255,.55)'], [1, 'rgba(255,255,255,0)']]), transparent: true, depthWrite: false, blending: THREE.AdditiveBlending, toneMapped: false, opacity: 0.55 }), 0.1, 3.9, -3.0, 'results_stats_glow');
    glow.rotation.y = Math.PI / 2; glow.userData.noShadow = true;
  }
  const scrs = perV.map((list, v) => {
    const im = new THREE.InstancedMesh(new THREE.PlaneGeometry(0.92, 1.64), screenMat(getClip(v).tex), list.length);
    im.name = `results_screens_${v + 1}`;
    list.forEach(([y, z], i) => { D.position.set(0.04, y, z); D.rotation.set(0, Math.PI / 2, 0); D.updateMatrix(); im.setMatrixAt(i, D.matrix); });
    g.add(im); return im;
  });
  updates[8] = () => {};
}

// ================================================================ STAGE 9: CONTACT
const term = canvasTex(512, 320);
{
  const g = stageGroup(8, 'contact', 1.2, -12.2);
  mk(g, B(4.6, 1.0, 1.0), MAT.dark, 0, 0.5, 0, 'contact_desk');
  mk(g, B(4.7, 0.06, 1.1), woodMat(4.7, 1.1), 0, 1.03, 0, 'contact_top');
  mk(g, B(4.4, 0.03, 0.02), glowMat(0xffb070, 1.5, 4.0), 0, 0.35, 0.51, 'contact_desk_glow');
  const t = new THREE.Group(); t.name = 'contact_terminal'; t.position.set(0, 1.06, -0.1); t.rotation.x = -0.12; g.add(t);
  mk(t, B(0.3, 0.5, 0.12), MAT.metal, 0, 0.25, -0.1);
  mk(t, B(1.5, 0.95, 0.08), MAT.black, 0, 0.78, 0);
  mk(t, new THREE.PlaneGeometry(1.4, 0.86), screenMat(term.tex), 0, 0.78, 0.045, 'contact_screen');
  glassOver(t, 1.4, 0.86, 0, 0.78, 0.048);
  const c = term.ctx;
  c.fillStyle = '#0a0d12'; c.fillRect(0, 0, 512, 320);
  c.fillStyle = '#ffd9a8'; c.font = '800 34px Inter, Arial'; c.textAlign = 'center'; c.fillText('READY WHEN YOU ARE', 256, 74);
  c.fillStyle = '#6b7587'; c.font = '600 18px Inter, Arial'; c.fillText('ilavidedits://contact', 256, 104);
  [['Send me an email', 150, '#2dd4ff', '#04202a'], ['Order a video edit', 230, '#ffb069', '#2a1604']].forEach(([txt, y, bg, fg]) => {
    c.fillStyle = bg; c.beginPath(); c.roundRect(76, y, 360, 58, 14); c.fill(); c.fillStyle = fg; c.font = '800 24px Inter, Arial'; c.fillText(txt, 256, y + 37);
  });
  term.tex.needsUpdate = true;
  // calm props
  const lamp = new THREE.Group(); lamp.name = 'contact_lamp'; lamp.position.set(-1.8, 1.06, 0.1); g.add(lamp);
  mk(lamp, new THREE.CylinderGeometry(0.1, 0.12, 0.04, 16), MAT.metal, 0, 0.02, 0);
  mk(lamp, new THREE.CylinderGeometry(0.015, 0.015, 0.5, 8), MAT.metal, 0, 0.27, 0);
  mk(lamp, new THREE.SphereGeometry(0.1, 16, 12), glowMat(0xffc890, 2.2, 4.0), 0, 0.55, 0);
  const plant = new THREE.Group(); plant.name = 'contact_plant'; plant.position.set(1.9, 1.06, 0.1); g.add(plant);
  mk(plant, new THREE.CylinderGeometry(0.12, 0.09, 0.2, 14), std(0x1c1f24, 0.8, 0.1), 0, 0.1, 0);
  for (let i = 0; i < 6; i++) { const l = mk(plant, new THREE.SphereGeometry(0.1, 8, 6), std(0x1d4a35, 0.7, 0.05), Math.sin(i * 1.1) * 0.1, 0.3 + (i % 3) * 0.1, Math.cos(i * 1.1) * 0.1); l.scale.set(0.8, 1.6, 0.5); }
  updates[9] = () => {};
  // big wall display: the lab sends the finished video back to the customer
  t.visible = false;
  {
    const W = 1024, H = 576, bg = canvasTex(W, H), c = bg.ctx, CL = [[0, 0], [1, 2], [2, 5]];
    const ph = (t, a, b) => sstep((t - a) / (b - a));
    const quad = (p, a, b, k) => { const x = (1 - p) * (1 - p) * a[0] + 2 * (1 - p) * p * k[0] + p * p * b[0], y = (1 - p) * (1 - p) * a[1] + 2 * (1 - p) * p * k[1] + p * p * b[1]; return [x, y]; };
    const clipIn = (x, y, w, h, r, T, v) => { c.save(); c.translate(x, y); c.beginPath(); c.roundRect(0, 0, w, h, r); c.clip(); drawClip(c, w, h, T, v, { caption: false }); c.restore(); };
    const drawSend = (T) => {
      const t = T % 11;
      const g1 = c.createLinearGradient(0, 0, 0, H); g1.addColorStop(0, '#15181d'); g1.addColorStop(1, '#0a0b0e'); c.fillStyle = g1; c.fillRect(0, 0, W, H);
      // the machine (left): rounded body, belt, turning gear, progress
      const work = ph(t, 0.2, 3.0), mx = 90, my = 150;
      c.fillStyle = '#d9dde2'; c.beginPath(); c.roundRect(mx, my, 290, 250, 34); c.fill();
      c.fillStyle = '#2b2e34'; c.beginPath(); c.roundRect(mx + 22, my + 150, 246, 56, 16); c.fill();
      c.strokeStyle = 'rgba(255,255,255,.35)'; c.lineWidth = 3; for (let i = 0; i < 12; i++) { const x = mx + 30 + ((i * 20 + T * 60 * (t < 3.2 ? 1 : 0)) % 234); c.beginPath(); c.moveTo(x, my + 156); c.lineTo(x, my + 200); c.stroke(); }
      c.save(); c.translate(mx + 145, my + 80); c.rotate(T * (t < 3.2 ? 2.2 : 0.2)); c.fillStyle = '#2b2e34';
      for (let i = 0; i < 8; i++) { c.rotate(Math.PI / 4); c.beginPath(); c.roundRect(-9, -62, 18, 22, 5); c.fill(); }
      c.beginPath(); c.arc(0, 0, 48, 0, 7); c.fill(); c.fillStyle = '#d9dde2'; c.beginPath(); c.arc(0, 0, 20, 0, 7); c.fill(); c.restore();
      c.fillStyle = 'rgba(255,255,255,.14)'; c.beginPath(); c.roundRect(mx, my + 282, 290, 16, 8); c.fill(); c.fillStyle = '#fff'; c.beginPath(); c.roundRect(mx, my + 282, 290 * work, 16, 8); c.fill();
      // dotted route from the machine to the customer
      const A = [mx + 290, my + 120], Z = [772, 300], K = [560, 70];
      c.fillStyle = 'rgba(255,255,255,.3)'; for (let i = 0; i <= 28; i++) { const q = quad(i / 28, A, Z, K); c.beginPath(); c.arc(q[0], q[1], 4, 0, 7); c.fill(); }
      // the customer (right): phone + person
      const px = 700, py = 150, pw = 190, pH = 340, recv = ph(t, 5.2, 5.8);
      c.fillStyle = '#e9ecef'; c.beginPath(); c.roundRect(px, py, pw, pH, 34); c.fill();
      c.fillStyle = '#0d0e11'; c.beginPath(); c.roundRect(px + 10, py + 10, pw - 20, pH - 20, 26); c.fill();
      if (recv > 0) { c.globalAlpha = recv; clipIn(px + 10, py + 10, pw - 20, pH - 20, 26, T, 0); c.globalAlpha = 1; }
      else { c.fillStyle = 'rgba(255,255,255,.18)'; c.beginPath(); c.arc(px + pw / 2, py + 150, 24, 0, 7); c.fill(); c.beginPath(); c.ellipse(px + pw / 2, py + 222, 46, 34, 0, Math.PI, 0); c.fill(); }
      c.fillStyle = '#fff'; c.beginPath(); c.arc(px + pw / 2, py - 56, 28, 0, 7); c.fill(); c.beginPath(); c.ellipse(px + pw / 2, py + 4, 60, 40, 0, Math.PI, 0); c.fill();
      // finished video leaves the machine and flies to the phone
      const fly = ph(t, 3.0, 5.2);
      if (t > 2.4 && fly < 1) {
        const appear = ph(t, 2.4, 3.0), q = quad(fly, [mx + 145, my - 20], [px + pw / 2, py + pH / 2], [440, 40]), sc = lerp(1, 0.28, fly) * appear, cw = 120 * sc, ch = 214 * sc;
        for (let i = 1; i <= 6; i++) { const tq = quad(Math.max(0, fly - i * 0.035), [mx + 145, my - 20], [px + pw / 2, py + pH / 2], [440, 40]); c.fillStyle = `rgba(255,255,255,${0.25 - i * 0.035})`; c.beginPath(); c.arc(tq[0], tq[1], 10 * sc + 4, 0, 7); c.fill(); }
        c.save(); c.translate(q[0] - cw / 2, q[1] - ch / 2); c.beginPath(); c.roundRect(0, 0, cw, ch, 16 * sc); c.clip(); drawClip(c, cw, ch, T, 0, { caption: false }); c.restore();
        c.strokeStyle = '#fff'; c.lineWidth = 4; c.beginPath(); c.roundRect(q[0] - cw / 2, q[1] - ch / 2, cw, ch, 16 * sc); c.stroke();
      }
      // delivered: ripple + check badge
      const dl = ph(t, 5.3, 6.2);
      if (dl > 0) {
        for (let i = 0; i < 3; i++) { const r = ((t - 5.3) * 0.7 + i / 3) % 1; c.strokeStyle = `rgba(255,255,255,${0.5 * (1 - r)})`; c.lineWidth = 4; c.beginPath(); c.arc(px + pw / 2, py + pH / 2, 140 + r * 120, 0, 7); c.stroke(); }
        c.fillStyle = '#fff'; c.beginPath(); c.arc(px + pw - 8, py + 8, 38 * easeOutBack(dl), 0, 7); c.fill();
        c.strokeStyle = '#0b0d10'; c.lineWidth = 9; c.lineCap = 'round'; c.lineJoin = 'round'; c.beginPath(); c.moveTo(px + pw - 24, py + 10); c.lineTo(px + pw - 12, py + 22); c.lineTo(px + pw + 10, py - 4); c.stroke();
      }
      bg.tex.needsUpdate = true;
    };
    drawSend(0);
    const wall = new THREE.Group(); wall.name = 'contact_big_display'; wall.position.set(0, 3.5, -2.55); g.add(wall);
    mk(wall, RB(5.2, 2.98, 0.16, 0.16), MAT.black, 0, 0, 0, 'big_display_body');
    mk(wall, new THREE.PlaneGeometry(4.96, 2.79), screenMat(bg.tex), 0, 0, 0.085, 'big_display_screen'); glassOver(wall, 4.96, 2.79, 0, 0, 0.088);
    addLight(wall, new THREE.PointLight(0xe8eeff, 30, 9, 2), 0, 0.4, 2.6, 4.0, true);
    const prevU = updates[9]; let acc = 0;
    updates[9] = (T, dt) => { acc += dt; if (acc > (LITE ? 1 / 10 : 1 / 20)) { acc = 0; drawSend(T); } if (prevU) prevU(T, dt); };
  }
}


// ---- the contact form: drawn on a tablet on the desk, driven by hidden real inputs (keyboard, phone keyboard, autofill all work)
{
  const g = ST.contact, W = 768, H = 580, cv = canvasTex(W, H), c = cv.ctx;
  const FIELDS = [{ k: 'name', y: 110, h: 84 }, { k: 'email', y: 212, h: 84 }, { k: 'message', y: 314, h: 140 }], SEND = { x: 40, y: 472, w: 688, h: 70 };
  const mkIn = (tag, type, name, auto, max) => {
    const el = document.createElement(tag); if (type) el.type = type; el.name = name; el.autocomplete = auto; el.maxLength = max; el.setAttribute('aria-label', name);
    Object.assign(el.style, { position: 'fixed', left: '0', bottom: '0', width: '2px', height: '2px', opacity: '0', fontSize: '16px', border: '0', padding: '0', margin: '0', zIndex: '-1' });
    document.body.appendChild(el); return el;
  };
  const inputs = [mkIn('input', 'text', 'name', 'name', 80), mkIn('input', 'email', 'email', 'email', 120), mkIn('textarea', null, 'message', 'off', 1500)];
  inputs[0].enterKeyHint = 'next'; inputs[1].enterKeyHint = 'next'; inputs[2].enterKeyHint = 'enter';
  let active = -1, state = 'idle', stateT = 0, bad = {}, badT = -9, clock = 0;
  const redraw = () => draw(clock);
  inputs.forEach((el, i) => {
    el.addEventListener('focus', () => { active = i; redraw(); });
    el.addEventListener('blur', () => setTimeout(() => { if (!inputs.includes(document.activeElement)) { active = -1; redraw(); } }, 30));
    el.addEventListener('input', () => { delete bad[FIELDS[i].k]; redraw(); });
    el.addEventListener('keydown', (e) => { if (e.key === 'Enter' && i < 2) { e.preventDefault(); inputs[i + 1].focus(); } e.stopPropagation(); });
  });
  const tablet = new THREE.Group(); tablet.name = 'contact_tablet'; tablet.position.set(0, 1.6, -0.05); tablet.rotation.x = -0.7; g.add(tablet);
  const shell = mk(tablet, RB(2.0, 1.52, 0.06, 0.1), MAT.black, 0, 0, -0.035, 'tablet_body');
  const mesh = mk(tablet, new THREE.PlaneGeometry(1.9, 1.9 * H / W), new THREE.MeshBasicMaterial({ map: cv.tex, toneMapped: false }), 0, 0, 0.002, 'contact_form');
  mk(g, RB(1.3, 0.1, 0.5, 0.05), std(0x4b5058, 0.5, 0.35), 0, 1.07, 0.0, 'tablet_stand');
  const glowM = new THREE.MeshBasicMaterial({ map: radialTex([[0, 'rgba(255,255,255,.65)'], [1, 'rgba(255,255,255,0)']]), transparent: true, depthWrite: false, blending: THREE.AdditiveBlending, toneMapped: false, opacity: 0.35 });
  const halo = mk(tablet, new THREE.PlaneGeometry(3.4, 2.8), glowM, 0, 0, -0.08, 'tablet_glow'); halo.userData.noShadow = true;
  // chevrons from the display down to the tablet: "this is where you start"
  const chev = canvasTex(128, 80), cc = chev.ctx; cc.strokeStyle = '#fff'; cc.lineWidth = 16; cc.lineCap = 'round'; cc.lineJoin = 'round'; cc.beginPath(); cc.moveTo(18, 14); cc.lineTo(64, 62); cc.lineTo(110, 14); cc.stroke(); chev.tex.needsUpdate = true;
  const chevs = [0, 1, 2].map((i) => { const m = mk(g, new THREE.PlaneGeometry(0.5, 0.31), new THREE.MeshBasicMaterial({ map: chev.tex, transparent: true, depthWrite: false, toneMapped: false, opacity: 0 }), 0, 3.0 - i * 0.34, -1.2, 'cta_chevron_' + (i + 1)); m.userData.noShadow = true; return m; });

  const rr = (x, y, w, h, r) => { c.beginPath(); c.roundRect(x, y, w, h, r); };
  const icon = (k, cx, cy, col) => {
    c.save(); c.strokeStyle = col; c.fillStyle = col; c.lineWidth = 5; c.lineCap = 'round'; c.lineJoin = 'round'; c.translate(cx, cy);
    if (k === 'name') { c.beginPath(); c.arc(0, -8, 9, 0, 7); c.stroke(); c.beginPath(); c.arc(0, 22, 18, Math.PI * 1.15, Math.PI * 1.85); c.stroke(); }
    else if (k === 'email') { rr(-18, -12, 36, 26, 5); c.stroke(); c.beginPath(); c.moveTo(-16, -8); c.lineTo(0, 4); c.lineTo(16, -8); c.stroke(); }
    else { rr(-18, -15, 36, 26, 8); c.stroke(); c.beginPath(); c.moveTo(-6, 11); c.lineTo(-10, 20); c.lineTo(2, 11); c.stroke(); c.beginPath(); c.arc(-8, -2, 1.5, 0, 7); c.arc(0, -2, 1.5, 0, 7); c.arc(8, -2, 1.5, 0, 7); c.fill(); }
    c.restore();
  };
  const plane = (cx, cy, s, col) => { c.save(); c.translate(cx, cy); c.scale(s, s); c.fillStyle = col; c.beginPath(); c.moveTo(-22, -4); c.lineTo(24, -20); c.lineTo(10, 22); c.lineTo(2, 6); c.closePath(); c.fill(); c.strokeStyle = col; c.lineWidth = 3; c.stroke(); c.restore(); };
  const wrap = (txt, maxW) => { const out = []; txt.split('\n').forEach((para) => { let line = ''; para.split(' ').forEach((w) => { const t = line ? line + ' ' + w : w; if (c.measureText(t).width > maxW && line) { out.push(line); line = w; } else line = t; }); out.push(line); }); return out; };
  function draw(T) {
    clock = T; const sinceBad = T - badT;
    c.clearRect(0, 0, W, H); c.fillStyle = '#f3f5f8'; rr(2, 2, W - 4, H - 4, 40); c.fill();
    if (state === 'sent') {                                               // delivered: plane flies off, check draws
      const t = clamp((T - stateT) / 1.2); c.strokeStyle = '#0b0d10'; c.lineWidth = 16; c.lineCap = 'round'; c.lineJoin = 'round';
      c.beginPath(); c.arc(W / 2, H / 2 - 20, 130, 0, 7); c.globalAlpha = 0.15; c.stroke(); c.globalAlpha = 1;
      c.beginPath(); c.moveTo(W / 2 - 62, H / 2 - 14); c.lineTo(W / 2 - 18, H / 2 + 30 - (1 - clamp(t * 1.4)) * 0); c.lineTo(W / 2 + 70, H / 2 - 68); c.setLineDash([300 * clamp(t * 1.6), 400]); c.stroke(); c.setLineDash([]);
      plane(W / 2 + 40 + 360 * easeInOut(clamp((T - stateT) / 1.6)), H / 2 - 20 - 130 * easeInOut(clamp((T - stateT) / 1.6)), 1.3, '#0b0d10'); cv.tex.needsUpdate = true; return;
    }
    // header: envelope with a pulse ring
    const pulse = 0.5 + 0.5 * Math.sin(T * 3); c.strokeStyle = `rgba(11,13,16,${0.12 + 0.12 * pulse})`; c.lineWidth = 4; c.beginPath(); c.arc(W / 2, 52, 30 + 6 * pulse, 0, 7); c.stroke();
    c.save(); c.translate(W / 2, 52); c.strokeStyle = '#0b0d10'; c.lineWidth = 6; c.lineCap = 'round'; c.lineJoin = 'round'; rr(-22, -15, 44, 30, 6); c.stroke(); c.beginPath(); c.moveTo(-19, -10); c.lineTo(0, 5); c.lineTo(19, -10); c.stroke(); c.restore();
    FIELDS.forEach((f, i) => {
      const on = active === i, isBad = bad[f.k] && sinceBad < 2.2, shake = isBad ? Math.sin(sinceBad * 50) * 6 * (1 - sinceBad / 2.2) : 0, x = 40 + shake, w = 688;
      c.fillStyle = '#fff'; rr(x, f.y, w, f.h, 22); c.fill(); c.lineWidth = on ? 5 : 3; c.strokeStyle = isBad ? '#e5484d' : on ? '#0b0d10' : '#c9ced6'; rr(x, f.y, w, f.h, 22); c.stroke();
      c.fillStyle = '#eef0f3'; c.beginPath(); c.arc(x + 54, f.y + 42, 30, 0, 7); c.fill(); icon(f.k, x + 54, f.y + 42, isBad ? '#e5484d' : '#0b0d10');
      const val = inputs[i].value, tx = x + 108, tw = w - 108 - 28;
      c.font = '500 32px Inter, system-ui, sans-serif'; c.textAlign = 'left'; c.textBaseline = 'alphabetic';
      c.save(); rr(x, f.y, w, f.h, 22); c.clip();
      if (i < 2) {
        c.fillStyle = val ? '#0b0d10' : '#8b929c'; const t = val || (i === 0 ? 'Your name' : 'Your email'), off = Math.min(0, tw - c.measureText(val).width - 6);
        c.fillText(t, tx + (val ? off : 0), f.y + 54);
        if (on && Math.floor(T * 2) % 2 === 0) c.fillRect(tx + (val ? off + c.measureText(val).width + 2 : 0), f.y + 22, 3, 40);
      } else {
        c.fillStyle = val ? '#0b0d10' : '#8b929c'; const lines = val ? wrap(val, tw) : ['Your message'], show = lines.slice(-3);
        show.forEach((ln, k) => c.fillText(ln, tx, f.y + 50 + k * 40));
        if (on && Math.floor(T * 2) % 2 === 0) c.fillRect(tx + (val ? c.measureText(show[show.length - 1]).width + 2 : 0), f.y + 24 + (show.length - 1) * 40, 3, 36);
      }
      c.restore();
    });
    // send button: a paper plane, no words
    const idle = state === 'idle', sh = (T * 0.6) % 2;
    c.fillStyle = state === 'error' ? '#e5484d' : '#0b0d10'; rr(SEND.x, SEND.y, SEND.w, SEND.h, 24); c.fill();
    if (idle && sh < 1) { const g2 = c.createLinearGradient(SEND.x + sh * SEND.w - 120, 0, SEND.x + sh * SEND.w + 120, 0); g2.addColorStop(0, 'rgba(255,255,255,0)'); g2.addColorStop(0.5, 'rgba(255,255,255,.28)'); g2.addColorStop(1, 'rgba(255,255,255,0)'); c.save(); rr(SEND.x, SEND.y, SEND.w, SEND.h, 24); c.clip(); c.fillStyle = g2; c.fillRect(SEND.x, SEND.y, SEND.w, SEND.h); c.restore(); }
    if (state === 'sending') { c.strokeStyle = '#fff'; c.lineWidth = 6; c.lineCap = 'round'; c.beginPath(); c.arc(W / 2, SEND.y + 35, 20, T * 6, T * 6 + 4.2); c.stroke(); }
    else plane(W / 2 + (idle ? Math.sin(T * 3) * 4 : 0), SEND.y + 35, 1, '#fff');
    cv.tex.needsUpdate = true;
  }
  function submit() {
    if (state === 'sending' || state === 'sent') return;
    const v = inputs.map((i) => i.value.trim()), ok = [v[0].length > 1, /^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(v[1]), v[2].length > 4];
    bad = {}; FIELDS.forEach((f, i) => { if (!ok[i]) bad[f.k] = true; });
    if (!ok.every(Boolean)) { badT = clock; inputs[ok.indexOf(false)].focus(); return; }
    state = 'sending'; stateT = clock;
    const subject = 'Video edit enquiry', body = `Name: ${v[0]}\nEmail: ${v[1]}\n\n${v[2]}`, done = () => { state = 'sent'; stateT = clock; inputs.forEach((i) => { i.value = ''; i.blur(); }); setTimeout(() => { state = 'idle'; }, 6000); };
    const viaMail = () => { setTimeout(() => { location.href = `mailto:${CFG.email}?subject=${encodeURIComponent(subject)}&body=${encodeURIComponent(body)}`; }, 450); setTimeout(done, 600); };
    if (CFG.formEndpoint) fetch(CFG.formEndpoint, { method: 'POST', headers: { 'Content-Type': 'application/json', Accept: 'application/json' }, body: JSON.stringify({ name: v[0], email: v[1], message: v[2], _subject: subject }) })
      .then((r) => (r.ok ? done() : Promise.reject())).catch(() => { state = 'error'; setTimeout(() => { state = 'idle'; viaMail(); }, 700); });
    else viaMail();
  }
  const hit = (x, y) => {
    for (let i = 0; i < FIELDS.length; i++) if (x >= 40 && x <= 728 && y >= FIELDS[i].y && y <= FIELDS[i].y + FIELDS[i].h) return { type: 'field', i };
    return x >= SEND.x && x <= SEND.x + SEND.w && y >= SEND.y && y <= SEND.y + SEND.h ? { type: 'send' } : null;
  };
  FORM = { mesh, lift: 0, hit, submit, focus: (i) => inputs[i].focus(), typing: () => active >= 0 };
  draw(0);
  const prevU = updates[9];
  updates[9] = (T, dt) => {
    if (prevU) prevU(T, dt); draw(T);
    FORM.lift += ((TOUCH && active >= 0 ? 1 : 0) - FORM.lift) * Math.min(1, dt * 5);
    glowM.opacity = 0.22 + 0.2 * (0.5 + 0.5 * Math.sin(T * 2.4)) + (active >= 0 ? 0.2 : 0);
    chevs.forEach((m, i) => { const p = (T * 1.1 - i * 0.22) % 1.6; m.material.opacity = active >= 0 ? 0 : Math.max(0, Math.sin(clamp(p) * Math.PI)) * 0.95; });
  };
}

scene.traverse((o) => {
  if (!o.isMesh || o.userData.noShadow) return;
  const m = o.material;
  if (m && m.isMeshStandardMaterial && !m.transparent) { o.castShadow = true; o.receiveShadow = true; }
});

// ---------------------------------------------------------------- camera path
const STOPS = [
  { pos: [-4, 1.8, 26], c: [-4, 2.7, 15.3], side: 'L' },
  { pos: [-12, 3.0, 5.0], c: [-12, 2.5, 14.6], side: 'B', pull: 1.65, via: [{ pos: [-4, 2.6, 18.5], c: [-4, 2.8, 8] }] },
  { pos: [-3.4, 3.2, 6.6], c: [5.6, 1.2, 12.4], side: 'T', pull: 1.5 },
  { pos: [-6.5, 2.5, -0.5], c: [-12, 1.7, -8], side: 'L' },
  { pos: [-6, 2.7, 0.8], c: [-6, 1.8, -8.3], side: 'R' },
  { pos: [8, 2.9, 0.8], c: [8, 1.9, -8.2], side: 'L' },
  { pos: [6.5, 2.9, 5], c: [12.5, 1.9, -1], side: 'R' },
  { pos: [8, 2.9, 10.5], c: [12, 2.3, 7], side: 'L' },
  { pos: [8.5, 3.4, 7.4], c: [-4, 1.2, 5], side: 'R' },
  { pos: [-3, 3.4, 5.5], c: [-17.5, 3.5, 5], side: 'R' },
  { pos: [1.2, 2.5, -6.2], c: [1.2, 2.75, -12.4], side: 'B', pull: 0.5 },
];
let posCurve, tgtCurve, stopTgt = [];
let stopU = [];
function buildPath() {
  const portrait = innerWidth / innerHeight < 1, up = new THREE.Vector3(0, 1, 0);
  const P = [], Tg = [], tgts = []; stopU = [];
  STOPS.forEach((s) => {
    (s.via || []).forEach((v) => { P.push(new THREE.Vector3(...v.pos)); Tg.push(new THREE.Vector3(...v.c)); });   // waypoints (e.g. the door) between two stops
    const c = new THREE.Vector3(...s.c), p = new THREE.Vector3(...s.pos);
    if (portrait) { const dl = p.clone().sub(c); p.copy(c).addScaledVector(dl, s.pull || 1.12); }   // upright phone: narrower view, so step back
    const f = c.clone().sub(p), dist = f.length();
    f.normalize(); const right = new THREE.Vector3().crossVectors(f, up).normalize();
    const t = portrait ? c.clone().addScaledVector(up, -dist * 0.2) : (s.side === 'T' || s.side === 'B') ? c.clone() : c.clone().addScaledVector(right, -dist * 0.2 * (s.side === 'L' ? 1 : -1));
    stopU.push(P.length); P.push(p); Tg.push(t); tgts.push(t);
  });
  stopU = stopU.map((i) => i / (P.length - 1));
  stopTgt = tgts;
  posCurve = new THREE.CatmullRomCurve3(P, false, 'centripetal'); tgtCurve = new THREE.CatmullRomCurve3(Tg, false, 'centripetal');
}
const uOf = (s) => { const i = Math.min(Math.floor(s), STOPS.length - 2), f = clamp(s - i, 0, 1); return lerp(stopU[i], stopU[i + 1], f); };
// ---------------------------------------------------------------- in-world text: holographic panels (no HTML overlay)
let PORT = innerWidth / innerHeight < 1;      // phones held upright: bigger type, plaque locked to the bottom of the screen
const SZ = () => (PORT
  ? { W: 720, num: 150, title: 66, tmin: 46, body: 32, line: 44, btnH: 86, btnF: 34, pad: 48, maxLines: 3 }
  : { W: 1024, num: 190, title: 70, tmin: 46, body: 34, line: 48, btnH: 92, btnF: 36, pad: 64, maxLines: 2 });
const LABELS = [
  { t: 'Short videos, built in a lab.', b: 'Reels, Shorts and TikTok edits for businesses. Step inside.' },
  { t: 'Before the first clip.', b: 'Deal, strategy, signature, a month of scripts. You film.' },
  { t: 'This is how it works.', b: 'One clip travels the line: six steps, one finished short.' },
  { n: '1', t: 'Send me the mess.', b: 'Any footage, any length.' },
  { n: '2', t: 'Every dead second goes.', b: 'The hook first, the slack out.' },
  { n: '3', t: 'It has to sound good.', b: 'Clean voice, music, effects on the beat.' },
  { n: '4', t: 'Flat in, finished out.', b: 'One consistent grade.' },
  { n: '5', t: 'Words that move.', b: 'Captions timed to the voice.' },
  { n: '6', t: 'Ready to post.', b: 'Vertical 9:16 for every platform.' },
  { t: 'Finished shorts.', b: 'Yours can be next.' },
  { hidden: true, t: ' ', b: ' ' },
];
const FONT = 'Inter, "SF Pro Display", system-ui, -apple-system, "Segoe UI", sans-serif';
function wrapText(c, text, maxW) {
  const out = []; let line = '';
  for (const w of text.split(' ')) { const t = line ? line + ' ' + w : w; if (c.measureText(t).width > maxW && line) { out.push(line); line = w; } else line = t; }
  out.push(line); return out;
}
// one pass lays the plaque out (returns its height); a second pass draws it
function layout(L, z, draw, H, hover) {
  const c = L.ctx, d = L.def, W = z.W, pad = z.pad, TW = W - 2 * pad; let y = pad * 0.5; const btn = [];
  c.textBaseline = 'alphabetic'; c.textAlign = 'left';
  if (draw) {
    c.clearRect(0, 0, W, H); c.fillStyle = 'rgba(8,10,14,.74)'; c.beginPath(); c.roundRect(2, 2, W - 4, H - 4, 28); c.fill();
    c.strokeStyle = 'rgba(255,255,255,.28)'; c.lineWidth = 2; c.stroke();
  }
  if (d.n) { y += z.num * 0.78; if (draw) { c.font = `300 ${z.num}px ${FONT}`; c.fillStyle = '#fff'; c.fillText(d.n, pad, y); } y += 18; }
  let size = z.title, lines; do { c.font = `700 ${size}px ${FONT}`; lines = wrapText(c, d.t, TW); size -= 4; } while (lines.length > z.maxLines && size + 4 > z.tmin); size += 4;
  c.font = `700 ${size}px ${FONT}`; y += size * (d.n ? 0.95 : 1.12);
  lines.forEach((ln, i) => { if (draw) { c.fillStyle = '#f5f5f5'; c.fillText(ln, pad, y); } y += i < lines.length - 1 ? size * 1.08 : 0; });
  y += 14; c.font = `400 ${z.body}px ${FONT}`;
  wrapText(c, d.b, TW).forEach((ln) => { y += z.line; if (draw) { c.fillStyle = 'rgba(245,245,245,.74)'; c.fillText(ln, pad, y - 6); } });
  if (d.buttons) {
    y += 26;
    d.buttons.forEach((txt, i) => {
      const b = { x: pad, y, w: TW, h: z.btnH }; btn.push(b);
      if (draw) {
        const on = hover === i, primary = i === 0;
        c.fillStyle = primary ? (on ? '#ffffff' : '#ececec') : (on ? 'rgba(255,255,255,.22)' : 'rgba(255,255,255,.07)');
        c.beginPath(); c.roundRect(b.x, b.y, b.w, b.h, 22); c.fill();
        c.strokeStyle = primary ? '#ececec' : (on ? '#fff' : 'rgba(255,255,255,.35)'); c.lineWidth = 3; c.stroke();
        c.font = `700 ${z.btnF}px ${FONT}`; c.fillStyle = primary ? '#0b0d10' : '#f5f5f5'; c.textAlign = 'left'; c.fillText(txt, b.x + 32, b.y + b.h * 0.64);
        c.textAlign = 'right'; c.fillText('→', b.x + b.w - 32, b.y + b.h * 0.64); c.textAlign = 'left';
      }
      y += z.btnH + 16;
    });
    y -= 16;
  }
  L.btn = btn;
  return Math.ceil(y + pad * 0.75);
}
function drawLabel(L, hover = -1) {
  const z = SZ(), cv = L.ctx.canvas;
  if (cv.width !== z.W) cv.width = z.W; cv.height = 16;
  const H = layout(L, z, false, 0, hover);
  const changed = L.h !== H || L.W !== z.W; L.h = H; L.W = z.W;
  cv.width = z.W; cv.height = H;
  layout(L, z, true, H, hover);
  if (changed) L.tex.dispose();
  L.tex.needsUpdate = true;
}
const labelObjs = LABELS.map((def, k) => {
  const { ctx, tex } = canvasTex(16, 16); tex.anisotropy = 8;
  const mesh = new THREE.Mesh(new THREE.PlaneGeometry(1, 1), new THREE.MeshBasicMaterial({ map: tex, transparent: true, opacity: 0, depthTest: false, depthWrite: false, toneMapped: false, fog: false }));
  mesh.name = `label_${String(k + 1).padStart(2, '0')}`; mesh.renderOrder = 20; mesh.visible = false; mesh.userData.noShadow = true; scene.add(mesh);
  const L = { def, ctx, tex, mesh, base: new THREE.Vector3(), size: [1, 1], h: 0, W: 0, btn: [], pd: 2.4, py: 0 }; drawLabel(L); return L;
});
function placeLabels() {
  const aspect = innerWidth / innerHeight, tanH = Math.tan(THREE.MathUtils.degToRad(camera.fov / 2)), up = new THREE.Vector3(0, 1, 0);
  STOPS.forEach((st, k) => {
    const L = labelObjs[k], pos = new THREE.Vector3(...st.pos);
    if (PORT) {                                                      // locked to the screen: full width, bottom edge
      const d = 2.4, hh = d * tanH, hw = hh * aspect, w = 1.9 * hw, h = (w * L.h) / L.W;
      L.pd = d; L.py = -hh * 0.97 + h / 2; L.size = [w, h]; return;
    }
    const f = stopTgt[k].clone().sub(pos).normalize(), right = new THREE.Vector3().crossVectors(f, up).normalize(), upc = new THREE.Vector3().crossVectors(right, f).normalize();
    const d = Math.min(7, pos.distanceTo(new THREE.Vector3(...st.c))), hh = d * tanH, hw = hh * aspect, top = st.side === 'T', bot = st.side === 'B';
    const w = top || bot ? 0.6 * hw : 0.62 * hw, nx = top || bot ? 0 : st.side === 'L' ? -0.52 : 0.52, ny = top ? 0.58 : bot ? -0.6 : 0;
    L.base.copy(pos).addScaledVector(f, d).addScaledVector(right, nx * hw).addScaledVector(upc, ny * hh);
    L.mesh.position.copy(L.base); L.mesh.lookAt(pos); L.size = [w, (w * L.h) / L.W];
  });
}
// the two contact buttons are real, clickable and hoverable inside the 3D scene
const ray = new THREE.Raycaster(), mv = new THREE.Vector2(); let hoverBtn = -1;
function pickBtn(e) {
  const L = labelObjs[LABELS.length - 1]; if (!L.mesh.visible || L.mesh.material.opacity < 0.6) return -1;
  mv.set((e.clientX / innerWidth) * 2 - 1, -(e.clientY / innerHeight) * 2 + 1); ray.setFromCamera(mv, camera);
  const hit = ray.intersectObject(L.mesh)[0]; if (!hit) return -1;
  const x = hit.uv.x * L.W, y = (1 - hit.uv.y) * L.h;
  return L.btn.findIndex((b) => x >= b.x && x <= b.x + b.w && y >= b.y && y <= b.y + b.h);
}
function go(url) { if (/^https?:/.test(url)) window.open(url, '_blank', 'noopener'); else location.href = url; }
addEventListener('pointermove', (e) => { const i = pickBtn(e); if (i !== hoverBtn) { hoverBtn = i; drawLabel(labelObjs[LABELS.length - 1], i); canvas.style.cursor = i >= 0 ? 'pointer' : ''; } });
function pickForm(e) {
  if (!FORM || sCur < 9.4) return null;
  mv.set((e.clientX / innerWidth) * 2 - 1, -(e.clientY / innerHeight) * 2 + 1); ray.setFromCamera(mv, camera);
  const h = ray.intersectObject(FORM.mesh)[0]; return h ? FORM.hit(h.uv.x * 768, (1 - h.uv.y) * 580) : null;
}
addEventListener('click', (e) => { const h = pickForm(e); if (h) { if (h.type === 'field') FORM.focus(h.i); else FORM.submit(); } });
addEventListener('pointermove', (e) => { if (pickForm(e)) canvas.style.cursor = 'pointer'; });
addEventListener('click', (e) => { const i = pickBtn(e), l = window.LAB_LINKS || {}; if (i === 0) go(l.order); else if (i === 1) go(l.email); });

function onResize() {
  const w = innerWidth, h = innerHeight, aspect = w / h;
  camera.aspect = aspect;
  camera.fov = aspect >= 1 ? 50 : Math.min(85, THREE.MathUtils.radToDeg(2 * Math.atan(Math.tan(THREE.MathUtils.degToRad(32)) / aspect)));
  camera.updateProjectionMatrix();
  renderer.setPixelRatio(pixelRatio); renderer.setSize(w, h);
  buildPath();
  if (PORT !== aspect < 1) { PORT = aspect < 1; labelObjs.forEach((L) => drawLabel(L)); }
  placeLabels();
}
addEventListener('resize', onResize);
onResize();

// ---------------------------------------------------------------- scroll + UI
const dots = [...document.querySelectorAll('#progress button')];
const snapLast = document.getElementById('scroll').lastElementChild;
const maxScroll = () => Math.max(1, snapLast.offsetTop);   // the last stop sits at the top of the last snap block, whatever the phone's toolbar does to the viewport height
const total = STOPS.length - 1;
let sTarget = 0, sCur = 0;
// touch devices: no native scrolling at all (momentum scrolling skipped whole stops); one swipe = one stop
const TOUCH = matchMedia('(pointer:coarse)').matches && FORCE_S === null;
let goal = 0, swipeT = -1e9;
if (TOUCH) document.documentElement.classList.add('touch');
function scrollToStage(s) {
  if (TOUCH) { goal = clamp(Math.round(s), 0, total); return; }
  const max = maxScroll();
  scrollTo({ top: (s / total) * max, behavior: 'smooth' });
}
if (TOUCH) {
  let y0 = null, t0 = 0;
  addEventListener('touchstart', (e) => { y0 = e.touches[0].clientY; t0 = performance.now(); }, { passive: true });
  addEventListener('touchend', (e) => {
    if (y0 === null) return; const dy = y0 - e.changedTouches[0].clientY; y0 = null;
    if (Math.abs(dy) < 36 || document.activeElement && /INPUT|TEXTAREA/.test(document.activeElement.tagName) || T < DOOR.open + DOOR.dur || performance.now() - swipeT < 500) return;   // taps, the door sequence and swipe spam are ignored
    swipeT = performance.now(); goal = clamp(goal + (dy > 0 ? 1 : -1), 0, total);
  }, { passive: true });
}
dots.forEach((d, i) => d.addEventListener('click', () => scrollToStage(i)));
// keyboard: arrows / page keys / space step through the stops, Home / End jump to the ends
let kbGoal = 0, kbT = -1e9;
addEventListener('keydown', (e) => {
  if (e.metaKey || e.ctrlKey || e.altKey) return;
  const dir = { ArrowDown: 1, ArrowRight: 1, PageDown: 1, ' ': e.shiftKey ? -1 : 1, ArrowUp: -1, ArrowLeft: -1, PageUp: -1 }[e.key];
  if (dir === undefined && e.key !== 'Home' && e.key !== 'End') return;
  if (e.target.closest && e.target.closest('a, input, textarea, select')) return;
  e.preventDefault();
  const cur = Math.round(sTarget);
  const base = performance.now() - kbT < 2500 ? kbGoal : cur;   // repeated presses queue up while the scroll is still gliding
  kbT = performance.now();
  kbGoal = e.key === 'Home' ? 0 : e.key === 'End' ? total : clamp(base + dir, 0, total);
  scrollToStage(kbGoal);
});
function readScroll() {
  if (TOUCH) return goal;
  const max = maxScroll();
  const p = clamp(scrollY / max), u = p * total, i = Math.min(Math.floor(u), total - 1), f = u - i;
  return i + sstep((f - 0.28) / 0.44);
}
let mx = 0, my = 0, smx = 0, smy = 0;
addEventListener('pointermove', (e) => { mx = (e.clientX / innerWidth - 0.5) * 2; my = (e.clientY / innerHeight - 0.5) * 2; });

// ---------------------------------------------------------------- loop
const clock = new THREE.Clock();
let PT = -1, powerT0 = FORCE_S !== null && FORCE_S >= 1 ? -100 : null;
let T = FORCE_S !== null ? parseFloat(params.get('t') || 12) : params.has('skipdoor') ? 20 : 0, clipAcc = 0, slow = 0, qStep = 0;
const tmpF = new THREE.Vector3(), tmpU = new THREE.Vector3(), tmpP = new THREE.Vector3(), tmpT = new THREE.Vector3(), right = new THREE.Vector3(), upv = new THREE.Vector3(0, 1, 0);

function frame() {
  requestAnimationFrame(frame);
  const dt = Math.min(clock.getDelta(), 0.05);
  T += dt;
  sTarget = FORCE_S !== null ? FORCE_S : readScroll();
  if (T < DOOR.open + DOOR.dur && FORCE_S === null) sTarget = 0;   // wait for the door
  sCur += (sTarget - sCur) * (1 - Math.exp(-dt * 5));
  const u = uOf(clamp(sCur, 0, total));

  // power-on
  if (powerT0 === null && sCur > 0.62) powerT0 = T;   // lab only powers on once you have stepped through the door
  PT = powerT0 === null ? -1 : T - powerT0;
  scene.environmentIntensity = 0.05 + (LITE ? 1.5 : 0.4) * clamp(PT / 2.5);
  shafts.forEach((c) => (c.material.uniforms.o.value = c.userData.o * clamp((PT - 1) / 3)));
  ramps.forEach((r) => { r.l.intensity = r.base * power(PT, r.t0); });
  glows.forEach((gl) => {
    const v = power(PT, gl.t0);
    if (gl.m) gl.m.color.copy(gl.base).multiplyScalar(v);
    if (gl.halo) gl.halo.opacity = 0.35 * v;
  });

  // camera
  posCurve.getPoint(u, tmpP); tgtCurve.getPoint(u, tmpT);
  if (FORM) tmpT.y -= 1.25 * FORM.lift;
  smx += (mx - smx) * (1 - Math.exp(-dt * 3)); smy += (my - smy) * (1 - Math.exp(-dt * 3));
  if (!REDUCED) { tmpP.x += Math.sin(T * 0.6) * 0.03; tmpP.y += Math.sin(T * 0.8 + 1) * 0.02; tmpP.z += Math.cos(T * 0.5) * 0.02; }
  camera.position.copy(tmpP);
  camera.lookAt(tmpT);
  right.set(1, 0, 0).applyQuaternion(camera.quaternion);
  camera.position.addScaledVector(right, smx * 0.18).addScaledVector(upv, -smy * 0.08);
  camera.rotateY(-smx * 0.035); camera.rotateX(-smy * 0.02);
  if (!REDUCED) camera.rotateZ(Math.sin(T * 0.4) * 0.004);

  // which stages are near enough to animate
  const stopOf = (k) => (k >= 1 && k <= 9 ? k + 1 : k === 10 ? 1 : k);   // stage k sits at this stop (the prelude was added at stop 1)
  for (let k = 0; k < 11; k++) act[k] = Math.abs(sCur - stopOf(k)) < 1.3 || (k === 0 && T < 14) || (k === 1 && PT < 6);
  clipAcc += dt;
  if (clipAcc > (LITE ? 1 / 9 : 1 / 15) && (act[1] || act[7] || act[8] || act[9])) { clipAcc = 0; clipCache.forEach((c) => c.tick(T)); }
  for (let k = 0; k < 11; k++) if (act[k] && updates[k]) updates[k](T, dt);

  // dust drift
  { const a = dust.geometry.attributes.position.array; for (let i = 1; i < a.length; i += 3) { a[i] += dt * 0.05; if (a[i] > 8.3) a[i] = 0.3; } dust.geometry.attributes.position.needsUpdate = true; }

  // UI
  { const hint = document.getElementById('hint'); if (hint) hint.style.opacity = String(sstep((T - (DOOR.open + DOOR.dur)) / 1.0) * (1 - sstep(sCur / 0.3))); }
  const near = Math.round(sCur);
  dots.forEach((d, i) => d.classList.toggle('on', i === near));
  labelObjs.forEach((L, k) => {
    const w = L.def.hidden ? 0 : sstep(1 - Math.abs(sCur - k) / 0.5);
    L.mesh.visible = w > 0.01; if (!L.mesh.visible) return;
    L.mesh.material.opacity = w; const sc = 0.94 + 0.06 * w;
    L.mesh.scale.set(L.size[0] * sc, L.size[1] * sc, 1);
    if (PORT) { const f = tmpF.set(0, 0, -1).applyQuaternion(camera.quaternion), u = tmpU.set(0, 1, 0).applyQuaternion(camera.quaternion); L.mesh.position.copy(camera.position).addScaledVector(f, L.pd).addScaledVector(u, L.py); L.mesh.quaternion.copy(camera.quaternion); }
    else L.mesh.position.copy(L.base).y += Math.sin(T * 0.7 + k) * 0.012 * L.size[0];
  });

  renderer.render(scene, camera);

  // adaptive quality: if we are well below 40 fps for ~1.5 s, drop a step
  if (T > 8 && FORCE_S === null) {
    slow = dt > 0.028 ? slow + dt : Math.max(0, slow - dt * 2);
    if (slow > 1.5 && qStep < 3) {
      slow = 0; qStep++;
      if (qStep === 1) { pixelRatio = Math.max(1, pixelRatio * 0.7); onResize(); }
      else if (qStep === 2 && reflector) { reflector.visible = false; }
      else if (qStep === 3) shafts.forEach((s) => (s.visible = false));
    }
  }
}
document.body.classList.add('ready'); window.LAB_READY = Math.round(performance.now());
frame();

// ---------------------------------------------------------------- GLB export (named stage groups)
window.LAB = { target: () => sTarget, scene, camera, renderer, stages: ST, setStage: (s) => scrollToStage(s) };
window.exportGLB = async (upload = false) => {
  const hide = [reflector, dust, ...shafts].filter(Boolean), prev = hide.map((o) => o.visible);
  hide.forEach((o) => (o.visible = false));
  const buf = await new Promise((res, rej) => new GLTFExporter().parse(scene, res, rej, { binary: true, onlyVisible: true, maxTextureSize: 512 }));
  hide.forEach((o, i) => (o.visible = prev[i]));
  const blob = new Blob([buf], { type: 'model/gltf-binary' });
  if (upload) { await fetch('/save-glb', { method: 'POST', body: blob }); return blob.size; }
  const a = document.createElement('a'); a.href = URL.createObjectURL(blob); a.download = 'ilavidedits-lab.glb'; a.click();
  return blob.size;
};
addEventListener('keydown', (e) => { if (e.key === 'g' && !e.metaKey && !e.ctrlKey && !(e.target.closest && e.target.closest('input, textarea'))) window.exportGLB(); });
