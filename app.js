// Демо-стенд: проигрывает записи трёх камер синхронно и рисует поверх результат платформы из data/run.json.
const $ = (id) => document.getElementById(id);
const fmt = (t) => {
  const s = Math.max(0, Math.floor(t));
  return `${String(Math.floor(s / 60)).padStart(2, "0")}:${String(s % 60).padStart(2, "0")}`;
};
const shortName = (name) => name.split("·")[0].trim();

let R, vids = {}, leader, speed = 1, playing = true;
let colors = {};
const ui = { count: -1, belt: -1, active: undefined, see: -1, sw: -1, statuses: "" };

function readColors() {
  const cs = getComputedStyle(document.documentElement);
  for (const k of ["belt", "tracking", "counted", "off", "ready", "ok", "frame", "muted"]) {
    colors[k] = cs.getPropertyValue(`--${k}`).trim();
  }
}

// ---------- кадр таймлайна для момента t ----------
function recAt(t) {
  const T = R.timeline;
  let lo = 0, hi = T.length - 1;
  while (lo < hi) {
    const mid = (lo + hi + 1) >> 1;
    if (T[mid].t <= t + 1e-6) lo = mid; else hi = mid - 1;
  }
  return T[lo];
}

// ---------- отрисовка камеры с разметкой ----------
function fitCanvas(c) {
  const dpr = window.devicePixelRatio || 1;
  const w = Math.round(c.clientWidth * dpr), h = Math.round(c.clientHeight * dpr);
  if (c.width !== w || c.height !== h) { c.width = w; c.height = h; }
  return dpr;
}

function drawCam(canvas, cam, rec, { arrow = false } = {}) {
  const dpr = fitCanvas(canvas);
  const ctx = canvas.getContext("2d");
  const W = canvas.width, H = canvas.height;
  ctx.fillStyle = colors.frame || "#0e0e0d";
  ctx.fillRect(0, 0, W, H);
  if (!cam) return;
  const v = vids[cam.id];
  const k = Math.min(W / cam.w, H / cam.h);
  const ox = (W - cam.w * k) / 2, oy = (H - cam.h * k) / 2;
  if (v.readyState >= 2) ctx.drawImage(v, ox, oy, cam.w * k, cam.h * k);
  const st = rec && rec.cams[cam.id];
  if (!st) return;
  const X = (x) => ox + x * k, Y = (y) => oy + y * k;

  if (st.belt) {
    const [x1, y1, x2, y2] = st.belt;
    ctx.setLineDash([8 * dpr, 6 * dpr]);
    ctx.lineWidth = 2 * dpr;
    ctx.strokeStyle = colors.belt;
    ctx.strokeRect(X(x1), Y(y1), (x2 - x1) * k, (y2 - y1) * k);
    ctx.setLineDash([]);
    if (arrow && cam.flow) {
      const [[ax, ay], [bx, by]] = cam.flow;
      const A = [X(ax), Y(ay)], B = [X(bx), Y(by)];
      const ang = Math.atan2(B[1] - A[1], B[0] - A[0]), L = 14 * dpr;
      ctx.strokeStyle = ctx.fillStyle = colors.ready;
      ctx.globalAlpha = 0.85;
      ctx.lineWidth = 2.5 * dpr;
      ctx.beginPath(); ctx.moveTo(...A); ctx.lineTo(...B); ctx.stroke();
      ctx.beginPath(); ctx.moveTo(...B);
      ctx.lineTo(B[0] - L * Math.cos(ang - 0.45), B[1] - L * Math.sin(ang - 0.45));
      ctx.lineTo(B[0] - L * Math.cos(ang + 0.45), B[1] - L * Math.sin(ang + 0.45));
      ctx.closePath(); ctx.fill();
      ctx.globalAlpha = 1;
    }
  }
  for (const [, x1, y1, x2, y2, state] of st.rolls) {
    const col = state === "counted" ? colors.counted : state === "tracking" ? colors.tracking
      : state === "preexisting" ? colors.ready : colors.off;
    ctx.lineWidth = (state === "off" ? 1.5 : 2.5) * dpr;
    ctx.strokeStyle = col;
    if (state === "off") ctx.setLineDash([4 * dpr, 4 * dpr]);
    ctx.strokeRect(X(x1), Y(y1), (x2 - x1) * k, (y2 - y1) * k);
    ctx.setLineDash([]);
    if (state === "counted") {
      const r = 9 * dpr, cx = X(x2) - r - 3 * dpr, cy = Y(y1) + r + 3 * dpr;
      ctx.fillStyle = col;
      ctx.beginPath(); ctx.arc(cx, cy, r, 0, Math.PI * 2); ctx.fill();
      ctx.strokeStyle = "#fff"; ctx.lineWidth = 2 * dpr;
      ctx.beginPath(); ctx.moveTo(cx - r * 0.45, cy); ctx.lineTo(cx - r * 0.1, cy + r * 0.35); ctx.lineTo(cx + r * 0.5, cy - r * 0.35); ctx.stroke();
    }
  }
}

// ---------- плитки камер ----------
function buildTiles() {
  const box = $("tiles");
  for (const c of R.cams) {
    const el = document.createElement("div");
    el.className = "tile";
    el.dataset.id = c.id;
    el.innerHTML = `<div class="frame"><canvas aria-label="${c.name}"></canvas></div>
      <div class="meta"><span class="name" title="${c.name}">${c.name}</span><span class="pill"></span></div>`;
    box.appendChild(el);
  }
}

// ---------- график: накопленный счёт + полосы статусов камер ----------
// Размеры в настоящих пикселях контейнера, чтобы подписи не мельчали; при ресайзе перестраиваем.
const CH = { x0: 74, x1: 0, top: 12, h: 110, lane: 16, gap: 9 };
let chartSvg, headLine, futureRect, chartW = 0;

function buildChart() {
  const host = $("chart");
  const W = Math.max(280, Math.round(host.clientWidth));
  if (W === chartW && chartSvg) return;
  chartW = W;
  CH.x0 = W < 420 ? 64 : 74;
  CH.x1 = W - 10;
  host.replaceChildren();
  const dur = R.duration, ev = R.events, cams = R.cams;
  const xs = (t) => CH.x0 + (t / dur) * (CH.x1 - CH.x0);
  const maxN = Math.max(ev.length, 1);
  const ys = (n) => CH.top + CH.h - (n / maxN) * CH.h;
  const lanesTop = CH.top + CH.h + 34;
  const height = lanesTop + cams.length * (CH.lane + CH.gap) + 4;
  const NS = "http://www.w3.org/2000/svg";
  const svg = document.createElementNS(NS, "svg");
  svg.setAttribute("viewBox", `0 0 ${W} ${height}`);
  svg.setAttribute("height", height);
  svg.setAttribute("role", "img");
  svg.setAttribute("aria-label", `Засчитано ${ev.length} рулонов за ${Math.round(dur)} секунд; полосы показывают состояние каждой камеры`);
  const add = (tag, attrs, text) => {
    const n = document.createElementNS(NS, tag);
    for (const [a, v] of Object.entries(attrs)) n.setAttribute(a, v);
    if (text != null) n.textContent = text;
    svg.appendChild(n);
    return n;
  };
  // сетка и подписи по Y
  const stepY = maxN <= 5 ? 1 : Math.ceil(maxN / 5);
  for (let n = 0; n <= maxN; n += stepY) {
    add("line", { x1: CH.x0, x2: CH.x1, y1: ys(n), y2: ys(n), class: "grid" });
    add("text", { x: CH.x0 - 10, y: ys(n) + 4, "text-anchor": "end", class: "axis" }, n);
  }
  // ось времени
  const tickStep = W < 420 ? 10 : 5;
  for (let t = 0; t <= dur + 0.01; t += tickStep) {
    add("text", { x: xs(t), y: CH.top + CH.h + 18, "text-anchor": "middle", class: "axis" }, fmt(t));
  }
  // ступенчатая линия счёта
  let d = `M${xs(0)},${ys(0)}`;
  ev.forEach((e, i) => { d += ` H${xs(e.t)} V${ys(i + 1)}`; });
  d += ` H${xs(dur)}`;
  add("path", { d: `${d} V${ys(0)} H${xs(0)} Z`, class: "area" });
  add("path", { d, class: "count" });
  ev.forEach((e, i) => add("circle", { cx: xs(e.t), cy: ys(i + 1), r: 5, class: "dot" }));
  // полосы камер
  cams.forEach((c, ci) => {
    const y = lanesTop + ci * (CH.lane + CH.gap);
    add("text", { x: CH.x0 - 10, y: y + CH.lane - 4, "text-anchor": "end", class: "lane-name" }, shortName(c.name));
    let start = 0, cur = R.timeline[0].cams[c.id].s;
    const flush = (end) => add("rect", { x: xs(start), y, width: Math.max(1, xs(end) - xs(start)), height: CH.lane, rx: 3, class: `seg ${cur}` });
    for (const rec of R.timeline) {
      const s = rec.cams[c.id].s;
      if (s !== cur) { flush(rec.t); start = rec.t; cur = s; }
    }
    flush(dur);
  });
  futureRect = add("rect", { x: CH.x0, y: 0, width: 0, height, class: "future" });
  headLine = add("line", { x1: CH.x0, x2: CH.x0, y1: 4, y2: height - 2, class: "head" });
  chartSvg = svg;
  host.appendChild(svg);

  const legend = document.createElement("ul");
  legend.className = "chart-legend";
  legend.innerHTML = [["active", "считает", "var(--ok)"], ["ready", "видит ленту", "color-mix(in srgb, var(--ready) 55%, transparent)"],
    ["blocked", "перекрыта", "var(--warn)"], ["no_belt", "ленты не видно", "color-mix(in srgb, var(--idle) 35%, transparent)"]]
    .map(([, l, c]) => `<li><i style="background:${c}"></i>${l}</li>`).join("");
  host.appendChild(legend);

  // перемотка кликом/перетаскиванием по графику
  const seekFromEvent = (e) => {
    const r = svg.getBoundingClientRect();
    const x = ((e.clientX - r.left) / r.width) * W;
    seek(((Math.min(Math.max(x, CH.x0), CH.x1) - CH.x0) / (CH.x1 - CH.x0)) * dur);
  };
  let dragging = false;
  svg.addEventListener("pointerdown", (e) => { dragging = true; svg.setPointerCapture(e.pointerId); seekFromEvent(e); });
  svg.addEventListener("pointermove", (e) => { if (dragging) seekFromEvent(e); });
  svg.addEventListener("pointerup", () => { dragging = false; });
}

function moveHead(t) {
  const x = CH.x0 + (Math.min(t, R.duration) / R.duration) * (CH.x1 - CH.x0);
  headLine.setAttribute("x1", x);
  headLine.setAttribute("x2", x);
  futureRect.setAttribute("x", x);
  futureRect.setAttribute("width", Math.max(0, CH.x1 - x + 4));
}

// ---------- лента засчитанных рулонов ----------
function renderFeed(n, animate) {
  const list = $("feed");
  const camName = Object.fromEntries(R.cams.map((c) => [c.id, shortName(c.name)]));
  const items = R.events.slice(0, n).reverse();
  list.replaceChildren(...items.map((e, i) => {
    const li = document.createElement("li");
    if (animate && i === 0) li.className = "new";
    li.innerHTML = `${e.thumb ? `<img src="${e.thumb}" alt="Рулон №${e.n}">` : "<span></span>"}
      <div><div class="n">Рулон №${e.n}</div><div class="m">${fmt(e.t)} · ${camName[e.cam]}</div></div>`;
    return li;
  }));
  $("feed-empty").hidden = n > 0;
}

// ---------- обновление всего экрана ----------
function render(t) {
  const rec = recAt(t);
  const active = rec.active;
  const activeCam = R.cams.find((c) => c.id === active);

  drawCam($("live"), activeCam || R.cams[0], rec, { arrow: true });
  for (const c of R.cams) {
    const tile = document.querySelector(`.tile[data-id="${c.id}"]`);
    drawCam(tile.querySelector("canvas"), c, rec);
  }

  const n = R.events.filter((e) => e.t <= t + 1e-6).length;
  if (n !== ui.count) {
    const grew = n > ui.count && ui.count >= 0;
    $("k-count").textContent = n;
    if (grew) { const el = $("k-count"); el.classList.remove("bump"); void el.offsetWidth; el.classList.add("bump"); }
    renderFeed(n, grew);
    ui.count = n;
  }
  const onBelt = activeCam ? rec.cams[active].on : 0;
  if (onBelt !== ui.belt) { $("k-belt").textContent = onBelt; ui.belt = onBelt; }

  const sw = R.switches.filter((s) => s.from && s.to && s.t <= t + 1e-6).length;
  if (active !== ui.active || sw !== ui.sw) {
    $("k-cam").textContent = activeCam ? activeCam.name : "никто — ленты не видно";
    $("k-switch").textContent = `переключений: ${sw}`;
    ui.active = active; ui.sw = sw;
  }

  const statuses = R.cams.map((c) => rec.cams[c.id].s).join(",");
  if (statuses !== ui.statuses) {
    const see = R.cams.filter((c) => ["active", "ready"].includes(rec.cams[c.id].s)).length;
    $("k-see").innerHTML = `${see}<small> из ${R.cams.length}</small>`;
    const blocked = R.cams.filter((c) => rec.cams[c.id].s === "blocked").map((c) => shortName(c.name));
    $("k-see-sub").textContent = blocked.length ? `перекрыта: ${blocked.join(", ")}` : "камер";
    for (const c of R.cams) {
      const s = rec.cams[c.id].s;
      const tile = document.querySelector(`.tile[data-id="${c.id}"]`);
      tile.classList.toggle("active", s === "active");
      const pill = tile.querySelector(".pill");
      pill.className = `pill ${s}`;
      pill.textContent = R.labels[s];
    }
    const lp = $("live-pill");
    if (activeCam) { lp.className = "pill active"; lp.textContent = R.labels.active; }
    else { lp.className = "pill"; lp.textContent = "счёт на паузе"; }
    $("live-name").textContent = activeCam ? activeCam.name : "Ни одна камера не видит ленту";
    ui.statuses = statuses;
  }

  moveHead(t);
  $("clock").textContent = `${fmt(t)} / ${fmt(R.duration)}`;
}

// ---------- воспроизведение ----------
function eachVid(fn) { for (const v of Object.values(vids)) fn(v); }

function showPlaying(p) {
  playing = p;
  // У SVG нет свойства .hidden — только атрибут.
  $("ico-pause").toggleAttribute("hidden", !p);
  $("ico-play").toggleAttribute("hidden", p);
  $("play").setAttribute("aria-label", p ? "Пауза" : "Воспроизвести");
}

function setPlaying(p) {
  showPlaying(p);
  if (p) {
    if (leader.ended || leader.currentTime >= R.duration - 0.05) seek(0);
    Promise.all(Object.values(vids).map((v) => v.play())).catch(() => {
      // Автозапуск не дали (вкладка открыта в фоне и т.п.): ждём, когда вкладку покажут или по ней кликнут.
      eachVid((v) => v.pause());
      showPlaying(false);
      const retry = (e) => {
        if (document.hidden) return;
        // Клик по самой кнопке обработает её собственный обработчик — иначе запуск тут же отменится.
        if (e && e.type === "pointerdown" && e.target.closest("#play")) return;
        document.removeEventListener("visibilitychange", retry);
        document.removeEventListener("pointerdown", retry);
        if (!playing) setPlaying(true);
      };
      document.addEventListener("visibilitychange", retry);
      document.addEventListener("pointerdown", retry);
    });
  } else {
    eachVid((v) => v.pause());
  }
}

function seek(t) {
  eachVid((v) => { v.currentTime = Math.min(t, (v.duration || R.duration) - 0.05); });
  render(t);
}

function tick() {
  const t = leader.currentTime;
  eachVid((v) => {
    if (v !== leader && Math.abs(v.currentTime - t) > 0.15 && !v.seeking) v.currentTime = t;
  });
  render(t);
  requestAnimationFrame(tick);
}

async function main() {
  readColors();
  matchMedia("(prefers-color-scheme: dark)").addEventListener("change", readColors);
  R = await (await fetch("data/run.json")).json();
  for (const c of R.cams) {
    const v = document.createElement("video");
    v.src = c.video;
    v.muted = true;
    v.playsInline = true;
    v.preload = "auto";
    v.setAttribute("playsinline", "");
    $("sources").appendChild(v);
    vids[c.id] = v;
  }
  leader = vids[R.cams[0].id];
  // Досмотрели — стоп на последнем кадре; «▶» начнёт заново (см. setPlaying).
  leader.addEventListener("ended", () => { eachVid((v) => v.pause()); showPlaying(false); render(R.duration); });

  buildTiles();
  buildChart();
  new ResizeObserver(() => { buildChart(); render(leader.currentTime); }).observe($("chart"));
  render(0);

  $("play").addEventListener("click", () => setPlaying(!playing));
  $("restart").addEventListener("click", () => { seek(0); setPlaying(true); });
  document.querySelectorAll("[data-speed]").forEach((b) => {
    b.setAttribute("aria-checked", b.classList.contains("on"));
    b.addEventListener("click", () => {
      speed = Number(b.dataset.speed);
      document.querySelectorAll("[data-speed]").forEach((x) => {
        x.classList.toggle("on", x === b);
        x.setAttribute("aria-checked", x === b);
      });
      eachVid((v) => { v.playbackRate = speed; });
    });
  });

  setPlaying(true);
  requestAnimationFrame(tick);
}

main();
