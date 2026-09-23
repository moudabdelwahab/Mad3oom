/* =====================================================================
   Mad3oom orbital — entry
   ---------------------------------------------------------------------
   الترتيب مقصود: واجهة الصفحة أولًا (تعمل فورًا حتى بلا WebGL)، ثم
   الرحلة، ثم يُحمَّل العالم ثلاثي الأبعاد كسولًا بعد أول رسم —
   Three.js (≈680KB) لا يؤخر ظهور العنوان أو الأزرار.
   ===================================================================== */

import { initLiveSurfaces } from "./dashboard.js";
import { createJourney } from "./journey.js";

const root = document.documentElement;
const reduce = window.matchMedia("(prefers-reduced-motion: reduce)").matches;

/* ── Which 3D tier this device gets ─────────────────────────────────── */
function pickTier() {
  const conn = navigator.connection;
  if (conn && (conn.saveData || /(^|-)2g$/.test(conn.effectiveType || ""))) return "none";
  if (reduce) return "static";
  const w = innerWidth;
  const coarse = window.matchMedia("(pointer: coarse)").matches;
  let tier = w < 900 ? "low" : w < 1200 || coarse ? "mid" : "high";
  const cores = navigator.hardwareConcurrency || 8;
  const mem = navigator.deviceMemory || 8;
  if (tier === "high" && (cores <= 4 || mem <= 4)) tier = "mid";
  if (tier === "mid" && cores <= 2) tier = "low";
  return tier;
}

/* ── Page UI: nav, menus, pricing toggle, FAQ, robot tour ───────────── */
function initUI() {
  const year = document.getElementById("year");
  if (year) year.textContent = String(new Date().getFullYear());

  // mobile sheet
  const burger = document.getElementById("navBurger");
  const sheet = document.getElementById("mnav");
  const closeBtn = document.getElementById("mnavClose");
  const setSheet = open => {
    sheet.classList.toggle("is-open", open);
    burger.setAttribute("aria-expanded", String(open));
    document.body.style.overflow = open ? "hidden" : "";
    if (open) closeBtn.focus();
  };
  if (burger && sheet) {
    burger.addEventListener("click", () => setSheet(true));
    closeBtn.addEventListener("click", () => { setSheet(false); burger.focus(); });
    sheet.querySelectorAll("a").forEach(a => a.addEventListener("click", () => setSheet(false)));
  }

  // resources dropdown
  const drop = document.getElementById("resDrop");
  if (drop) {
    const btn = drop.querySelector("button");
    const set = open => {
      drop.classList.toggle("is-open", open);
      btn.setAttribute("aria-expanded", String(open));
    };
    // hover opens it on mouse devices; a click that follows the hover must not close it again
    let hoverAt = 0;
    btn.addEventListener("click", e => {
      e.stopPropagation();
      const justHovered = performance.now() - hoverAt < 500;
      set(justHovered || !drop.classList.contains("is-open"));
    });
    drop.addEventListener("mouseenter", () => {
      if (!window.matchMedia("(hover: hover)").matches) return;
      hoverAt = performance.now();
      set(true);
    });
    drop.addEventListener("mouseleave", () => window.matchMedia("(hover: hover)").matches && set(false));
    document.addEventListener("click", e => { if (!drop.contains(e.target)) set(false); });
    drop.addEventListener("keydown", e => { if (e.key === "Escape") { set(false); btn.focus(); } });
  }

  document.addEventListener("keydown", e => {
    if (e.key === "Escape" && sheet && sheet.classList.contains("is-open")) {
      setSheet(false);
      burger.focus();
    }
  });

  // pricing: monthly / yearly (same data attributes as before)
  const toggle = document.getElementById("billingToggle");
  if (toggle) {
    const buttons = toggle.querySelectorAll("button");
    const setPeriod = period => {
      buttons.forEach(b => {
        const on = b.dataset.period === period;
        b.classList.toggle("active", on);
        b.setAttribute("aria-pressed", String(on));
      });
      document.querySelectorAll("#pricing [data-monthly]").forEach(el => {
        const v = period === "yearly" ? el.dataset.yearly : el.dataset.monthly;
        if (v !== undefined) el.textContent = v;
      });
    };
    buttons.forEach(b => b.addEventListener("click", () => setPeriod(b.dataset.period)));
  }

  // FAQ: one open at a time
  const faqs = document.querySelectorAll(".faq__item");
  faqs.forEach(item => item.addEventListener("toggle", () => {
    if (item.open) faqs.forEach(o => { if (o !== item) o.removeAttribute("open"); });
  }));

  initRobotTour();
}

function initRobotTour() {
  const helper = document.getElementById("robotHelper");
  const btn = document.getElementById("robotBtn");
  const track = document.getElementById("robotTourTrack");
  const dotsWrap = document.getElementById("robotTourDots");
  const prevBtn = document.getElementById("rtPrev");
  const nextBtn = document.getElementById("rtNext");
  const closeBtn = document.getElementById("robotTourClose");
  if (!helper || !btn || !track) return;

  const slides = Array.from(track.querySelectorAll(".robot-tour-slide"));
  let current = 0;
  slides.forEach((_, i) => {
    const dot = document.createElement("button");
    dot.type = "button";
    dot.setAttribute("aria-label", "الخطوة " + (i + 1));
    dot.addEventListener("click", () => goTo(i));
    dotsWrap.appendChild(dot);
  });
  const dots = Array.from(dotsWrap.children);
  function render() {
    slides.forEach((s, i) => s.classList.toggle("active", i === current));
    dots.forEach((d, i) => d.classList.toggle("active", i === current));
    prevBtn.disabled = current === 0;
    nextBtn.textContent = current === slides.length - 1 ? "من جديد" : "التالي";
  }
  function goTo(i) {
    current = Math.max(0, Math.min(slides.length - 1, i));
    render();
  }
  prevBtn.addEventListener("click", () => goTo(current - 1));
  nextBtn.addEventListener("click", () => goTo(current === slides.length - 1 ? 0 : current + 1));
  const open = () => { helper.classList.add("tour-open"); btn.setAttribute("aria-expanded", "true"); };
  const close = () => { helper.classList.remove("tour-open"); btn.setAttribute("aria-expanded", "false"); };
  btn.addEventListener("click", () => (helper.classList.contains("tour-open") ? close() : open()));
  closeBtn.addEventListener("click", close);
  document.addEventListener("click", e => { if (!helper.contains(e.target)) close(); });
  document.addEventListener("keydown", e => { if (e.key === "Escape") close(); });

  // the robot standing in the command center also opens the tour
  const heroRobot = document.getElementById("robot");
  if (heroRobot) {
    // clickable only while its scene is on screen (see .scene.is-live .hit)
    heroRobot.classList.add("hit");
    heroRobot.style.cursor = "pointer";
    heroRobot.setAttribute("title", "اضغط لتعرف على مدعوم");
    heroRobot.addEventListener("click", e => {
      e.stopPropagation();
      goTo(0);
      open();
    });
  }
  render();
}

/* ── Boot ───────────────────────────────────────────────────────────── */
initUI();
const live = initLiveSurfaces();
const tier = pickTier();
const journey = createJourney({ tier, onDashActive: on => live.setDashActive(on) });
// test hook: /?orbdebug exposes the journey state for automated checks
if (/[?&]orbdebug\b/.test(location.search)) window.__orbJourney = journey;

let world = null;
let lastT = performance.now();
function loop(now) {
  const dt = Math.min(0.1, (now - lastT) / 1000);
  lastT = now;
  journey.update(dt);
  if (world) world.frame(dt, journey.state);
  requestAnimationFrame(loop);
}
requestAnimationFrame(loop);

function hasWebGL() {
  try {
    const c = document.createElement("canvas");
    return !!(c.getContext("webgl2") || c.getContext("webgl"));
  } catch (e) {
    return false;
  }
}

function loadWorld() {
  const canvas = document.getElementById("orbital-canvas");
  // no WebGL: skip the 3D download entirely; the CSS world is already on screen
  if (!canvas || tier === "none" || !hasWebGL()) return;
  import("./scene.js")
    .then(m => m.createWorld(canvas, { tier }))
    .then(w => {
      world = w;
      root.classList.add("webgl-ready");
    })
    .catch(err => {
      // the CSS environment stays in place; the page is fully usable without WebGL
      console.warn("[orbital] 3D world unavailable:", err && err.message);
    });
}
// after first paint, when the main thread is free
const idle = window.requestIdleCallback || (cb => setTimeout(cb, 200));
if (document.readyState === "complete") idle(loadWorld, { timeout: 1500 });
else addEventListener("load", () => idle(loadWorld, { timeout: 1500 }), { once: true });
