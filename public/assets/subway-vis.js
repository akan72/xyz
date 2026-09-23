// Live "which train is running right now" figure for the istheldown.com entry.
// Subscribes to istheldown's WebSocket, picks one subway line at random on every
// page load, and renders it with hydra-synth: one band per train on that line,
// bands turned to the line's geographic axis, the line's official color, and the
// trains' positions (blurred) warping the shape. Falls back to a fixed sketch if
// the feed can't be reached.
(function () {
  const canvas = document.getElementById('subway-vis');
  const caption = document.getElementById('subway-vis-caption');
  if (!canvas || typeof Hydra === 'undefined') return;

  const LINE = { '1': '#D82233', '2': '#D82233', '3': '#D82233', '4': '#009952', '5': '#009952', '6': '#009952', '7': '#9A38A1', A: '#0062CF', C: '#0062CF', E: '#0062CF', B: '#EB6800', D: '#EB6800', F: '#EB6800', M: '#EB6800', G: '#799534', J: '#8E5C33', Z: '#8E5C33', L: '#7C858C', N: '#F6BC26', Q: '#F6BC26', R: '#F6BC26', W: '#F6BC26' };
  const CANDIDATES = Object.keys(LINE);          // mainline services only; no shuttles or express variants
  const WS_URL = 'wss://istheldown.com/ws';
  const STATIONS_URL = '/assets/subway-stations.json';
  const BBOX = { lonMin: -74.26, lonMax: -73.70, latMin: 40.49, latMax: 40.92 }, KX = Math.cos(40.7 * Math.PI / 180);
  const hex = h => [1, 3, 5].map(i => parseInt(h.slice(i, i + 2), 16) / 255);
  const clamp = (v, a, b) => Math.max(a, Math.min(b, v));
  const parentOf = s => (s && /[NS]$/.test(s)) ? s.slice(0, -1) : s;

  // --- renderer ---
  const box = canvas.parentElement;
  const W = Math.max(2, Math.round(box.clientWidth)), H = Math.max(2, Math.round(box.clientHeight));
  const hydra = new Hydra({ canvas, width: W, height: H, detectAudio: false, makeGlobal: false, autoLoop: false, enableStreamCapture: false });
  const S = hydra.synth;
  const dots = document.createElement('canvas'); dots.width = 280; dots.height = 350; const dctx = dots.getContext('2d');
  const field = document.createElement('canvas'); field.width = 70; field.height = 88; const fctx = field.getContext('2d');
  const scratch = document.createElement('canvas'); scratch.width = 70; scratch.height = 88; const sctx = scratch.getContext('2d');
  S.s0.init({ src: dots, dynamic: true }); S.s1.init({ src: field, dynamic: true });
  const seed = Math.floor(Math.random() * 10000);

  function build(p, withData) {
    const [lo, mid, hi] = p.pal.map(hex);
    let shape = S.osc(p.bands, p.drift, 0).rotate(p.angle, p.spin)
      .modulate(S.noise(4, p.morph).pixelate(50, 1).rotate(seed, 0.75), 1);
    if (withData) shape = shape.modulate(S.src(S.s1), 0.35);
    shape.modulateRotate(S.noise(1, p.morph).rotate(seed, 0.75), 1.57).pixelate(112, 140).out(S.o0);
    S.src(S.o1).blend(S.src(S.o0), 0.12).out(S.o1);
    const L = () => S.src(S.o1);
    S.solid(...lo).mult(L().thresh(0.1).invert())
      .add(S.solid(...mid).mult(L().thresh(0.1).mult(L().thresh(0.8).invert())))
      .add(S.solid(...hi).mult(L().thresh(0.8)))
      .out(S.o2);
    S.src(S.o2).modulate(S.noise(1000, 5), p.jitter)
      .add(S.noise(300, 20).luma(0.6, 0.1), 0.12)
      .brightness(p.bright)
      .out(S.o3);
    S.render(S.o3);
    S.speed = p.speed;
  }

  // --- frame loop: pauses offscreen, on hidden tabs, and for reduced motion ---
  let raf = null, last = 0, visible = true, frameNo = 0, scene = null;
  const reduced = matchMedia('(prefers-reduced-motion: reduce)').matches;
  function frame(t) { const dt = Math.min(t - last, 100); last = t; frameNo++; if (scene && frameNo % 30 === 0) drawInputs(scene); hydra.tick(dt); raf = requestAnimationFrame(frame); }
  function start() { if (raf || reduced || document.hidden || !visible) return; last = performance.now(); raf = requestAnimationFrame(frame); }
  function stop() { cancelAnimationFrame(raf); raf = null; }
  const settle = () => { for (let k = 0; k < 40; k++) hydra.tick(16); };
  new IntersectionObserver(([e]) => { visible = e.isIntersecting; visible ? start() : stop(); }, { threshold: 0 }).observe(box);
  document.addEventListener('visibilitychange', () => (document.hidden ? stop() : start()));

  // --- data: one random line from the live feed ---
  function project(lat, lon, w, h) {
    const wDeg = (BBOX.lonMax - BBOX.lonMin) * KX, hDeg = BBOX.latMax - BBOX.latMin;
    const s = Math.min(w / wDeg, h / hDeg) * 0.94;
    return [(w - wDeg * s) / 2 + (lon - BBOX.lonMin) * KX * s, (h - hDeg * s) / 2 + (BBOX.latMax - lat) * s];
  }
  function positions(sc) {
    const now = sc.serverTime + (performance.now() - sc.receivedAt) / 1000, out = [];
    for (const t of sc.trains.values()) {
      const n = sc.stations[parentOf(t.nextStopId)], p = sc.stations[parentOf(t.previousStopId)];
      if (!n && !p) continue;
      if (n && p && t.previousStopArrival && t.nextStopArrival && t.nextStopArrival > t.previousStopArrival) {
        const f = clamp((now - t.previousStopArrival) / (t.nextStopArrival - t.previousStopArrival), 0, 1);
        out.push([p[0] + (n[0] - p[0]) * f, p[1] + (n[1] - p[1]) * f]);
      } else { const s = n || p; out.push([s[0], s[1]]); }
    }
    return out;
  }
  function drawInputs(sc) {
    const pos = positions(sc);
    dctx.fillStyle = '#000'; dctx.fillRect(0, 0, dots.width, dots.height); dctx.fillStyle = '#fff';
    for (const [lat, lon] of pos) { const [x, y] = project(lat, lon, dots.width, dots.height); dctx.fillRect(Math.round(x), Math.round(y), 1, 1); }
    sctx.fillStyle = '#000'; sctx.fillRect(0, 0, 70, 88); sctx.fillStyle = 'rgba(255,255,255,0.10)';
    for (const [lat, lon] of pos) { const [x, y] = project(lat, lon, 70, 88); sctx.beginPath(); sctx.arc(x, y, 5, 0, Math.PI * 2); sctx.fill(); }
    fctx.filter = 'none'; fctx.fillStyle = '#000'; fctx.fillRect(0, 0, 70, 88); fctx.filter = 'blur(4px)'; fctx.drawImage(scratch, 0, 0); fctx.filter = 'none';
    return pos;
  }
  function knobs(sc) {
    const ts = [...sc.trains.values()], n = ts.length, now = sc.serverTime;
    const N = ts.filter(t => t.direction === 'N').length, Sn = ts.filter(t => t.direction === 'S').length;
    const eta = ts.filter(t => t.nextStopArrival), moving = eta.filter(t => t.nextStopArrival - now > 45).length / Math.max(1, eta.length);
    const pos = positions(sc); let axis = 0;
    if (pos.length > 2) {
      const xs = pos.map(p => p[1] * KX), ys = pos.map(p => p[0]);
      const mx = xs.reduce((a, b) => a + b, 0) / xs.length, my = ys.reduce((a, b) => a + b, 0) / ys.length;
      let sxx = 0, syy = 0, sxy = 0;
      for (let k = 0; k < xs.length; k++) { const dx = xs[k] - mx, dy = ys[k] - my; sxx += dx * dx; syy += dy * dy; sxy += dx * dy; }
      axis = 0.5 * Math.atan2(2 * sxy, sxx - syy);
    }
    const hour = +new Intl.DateTimeFormat('en-US', { timeZone: 'America/New_York', hour: 'numeric', hour12: false }).format(new Date(now * 1000)) % 24;
    const night = hour < 6 || hour >= 20, alerts = sc.alerts;
    return {
      bands: clamp(n, 4, 60), angle: axis + Math.PI / 2, spin: 0,
      drift: (N >= Sn ? 1 : -1) * (0.04 + 0.6 * Math.abs(N / Math.max(1, N + Sn) - 0.5)),
      morph: 0.3 + 1.5 * clamp(alerts / Math.max(1, n), 0, 1), speed: 0.08 + 0.25 * moving,
      jitter: 0.001 + 0.012 * clamp(alerts / 15, 0, 1), bright: night ? -0.12 : -0.1,
      pal: [LINE[sc.route], night ? '#404040' : '#525252', night ? '#2a2a2a' : '#3d3d3d'],
      n, alerts, moving,
    };
  }
  function describe(sc, k, live) {
    caption.innerHTML = '<span class="bullet" style="background:' + LINE[sc.route] + '">' + sc.route + '</span> ' +
      k.n + ' ' + sc.route + ' train' + (k.n === 1 ? '' : 's') + ' running, ' + k.alerts + ' alert' + (k.alerts === 1 ? '' : 's') +
      (live ? ' &middot; live from istheldown.com' : '') + '. One band per train, turned to the line’s axis. Refresh for another line.';
  }
  function fallback(msg) {
    build({ bands: 20, drift: 0.1, angle: 1.57, spin: 0.1, morph: 0.5, speed: 0.15, jitter: 0.002, bright: -0.1, pal: ['#ff7aed', '#525252', '#3d3d3d'] }, false);
    caption.textContent = msg;
    settle(); start();
  }

  (async () => {
    let stations;
    try { stations = await (await fetch(STATIONS_URL)).json(); } catch (e) { return fallback('Couldn’t load station data.'); }
    let ws; try { ws = new WebSocket(WS_URL); } catch (e) { return fallback('Couldn’t reach istheldown.com.'); }
    const timer = setTimeout(() => { try { ws.close(); } catch (e) {} if (!scene) fallback('Couldn’t reach istheldown.com.'); }, 8000);
    const subway = t => (t.system || 'subway') === 'subway';
    let lastBuild = 0, dirty = false;
    ws.onmessage = ev => {
      const m = JSON.parse(ev.data);
      if (m.type === 'snapshot') {
        clearTimeout(timer);
        const counts = {}; m.trains.filter(subway).forEach(t => { counts[t.routeId] = (counts[t.routeId] || 0) + 1; });
        const pool = CANDIDATES.filter(r => (counts[r] || 0) >= 3);
        const route = (pool.length ? pool : CANDIDATES)[Math.floor(Math.random() * (pool.length || CANDIDATES.length))];
        scene = { route, stations, trains: new Map(), alerts: 0, serverTime: m.serverTime, receivedAt: performance.now() };
        m.trains.forEach(t => { if (subway(t) && t.routeId === route) scene.trains.set(t.tripId, t); });
        scene.alerts = m.alerts.filter(a => (a.system || 'subway') === 'subway' && a.routeIds.includes(route)).length;
        drawInputs(scene); const k = knobs(scene); build(k, true); describe(scene, k, true); settle(); start(); lastBuild = performance.now();
      } else if (!scene) return;
      else if (m.type === 'trains') { m.updated.forEach(t => { if (subway(t) && t.routeId === scene.route) scene.trains.set(t.tripId, t); }); m.removed.forEach(id => scene.trains.delete(id)); dirty = true; }
      else if (m.type === 'alerts') { scene.alerts = m.alerts.filter(a => (a.system || 'subway') === 'subway' && a.routeIds.includes(scene.route)).length; dirty = true; }
      else return;
      scene.serverTime = m.serverTime; scene.receivedAt = performance.now();
      if (dirty && performance.now() - lastBuild > 20000) { const k = knobs(scene); build(k, true); describe(scene, k, true); lastBuild = performance.now(); dirty = false; }
    };
    ws.onerror = () => { if (!scene) { clearTimeout(timer); fallback('Couldn’t reach istheldown.com.'); } };
  })();
})();
