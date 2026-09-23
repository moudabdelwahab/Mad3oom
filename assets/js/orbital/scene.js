/* =====================================================================
   Mad3oom orbital — the WebGL world
   ---------------------------------------------------------------------
   بيئة إجرائية بالكامل: لا نماذج ثقيلة ولا صور. الكوكب والسديم يُخبزان
   مرة واحدة في قوام عند البدء، ثم يُرسم كل إطار بكلفة منخفضة.

   المستويات (tier):
     high   سطح المكتب: كل التفاصيل، دقة حتى 1.75x.
     mid    اللوحي/الأجهزة المتوسطة: كثافة أقل، دقة حتى 1.25x.
     low    الجوال: كوكب ونجوم ومحطة مبسطة، 30 إطارًا/ثانية.
     static تقليل الحركة: يُرسم فقط عند تغيّر الفصل أو المقاس.
   ===================================================================== */

import * as THREE from "/assets/vendor/three/three.module.min.js";

const clamp = (v, a = 0, b = 1) => Math.min(b, Math.max(a, v));
const smooth = t => t * t * (3 - 2 * t);

const NOISE = /* glsl */ `
vec3 mod289(vec3 x){return x-floor(x*(1.0/289.0))*289.0;}
vec4 mod289(vec4 x){return x-floor(x*(1.0/289.0))*289.0;}
vec4 permute(vec4 x){return mod289(((x*34.0)+1.0)*x);}
vec4 taylorInvSqrt(vec4 r){return 1.79284291400159-0.85373472095314*r;}
float snoise(vec3 v){
  const vec2 C=vec2(1.0/6.0,1.0/3.0);
  const vec4 D=vec4(0.0,0.5,1.0,2.0);
  vec3 i=floor(v+dot(v,C.yyy));
  vec3 x0=v-i+dot(i,C.xxx);
  vec3 g=step(x0.yzx,x0.xyz);
  vec3 l=1.0-g;
  vec3 i1=min(g.xyz,l.zxy);
  vec3 i2=max(g.xyz,l.zxy);
  vec3 x1=x0-i1+C.xxx;
  vec3 x2=x0-i2+C.yyy;
  vec3 x3=x0-D.yyy;
  i=mod289(i);
  vec4 p=permute(permute(permute(i.z+vec4(0.0,i1.z,i2.z,1.0))+i.y+vec4(0.0,i1.y,i2.y,1.0))+i.x+vec4(0.0,i1.x,i2.x,1.0));
  float n_=0.142857142857;
  vec3 ns=n_*D.wyz-D.xzx;
  vec4 j=p-49.0*floor(p*ns.z*ns.z);
  vec4 x_=floor(j*ns.z);
  vec4 y_=floor(j-7.0*x_);
  vec4 x=x_*ns.x+ns.yyyy;
  vec4 y=y_*ns.x+ns.yyyy;
  vec4 h=1.0-abs(x)-abs(y);
  vec4 b0=vec4(x.xy,y.xy);
  vec4 b1=vec4(x.zw,y.zw);
  vec4 s0=floor(b0)*2.0+1.0;
  vec4 s1=floor(b1)*2.0+1.0;
  vec4 sh=-step(h,vec4(0.0));
  vec4 a0=b0.xzyw+s0.xzyw*sh.xxyy;
  vec4 a1=b1.xzyw+s1.xzyw*sh.zzww;
  vec3 p0=vec3(a0.xy,h.x);
  vec3 p1=vec3(a0.zw,h.y);
  vec3 p2=vec3(a1.xy,h.z);
  vec3 p3=vec3(a1.zw,h.w);
  vec4 norm=taylorInvSqrt(vec4(dot(p0,p0),dot(p1,p1),dot(p2,p2),dot(p3,p3)));
  p0*=norm.x;p1*=norm.y;p2*=norm.z;p3*=norm.w;
  vec4 m=max(0.6-vec4(dot(x0,x0),dot(x1,x1),dot(x2,x2),dot(x3,x3)),0.0);
  m=m*m;
  return 42.0*dot(m*m,vec4(dot(p0,x0),dot(p1,x1),dot(p2,x2),dot(p3,x3)));
}
float fbm(vec3 p){float a=0.5,s=0.0;for(int i=0;i<6;i++){s+=a*snoise(p);p*=2.03;a*=0.5;}return s;}
`;

const TIERS = {
  high: { dpr: 1.75, stars: 5200, dust: 520, ships: 6, streams: 6, cube: 1024, planetSeg: 128, net: true, bars: true, windows: true, fps: 60, aa: true },
  mid: { dpr: 1.25, stars: 2800, dust: 220, ships: 3, streams: 3, cube: 512, planetSeg: 96, net: true, bars: true, windows: true, fps: 60, aa: false },
  low: { dpr: 1, stars: 1300, dust: 0, ships: 2, streams: 0, cube: 256, planetSeg: 64, net: false, bars: false, windows: false, fps: 30, aa: false },
  static: { dpr: 1.25, stars: 2800, dust: 0, ships: 3, streams: 3, cube: 512, planetSeg: 96, net: true, bars: true, windows: true, fps: 0, aa: false },
};

/* Camera path. c = chapter (0..10). `hold` keys are where the camera
   settles: velocity eases to zero there, so each scene reads as a shot. */
const KEYS = [
  { c: 0, hold: 1, pos: [0, 1.4, 18], tgt: [0, 1.0, -40], fov: 52 },
  { c: 1, hold: 1, pos: [0, 1.0, 8], tgt: [0, 0.9, -40], fov: 48 },
  { c: 1.55, hold: 0, pos: [0, 1.2, -2], tgt: [-2, 1.4, -40], fov: 62 },
  { c: 1.9, hold: 0, pos: [-2.5, 1.8, -13], tgt: [-6, 2.4, -60], fov: 54 },
  { c: 2.45, hold: 0, pos: [-4, 2.6, -27], tgt: [-1, 3.2, -70], fov: 52 },
  // each pinned scene holds its shot while it is on screen; moves happen between them
  { c: 2.95, hold: 1, pos: [0, 3.2, -35], tgt: [0, 3.8, -62], fov: 50 },
  { c: 3.45, hold: 1, pos: [0, 3.2, -35.6], tgt: [0, 3.8, -62], fov: 50 },
  { c: 3.95, hold: 1, pos: [12, 6.5, -75], tgt: [24, 5, -96], fov: 50 },
  { c: 4.45, hold: 1, pos: [12.4, 6.5, -75.6], tgt: [24, 5, -96], fov: 50 },
  { c: 4.95, hold: 1, pos: [6, 5, -58], tgt: [30, 3, -140], fov: 50 },
  { c: 5.35, hold: 1, pos: [6.4, 5.2, -58.6], tgt: [30, 3, -140], fov: 50 },
  { c: 6, hold: 1, pos: [0, 24, 64], tgt: [0, -2, -50], fov: 48 },
  { c: 7, hold: 0, pos: [-20, 15, 50], tgt: [-18, 4, -80], fov: 50 },
  { c: 8, hold: 0, pos: [24, 11, 42], tgt: [36, 4, -70], fov: 50 },
  { c: 9, hold: 0, pos: [6, 17, 54], tgt: [0, 4, -80], fov: 50 },
  { c: 10, hold: 1, pos: [0, 2.4, 24], tgt: [0, 1.6, -40], fov: 50 },
];

const SUN = new THREE.Vector3(0.62, 0.34, 0.42).normalize();

/* ── helpers ─────────────────────────────────────────────────────────── */
function glowTexture() {
  const c = document.createElement("canvas");
  c.width = c.height = 128;
  const g = c.getContext("2d");
  const r = g.createRadialGradient(64, 64, 0, 64, 64, 64);
  r.addColorStop(0, "rgba(255,255,255,1)");
  r.addColorStop(0.18, "rgba(255,255,255,.55)");
  r.addColorStop(0.45, "rgba(255,255,255,.12)");
  r.addColorStop(1, "rgba(255,255,255,0)");
  g.fillStyle = r;
  g.fillRect(0, 0, 128, 128);
  const t = new THREE.CanvasTexture(c);
  t.colorSpace = THREE.SRGBColorSpace;
  return t;
}

function glow(tex, color, size, opacity = 1) {
  const s = new THREE.Sprite(new THREE.SpriteMaterial({
    map: tex, color, transparent: true, opacity, blending: THREE.AdditiveBlending, depthWrite: false,
  }));
  s.scale.set(size, size, 1);
  return s;
}

function bake(renderer, frag, w, h) {
  const rt = new THREE.WebGLRenderTarget(w, h, {
    minFilter: THREE.LinearMipmapLinearFilter,
    magFilter: THREE.LinearFilter,
    generateMipmaps: true,
    wrapS: THREE.RepeatWrapping,
    wrapT: THREE.ClampToEdgeWrapping,
  });
  const mat = new THREE.ShaderMaterial({
    vertexShader: "varying vec2 vUv; void main(){ vUv = uv; gl_Position = vec4(position.xy, 0.0, 1.0); }",
    fragmentShader: NOISE + frag,
    depthTest: false,
    depthWrite: false,
  });
  const quad = new THREE.Mesh(new THREE.PlaneGeometry(2, 2), mat);
  const sc = new THREE.Scene();
  sc.add(quad);
  renderer.setRenderTarget(rt);
  renderer.render(sc, new THREE.Camera());
  renderer.setRenderTarget(null);
  mat.dispose();
  quad.geometry.dispose();
  return rt;
}

const DIR_FROM_UV = /* glsl */ `
vec3 dirFromUv(vec2 uv){
  float lon = (uv.x - 0.5) * 6.2831853;
  float lat = (uv.y - 0.5) * 3.1415926;
  return vec3(cos(lat) * cos(lon), sin(lat), cos(lat) * sin(lon));
}`;

/* ── builders ────────────────────────────────────────────────────────── */
function buildNebula(renderer, size) {
  const mat = new THREE.ShaderMaterial({
    side: THREE.BackSide,
    depthWrite: false,
    vertexShader: "varying vec3 vDir; void main(){ vDir = position; gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0); }",
    fragmentShader: NOISE + /* glsl */ `
      varying vec3 vDir;
      void main(){
        vec3 d = normalize(vDir);
        float n = fbm(d * 1.6 + vec3(2.0));
        float n2 = fbm(d * 3.4 + vec3(-3.0, 1.0, 5.0));
        float band = exp(-pow(dot(d, normalize(vec3(0.28, 1.0, 0.32))) * 3.0, 2.0));
        vec3 base = vec3(0.004, 0.085, 0.19);
        vec3 blue = vec3(0.13, 0.25, 0.62);
        vec3 violet = vec3(0.26, 0.26, 0.66);
        // soft, low-contrast nebula: the reference sky is a smooth royal-navy field
        float cloud = smoothstep(-0.35, 1.0, n) * (0.35 + 0.65 * band);
        vec3 col = base + blue * cloud * 0.42 + violet * smoothstep(0.3, 1.0, n2) * band * 0.16;
        col *= 0.92 + 0.08 * smoothstep(-0.4, 0.4, fbm(d * 8.0));
        // brighter toward the horizon, darker toward the zenith (reference #163061 → #01132e)
        col += vec3(0.03, 0.07, 0.16) * smoothstep(0.45, -0.1, d.y);
        col *= 1.0 - 0.25 * smoothstep(0.35, 0.95, d.y);
        vec3 q = d * 420.0; vec3 id = floor(q);
        float h = fract(sin(dot(id, vec3(127.1, 311.7, 74.7))) * 43758.5453);
        float star = step(0.9962, h) * smoothstep(0.4, 0.0, length(fract(q) - 0.5));
        col += vec3(0.72, 0.82, 1.0) * star * 0.7;
        gl_FragColor = vec4(pow(col, vec3(2.2)), 1.0);
      }`,
  });
  const mesh = new THREE.Mesh(new THREE.SphereGeometry(100, 64, 32), mat);
  const sc = new THREE.Scene();
  sc.add(mesh);
  const rt = new THREE.WebGLCubeRenderTarget(size, { generateMipmaps: true, minFilter: THREE.LinearMipmapLinearFilter });
  const cam = new THREE.CubeCamera(1, 500, rt);
  cam.update(renderer, sc);
  mat.dispose();
  mesh.geometry.dispose();
  return rt;
}

function buildStars(count) {
  const pos = new Float32Array(count * 3), col = new Float32Array(count * 3), size = new Float32Array(count), phase = new Float32Array(count);
  const tints = [[1, 1, 1], [0.78, 0.85, 1], [0.7, 0.78, 1], [0.78, 0.86, 1], [0.84, 0.82, 1]];
  for (let i = 0; i < count; i++) {
    const u = Math.random() * 2 - 1, th = Math.random() * Math.PI * 2, r = 380 + Math.random() * 480;
    const s = Math.sqrt(1 - u * u);
    pos.set([Math.cos(th) * s * r, u * r, Math.sin(th) * s * r], i * 3);
    const t = tints[(Math.random() * tints.length) | 0];
    col.set(t, i * 3);
    size[i] = Math.random() < 0.04 ? 2.6 + Math.random() * 2 : 0.8 + Math.random() * 1.5;
    phase[i] = Math.random() * 6.283;
  }
  const g = new THREE.BufferGeometry();
  g.setAttribute("position", new THREE.BufferAttribute(pos, 3));
  g.setAttribute("color", new THREE.BufferAttribute(col, 3));
  g.setAttribute("size", new THREE.BufferAttribute(size, 1));
  g.setAttribute("phase", new THREE.BufferAttribute(phase, 1));
  const m = new THREE.ShaderMaterial({
    uniforms: { time: { value: 0 }, pr: { value: 1 } },
    transparent: true,
    depthWrite: false,
    blending: THREE.AdditiveBlending,
    vertexShader: /* glsl */ `
      attribute float size; attribute float phase; attribute vec3 color;
      uniform float time; uniform float pr; varying vec3 vC; varying float vA;
      void main(){
        vC = color;
        vA = 0.62 + 0.38 * sin(time * (0.6 + fract(phase) * 1.4) + phase);
        gl_PointSize = size * pr;
        gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
      }`,
    fragmentShader: /* glsl */ `
      varying vec3 vC; varying float vA;
      void main(){
        float d = length(gl_PointCoord - 0.5);
        float a = pow(smoothstep(0.5, 0.0, d), 1.7) * vA;
        gl_FragColor = vec4(vC * a, a);
      }`,
  });
  const pts = new THREE.Points(g, m);
  pts.frustumCulled = false;
  return pts;
}

function buildPlanet(renderer, seg, tex) {
  const albedo = bake(renderer, DIR_FROM_UV + /* glsl */ `
    varying vec2 vUv;
    void main(){
      vec3 d = dirFromUv(vUv);
      float h = fbm(d * 2.1);
      float land = smoothstep(0.03, 0.13, h);
      float detail = fbm(d * 9.0) * 0.5 + 0.5;
      vec3 ocean = mix(vec3(0.03, 0.07, 0.22), vec3(0.07, 0.16, 0.42), smoothstep(-0.5, 0.1, h));
      vec3 ground = mix(vec3(0.12, 0.2, 0.42), vec3(0.3, 0.42, 0.66), detail);
      float ice = smoothstep(0.8, 0.92, abs(d.y) + detail * 0.08);
      vec3 col = mix(ocean, ground, land);
      col = mix(col, vec3(0.82, 0.9, 1.0), ice);
      float cl = fbm(d * 3.1 + vec3(4.1, 1.3, -2.2)) + 0.18 * fbm(d * 12.0);
      cl = smoothstep(0.02, 0.55, cl);
      gl_FragColor = vec4(pow(col, vec3(2.2)), cl);
    }`, 1024, 512);

  const R = 44;
  const planet = new THREE.Mesh(
    new THREE.SphereGeometry(R, seg, seg / 2),
    new THREE.ShaderMaterial({
      uniforms: { map: { value: albedo.texture }, sunDir: { value: SUN }, time: { value: 0 }, atmo: { value: new THREE.Color(0x4a80ff) } },
      vertexShader: /* glsl */ `
        varying vec3 vN; varying vec3 vW; varying vec2 vUv;
        void main(){
          vUv = uv;
          vN = normalize(mat3(modelMatrix) * normal);
          vec4 w = modelMatrix * vec4(position, 1.0);
          vW = w.xyz;
          gl_Position = projectionMatrix * viewMatrix * w;
        }`,
      fragmentShader: /* glsl */ `
        uniform sampler2D map; uniform vec3 sunDir; uniform float time; uniform vec3 atmo;
        varying vec3 vN; varying vec3 vW; varying vec2 vUv;
        void main(){
          vec3 n = normalize(vN);
          vec3 v = normalize(cameraPosition - vW);
          vec4 s = texture2D(map, vUv);
          float clouds = texture2D(map, vUv + vec2(time * 0.0035, 0.0)).a;
          float ndl = dot(n, sunDir);
          float lit = max(ndl, 0.0);
          vec3 col = s.rgb * (0.035 + 1.15 * lit);
          col = mix(col, vec3(0.8, 0.88, 1.0) * (0.025 + 1.05 * lit), clouds * 0.82);
          float lum = dot(s.rgb, vec3(0.3, 0.6, 0.1));
          vec3 h = normalize(sunDir + v);
          col += pow(max(dot(n, h), 0.0), 70.0) * 0.55 * (1.0 - clouds) * (1.0 - smoothstep(0.015, 0.06, lum));
          float fr = pow(1.0 - max(dot(n, v), 0.0), 3.0);
          col += atmo * fr * (0.18 + 0.95 * smoothstep(-0.35, 0.6, ndl));
          // faint cyan night-side city grid, kept in-palette
          float night = smoothstep(0.1, -0.25, ndl) * (1.0 - clouds);
          float grid = step(0.985, fract(vUv.x * 180.0)) + step(0.985, fract(vUv.y * 90.0));
          col += vec3(0.35, 0.55, 1.0) * night * grid * step(0.02, lum) * 0.06;
          gl_FragColor = vec4(col, 1.0);
          #include <colorspace_fragment>
        }`,
    })
  );

  const atmo = new THREE.Mesh(
    new THREE.SphereGeometry(R * 1.075, seg / 2, seg / 4),
    new THREE.ShaderMaterial({
      uniforms: { sunDir: { value: SUN }, color: { value: new THREE.Color(0x3f6ff0) } },
      side: THREE.BackSide,
      transparent: true,
      depthWrite: false,
      blending: THREE.AdditiveBlending,
      vertexShader: /* glsl */ `
        varying vec3 vN; varying vec3 vV; varying vec3 vWN;
        void main(){
          vN = normalize(normalMatrix * normal);
          vWN = normalize(mat3(modelMatrix) * normal);
          vec4 mv = modelViewMatrix * vec4(position, 1.0);
          vV = normalize(-mv.xyz);
          gl_Position = projectionMatrix * mv;
        }`,
      fragmentShader: /* glsl */ `
        uniform vec3 sunDir; uniform vec3 color;
        varying vec3 vN; varying vec3 vV; varying vec3 vWN;
        void main(){
          float rim = pow(clamp(0.68 + dot(normalize(vN), normalize(vV)), 0.0, 1.0), 5.0);
          float day = 0.3 + 0.7 * smoothstep(-0.45, 0.6, dot(vWN, sunDir));
          vec3 c = color * rim * day * 1.6;
          gl_FragColor = vec4(c, rim * day);
          #include <colorspace_fragment>
        }`,
    })
  );

  const group = new THREE.Group();
  group.add(planet, atmo);
  const halo = glow(tex, 0x3566f0, R * 3.4, 0.22);
  group.add(halo);
  group.position.set(-50, 4, -122);
  planet.rotation.set(0.25, 0.8, -0.18);
  return { group, planet, uniforms: planet.material.uniforms };
}

function buildMoon(renderer, r, pos, tint) {
  const tx = bake(renderer, DIR_FROM_UV + /* glsl */ `
    varying vec2 vUv;
    void main(){
      vec3 d = dirFromUv(vUv);
      float n = fbm(d * 3.0) * 0.5 + 0.5;
      float cr = 1.0 - smoothstep(0.0, 0.18, abs(snoise(d * 9.0)));
      vec3 col = mix(vec3(0.36, 0.42, 0.6), vec3(0.74, 0.78, 0.94), n) * (1.0 - cr * 0.25);
      gl_FragColor = vec4(pow(col, vec3(2.2)), 1.0);
    }`, 512, 256);
  const m = new THREE.Mesh(
    new THREE.SphereGeometry(r, 48, 24),
    new THREE.MeshStandardMaterial({ map: tx.texture, color: tint, roughness: 0.95, metalness: 0 })
  );
  m.position.set(...pos);
  return m;
}

function buildDeck() {
  const u = { time: { value: 0 }, boost: { value: 0 }, line: { value: new THREE.Color(0x5b8cf5) }, base: { value: new THREE.Color(0x06163a) } };
  const disk = new THREE.Mesh(
    new THREE.CircleGeometry(17, 96),
    new THREE.ShaderMaterial({
      uniforms: u,
      transparent: true,
      depthWrite: false,
      vertexShader: "varying vec2 vUv; void main(){ vUv = uv; gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0); }",
      fragmentShader: /* glsl */ `
        uniform float time; uniform float boost; uniform vec3 line; uniform vec3 base; varying vec2 vUv;
        void main(){
          vec2 p = vUv - 0.5; float r = length(p) * 2.0; float a = atan(p.y, p.x);
          float f = fract(r * 9.0); float ring = smoothstep(0.05, 0.0, min(f, 1.0 - f));
          float sp = fract(a / 6.2831853 * 32.0); float spoke = smoothstep(0.04, 0.0, min(sp, 1.0 - sp)) * smoothstep(0.3, 0.45, r);
          float pulse = smoothstep(0.06, 0.0, abs(r - fract(time * 0.07)));
          vec3 col = base * (1.1 - r * 0.5);
          float fade = 1.0 - smoothstep(0.72, 1.0, r);
          col += line * (ring * 0.32 + spoke * 0.1) * fade * (1.0 + boost);
          col += line * pulse * (0.45 + boost) * (1.0 - r);
          col += line * smoothstep(0.4, 0.0, r) * (0.18 + boost * 0.3);
          gl_FragColor = vec4(col, smoothstep(1.0, 0.9, r) * 0.96);
          #include <colorspace_fragment>
        }`,
    })
  );
  disk.rotation.x = -Math.PI / 2;
  const rim = new THREE.Mesh(
    new THREE.TorusGeometry(16.6, 0.09, 8, 160),
    new THREE.MeshBasicMaterial({ color: 0x6a9cf5, transparent: true, opacity: 0.75, blending: THREE.AdditiveBlending, depthWrite: false })
  );
  rim.rotation.x = -Math.PI / 2;
  const inner = rim.clone();
  inner.scale.setScalar(0.42);
  const g = new THREE.Group();
  g.add(disk, rim, inner);
  g.position.set(0, -3.2, -6);
  return { group: g, uniforms: u };
}

function brandTexture() {
  const c = document.createElement("canvas");
  c.width = 1024;
  c.height = 300;
  const g = c.getContext("2d");
  g.direction = "rtl";
  g.textAlign = "center";
  g.textBaseline = "middle";
  g.font = '900 190px "Cairo", "IBM Plex Sans Arabic", sans-serif';
  g.shadowColor = "rgba(68,124,245,.95)";
  g.shadowBlur = 40;
  g.fillStyle = "#c9d8ff";
  g.fillText("مدعوم", 512, 160);
  g.shadowBlur = 0;
  g.fillStyle = "#f2f8ff";
  g.fillText("مدعوم", 512, 160);
  const t = new THREE.CanvasTexture(c);
  t.colorSpace = THREE.SRGBColorSpace;
  return t;
}

function holoTexture(seed) {
  const c = document.createElement("canvas");
  c.width = 512;
  c.height = 256;
  const g = c.getContext("2d");
  let s = seed;
  const rnd = () => ((s = (s * 9301 + 49297) % 233280) / 233280);
  g.strokeStyle = "rgba(140,175,255,.9)";
  g.lineWidth = 3;
  g.strokeRect(6, 6, 500, 244);
  g.fillStyle = "rgba(70,110,250,.12)";
  g.fillRect(6, 6, 500, 244);
  g.fillStyle = "rgba(175,200,255,.9)";
  g.fillRect(24, 24, 140, 12);
  g.fillStyle = "rgba(130,165,250,.5)";
  g.fillRect(24, 44, 90, 8);
  for (let i = 0; i < 14; i++) {
    const h = 30 + rnd() * 120;
    g.fillStyle = `rgba(100,140,255,${0.45 + rnd() * 0.4})`;
    g.fillRect(24 + i * 22, 226 - h, 14, h);
  }
  g.beginPath();
  g.strokeStyle = "rgba(108,203,251,.95)";
  g.lineWidth = 3;
  for (let i = 0; i <= 10; i++) {
    const x = 340 + i * 15, y = 200 - rnd() * 110;
    i ? g.lineTo(x, y) : g.moveTo(x, y);
  }
  g.stroke();
  const t = new THREE.CanvasTexture(c);
  t.colorSpace = THREE.SRGBColorSpace;
  return t;
}

function buildStation(cfg, tex) {
  const hull = new THREE.MeshStandardMaterial({ color: 0x1c2f55, metalness: 0.78, roughness: 0.34, envMapIntensity: 2.2 });
  const dark = new THREE.MeshStandardMaterial({ color: 0x0c1832, metalness: 0.6, roughness: 0.5, envMapIntensity: 1.4 });
  const lit = new THREE.MeshBasicMaterial({ color: 0x9cc0ff });
  const litBlue = new THREE.MeshBasicMaterial({ color: 0x447cf5 });

  const g = new THREE.Group();
  const hub = new THREE.Mesh(new THREE.CylinderGeometry(2.6, 2.6, 30, 32), hull);
  g.add(hub);
  const cap = new THREE.Mesh(new THREE.ConeGeometry(2.6, 9, 32), hull);
  cap.position.y = 19.5;
  g.add(cap);
  const mast = new THREE.Mesh(new THREE.CylinderGeometry(0.12, 0.12, 12, 8), dark);
  mast.position.y = 29;
  g.add(mast);
  const tip = glow(tex, 0x6ccbfb, 2.4, 0.9);
  tip.position.y = 35;
  g.add(tip);
  const base = new THREE.Mesh(new THREE.ConeGeometry(2.6, 8, 32), hull);
  base.rotation.x = Math.PI;
  base.position.y = -19;
  g.add(base);

  // bands of lit windows around the hub
  for (const y of [-9, -3, 3, 9]) {
    const band = new THREE.Mesh(new THREE.CylinderGeometry(2.65, 2.65, 0.28, 32, 1, true), y % 2 ? lit : litBlue);
    band.position.y = y;
    g.add(band);
  }

  const rings = [];
  const ringDefs = [[14, 0.55, 4, 0], [10, 0.4, -5, 0.22]];
  for (const [r, tube, y, tilt] of ringDefs) {
    const holder = new THREE.Group();
    holder.position.y = y;
    holder.rotation.z = tilt;
    const ring = new THREE.Group();
    const torus = new THREE.Mesh(new THREE.TorusGeometry(r, tube, 14, 128), hull);
    torus.rotation.x = Math.PI / 2;
    ring.add(torus);
    const edge = new THREE.Mesh(new THREE.TorusGeometry(r + tube * 0.9, 0.06, 6, 160), litBlue);
    edge.rotation.x = Math.PI / 2;
    ring.add(edge);
    for (let k = 0; k < 4; k++) {
      const spoke = new THREE.Mesh(new THREE.CylinderGeometry(0.16, 0.16, r * 2, 8), dark);
      spoke.rotation.z = Math.PI / 2;
      spoke.rotation.y = (k * Math.PI) / 4;
      ring.add(spoke);
    }
    if (cfg.windows) {
      const n = 96;
      const win = new THREE.InstancedMesh(new THREE.BoxGeometry(0.34, 0.2, 0.08), lit, n);
      const m = new THREE.Matrix4(), q = new THREE.Quaternion(), e = new THREE.Euler(), p = new THREE.Vector3(), s = new THREE.Vector3(1, 1, 1);
      for (let i = 0; i < n; i++) {
        const a = (i / n) * Math.PI * 2;
        p.set(Math.cos(a) * (r + tube * 0.95), (i % 2 ? 0.14 : -0.14), Math.sin(a) * (r + tube * 0.95));
        e.set(0, -a + Math.PI / 2, 0);
        q.setFromEuler(e);
        m.compose(p, q, s);
        win.setMatrixAt(i, m);
      }
      ring.add(win);
    }
    holder.add(ring);
    g.add(holder);
    rings.push(ring);
  }

  // habitat modules
  const modGeo = new THREE.BoxGeometry(3.2, 2, 5);
  const stripGeo = new THREE.BoxGeometry(3.26, 0.14, 5.06);
  [[4.6, 10, 0, 0.3], [-4.8, 6, 1.2, -0.4], [4.2, -6, -2, 1.1], [-4.4, -11, 1, 2.2], [0, 14, 4.6, 1.57]].forEach(([x, y, z, ry]) => {
    const mdl = new THREE.Mesh(modGeo, dark);
    mdl.position.set(x, y, z);
    mdl.rotation.y = ry;
    const strip = new THREE.Mesh(stripGeo, lit);
    strip.position.copy(mdl.position);
    strip.rotation.y = ry;
    g.add(mdl, strip);
  });

  // brand sign facing the command deck
  const sign = new THREE.Mesh(
    new THREE.PlaneGeometry(15, 4.4),
    new THREE.MeshBasicMaterial({ map: brandTexture(), transparent: true, blending: THREE.AdditiveBlending, depthWrite: false })
  );
  sign.position.set(-10, 27, 9);
  sign.rotation.y = -0.62;
  g.add(sign);

  const halo = glow(tex, 0x3060e8, 70, 0.14);
  g.add(halo);

  g.position.set(40, 0, -66);
  return {
    group: g,
    sign,
    update(t) {
      rings[0].rotation.y = t * 0.035;
      rings[1].rotation.y = -t * 0.05;
    },
  };
}

function buildTower(tex) {
  const hull = new THREE.MeshStandardMaterial({ color: 0x15254a, metalness: 0.8, roughness: 0.3, envMapIntensity: 2 });
  const lit = new THREE.MeshBasicMaterial({ color: 0x86b4ff });
  const g = new THREE.Group();
  const core = new THREE.Mesh(new THREE.BoxGeometry(3, 38, 3), hull);
  g.add(core);
  for (let i = 0; i < 7; i++) {
    const f = new THREE.Mesh(new THREE.BoxGeometry(4.4, 0.5, 4.4), hull);
    f.position.y = -14 + i * 5;
    g.add(f);
  }
  const strip = new THREE.Mesh(new THREE.BoxGeometry(0.16, 36, 0.16), lit);
  strip.position.set(1.52, 0, 1.52);
  g.add(strip);
  const beacon = glow(tex, 0x6ccbfb, 3, 0.9);
  beacon.position.y = 20;
  g.add(beacon);
  g.position.set(-29, 6, -24);
  return g;
}

function buildCity(tex, count) {
  const hull = new THREE.MeshStandardMaterial({ color: 0x1a2f60, metalness: 0.6, roughness: 0.5, envMapIntensity: 1.5 });
  const geo = new THREE.BoxGeometry(1, 1, 1);
  const inst = new THREE.InstancedMesh(geo, hull, count);
  const m = new THREE.Matrix4();
  const tips = new Float32Array(count * 3);
  for (let i = 0; i < count; i++) {
    const x = -140 + Math.random() * 280, z = -150 - Math.random() * 90;
    const h = 10 + Math.random() * 38, w = 1.5 + Math.random() * 3;
    m.makeScale(w, h, w);
    m.setPosition(x, -24 + h / 2, z);
    inst.setMatrixAt(i, m);
    tips.set([x, -24 + h + 0.6, z], i * 3);
  }
  const tg = new THREE.BufferGeometry();
  tg.setAttribute("position", new THREE.BufferAttribute(tips, 3));
  const tipPts = new THREE.Points(tg, new THREE.PointsMaterial({ map: tex, color: 0x6ccbfb, size: 2.4, transparent: true, depthWrite: false, blending: THREE.AdditiveBlending }));
  const g = new THREE.Group();
  g.add(inst, tipPts);
  return g;
}

function buildPlatforms(tex) {
  const mat = new THREE.MeshStandardMaterial({ color: 0x16284a, metalness: 0.8, roughness: 0.3, envMapIntensity: 2 });
  const rimMat = new THREE.MeshBasicMaterial({ color: 0x5b8cf5, transparent: true, opacity: 0.85, blending: THREE.AdditiveBlending, depthWrite: false });
  const g = new THREE.Group();
  const list = [];
  [[-17, -3.4, -34, 3.2], [19, -3.4, -38, 2.6], [-4, -3.5, -84, 4.2], [30, 2, -50, 2.2], [-36, 5, -62, 2.6]].forEach(([x, y, z, r], i) => {
    const p = new THREE.Group();
    const disk = new THREE.Mesh(new THREE.CylinderGeometry(r, r * 0.8, 0.5, 40), mat);
    const rim = new THREE.Mesh(new THREE.TorusGeometry(r + 0.05, 0.05, 6, 80), rimMat);
    rim.rotation.x = Math.PI / 2;
    rim.position.y = 0.26;
    const under = glow(tex, 0x3f6ff0, r * 3, 0.35);
    under.position.y = -0.6;
    p.add(disk, rim, under);
    p.position.set(x, y, z);
    p.userData = { y, ph: i * 1.7 };
    g.add(p);
    list.push(p);
  });
  return {
    group: g,
    update(t) {
      for (const p of list) p.position.y = p.userData.y + Math.sin(t * 0.4 + p.userData.ph) * 0.35;
    },
  };
}

function buildHolos() {
  const g = new THREE.Group();
  const list = [];
  [[-30, 2, -40, 0.7, 11], [30, 16, -48, -0.8, 23], [50, 5, -84, -0.9, 37], [-40, 14, -70, 0.8, 51], [16, -1, -104, -0.3, 67]].forEach(([x, y, z, ry, seed]) => {
    const m = new THREE.Mesh(
      new THREE.PlaneGeometry(6, 3),
      new THREE.MeshBasicMaterial({ map: holoTexture(seed), transparent: true, opacity: 0.55, blending: THREE.AdditiveBlending, depthWrite: false, side: THREE.DoubleSide })
    );
    m.position.set(x, y, z);
    m.rotation.y = ry;
    m.userData = { y, ph: seed };
    g.add(m);
    list.push(m);
  });
  return {
    group: g,
    update(t) {
      for (const m of list) {
        m.position.y = m.userData.y + Math.sin(t * 0.5 + m.userData.ph) * 0.25;
        m.material.opacity = 0.42 + 0.14 * Math.sin(t * 1.3 + m.userData.ph) + (Math.random() < 0.004 ? -0.3 : 0);
      }
    },
  };
}

function buildShips(tex, n) {
  const hull = new THREE.MeshStandardMaterial({ color: 0x2a3d66, metalness: 0.8, roughness: 0.35, envMapIntensity: 2 });
  const g = new THREE.Group();
  const ships = [];
  for (let i = 0; i < n; i++) {
    const s = new THREE.Group();
    const body = new THREE.Mesh(new THREE.ConeGeometry(0.35, 1.8, 8), hull);
    body.rotation.z = -Math.PI / 2;
    const wing = new THREE.Mesh(new THREE.BoxGeometry(0.7, 0.06, 1.6), hull);
    wing.position.x = -0.2;
    const engine = glow(tex, i % 2 ? 0x6ccbfb : 0x9cb4ff, 1.6, 0.95);
    engine.position.x = -1;
    s.add(body, wing, engine);
    const from = new THREE.Vector3(-160, 8 + Math.random() * 40, -90 - Math.random() * 120);
    const to = new THREE.Vector3(160, from.y + (Math.random() - 0.5) * 20, from.z + (Math.random() - 0.5) * 60);
    if (i % 2) [from.x, to.x] = [to.x, from.x];
    s.userData = { from, to, dur: 45 + Math.random() * 40, off: Math.random() };
    s.lookAt(to);
    s.rotateY(-Math.PI / 2);
    g.add(s);
    ships.push(s);
  }
  return {
    group: g,
    update(t) {
      for (const s of ships) {
        const { from, to, dur, off } = s.userData;
        const k = ((t / dur) + off) % 1;
        s.position.lerpVectors(from, to, k);
      }
    },
  };
}

function buildStreams(n) {
  const g = new THREE.Group();
  const mats = [];
  const targets = [[40, 8, -66], [40, -4, -66], [0, 2, -62], [24, 5, -96], [-26, 0, -88], [-21, 16, -14]];
  for (let i = 0; i < n; i++) {
    const a = (i / n) * Math.PI * 2;
    const start = new THREE.Vector3(Math.cos(a) * 15, -3, -6 + Math.sin(a) * 15);
    const end = new THREE.Vector3(...targets[i % targets.length]);
    const mid = start.clone().lerp(end, 0.5).add(new THREE.Vector3(0, 8 + i * 1.5, 0));
    const curve = new THREE.CatmullRomCurve3([start, mid, end]);
    const mat = new THREE.ShaderMaterial({
      uniforms: { time: { value: 0 }, col: { value: new THREE.Color(i % 2 ? 0x6ccbfb : 0x447cf5) }, speed: { value: 0.25 + (i % 3) * 0.08 } },
      transparent: true,
      depthWrite: false,
      blending: THREE.AdditiveBlending,
      vertexShader: "varying vec2 vUv; void main(){ vUv = uv; gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0); }",
      fragmentShader: /* glsl */ `
        uniform float time; uniform vec3 col; uniform float speed; varying vec2 vUv;
        void main(){
          float d = fract(vUv.x * 5.0 - time * speed);
          float a = smoothstep(0.0, 0.08, d) * smoothstep(0.4, 0.08, d) * 0.85 + 0.06;
          a *= smoothstep(0.0, 0.06, vUv.x) * smoothstep(1.0, 0.92, vUv.x);
          gl_FragColor = vec4(col * a, a);
          #include <colorspace_fragment>
        }`,
    });
    g.add(new THREE.Mesh(new THREE.TubeGeometry(curve, 96, 0.05, 5, false), mat));
    mats.push(mat);
  }
  return { group: g, update(t) { for (const m of mats) m.uniforms.time.value = t; } };
}

function buildDust(n) {
  const pos = new Float32Array(n * 3);
  for (let i = 0; i < n; i++) pos.set([-40 + Math.random() * 80, -3 + Math.random() * 22, -110 + Math.random() * 150], i * 3);
  const g = new THREE.BufferGeometry();
  g.setAttribute("position", new THREE.BufferAttribute(pos, 3));
  const m = new THREE.ShaderMaterial({
    uniforms: { time: { value: 0 }, pr: { value: 1 } },
    transparent: true,
    depthWrite: false,
    blending: THREE.AdditiveBlending,
    vertexShader: /* glsl */ `
      uniform float time; uniform float pr; varying float vA;
      void main(){
        vec3 p = position;
        p.y += sin(time * 0.2 + position.x * 0.3) * 0.6;
        p.x += cos(time * 0.15 + position.z * 0.2) * 0.6;
        vec4 mv = modelViewMatrix * vec4(p, 1.0);
        gl_PointSize = pr * 26.0 / -mv.z;
        vA = smoothstep(80.0, 6.0, -mv.z) * smoothstep(0.5, 3.0, -mv.z);
        gl_Position = projectionMatrix * mv;
      }`,
    fragmentShader: /* glsl */ `
      varying float vA;
      void main(){
        float d = length(gl_PointCoord - 0.5);
        float a = smoothstep(0.5, 0.0, d) * vA * 0.55;
        gl_FragColor = vec4(vec3(0.62, 0.74, 1.0) * a, a);
      }`,
  });
  const p = new THREE.Points(g, m);
  p.frustumCulled = false;
  return { points: p, uniforms: m.uniforms };
}

function buildCore(tex) {
  const g = new THREE.Group();
  const u = { time: { value: 0 }, energy: { value: 0.4 } };
  const orb = new THREE.Mesh(
    new THREE.SphereGeometry(2.2, 64, 32),
    new THREE.ShaderMaterial({
      uniforms: u,
      vertexShader: "varying vec3 vN; varying vec3 vP; varying vec3 vV; void main(){ vN = normalize(normalMatrix * normal); vP = position; vec4 mv = modelViewMatrix * vec4(position, 1.0); vV = normalize(-mv.xyz); gl_Position = projectionMatrix * mv; }",
      fragmentShader: NOISE + /* glsl */ `
        uniform float time; uniform float energy; varying vec3 vN; varying vec3 vP; varying vec3 vV;
        void main(){
          float ndv = max(dot(normalize(vN), normalize(vV)), 0.0);
          float nz = snoise(vP * 1.3 + vec3(0.0, time * 0.5, time * 0.3)) * 0.5 + 0.5;
          vec3 col = mix(vec3(0.14, 0.3, 1.0), vec3(0.55, 0.8, 1.0), nz) * (0.35 + pow(1.0 - ndv, 2.0) * 1.3);
          col += vec3(0.9, 0.94, 1.0) * pow(ndv, 5.0) * (0.45 + energy * 0.5);
          gl_FragColor = vec4(col * (0.8 + energy * 0.5), 1.0);
          #include <colorspace_fragment>
        }`,
    })
  );
  g.add(orb);
  const shell = new THREE.LineSegments(
    new THREE.EdgesGeometry(new THREE.IcosahedronGeometry(2.9, 1)),
    new THREE.LineBasicMaterial({ color: 0x5a86ff, transparent: true, opacity: 0.5, blending: THREE.AdditiveBlending, depthWrite: false })
  );
  g.add(shell);
  const rings = [];
  [[3.4, 0.4, 0.2], [4.1, -0.6, 1.1], [4.8, 1.2, -0.4]].forEach(([r, rx, rz], i) => {
    const ring = new THREE.Mesh(
      new THREE.TorusGeometry(r, 0.035, 6, 160),
      new THREE.MeshBasicMaterial({ color: i === 1 ? 0x8a87e2 : 0x6ccbfb, transparent: true, opacity: 0.65, blending: THREE.AdditiveBlending, depthWrite: false })
    );
    ring.rotation.set(rx, 0, rz);
    g.add(ring);
    rings.push(ring);
  });
  g.add(glow(tex, 0x447cf5, 13, 0.6));
  g.add(glow(tex, 0xc2dcff, 5.5, 0.85));
  const n = 360, pos = new Float32Array(n * 3);
  for (let i = 0; i < n; i++) {
    const u2 = Math.random() * 2 - 1, th = Math.random() * 6.283, r = 3.2 + Math.random() * 2.8, s = Math.sqrt(1 - u2 * u2);
    pos.set([Math.cos(th) * s * r, u2 * r, Math.sin(th) * s * r], i * 3);
  }
  const pg = new THREE.BufferGeometry();
  pg.setAttribute("position", new THREE.BufferAttribute(pos, 3));
  const motes = new THREE.Points(pg, new THREE.PointsMaterial({ map: tex, color: 0xa5c4ff, size: 0.35, transparent: true, depthWrite: false, blending: THREE.AdditiveBlending }));
  g.add(motes);
  const light = new THREE.PointLight(0x447cf5, 40, 40, 2);
  g.add(light);
  g.position.set(0, 2, -62);
  return {
    group: g,
    uniforms: u,
    update(t, energy) {
      u.time.value = t;
      u.energy.value = energy;
      shell.rotation.y = t * 0.12;
      shell.rotation.x = t * 0.05;
      rings.forEach((r, i) => { r.rotation.y = t * (0.2 + i * 0.12) * (i % 2 ? -1 : 1); });
      motes.rotation.y = -t * 0.06;
      orb.scale.setScalar(1 + Math.sin(t * 2) * 0.03 * (0.5 + energy));
      light.intensity = 30 + energy * 40;
    },
  };
}

function buildNetwork(tex) {
  const g = new THREE.Group();
  const cols = [[6, 0], [2, -3], [2, 3], [-2, -5], [-2, 0], [-2, 5], [-6, -3], [-6, 3], [-10, 0]];
  const nodes = cols.map(([x, y], i) => new THREE.Vector3(x * 1.2, y * 0.9, Math.sin(i * 1.7) * 2));
  const edges = [[0, 1], [0, 2], [1, 3], [1, 4], [2, 4], [2, 5], [3, 6], [4, 6], [4, 7], [5, 7], [6, 8], [7, 8]];
  const gem = new THREE.InstancedMesh(new THREE.IcosahedronGeometry(0.42, 1), new THREE.MeshBasicMaterial({ color: 0xa5c4ff }), nodes.length);
  const m = new THREE.Matrix4();
  nodes.forEach((p, i) => { m.makeTranslation(p.x, p.y, p.z); gem.setMatrixAt(i, m); });
  g.add(gem);
  const lp = new Float32Array(edges.length * 6);
  edges.forEach(([a, b], i) => lp.set([...nodes[a].toArray(), ...nodes[b].toArray()], i * 6));
  const lg = new THREE.BufferGeometry();
  lg.setAttribute("position", new THREE.BufferAttribute(lp, 3));
  g.add(new THREE.LineSegments(lg, new THREE.LineBasicMaterial({ color: 0x447cf5, transparent: true, opacity: 0.55, blending: THREE.AdditiveBlending, depthWrite: false })));
  const pulses = new THREE.Group();
  const pl = edges.map(() => {
    const s = glow(tex, 0xc2dcff, 1.1, 0.95);
    pulses.add(s);
    return s;
  });
  g.add(pulses);
  nodes.forEach(p => {
    const s = glow(tex, 0x447cf5, 2.6, 0.45);
    s.position.copy(p);
    g.add(s);
  });
  g.position.set(24, 5, -97);
  g.rotation.y = -0.35;
  return {
    group: g,
    update(t) {
      edges.forEach(([a, b], i) => {
        const k = (t * 0.35 + i * 0.37) % 1;
        pl[i].position.lerpVectors(nodes[a], nodes[b], k);
      });
    },
  };
}

function buildBars(tex) {
  const g = new THREE.Group();
  const nx = 8, nz = 5, n = nx * nz;
  const bars = new THREE.InstancedMesh(
    new THREE.BoxGeometry(0.7, 1, 0.7),
    new THREE.MeshBasicMaterial({ color: 0x3f6ff0, transparent: true, opacity: 0.55, blending: THREE.AdditiveBlending, depthWrite: false }),
    n
  );
  g.add(bars);
  const grid = new THREE.GridHelper(14, 14, 0x3a5fc0, 0x1c2f66);
  grid.material.transparent = true;
  grid.material.opacity = 0.5;
  g.add(grid);
  const ring = new THREE.Mesh(new THREE.TorusGeometry(8.5, 0.05, 6, 120), new THREE.MeshBasicMaterial({ color: 0x6ccbfb, transparent: true, opacity: 0.6, blending: THREE.AdditiveBlending, depthWrite: false }));
  ring.rotation.x = Math.PI / 2;
  g.add(ring);
  g.add(glow(tex, 0x3a64e0, 26, 0.25));
  g.position.set(-26, -1, -88);
  const m = new THREE.Matrix4();
  return {
    group: g,
    update(t) {
      for (let i = 0; i < n; i++) {
        const x = (i % nx) - nx / 2 + 0.5, z = Math.floor(i / nx) - nz / 2 + 0.5;
        const h = 1 + 3.5 * (0.5 + 0.5 * Math.sin(t * 0.6 + x * 0.7 + z * 1.3)) * (1 - Math.abs(z) * 0.18);
        m.makeScale(1, h, 1);
        m.setPosition(x * 1.2, h / 2, z * 1.2);
        bars.setMatrixAt(i, m);
      }
      bars.instanceMatrix.needsUpdate = true;
    },
  };
}

function buildWarp() {
  const n = 320, pos = new Float32Array(n * 6), end = new Float32Array(n * 2);
  for (let i = 0; i < n; i++) {
    const a = Math.random() * 6.283, r = 1.5 + Math.random() * 7, z = -5 - Math.random() * 70;
    const x = Math.cos(a) * r, y = Math.sin(a) * r;
    pos.set([x, y, z, x, y, z], i * 6);
    end.set([0, 1], i * 2);
  }
  const g = new THREE.BufferGeometry();
  g.setAttribute("position", new THREE.BufferAttribute(pos, 3));
  g.setAttribute("tail", new THREE.BufferAttribute(end, 1));
  const m = new THREE.ShaderMaterial({
    uniforms: { w: { value: 0 }, time: { value: 0 } },
    transparent: true,
    depthWrite: false,
    depthTest: false,
    blending: THREE.AdditiveBlending,
    vertexShader: /* glsl */ `
      attribute float tail; uniform float w; uniform float time; varying float vA;
      void main(){
        vec3 p = position;
        p.z = mod(p.z + time * 60.0 * w, 75.0) - 78.0;
        p.z += tail * w * 9.0;
        vA = w * (1.0 - tail * 0.9) * smoothstep(-78.0, -40.0, p.z);
        gl_Position = projectionMatrix * modelViewMatrix * vec4(p, 1.0);
      }`,
    fragmentShader: "varying float vA; void main(){ gl_FragColor = vec4(vec3(0.62, 0.76, 1.0) * vA, vA); }",
  });
  const lines = new THREE.LineSegments(g, m);
  lines.frustumCulled = false;
  lines.renderOrder = 10;
  return { lines, uniforms: m.uniforms };
}

/* ── camera path evaluation (Catmull-Rom through keys) ──────────────── */
function cr(p0, p1, p2, p3, t) {
  const t2 = t * t, t3 = t2 * t;
  return 0.5 * (2 * p1 + (-p0 + p2) * t + (2 * p0 - 5 * p1 + 4 * p2 - p3) * t2 + (-p0 + 3 * p1 - 3 * p2 + p3) * t3);
}
function evalPath(c, outPos, outTgt) {
  const n = KEYS.length;
  let i = 0;
  while (i < n - 2 && c > KEYS[i + 1].c) i++;
  const k0 = KEYS[Math.max(0, i - 1)], k1 = KEYS[i], k2 = KEYS[Math.min(n - 1, i + 1)], k3 = KEYS[Math.min(n - 1, i + 2)];
  let t = clamp((c - k1.c) / (k2.c - k1.c || 1));
  // velocity is zero at hold keys and continuous (≈1) through the others
  if (k1.hold && k2.hold) t = smooth(t);
  else if (k1.hold) t = t * t * (2 - t); // leave a rest
  else if (k2.hold) t = t + t * t - t * t * t; // arrive at a rest
  for (let a = 0; a < 3; a++) {
    outPos.setComponent(a, cr(k0.pos[a], k1.pos[a], k2.pos[a], k3.pos[a], t));
    outTgt.setComponent(a, cr(k0.tgt[a], k1.tgt[a], k2.tgt[a], k3.tgt[a], t));
  }
  return k1.fov + (k2.fov - k1.fov) * t;
}

/* ── the world ───────────────────────────────────────────────────────── */
export async function createWorld(canvas, { tier = "high" } = {}) {
  const cfg = TIERS[tier] || TIERS.mid;
  let renderer;
  try {
    renderer = new THREE.WebGLRenderer({ canvas, antialias: cfg.aa, alpha: false, powerPreference: "high-performance", stencil: false });
  } catch (e) {
    throw new Error("webgl-unavailable");
  }
  let dpr = Math.min(window.devicePixelRatio || 1, cfg.dpr);
  renderer.setPixelRatio(dpr);
  renderer.setSize(innerWidth, innerHeight, false);
  renderer.setClearColor(0x010f28, 1);
  renderer.outputColorSpace = THREE.SRGBColorSpace;

  if (document.fonts && document.fonts.load) {
    await Promise.race([document.fonts.load('900 190px "Cairo"'), new Promise(r => setTimeout(r, 1200))]).catch(() => {});
  }

  const scene = new THREE.Scene();
  const camera = new THREE.PerspectiveCamera(52, innerWidth / innerHeight, 0.1, 2000);
  scene.add(camera);
  const tex = glowTexture();

  const cube = buildNebula(renderer, cfg.cube);
  scene.background = cube.texture;
  scene.environment = cube.texture;
  scene.fog = new THREE.FogExp2(0x0b1f4c, 0.006); // far structures dissolve into the navy haze, as in the reference

  scene.add(new THREE.HemisphereLight(0x4a6fe0, 0x061430, 1.1));
  const sun = new THREE.DirectionalLight(0xdfe6ff, 2.4);
  sun.position.copy(SUN).multiplyScalar(100);
  scene.add(sun);
  const deckLight = new THREE.PointLight(0x447cf5, 60, 60, 2);
  deckLight.position.set(0, 3, 2);
  scene.add(deckLight);

  const stars = buildStars(cfg.stars);
  scene.add(stars);
  const planet = buildPlanet(renderer, cfg.planetSeg, tex);
  scene.add(planet.group);
  scene.add(buildMoon(renderer, 5.2, [30, 57, -134], 0xc9d6f0));
  scene.add(buildMoon(renderer, 2.6, [66, 44, -250], 0xa8b8e0));
  const deck = buildDeck();
  scene.add(deck.group);
  const station = buildStation(cfg, tex);
  scene.add(station.group);
  scene.add(buildTower(tex));
  const core = buildCore(tex);
  scene.add(core.group);
  const platforms = buildPlatforms(tex);
  scene.add(platforms.group);

  const updaters = [station.update, platforms.update];
  // chapter-bound objects appear only when their scene (or the wide reveal) is on screen
  const bound = [{ obj: core.group, spans: [[2.3, 2.7, 3.6, 4.0], [5.4, 6.0, 8.8, 9.4]] }];
  if (tier !== "low") {
    scene.add(buildCity(tex, tier === "high" ? 46 : 26));
    const holos = buildHolos();
    scene.add(holos.group);
    updaters.push(holos.update);
    bound.push({ obj: holos.group, fixed: true, spans: [[-9, -8, 1.2, 1.45], [5.4, 6.0, 99, 100]] });
  }
  const ships = buildShips(tex, cfg.ships);
  scene.add(ships.group);
  updaters.push(ships.update);
  if (cfg.streams) {
    const streams = buildStreams(cfg.streams);
    scene.add(streams.group);
    updaters.push(streams.update);
  }
  let dust = null;
  if (cfg.dust) {
    dust = buildDust(cfg.dust);
    scene.add(dust.points);
  }
  if (cfg.net) {
    const net = buildNetwork(tex);
    scene.add(net.group);
    updaters.push(net.update);
    bound.push({ obj: net.group, spans: [[5.4, 6.0, 8.8, 9.4]] });
  }
  if (cfg.bars) {
    const bars = buildBars(tex);
    scene.add(bars.group);
    updaters.push(bars.update);
    bound.push({ obj: bars.group, spans: [[5.4, 6.0, 8.8, 9.4]] });
  }
  const warp = buildWarp();
  camera.add(warp.lines);

  const pos = new THREE.Vector3(), tgt = new THREE.Vector3();
  const right = new THREE.Vector3(), up = new THREE.Vector3(0, 1, 0);
  let t = 0;
  let acc = 0;
  let lastC = -1;
  let dirty = true;
  const frameTimes = [];

  function setPR() {
    stars.material.uniforms.pr.value = dpr;
    if (dust) dust.uniforms.pr.value = dpr * (innerHeight / 900);
  }
  setPR();

  let lastW = innerWidth, lastH = innerHeight;
  function resize(force) {
    const w = innerWidth, h = innerHeight;
    // mobile URL bars change height constantly: ignore small height-only changes
    if (!force && w === lastW && Math.abs(h - lastH) < 120) return;
    lastW = w;
    lastH = h;
    camera.aspect = w / h;
    camera.updateProjectionMatrix();
    renderer.setSize(w, h, false);
    setPR();
    dirty = true;
  }
  addEventListener("resize", () => resize(false));

  function adapt(dt) {
    if (tier === "static" || tier === "low") return;
    frameTimes.push(dt);
    if (frameTimes.length < 90) return;
    const avg = frameTimes.reduce((a, b) => a + b, 0) / frameTimes.length;
    frameTimes.length = 0;
    if (avg > 0.024 && dpr > 1) {
      dpr = Math.max(1, dpr - 0.25);
      renderer.setPixelRatio(dpr);
      renderer.setSize(innerWidth, innerHeight, false);
      setPR();
    }
  }

  function frame(dt, s) {
    const c = s.c;
    if (tier === "static") {
      if (!dirty && Math.abs(c - lastC) < 0.002) return;
    } else if (cfg.fps < 60) {
      acc += dt;
      if (acc < 1 / cfg.fps) return;
      dt = acc;
      acc = 0;
    }
    lastC = c;
    dirty = false;
    if (tier !== "static") t += Math.min(dt, 0.1);

    // camera
    const fov = evalPath(c, pos, tgt);
    right.subVectors(tgt, pos).cross(up).normalize();
    const drift = tier === "static" ? 0 : 1;
    pos.addScaledVector(right, s.mx * 0.8 + Math.sin(t * 0.13) * 0.22 * drift);
    pos.y += -s.my * 0.45 + Math.sin(t * 0.21) * 0.12 * drift;
    tgt.addScaledVector(right, s.mx * 0.3);
    tgt.y += -s.my * 0.2;
    const w = s.warp || 0;
    if (w > 0.01) {
      pos.x += (Math.sin(t * 47) + Math.sin(t * 31)) * 0.03 * w;
      pos.y += (Math.sin(t * 53) + Math.cos(t * 29)) * 0.03 * w;
    }
    camera.position.copy(pos);
    camera.lookAt(tgt);
    camera.fov = fov + w * 6;
    camera.updateProjectionMatrix();

    stars.position.copy(camera.position);
    stars.material.uniforms.time.value = t;
    planet.uniforms.time.value = t;
    planet.group.children[0].rotation.y = 0.8 + t * 0.004;
    deck.uniforms.time.value = t;
    deck.uniforms.boost.value = clamp((c - 9.3) / 0.7) * 1.2 + clamp(1 - Math.abs(c - 1.3) / 0.4) * 0.6;
    for (const b of bound) {
      let v = 0;
      for (const [a0, a1, b0, b1] of b.spans) v = Math.max(v, clamp((c - a0) / (a1 - a0)) * (1 - clamp((c - b0) / (b1 - b0))));
      b.obj.visible = v > 0.01;
      if (b.obj.visible && !b.fixed) b.obj.scale.setScalar(0.35 + 0.65 * smooth(v));
    }
    const energy = clamp(1 - Math.abs(c - 3) / 0.9);
    core.update(t, 0.35 + energy * 0.9);
    for (const u of updaters) u(t);
    if (dust) dust.uniforms.time.value = t;
    warp.uniforms.w.value = w;
    warp.uniforms.time.value = t;
    deckLight.position.set(s.mx * 6, 3 - s.my, 2);

    renderer.render(scene, camera);
    adapt(dt);
  }

  // first frame before the canvas fades in
  frame(0.016, { c: 0, mx: 0, my: 0, warp: 0 });

  return {
    frame,
    resize,
    invalidate() { dirty = true; },
    dispose() {
      renderer.dispose();
    },
  };
}
