/* =====================================================================
   Mad3oom orbital — the journey
   ---------------------------------------------------------------------
   يحوّل التمرير إلى قيمة واحدة: «الفصل» c (من 0 إلى 10). كل شيء في
   الصفحة يُشتق منها: الكاميرا ثلاثية الأبعاد، المشاهد المثبّتة، دخول
   اللوحة، رحلة القنوات، إضاءة مراحل SIE، رسم مسارات الأتمتة.

   التمرير نفسه يبقى أصليًا (لا اختطاف لعجلة الفأرة، لا كسر للوحة
   المفاتيح أو قارئات الشاشة). النعومة السينمائية تأتي من تخميد c نحو
   هدفه، لا من التحكم بالتمرير.

     0 المحطة · 1 المحادثات · 2 القنوات · 3 SIE · 4 الأتمتة
     5 التحليلات · 6 الأنظمة · 7 الأسعار · 8 الاتصالات · 9 الأسئلة · 10 الانطلاق
   ===================================================================== */

const clamp = (v, a = 0, b = 1) => Math.min(b, Math.max(a, v));
const lerp = (a, b, t) => a + (b - a) * t;
const smooth = (a, b, v) => {
  const t = clamp((v - a) / (b - a));
  return t * t * (3 - 2 * t);
};

/* Scroll length, in viewport heights, between stage chapters 0→1→…→5.
   The channel fly-through gets the longest run: it has four stops. */
const WEIGHTS = [1.1, 1.4, 2.0, 1.5, 1.3];
const HOLD = 0.7; // analytics stays pinned a little before the stage releases

/* [fade-in start, fade-in end, fade-out start, fade-out end] on c */
const WINDOWS = [
  [null, null, 0.2, 0.55],
  [0.55, 0.85, 1.2, 1.42],
  [1.55, 1.8, 2.55, 2.75],
  [2.7, 2.95, 3.55, 3.75],
  [3.7, 3.95, 4.55, 4.75],
  [4.7, 4.95, null, null],
];

/* how dark the world gets behind reading-heavy sections */
const DIM = [[0, 0], [1.3, 0], [2.6, 0.05], [3, 0.12], [4, 0.16], [4.8, 0.3], [5.6, 0.3], [6, 0.32], [6.7, 0.5], [7, 0.62], [8, 0.5], [9, 0.58], [9.5, 0.22], [10, 0.08]];

const POD_GAP = 1150;
const NODE_START = [0, 0.18, 0.36, 0.56, 0.56, 0.78, 0.78];
const WIRES = [[0, 1], [1, 2], [2, 3], [2, 4], [3, 5], [4, 6]];

function piecewise(keys, x) {
  if (x <= keys[0][0]) return keys[0][1];
  for (let i = 1; i < keys.length; i++) {
    if (x <= keys[i][0]) {
      const [x0, y0] = keys[i - 1], [x1, y1] = keys[i];
      return lerp(y0, y1, (x - x0) / (x1 - x0));
    }
  }
  return keys[keys.length - 1][1];
}

function offsetWithin(el, ancestor) {
  let x = 0, y = 0, n = el;
  while (n && n !== ancestor) {
    x += n.offsetLeft;
    y += n.offsetTop;
    n = n.offsetParent;
  }
  return { x, y, w: el.offsetWidth, h: el.offsetHeight };
}

export function createJourney({ tier = "high", onDashActive = () => {} } = {}) {
  const root = document.documentElement;
  const $ = s => document.querySelector(s);
  const $$ = s => Array.from(document.querySelectorAll(s));
  const reduce = window.matchMedia("(prefers-reduced-motion: reduce)").matches;

  const journey = $("#journey");
  const stage = $("#stage");
  const scenes = $$(".scene").sort((a, b) => a.dataset.scene - b.dataset.scene);
  const heroCopy = $("#heroCopy");
  const slots = $$(".holo-slot");
  const robot = $("#robot");
  const chips = $(".stat-chips");
  const dashRig = $("#dashRig");
  const dash = $("#dash");
  const callouts = $$("[data-callout]");
  const warpEl = $("#warp");
  const tunnel = $("#tunnel");
  const pods = $$(".pod");
  const chanItems = $$(".chan-rail__item");
  const sieBoard = $("#sieBoard");
  const sieSteps = $$(".sie-step");
  const sieFlows = $("#sieFlows");
  const readout = $("#coreReadout");
  const flowboard = $("#flowboard");
  const nodes = $$(".node");
  const wiresSvg = $("#wires");
  const cmd = $("#cmd");
  const hud = $("#hud");
  const hudItems = $$(".hud__item");
  const navLinks = $$(".nav__link[data-nav]");
  const nav = $("#nav");
  const env = $(".env");
  const dimEl = $(".env-dim");

  // remember authored inline styles so a mode switch can restore them
  const animated = [...scenes, heroCopy, ...slots, robot, chips, dashRig, dash, ...callouts, warpEl, tunnel, ...pods,
    sieBoard, ...sieSteps, flowboard, ...nodes, cmd, stage].filter(Boolean);
  const authored = new Map(animated.map(n => [n, n.getAttribute("style")]));

  const state = { c: 0, target: 0, mx: 0, my: 0, tmx: 0, tmy: 0, warp: 0, vel: 0 };
  let mode = root.classList.contains("mode-cinema") ? "cinema" : "flow";
  let vw = innerWidth, vh = innerHeight;
  let anchors = [];
  let dashBase = 1;
  let boardScale = 1;
  let last = { c: -1, mx: 9, my: 9 };
  let dashOn = null;
  let wirePaths = [];
  let flowPaths = [];
  let docH = 0;

  /* ── layout ───────────────────────────────────────────────────────── */
  function setMode(next) {
    if (next === mode) return;
    root.classList.remove("mode-cinema", "mode-flow");
    root.classList.add("mode-" + next);
    mode = next;
    for (const [n, s] of authored) s == null ? n.removeAttribute("style") : n.setAttribute("style", s);
    scenes.forEach(s => s.classList.toggle("is-live", next === "flow"));
    last.c = -1;
    if (next === "flow") primeFlow();
  }

  function sectionTop(el) {
    return el.getBoundingClientRect().top + scrollY;
  }

  function layout() {
    vw = innerWidth;
    vh = innerHeight;
    setMode(!reduce && vw >= 900 ? "cinema" : "flow");

    if (mode === "cinema") {
      const L = WEIGHTS.reduce((a, b) => a + b, 0);
      journey.style.height = Math.round((L + HOLD + 1) * vh) + "px";
    } else {
      journey.style.height = "";
    }

    const top = sectionTop(journey);
    anchors = [];
    if (mode === "cinema") {
      let acc = 0;
      anchors.push(top);
      for (const w of WEIGHTS) {
        acc += w;
        anchors.push(top + acc * vh);
      }
    } else {
      for (const s of scenes) anchors.push(Math.max(0, sectionTop(s) + s.offsetHeight / 2 - vh / 2));
      anchors[0] = 0;
    }
    docH = document.documentElement.scrollHeight;
    const maxY = Math.max(0, docH - vh);
    for (const k of [6, 7, 8, 9, 10]) {
      const el = document.querySelector(`[data-chapter-anchor="${k}"]`);
      const h = el ? el.offsetHeight : vh;
      // tall sections anchor at their top third; short ones at their center
      let a = el ? sectionTop(el) + Math.min(h / 2, vh * 0.35) - vh * 0.35 : maxY;
      if (k === 10 && el) a = sectionTop(el) + h / 2 - vh / 2;
      anchors[k] = Math.min(maxY, a);
    }
    for (let k = 1; k < anchors.length; k++) anchors[k] = Math.max(anchors[k], anchors[k - 1] + 1);

    dashBase = Math.min((0.86 * vw) / 1200, (0.68 * vh) / 660);
    boardScale = Math.min(1, (0.94 * vw) / 1180, (0.6 * vh) / 460);
    drawSieFlows();
    drawWires();
    last.c = -1;
  }

  function scrollToChapterC(y) {
    if (y <= anchors[0]) return 0;
    for (let k = 1; k < anchors.length; k++) {
      if (y < anchors[k]) return k - 1 + (y - anchors[k - 1]) / (anchors[k] - anchors[k - 1]);
    }
    return anchors.length - 1;
  }

  /* ── SVG connectors (computed from real element geometry) ──────────── */
  function drawSieFlows() {
    if (!sieFlows || !sieBoard) return;
    sieFlows.innerHTML = "";
    flowPaths = [];
    if (mode !== "cinema") return;
    const W = sieBoard.offsetWidth, H = sieBoard.offsetHeight;
    sieFlows.setAttribute("viewBox", `0 0 ${W} ${H}`);
    const core = sieBoard.querySelector(".sie__core");
    const cr = offsetWithin(core, sieBoard);
    const cx = cr.x + cr.w / 2, cy = cr.y + cr.h / 2, rr = cr.w * 0.3;
    sieSteps.forEach((st, i) => {
      const r = offsetWithin(st, sieBoard);
      const isIn = i < 3;
      // RTL: inputs sit to the right of the core, outputs to the left
      const sx = isIn ? r.x : r.x + r.w;
      const sy = r.y + r.h / 2;
      const ex = isIn ? cx + rr : cx - rr;
      const mid = (sx + ex) / 2;
      const d = isIn
        ? `M${sx} ${sy} C ${mid} ${sy}, ${mid} ${cy}, ${ex} ${cy}`
        : `M${ex} ${cy} C ${mid} ${cy}, ${mid} ${sy}, ${sx} ${sy}`;
      const base = document.createElementNS("http://www.w3.org/2000/svg", "path");
      base.setAttribute("d", d);
      base.setAttribute("class", "flow");
      const live = base.cloneNode();
      live.setAttribute("class", "flow flow--live");
      sieFlows.append(base, live);
      flowPaths.push(live);
    });
  }

  function drawWires() {
    if (!wiresSvg || !flowboard) return;
    wiresSvg.innerHTML = "";
    wirePaths = [];
    if (mode !== "cinema") return;
    const NS = "http://www.w3.org/2000/svg";
    WIRES.forEach(([a, b], i) => {
      const A = offsetWithin(nodes[a], flowboard), B = offsetWithin(nodes[b], flowboard);
      // flow runs right → left (RTL): leave A's left edge, enter B's right edge
      const sx = A.x, sy = A.y + A.h / 2, ex = B.x + B.w, ey = B.y + B.h / 2;
      const mid = (sx + ex) / 2;
      const d = `M${sx} ${sy} C ${mid} ${sy}, ${mid} ${ey}, ${ex} ${ey}`;
      const base = document.createElementNS(NS, "path");
      base.setAttribute("d", d);
      base.setAttribute("class", "wire");
      const draw = document.createElementNS(NS, "path");
      draw.setAttribute("d", d);
      draw.setAttribute("id", "wire-" + i);
      draw.setAttribute("class", "wire wire--draw");
      draw.setAttribute("pathLength", "1");
      draw.setAttribute("stroke-dasharray", "1 1");
      draw.setAttribute("stroke-dashoffset", "1");
      const pulse = document.createElementNS(NS, "circle");
      pulse.setAttribute("r", "3.5");
      pulse.setAttribute("class", "wire-pulse");
      pulse.setAttribute("opacity", "0");
      if (!reduce) {
        const mo = document.createElementNS(NS, "animateMotion");
        mo.setAttribute("dur", (2.2 + (i % 3) * 0.4) + "s");
        mo.setAttribute("repeatCount", "indefinite");
        mo.setAttribute("path", d);
        pulse.appendChild(mo);
      }
      wiresSvg.append(base, draw, pulse);
      wirePaths.push({ draw, pulse });
    });
  }

  /* ── per-frame application ─────────────────────────────────────────── */
  function applyCinema(c, mx, my) {
    // scenes: depth fade in from ahead, fly past the camera on exit
    scenes.forEach((s, k) => {
      const [a0, a1, b0, b1] = WINDOWS[k];
      const vin = a0 == null ? 1 : smooth(a0, a1, c);
      const vout = b0 == null ? 0 : smooth(b0, b1, c);
      const op = vin * (1 - vout);
      const z = (1 - vin) * -380 + vout * 240;
      s.style.opacity = op.toFixed(3);
      s.style.transform = `translate3d(${(-mx * 6).toFixed(1)}px, ${(-my * 4).toFixed(1)}px, ${z.toFixed(1)}px)`;
      const live = op > 0.004;
      if (live !== s.classList.contains("is-live")) s.classList.toggle("is-live", live);
    });

    // hero composition
    const out = smooth(0.02, 0.8, c);
    if (heroCopy) {
      heroCopy.style.transform = `translate(-50%, ${(-c * 90).toFixed(1)}px) scale(${(1 - Math.min(c, 1) * 0.06).toFixed(4)})`;
    }
    for (const slot of slots) {
      const d = +slot.dataset.depth || 0.8;
      const side = slot.dataset.side === "l" ? -1 : 1;
      const tx = side * out * 420 * d + mx * 26 * d;
      const ty = my * 16 * d - out * 40 * d;
      const tz = out * 700 * d;
      slot.style.transform = `translate3d(${tx.toFixed(1)}px, ${ty.toFixed(1)}px, ${tz.toFixed(1)}px)`;
    }
    if (robot) robot.style.transform = `translate3d(${(-out * 320 + mx * 20).toFixed(1)}px, ${(out * 140 + my * 10).toFixed(1)}px, 0) scale(${(1 + out * 0.4).toFixed(3)})`;
    if (chips) chips.style.transform = `translate3d(${(out * 380 + mx * 18).toFixed(1)}px, ${(my * 10).toFixed(1)}px, 0) rotateY(-16deg)`;

    // the dashboard: approach, focus, then the camera goes through it
    if (dashRig) {
      const p = smooth(0, 1, c);
      const e = smooth(1.2, 1.55, c);
      const s0 = dashBase * 0.84, s1 = dashBase;
      const scale = lerp(s0, s1, p) * (1 + e * 1.5);
      const cy0 = 0.585 * vh + 330 * s0 - vh / 2;
      const cy1 = 0.1 * vh;
      const ty = lerp(cy0, cy1, p) * (1 - e);
      const rx = lerp(9, 0, p) - my * 2.2 * (1 - e);
      const ry = mx * 3.2 * (1 - e);
      const op = 1 - smooth(1.24, 1.44, c);
      dashRig.style.transform = `translate3d(${(-mx * 10).toFixed(1)}px, ${ty.toFixed(1)}px, 0) rotateX(${rx.toFixed(2)}deg) rotateY(${ry.toFixed(2)}deg) scale(${scale.toFixed(4)})`;
      dashRig.style.opacity = op.toFixed(3);
      dashRig.style.visibility = op < 0.004 ? "hidden" : "visible";
      dash.style.setProperty("--curve", (lerp(18, 5, p) * (1 - e)).toFixed(2) + "deg");
      dash.style.setProperty("--focus-blur", (lerp(0.6, 0, smooth(0, 0.7, c)) + e * 5).toFixed(2) + "px");
      const co = smooth(0.72, 0.95, c) * (1 - smooth(1.12, 1.3, c));
      for (const k of callouts) k.style.setProperty("--co", co.toFixed(3));
    }
    const w = clamp(1 - Math.abs(c - 1.5) / 0.22);
    state.warp = w;
    if (warpEl) warpEl.style.setProperty("--w", (w * 0.85).toFixed(3));

    // channel fly-through: the camera travels along the pods
    if (tunnel && c > 1.4 && c < 2.9) {
      const u = clamp((c - 1.62) / (2.6 - 1.62));
      const camZ = lerp(-700, 3 * POD_GAP + 550, u);
      tunnel.style.transform = `rotateY(${(mx * 5).toFixed(2)}deg) rotateX(${(-my * 3).toFixed(2)}deg)`;
      let best = 0, bestD = 1e9;
      pods.forEach((pod, i) => {
        const rel = camZ - i * POD_GAP;
        if (Math.abs(rel) < bestD) { bestD = Math.abs(rel); best = i; }
        const x = (i % 2 === 0 ? 1 : -1) * 230;
        const op = smooth(-2800, -1500, rel) * (1 - smooth(160, 640, rel));
        const blur = tier === "high" ? Math.min(5, Math.max(0, Math.abs(rel) - 260) / 240) : 0;
        pod.style.transform = `translate3d(${x}px, -10px, ${rel.toFixed(0)}px) rotateY(${(i % 2 === 0 ? -9 : 9)}deg)`;
        pod.style.opacity = op.toFixed(3);
        pod.style.filter = blur > 0.25 ? `blur(${blur.toFixed(1)}px)` : "none";
        pod.style.visibility = op < 0.004 ? "hidden" : "visible";
      });
      chanItems.forEach((it, i) => it.classList.toggle("is-active", i === best));
    }

    // SIE: stages light up in order, data flows into and out of the core
    if (sieBoard && c > 2.5 && c < 4) {
      const u = clamp((c - 2.82) / (3.45 - 2.82));
      sieBoard.style.transform = `translate(-50%, -50%) rotateY(${(mx * 3).toFixed(2)}deg) rotateX(${(-my * 2).toFixed(2)}deg)`;
      sieSteps.forEach((st, i) => {
        const lit = clamp(u * 6.4 - i);
        st.style.setProperty("--lit", lit.toFixed(3));
        st.classList.toggle("is-lit", lit > 0.95);
        if (flowPaths[i]) flowPaths[i].style.setProperty("--lit", lit.toFixed(3));
      });
      if (readout) readout.textContent = u < 0.45 ? "SIE · UNDERSTANDING" : u < 0.97 ? "SIE · RESOLVING" : "SIE · ANSWER READY";
    }

    // automation: the workflow draws itself
    if (flowboard && c > 3.5 && c < 5) {
      const u = clamp((c - 3.82) / (4.45 - 3.82));
      flowboard.style.transform = `rotateX(${(16 - my * 3).toFixed(2)}deg) rotateY(${(mx * 4).toFixed(2)}deg) scale(${boardScale.toFixed(3)})`;
      nodes.forEach((n, i) => {
        const lit = clamp((u - NODE_START[i]) / 0.12);
        n.style.setProperty("--lit", lit.toFixed(3));
        n.classList.toggle("is-lit", lit > 0.95);
      });
      WIRES.forEach(([a, b], i) => {
        const wp = wirePaths[i];
        if (!wp) return;
        const p = clamp((u - NODE_START[a]) / (NODE_START[b] - NODE_START[a] || 0.1));
        wp.draw.setAttribute("stroke-dashoffset", (1 - p).toFixed(3));
        wp.pulse.setAttribute("opacity", p >= 1 ? "1" : "0");
      });
    }

    if (cmd && c > 4.4) {
      cmd.style.transform = `translate(-50%, -50%) rotateY(${(mx * 3).toFixed(2)}deg) rotateX(${(-my * 2).toFixed(2)}deg)`;
    }

    const on = c < 1.45;
    if (on !== dashOn) {
      dashOn = on;
      onDashActive(on);
    }
  }

  function applyCommon(c, mx, my) {
    // HUD
    const hk = c < 6.5 ? Math.min(6, Math.round(c)) : c > 9.5 ? 10 : -1;
    if (hud) {
      const hv = smooth(0.45, 0.85, c);
      hud.style.opacity = hv.toFixed(3);
      hud.style.pointerEvents = hv > 0.5 ? "auto" : "none";
      hud.style.visibility = hv < 0.02 ? "hidden" : "visible";
    }
    for (const a of hudItems) a.classList.toggle("is-active", +a.dataset.chapter === hk);

    // nav "you are here"
    const nearBottom = scrollY + vh >= docH - 60;
    const cur = nearBottom ? "contact" : c < 5.6 ? "hero" : c < 6.9 ? "features" : c < 7.9 ? "pricing" : "";
    for (const a of navLinks) a.classList.toggle("is-current", a.dataset.nav === cur);

    if (dimEl) dimEl.style.setProperty("--dim", piecewise(DIM, c).toFixed(3));
    const pmx = (mx * 0.5 + 0.5).toFixed(3), pmy = (my * 0.5 + 0.5).toFixed(3);
    stage.style.setProperty("--mx", pmx);
    stage.style.setProperty("--my", pmy);
    if (env) {
      env.style.setProperty("--mx", pmx);
      env.style.setProperty("--my", pmy);
    }
  }

  /* ── flow mode (phones, reduced motion) ────────────────────────────── */
  let flowIO = null;
  let dashIO = null;
  function primeFlow() {
    scenes.forEach(s => {
      s.classList.add("is-live");
      if (s.dataset.scene !== "0") s.classList.add("rv-scene");
    });
    sieSteps.forEach(s => s.classList.add("is-lit"));
    nodes.forEach(n => n.classList.add("is-lit"));
    if (!flowIO) {
      flowIO = new IntersectionObserver(es => {
        for (const e of es) if (e.isIntersecting) e.target.classList.add("is-in");
      }, { threshold: 0.08 });
    }
    $$(".rv-scene").forEach(s => flowIO.observe(s));
    // dashboard animates while it is on screen
    if (dashRig && !dashIO) {
      const io = (dashIO = new IntersectionObserver(es => {
        for (const e of es) if (mode === "flow") onDashActive(e.isIntersecting);
      }));
      io.observe(dashRig);
    }
  }

  /* ── reveals for flowing sections (both modes) ─────────────────────── */
  const rvIO = new IntersectionObserver(es => {
    for (const e of es) {
      if (e.isIntersecting) {
        e.target.classList.add("is-in");
        rvIO.unobserve(e.target);
      }
    }
  }, { threshold: 0.12, rootMargin: "0px 0px -6% 0px" });
  $$(".rv").forEach(n => rvIO.observe(n));

  /* ── pointer & tilt ────────────────────────────────────────────────── */
  const finePointer = window.matchMedia("(pointer: fine)").matches;
  if (finePointer && !reduce) {
    addEventListener("pointermove", e => {
      if (e.pointerType !== "mouse") return;
      state.tmx = (e.clientX / vw) * 2 - 1;
      state.tmy = (e.clientY / vh) * 2 - 1;
    }, { passive: true });
    document.addEventListener("pointerleave", () => { state.tmx = 0; state.tmy = 0; });

    for (const card of $$("[data-tilt]")) {
      card.addEventListener("pointermove", e => {
        const r = card.getBoundingClientRect();
        const px = (e.clientX - r.left) / r.width, py = (e.clientY - r.top) / r.height;
        card.style.setProperty("--ry", ((px - 0.5) * 10).toFixed(2) + "deg");
        card.style.setProperty("--rx", ((0.5 - py) * 8).toFixed(2) + "deg");
        card.style.setProperty("--px", px.toFixed(3));
        card.style.setProperty("--py", py.toFixed(3));
      });
      card.addEventListener("pointerleave", () => {
        card.style.setProperty("--rx", "0deg");
        card.style.setProperty("--ry", "0deg");
        card.style.removeProperty("--px");
        card.style.removeProperty("--py");
      });
    }
  }

  /* ── in-page links travel the journey ──────────────────────────────── */
  function targetY(el) {
    if (!el) return null;
    if (mode === "cinema" && el.classList.contains("scene")) return anchors[+el.dataset.scene];
    if (el.id === "hero") return 0;
    return Math.max(0, sectionTop(el) - 88);
  }
  function go(hash, smoothly = true) {
    const id = decodeURIComponent(hash.replace(/^#/, ""));
    if (!id) return false;
    const el = document.getElementById(id);
    const y = targetY(el);
    if (y == null) return false;
    scrollTo({ top: y, behavior: smoothly && !reduce ? "smooth" : "auto" });
    return true;
  }
  document.addEventListener("click", e => {
    const a = e.target.closest('a[href^="#"]');
    if (!a || e.defaultPrevented || e.metaKey || e.ctrlKey) return;
    if (go(a.getAttribute("href"))) {
      e.preventDefault();
      history.replaceState(null, "", a.getAttribute("href"));
      // move keyboard focus to the destination for screen reader users
      const t = document.getElementById(a.getAttribute("href").slice(1));
      if (t) {
        if (!t.hasAttribute("tabindex")) t.setAttribute("tabindex", "-1");
        t.focus({ preventScroll: true });
      }
    }
  });

  /* keyboard users tabbing into a scene that has faded out get taken to it */
  document.addEventListener("focusin", e => {
    if (mode !== "cinema") return;
    const sc = e.target.closest && e.target.closest(".scene");
    if (!sc || sc.classList.contains("is-live")) return;
    scrollTo({ top: anchors[+sc.dataset.scene], behavior: "auto" });
  });

  /* ── lifecycle ─────────────────────────────────────────────────────── */
  let rT = 0;
  addEventListener("resize", () => {
    clearTimeout(rT);
    rT = setTimeout(layout, 140);
  });
  addEventListener("scroll", () => {
    if (nav) nav.classList.toggle("is-scrolled", scrollY > 20);
  }, { passive: true });

  layout();
  if (mode === "flow") primeFlow();
  state.target = state.c = scrollToChapterC(scrollY);
  if (location.hash) requestAnimationFrame(() => go(location.hash, false));
  if (document.fonts && document.fonts.ready) document.fonts.ready.then(layout);
  addEventListener("load", layout);

  function update(dt) {
    const y = scrollY;
    state.target = scrollToChapterC(y);
    const k = reduce ? 1 : 1 - Math.exp(-dt * 5.2);
    const prev = state.c;
    state.c += (state.target - state.c) * k;
    if (Math.abs(state.target - state.c) < 1e-4) state.c = state.target;
    state.vel = dt > 0 ? (state.c - prev) / dt : 0;
    const kp = 1 - Math.exp(-dt * 3.5);
    state.mx += (state.tmx - state.mx) * kp;
    state.my += (state.tmy - state.my) * kp;

    const { c, mx, my } = state;
    if (Math.abs(c - last.c) < 0.0004 && Math.abs(mx - last.mx) < 0.0008 && Math.abs(my - last.my) < 0.0008) return;
    last = { c, mx, my };
    if (mode === "cinema") applyCinema(c, mx, my);
    else state.warp = 0;
    applyCommon(c, mx, my);
  }

  /** scroll position that lands exactly on chapter c (inverse of the mapping) */
  function yFor(c) {
    const n = anchors.length - 1;
    const k = Math.floor(clamp(c, 0, n));
    if (k >= n) return anchors[n];
    return anchors[k] + (anchors[k + 1] - anchors[k]) * (c - k);
  }

  return { state, update, layout, yFor, get mode() { return mode; } };
}
