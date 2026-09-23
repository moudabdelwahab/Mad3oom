/* =====================================================================
   Mad3oom orbital — live product surfaces
   ---------------------------------------------------------------------
   يجعل لوحات العرض تتصرف كمنتج يعمل: محادثات تصل، SIE يقترح، الموظف
   يرد، مؤقت SLA يعدّ، والمخططات تُبنى من بيانات لا من صور.

   كل شيء هنا بيانات عرض توضيحية ثابتة؛ لا شيء يتصل بالشبكة.
   المؤقتات لا تعمل إلا حين يكون السطح المعني ظاهرًا والتبويب نشطًا.
   ===================================================================== */

const NS = "http://www.w3.org/2000/svg";
const reduceMotion = window.matchMedia("(prefers-reduced-motion: reduce)").matches;

const CH_ICON = { wa: "i-wa", em: "i-mail", lc: "i-chat", tg: "i-tg" };

function el(tag, attrs = {}, html = "") {
  const n = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs)) n.setAttribute(k, v);
  if (html) n.innerHTML = html;
  return n;
}
function svg(tag, attrs = {}) {
  const n = document.createElementNS(NS, tag);
  for (const [k, v] of Object.entries(attrs)) n.setAttribute(k, v);
  return n;
}
function esc(s) {
  return String(s).replace(/[&<>"']/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]);
}
function chBadge(ch) {
  return `<span class="ch ch--${ch}"><svg><use href="#${CH_ICON[ch]}"/></svg></span>`;
}
const fmtInt = n => Math.round(n).toLocaleString("en-US");

/* Visibility gate: a surface animates only while on screen. */
function watch(target, cb) {
  if (!target) return () => false;
  let on = false;
  const io = new IntersectionObserver(es => {
    for (const e of es) {
      on = e.isIntersecting;
      cb && cb(on);
    }
  }, { rootMargin: "80px" });
  io.observe(target);
  return () => on && !document.hidden;
}

/* ── Sparklines ─────────────────────────────────────────────────────── */
function buildSparks(root = document) {
  root.querySelectorAll("svg[data-spark]").forEach(s => {
    const vals = s.dataset.spark.split(",").map(Number);
    const [w, h] = s.getAttribute("viewBox").split(" ").slice(2).map(Number);
    const min = Math.min(...vals), max = Math.max(...vals);
    const pts = vals.map((v, i) => [
      (i / (vals.length - 1)) * w,
      h - 2 - ((v - min) / (max - min || 1)) * (h - 6),
    ]);
    const d = pts.map((p, i) => (i ? "L" : "M") + p[0].toFixed(1) + " " + p[1].toFixed(1)).join(" ");
    s.innerHTML = "";
    if (!s.classList.contains("spark")) s.classList.add("spark");
    s.appendChild(svg("path", { class: "area", d: `${d} L${w} ${h} L0 ${h} Z` }));
    s.appendChild(svg("path", { d, "vector-effect": "non-scaling-stroke" }));
  });
}

/* ── Ticket volume chart (two series, one axis, crosshair) ──────────── */
const VOL = {
  days: ["10/9", "11/9", "12/9", "13/9", "14/9", "15/9", "16/9", "17/9", "18/9", "19/9", "20/9", "21/9", "22/9", "23/9"],
  recv: [212, 198, 236, 251, 229, 188, 176, 243, 262, 255, 238, 219, 247, 268],
  res: [201, 195, 220, 244, 226, 190, 170, 231, 255, 249, 236, 214, 240, 259],
};

function buildVolumeChart(host) {
  if (!host) return null;
  const W = 560, H = 210, L = 34, R = 92, T = 12, B = 26;
  const yMin = 150, yMax = 300;
  const x = i => L + (i / (VOL.days.length - 1)) * (W - L - R);
  const y = v => T + (1 - (v - yMin) / (yMax - yMin)) * (H - T - B);

  const s = svg("svg", { viewBox: `0 0 ${W} ${H}`, role: "img", "aria-label": "حجم التذاكر في آخر 14 يومًا: الواردة بين 176 و268 يوميًا، والمحلولة تتبعها عن قرب" });
  s.style.direction = "ltr";
  const grid = svg("g", { class: "grid" });
  const axis = svg("g", { class: "axis" });
  for (const v of [150, 200, 250, 300]) {
    grid.appendChild(svg("line", { x1: L, x2: W - R, y1: y(v), y2: y(v) }));
    const t = svg("text", { x: L - 8, y: y(v) + 3, "text-anchor": "end" });
    t.textContent = v;
    axis.appendChild(t);
  }
  VOL.days.forEach((d, i) => {
    if (i % 3 !== 0 && i !== VOL.days.length - 1) return;
    const t = svg("text", { x: x(i), y: H - 6, "text-anchor": "middle" });
    t.textContent = d;
    axis.appendChild(t);
  });
  s.append(grid, axis);

  const line = arr => arr.map((v, i) => (i ? "L" : "M") + x(i).toFixed(1) + " " + y(v).toFixed(1)).join(" ");
  const area = arr => `${line(arr)} L${x(arr.length - 1)} ${y(yMin)} L${x(0)} ${y(yMin)} Z`;
  const fRecv = svg("path", { class: "fill-recv", d: area(VOL.recv) });
  const fRes = svg("path", { class: "fill-res", d: area(VOL.res) });
  const lRecv = svg("path", { class: "line s-recv", d: line(VOL.recv) });
  const lRes = svg("path", { class: "line s-res", d: line(VOL.res) });
  s.append(fRecv, fRes, lRecv, lRes);

  // direct labels at the line ends (identity never by colour alone)
  const last = VOL.days.length - 1;
  const labRecv = svg("text", { class: "label", x: x(last) + 10, y: y(VOL.recv[last]) - 4 });
  const labRes = svg("text", { class: "label", x: x(last) + 10, y: y(VOL.res[last]) + 12 });
  s.append(labRecv, labRes);
  const endDotRecv = svg("circle", { class: "dot", r: 4.5, fill: "#2f7fe0" });
  const endDotRes = svg("circle", { class: "dot", r: 4.5, fill: "#14a89a" });
  s.append(endDotRecv, endDotRes);

  // crosshair layer
  const xh = svg("line", { class: "xhair", y1: T, y2: H - B, opacity: 0 });
  const hRecv = svg("circle", { class: "dot", r: 5, fill: "#2f7fe0", opacity: 0 });
  const hRes = svg("circle", { class: "dot", r: 5, fill: "#14a89a", opacity: 0 });
  const hit = svg("rect", { x: L, y: T, width: W - L - R, height: H - T - B, fill: "transparent" });
  s.append(xh, hRecv, hRes, hit);
  host.appendChild(s);

  const tip = el("div", { class: "chart-tip", role: "presentation" });
  host.appendChild(tip);

  function paintEnds() {
    const l = VOL.days.length - 1;
    labRecv.textContent = `الواردة ${VOL.recv[l]}`;
    labRes.textContent = `المحلولة ${VOL.res[l]}`;
    labRecv.setAttribute("y", y(VOL.recv[l]) - 4);
    labRes.setAttribute("y", y(VOL.res[l]) + 12);
    endDotRecv.setAttribute("cx", x(l)); endDotRecv.setAttribute("cy", y(VOL.recv[l]));
    endDotRes.setAttribute("cx", x(l)); endDotRes.setAttribute("cy", y(VOL.res[l]));
  }
  paintEnds();

  function show(clientX) {
    const r = s.getBoundingClientRect();
    const px = ((clientX - r.left) / r.width) * W;
    const i = Math.max(0, Math.min(VOL.days.length - 1, Math.round(((px - L) / (W - L - R)) * (VOL.days.length - 1))));
    xh.setAttribute("x1", x(i)); xh.setAttribute("x2", x(i)); xh.setAttribute("opacity", 1);
    hRecv.setAttribute("cx", x(i)); hRecv.setAttribute("cy", y(VOL.recv[i])); hRecv.setAttribute("opacity", 1);
    hRes.setAttribute("cx", x(i)); hRes.setAttribute("cy", y(VOL.res[i])); hRes.setAttribute("opacity", 1);
    tip.innerHTML = `<strong>${VOL.days[i]}</strong><div><span><i style="background:#2f7fe0"></i> الواردة</span><b>${VOL.recv[i]}</b></div><div><span><i style="background:#14a89a"></i> المحلولة</span><b>${VOL.res[i]}</b></div>`;
    const hr = host.getBoundingClientRect();
    // keep the tooltip inside the chart box at both ends
    const half = tip.offsetWidth / 2 + 4;
    const tx = (x(i) / W) * r.width + (r.left - hr.left);
    tip.style.left = Math.max(half, Math.min(hr.width - half, tx)) + "px";
    tip.style.top = ((y(VOL.recv[i]) / H) * r.height + (r.top - hr.top) - 10) + "px";
    tip.classList.add("is-on");
  }
  function hide() {
    tip.classList.remove("is-on");
    [xh, hRecv, hRes].forEach(n => n.setAttribute("opacity", 0));
  }
  hit.addEventListener("pointermove", e => show(e.clientX));
  hit.addEventListener("pointerleave", hide);

  // "live": today's bar keeps ticking up
  return function tick() {
    const l = VOL.days.length - 1;
    if (Math.random() < 0.6) VOL.recv[l] += 1;
    if (Math.random() < 0.55) VOL.res[l] += 1;
    lRecv.setAttribute("d", line(VOL.recv));
    lRes.setAttribute("d", line(VOL.res));
    fRecv.setAttribute("d", area(VOL.recv));
    fRes.setAttribute("d", area(VOL.res));
    paintEnds();
  };
}

/* ── Heat strip, response bars, gauge ───────────────────────────────── */
function buildHeat(host) {
  if (!host) return;
  const v = [4, 3, 2, 2, 1, 2, 5, 9, 14, 19, 24, 28, 30, 27, 22, 18, 17, 19, 23, 27, 29, 24, 15, 8];
  const max = Math.max(...v);
  host.innerHTML = v.map((n, h) => `<i style="--o:${(0.08 + 0.9 * (n / max)).toFixed(2)}" title="${String(h).padStart(2, "0")}:00 · ${n * 6} محادثة"></i>`).join("");
}
function buildRespBars(host) {
  if (!host) return;
  const v = [1.4, 1.5, 1.8, 2.2, 2.6, 2.4, 2.0, 1.7, 1.6, 1.8, 2.1, 2.5, 2.7, 2.2, 1.6, 1.3];
  host.innerHTML = v.map((m, i) => `<i style="--v:0" data-v="${((m / 3) * 100).toFixed(1)}" data-tip="${String(8 + i).padStart(2, "0")}:00 · ${m.toFixed(1)} د"></i>`).join("");
}

/* ── Customer message feed ──────────────────────────────────────────── */
const FEED = [
  { n: "نورة الدوسري", h: 275, ch: "tg", t: "شكرًا، تم تحديث العنوان بسرعة 🙏", s: 5, m: "حُلّت في 3 د" },
  { n: "خالد المطيري", h: 160, ch: "wa", t: "وصلتني الفاتورة الضريبية باسم الشركة، تعامل راقٍ.", s: 5, m: "حُلّت في 6 د" },
  { n: "منى إبراهيم", h: 225, ch: "em", t: "تم استرجاع المبلغ المكرر، أشكركم على المتابعة.", s: 5, m: "حُلّت في 38 ث بمساعدة SIE" },
  { n: "يوسف منصور", h: 195, ch: "lc", t: "الرد كان سريع وواضح جدًا.", s: 4, m: "حُلّت في 2 د" },
  { n: "هالة سمير", h: 320, ch: "wa", t: "كنت متوقعة أنتظر يوم، الرد جاء خلال دقيقتين.", s: 5, m: "حُلّت في 2 د" },
  { n: "عمر حسن", h: 210, ch: "lc", t: "البوت فهم طلبي من أول رسالة!", s: 5, m: "رد آلي" },
  { n: "ليلى حسن", h: 300, ch: "em", t: "تم حل مشكلة الدخول، شكرًا لكم.", s: 4, m: "حُلّت في 9 د" },
  { n: "عبدالرحمن الشمري", h: 180, ch: "tg", t: "تنبيهات الطلبات على تيليجرام مفيدة جدًا.", s: 5, m: "إشعار تلقائي" },
  { n: "سارة القحطاني", h: 205, ch: "wa", t: "ممتاز، شكرًا على التعويض 🌟", s: 5, m: "حُلّت في 4 د" },
];
function feedItem(f, isNew) {
  const stars = "★".repeat(f.s) + "☆".repeat(5 - f.s);
  const item = el("div", { class: "feed__item" + (isNew ? " is-new" : "") });
  item.innerHTML =
    `<span class="av" style="--h:${f.h}">${esc(f.n[0])}${chBadge(f.ch)}</span>` +
    `<div><div class="feed__row"><strong>${esc(f.n)}</strong><time>الآن</time></div>` +
    `<div class="feed__text">${esc(f.t)}</div>` +
    `<div class="feed__foot"><span class="stars" role="img" aria-label="تقييم ${f.s} من 5">${stars}</span><span>${esc(f.m)}</span></div></div>`;
  return item;
}
function relabelFeed(host) {
  [...host.children].forEach((c, i) => {
    const t = c.querySelector("time");
    if (t) t.textContent = i === 0 ? "الآن" : `منذ ${i * 2} د`;
  });
}

/* ── Inbox & agent workspace script ─────────────────────────────────── */
const INCOMING = [
  { n: "هالة سمير", h: 320, ch: "wa", p: "هل يمكن تغيير المقاس بعد الشحن؟", tag: ["new", "جديد"] },
  { n: "عمر حسن", h: 210, ch: "lc", p: "أبي أعرف تفاصيل الباقة الشاملة", tag: ["new", "جديد"] },
  { n: "ليلى حسن", h: 300, ch: "em", p: "لم يصلني رمز التحقق على البريد", tag: ["open", "مفتوح"] },
  { n: "فهد القرني", h: 150, ch: "tg", p: "/track 90412", tag: ["new", "جديد"] },
  { n: "دينا عادل", h: 340, ch: "wa", p: "المنتج وصل مكسور 😞", tag: ["high", "عالية"] },
];

const SIE_A = {
  text: "الشحنة وصلت مركز التوزيع في الرياض، والتسليم المتوقع غدًا قبل الساعة 2 ظهرًا. أضفنا لك كوبون خصم 15% تعويضًا عن التأخير.",
  conf: "ثقة 92%",
  src: "سياسة التأخير والتعويض",
};
const SIE_B = {
  text: "العميلة راضية عن الحل. اقتراح: إغلاق التذكرة وإرسال استبيان الرضا تلقائيًا.",
  conf: "ثقة 97%",
  src: "إجراء: إغلاق مع استبيان",
};

function initWorkspace(isOn) {
  const list = document.getElementById("dbList");
  const thread = document.getElementById("dbThread");
  const state = document.getElementById("ticketState");
  const sieText = document.getElementById("sieText");
  const sieConf = document.getElementById("sieConf");
  const sieSrc = document.getElementById("sieSrc");
  const senti = document.getElementById("sentiBar");
  const sentiLabel = document.getElementById("sentiLabel");
  const sla = document.getElementById("slaClock");
  if (!list || !thread) return () => {};

  const initialThread = thread.innerHTML;
  let inc = 0;
  let step = 0;
  let slaSec = 42 * 60 + 18;

  function setState(kind) {
    state.className = "tag " + (kind === "done" ? "tag--done" : "tag--open");
    state.textContent = kind === "done" ? "محلول" : "مفتوح";
  }
  setState("open");
  function setSie(o) {
    sieText.textContent = o.text;
    sieConf.textContent = o.conf;
    sieSrc.textContent = o.src;
  }
  function push(html, cls) {
    const n = el("div", { class: `msg ${cls} is-new` }, html);
    thread.appendChild(n);
    while (thread.children.length > 7) thread.firstElementChild.remove();
    return n;
  }
  function typing(on, side = "in") {
    thread.querySelectorAll(".msg--typing").forEach(n => n.remove());
    if (on) push('<span class="typing"><i></i><i></i><i></i></span>', `msg--${side} msg--typing`);
  }

  function nextConversation() {
    const c = INCOMING[inc++ % INCOMING.length];
    const row = el("div", { class: "db-conv is-new" });
    row.innerHTML =
      `<span class="av" style="--h:${c.h}">${esc(c.n[0])}${chBadge(c.ch)}</span>` +
      `<div class="db-conv__main"><div class="db-conv__row"><span class="db-conv__name">${esc(c.n)}</span><span class="tag tag--${c.tag[0]}">${c.tag[1]}</span></div><div class="db-conv__prev">${esc(c.p)}</div></div>` +
      `<div class="db-conv__meta"><span>الآن</span><span class="unread">1</span></div>`;
    // the open conversation stays pinned first; new arrivals land beneath it
    list.insertBefore(row, list.children[1] || null);
    while (list.children.length > 7) list.lastElementChild.remove();
    const all = document.querySelector('[data-live="all"]');
    if (all) all.textContent = String(Number(all.textContent) + 1);
  }

  const script = [
    () => typing(true, "out"),
    () => {
      typing(false);
      push(`<div class="msg__bubble">${esc(SIE_A.text)}<span class="msg__time">10:28 · ريم</span></div>`, "msg--out");
      push("أُرسل الرد من اقتراح SIE بعد مراجعة ريم", "msg--sys");
      senti.style.setProperty("--v", "58%");
      sentiLabel.textContent = "يتحسّن";
    },
    () => typing(true, "in"),
    () => {
      typing(false);
      push('<div class="msg__bubble">ممتاز، شكرًا لكم على التعويض 🙏<span class="msg__time">10:29</span></div>', "msg--in");
      senti.style.setProperty("--v", "90%");
      sentiLabel.textContent = "راضٍ";
    },
    () => setSie(SIE_B),
    () => {
      setState("done");
      push("أُغلقت التذكرة · أُرسل استبيان الرضا", "msg--sys");
    },
    () => {},
    () => {
      thread.innerHTML = initialThread;
      setSie(SIE_A);
      setState("open");
      senti.style.setProperty("--v", "34%");
      sentiLabel.textContent = "منزعج";
      slaSec = 42 * 60 + 18;
    },
  ];

  let beat = 0;
  return function tick() {
    // every second
    if (!isOn()) return;
    slaSec = Math.max(0, slaSec - 1);
    const h = Math.floor(slaSec / 3600), m = Math.floor((slaSec % 3600) / 60), s = slaSec % 60;
    sla.textContent = [h, m, s].map(n => String(n).padStart(2, "0")).join(":");
    beat++;
    if (beat % 3 === 0) {
      script[step % script.length]();
      step++;
    }
    if (beat % 7 === 0) nextConversation();
  };
}

/* ── Live counters sprinkled through the world ──────────────────────── */
function initCounters() {
  const q = k => document.querySelectorAll(`[data-live="${k}"]`);
  const state = { wa: 12, em: 7, lc: 5, tg: 3, auto: 1284, team: 8, open: 128, frt: 102 };
  const walk = (k, lo, hi) => {
    state[k] = Math.max(lo, Math.min(hi, state[k] + (Math.random() < 0.5 ? -1 : 1)));
  };
  return function tick() {
    walk("wa", 9, 16); walk("em", 4, 10); walk("lc", 3, 8); walk("tg", 2, 5); walk("open", 118, 136);
    state.auto += 1 + Math.floor(Math.random() * 3);
    state.frt = Math.max(94, Math.min(110, state.frt + (Math.random() < 0.5 ? -1 : 1)));
    const frt = `${Math.floor(state.frt / 60)}:${String(state.frt % 60).padStart(2, "0")}`;
    const set = (k, v) => q(k).forEach(n => { n.textContent = v; });
    set("wa", state.wa); set("em", state.em); set("lc", state.lc); set("tg", state.tg);
    set("auto", fmtInt(state.auto)); set("auto2", fmtInt(state.auto));
    set("open", state.open); set("frt", frt); set("frt2", frt);
    q("frt3").forEach(n => { n.firstChild.textContent = frt; });
  };
}

/* ── Public entry ───────────────────────────────────────────────────── */
export function initLiveSurfaces() {
  buildSparks();
  const volTick = buildVolumeChart(document.getElementById("volChart"));
  buildHeat(document.getElementById("heat"));
  const rt = document.getElementById("rtBars");
  buildRespBars(rt);

  // feed
  const feed = document.getElementById("feed");
  let feedIdx = 0;
  if (feed) {
    for (let i = 0; i < 5; i++) feed.appendChild(feedItem(FEED[feedIdx++ % FEED.length], false));
    relabelFeed(feed);
  }

  // one-shot entrance for bars and gauge when their panel appears
  const gauge = document.getElementById("gaugeVal");
  const once = new IntersectionObserver(es => {
    for (const e of es) {
      if (!e.isIntersecting) continue;
      const t = e.target;
      if (t === rt) rt.querySelectorAll("i").forEach(b => b.style.setProperty("--v", b.dataset.v));
      if (t === gauge) gauge.style.strokeDashoffset = String(263.9 * (1 - 4.8 / 5));
      once.unobserve(t);
    }
  }, { threshold: 0.3 });
  if (rt) once.observe(rt);
  if (gauge) once.observe(gauge);
  // hbars fill in when shown
  document.querySelectorAll(".hbar__track i").forEach(i => {
    const v = i.style.getPropertyValue("--v");
    i.dataset.v = v;
    i.style.setProperty("--v", "0");
  });
  const barIO = new IntersectionObserver(es => {
    for (const e of es) {
      if (!e.isIntersecting) continue;
      e.target.querySelectorAll(".hbar__track i").forEach(i => i.style.setProperty("--v", i.dataset.v));
      barIO.unobserve(e.target);
    }
  }, { threshold: 0.2 });
  document.querySelectorAll(".hbars").forEach(h => barIO.observe(h));

  if (reduceMotion) {
    // static but complete: show final values, no timers
    if (rt) rt.querySelectorAll("i").forEach(b => b.style.setProperty("--v", b.dataset.v));
    if (gauge) gauge.style.strokeDashoffset = String(263.9 * (1 - 4.8 / 5));
    return { setDashActive() {} };
  }

  let dashActive = false;
  const workTick = initWorkspace(() => dashActive && !document.hidden);
  const counters = initCounters();
  const feedOn = watch(feed);
  const cmdOn = watch(document.getElementById("cmd"));
  const sysOn = watch(document.getElementById("sysBars"));
  const sysBars = document.querySelectorAll("#sysBars i");

  let sec = 0;
  setInterval(() => {
    if (document.hidden) return;
    sec++;
    workTick();
    if (sec % 3 === 0) counters();
    if (feed && feedOn() && sec % 4 === 0) {
      feed.insertBefore(feedItem(FEED[feedIdx++ % FEED.length], true), feed.firstChild);
      while (feed.children.length > 7) feed.lastElementChild.remove();
      relabelFeed(feed);
    }
    if (volTick && (cmdOn() || dashActive) && sec % 2 === 0) volTick();
    if (sysOn() && sec % 3 === 0) {
      sysBars.forEach(b => b.style.setProperty("--h", String(30 + Math.round(Math.random() * 65))));
    }
  }, 1000);

  return {
    /** journey tells us when the dashboard is close enough to read */
    setDashActive(on) {
      dashActive = on;
    },
  };
}
