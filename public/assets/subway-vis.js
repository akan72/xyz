// Live "which train is running right now" figure for the istheldown.com entry.
//
// Subscribes to istheldown's WebSocket (subway trains and subway alerts only),
// picks one subway line at random on every page load, and renders it with
// hydra-synth. A second canvas beside it maps every subway train, with the chosen
// line's trains in its color. Its space is reserved before the snapshot arrives;
// if istheldown can't be reached, the same space shows an unavailable state.
//
// A train counts as "running" once it has left its first stop (it has a
// previousStopId). Scheduled trips still waiting at their origin terminal are
// left out of every signal below and off the map.
//
// Signal -> knob. Every signal comes from the chosen line's running trains and
// is recomputed when the socket's diffs arrive (at most every 20 s). See knobs().
//
//   signal                          value (example)        knob                  effect
//   ------------------------------  ---------------------  --------------------  -----------------------------------------------
//   trains on the line              17                     bands = n, 4..60      osc() frequency: one band per train
//   trains' geographic axis         -42deg, via PCA        angle = axis + 90deg  bands run along the line's direction
//   northbound vs southbound        9 / 8                  drift, +-0.04..0.34   band slide; sign = the busier direction
//   share between stations          41% (ETA > 45 s)       speed, 0.08..0.33     global time rate
//   alerts naming the line / trains 5 / 17                 morph, 0.3..1.8       how fast the warp noise changes shape
//   alerts naming the line          5 of 15 max            jitter, 0.001..0.013  sub-pixel shimmer
//   the line                        F                      palette[0]            blob color = the line's official color
//   NYC hour (8 pm to 6 am = night) 19                     greys, bright         darker greys and brightness at night
//   train positions                 17 lat/lon points      warp field (s1)       blurred density map pushes the bands
//
// Fixed knobs (not data-driven): warp-noise scale 4 with 50 x 1 steps, warp 1,
// twist 1.57, pixel grid 112 x 140, feedback trail 0.12, three-tone thresholds
// 0.1 / 0.8, scanlines with a 3 px period, grain 0.12 at scale 300.
window.xyzMountProjects = function () {
  window.xyzDisposeProjects?.();
  const canvas = document.getElementById('subway-vis');
  const caption = document.getElementById('subway-vis-caption');
  if (!canvas) return;
  let disposed = false, suspended = false, activeSocket = null, socketTimer, retryTimer;
  const DEBUG = /[?&]debug\b/.test(location.search);
  const box = canvas.parentElement, captionBlock = caption.parentElement;
  const hide = reason => {
    try { console.info('[subway-vis] figure hidden: ' + reason); } catch (e) {}
    if (DEBUG) { captionBlock.hidden = false; caption.textContent = 'subway-vis hidden: ' + reason + ' | ' + navigator.userAgent; }
  };
  // Fetches can start early, but evaluating Hydra and compiling shaders must not interrupt the fade.
  function loadScript(src) {
    return new Promise(resolve => {
      const sc = document.createElement('script');
      const finish = () => { clearTimeout(timer); resolve(typeof Hydra !== 'undefined'); };
      const timer = setTimeout(finish, 5000);
      sc.onload = finish; sc.onerror = finish; sc.src = src;
      document.head.appendChild(sc);
    });
  }
  function ensureHydra() {
    if (typeof Hydra !== 'undefined') return Promise.resolve(true);
    if (window.xyzHydraLoading) return window.xyzHydraLoading;
    window.xyzHydraLoading = loadScript('https://cdn.jsdelivr.net/npm/hydra-synth@1.4.0/dist/hydra-synth.js')
      .then(ok => ok || loadScript('https://unpkg.com/hydra-synth@1.4.0/dist/hydra-synth.js'))
      .then(ok => { if (!ok) window.xyzHydraLoading = null; return ok; });
    return window.xyzHydraLoading;
  }

  const LINE = { '1': '#D82233', '2': '#D82233', '3': '#D82233', '4': '#009952', '5': '#009952', '6': '#009952', '7': '#9A38A1', A: '#0062CF', C: '#0062CF', E: '#0062CF', B: '#EB6800', D: '#EB6800', F: '#EB6800', M: '#EB6800', G: '#799534', J: '#8E5C33', Z: '#8E5C33', L: '#7C858C', N: '#F6BC26', Q: '#F6BC26', R: '#F6BC26', W: '#F6BC26' };
  const CANDIDATES = Object.keys(LINE);          // mainline services only; no shuttles or express variants
  const WS_URL = 'wss://istheldown.com/ws?systems=subway&alerts=subway'; // subway trains + subway alerts only (istheldown D-123)
  const STATIONS_URL = '/assets/subway-stations.json';
  const BBOX = { lonMin: -74.26, lonMax: -73.70, latMin: 40.49, latMax: 40.92 }, KX = Math.cos(40.7 * Math.PI / 180);
  const hex = h => [1, 3, 5].map(i => parseInt(h.slice(i, i + 2), 16) / 255);
  const clamp = (v, a, b) => Math.max(a, Math.min(b, v));
  const parentOf = s => (s && /[NS]$/.test(s)) ? s.slice(0, -1) : s;

  // --- renderer (created only once a snapshot has arrived, so a dead feed never shows a black box) ---
  let hydra = null, S = null;
  const wrap = box.closest('.figs') || box;
  function show() { wrap.dataset.state = 'ready'; }
  function remove(reason) {
    stop();
    wrap.dataset.state = 'unavailable';
    caption.textContent = 'Live transit preview unavailable. Visit istheldown.com for the current map.';
    hide(reason || 'unknown');
  }
  function createRenderer() {
    const W = Math.max(2, Math.min(260, Math.round(box.parentElement.clientWidth || 260))), H = Math.round(W * 1.25);
    hydra = new Hydra({ canvas, width: W, height: H, detectAudio: false, makeGlobal: false, autoLoop: false, enableStreamCapture: false });
    S = hydra.synth;
    S.s0.init({ src: dots, dynamic: true }); S.s1.init({ src: field, dynamic: true });
  }
  const dots = document.createElement('canvas'); dots.width = 280; dots.height = 350; const dctx = dots.getContext('2d');
  const field = document.createElement('canvas'); field.width = 70; field.height = 88; const fctx = field.getContext('2d');
  const scratch = document.createElement('canvas'); scratch.width = 70; scratch.height = 88; const sctx = scratch.getContext('2d');
  const seed = Math.floor(Math.random() * 10000);

  // Every data-driven value is read through a function, so hydra treats it as a uniform: the shader
  // source never changes, the graph is compiled exactly once (before the data arrives), and a new
  // snapshot only updates numbers. Two output programs: the feedback buffer and the colour/post pass.
  const K = { bands: 20, drift: 0.1, angle: 1.57, spin: 0, morph: 0.5, jitter: 0.002, bright: -0.1, lo: hex('#7c858c'), mid: hex('#525252'), hi: hex('#3d3d3d') };
  function buildGraph() {
    const u = k => () => K[k], c = (k, i) => () => K[k][i];   // read at draw time, so hydra makes them uniforms
    // 1. Shape: one band per train, turned to the line's axis, warped by noise and by where the trains are, snapped to a pixel grid.
    const shape = S.osc(u('bands'), u('drift'), 0).rotate(u('angle'), u('spin'))
      .modulate(S.noise(4, u('morph')).pixelate(50, 1).rotate(seed, 0.75), 1)
      .modulate(S.src(S.s1), 0.35)
      .modulateRotate(S.noise(1, u('morph')).rotate(seed, 0.75), 1.57)
      .pixelate(112, 140);
    // 2. Feedback: o1 keeps 88% of the previous frame each frame, which smears the motion.
    S.src(S.o1).blend(shape, 0.12).out(S.o1);
    // 3. Three tones by brightness: line color below 0.1, mid grey between, dark grey above 0.8.
    const L = () => S.src(S.o1);
    S.solid(c('lo', 0), c('lo', 1), c('lo', 2)).mult(L().thresh(0.1).invert())
      .add(S.solid(c('mid', 0), c('mid', 1), c('mid', 2)).mult(L().thresh(0.1).mult(L().thresh(0.8).invert())))
      .add(S.solid(c('hi', 0), c('hi', 1), c('hi', 2)).mult(L().thresh(0.8)))
      // 4. Post: shimmer, scanlines, grain, overall brightness.
      .modulate(S.noise(1000, 5), u('jitter'))
      // Scanlines, locked to a 3 px period of the canvas so they never alias into wide bars
      .mult(S.osc(() => 2 * Math.PI * S.width / 3, 0, 0).color(0.35, 0.35, 0.35).add(S.solid(0.75, 0.75, 0.75)))
      .add(S.noise(300, 20).luma(0.6, 0.1), 0.12)
      .brightness(u('bright'))
      .out(S.o2);
    S.render(S.o2);
  }
  function applyKnobs(k) {
    Object.assign(K, { bands: k.bands, drift: k.drift, angle: k.angle, spin: k.spin, morph: k.morph, jitter: k.jitter, bright: k.bright });
    [K.lo, K.mid, K.hi] = k.pal.map(hex);
    S.speed = k.speed;
  }

  // --- frame loop: pauses offscreen, on hidden tabs, and for reduced motion ---
  let raf = null, last = 0, visible = true, frameNo = 0, scene = null, warmup = 0;
  const reduced = matchMedia('(prefers-reduced-motion: reduce)').matches;
  function frame(t) {
    raf = null;
    if (!hydra || document.hidden || !visible) return;
    if (warmup) {
      // Settle the feedback a frame at a time so navigation and scrolling stay responsive.
      hydra.tick(16);
      if (--warmup === 0) show();
    } else {
      const dt = Math.min(t - last, 100);
      frameNo++;
      if (scene && frameNo % 30 === 0) drawInputs(scene);
      hydra.tick(dt);
    }
    last = t;
    if (warmup || !reduced) raf = requestAnimationFrame(frame);
  }
  function start() { if (disposed || suspended || !hydra || !scene || raf !== null || (reduced && !warmup) || document.hidden || !visible) return; last = performance.now(); raf = requestAnimationFrame(frame); }
  function stop() { cancelAnimationFrame(raf); raf = null; }
  const settle = () => { warmup = 24; start(); };
  const observer = new IntersectionObserver(([e]) => { visible = e.isIntersecting; visible ? start() : stop(); }, { threshold: 0 });
  observer.observe(box);
  const onVisibility = () => (document.hidden ? stop() : start());
  document.addEventListener('visibilitychange', onVisibility);
  const pause = () => { suspended = true; stop(); };
  window.xyzPauseProjects = pause;
  window.xyzDisposeProjects = () => {
    if (disposed) return;
    disposed = true;
    stop();
    observer.disconnect();
    document.removeEventListener('visibilitychange', onVisibility);
    clearTimeout(socketTimer); clearTimeout(retryTimer);
    if (activeSocket) { activeSocket.onclose = null; activeSocket.onmessage = null; activeSocket.close(); }
    if (window.__subway) {
      window.__subway.ws.removeEventListener('message', window.__subway.onmsg);
      if (window.__subway.ws !== activeSocket) window.__subway.ws.close();
      delete window.__subway;
    }
    if (window.xyzPauseProjects === pause) window.xyzPauseProjects = null;
    hydra?.regl.destroy();
    hydra = null;
  };

  // --- data: one random line from the live feed ---
  function project(lat, lon, w, h) {
    const wDeg = (BBOX.lonMax - BBOX.lonMin) * KX, hDeg = BBOX.latMax - BBOX.latMin;
    const s = Math.min(w / wDeg, h / hDeg) * 0.94;
    return [(w - wDeg * s) / 2 + (lon - BBOX.lonMin) * KX * s, (h - hDeg * s) / 2 + (BBOX.latMax - lat) * s];
  }
  // A train with no previous stop is a scheduled trip still waiting at its first terminal: not running yet.
  const running = t => !!t.previousStopId;
  function positions(sc, trains) {
    const now = sc.serverTime + (performance.now() - sc.receivedAt) / 1000, out = [];
    for (const t of (trains || sc.trains).values()) {
      if (!running(t)) continue;
      const n = sc.stations[parentOf(t.nextStopId)], p = sc.stations[parentOf(t.previousStopId)];
      if (!n && !p) continue;
      if (n && p && t.previousStopArrival && t.nextStopArrival && t.nextStopArrival > t.previousStopArrival) {
        const f = clamp((now - t.previousStopArrival) / (t.nextStopArrival - t.previousStopArrival), 0, 1);
        out.push([p[0] + (n[0] - p[0]) * f, p[1] + (n[1] - p[1]) * f]);
      } else { const s = n || p; out.push([s[0], s[1]]); }
    }
    return out;
  }
  const map = document.getElementById('subway-map'), mctx = map && map.getContext('2d');
  function drawMap(sc, mine) {
    if (!mctx) return;
    const w = map.width, h = map.height;
    mctx.fillStyle = '#000'; mctx.fillRect(0, 0, w, h);
    mctx.fillStyle = 'rgba(255,255,255,0.45)';
    for (const [lat, lon] of positions(sc, sc.all)) { const [x, y] = project(lat, lon, w, h); mctx.fillRect(Math.round(x) - 1, Math.round(y) - 1, 3, 3); }
    mctx.fillStyle = LINE[sc.route];
    for (const [lat, lon] of mine) { const [x, y] = project(lat, lon, w, h); mctx.beginPath(); mctx.arc(x, y, 5, 0, Math.PI * 2); mctx.fill(); }
  }
  function drawInputs(sc) {
    const pos = positions(sc);
    drawMap(sc, pos);
    dctx.fillStyle = '#000'; dctx.fillRect(0, 0, dots.width, dots.height); dctx.fillStyle = '#fff';
    for (const [lat, lon] of pos) { const [x, y] = project(lat, lon, dots.width, dots.height); dctx.fillRect(Math.round(x), Math.round(y), 1, 1); }
    sctx.fillStyle = '#000'; sctx.fillRect(0, 0, 70, 88); sctx.fillStyle = 'rgba(255,255,255,0.10)';
    for (const [lat, lon] of pos) { const [x, y] = project(lat, lon, 70, 88); sctx.beginPath(); sctx.arc(x, y, 5, 0, Math.PI * 2); sctx.fill(); }
    fctx.filter = 'none'; fctx.fillStyle = '#000'; fctx.fillRect(0, 0, 70, 88); fctx.filter = 'blur(4px)'; fctx.drawImage(scratch, 0, 0); fctx.filter = 'none';
    return pos;
  }
  function knobs(sc) {
    const ts = [...sc.trains.values()].filter(running), n = ts.length, now = sc.serverTime;
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
      bands: clamp(n, 4, 60),                     // one band per running train
      angle: axis + Math.PI / 2, spin: 0,         // bands run along the line's principal geographic axis
      drift: (N >= Sn ? 1 : -1) * (0.04 + 0.6 * Math.abs(N / Math.max(1, N + Sn) - 0.5)),   // slide toward the busier direction
      morph: 0.3 + 1.5 * clamp(alerts / Math.max(1, n), 0, 1),   // more alerts per train, faster-changing warp
      speed: 0.08 + 0.25 * moving,                // share of trains between stations sets the time rate
      jitter: 0.001 + 0.012 * clamp(alerts / 15, 0, 1),          // alerts naming the line add shimmer
      bright: night ? -0.12 : -0.1,               // slightly darker at night (8 pm to 6 am NYC time)
      pal: [LINE[sc.route], night ? '#404040' : '#525252', night ? '#2a2a2a' : '#3d3d3d'],   // line color, then two greys
      n, alerts, moving,
    };
  }
  function describe(sc, k, live) {
    const one = k.n === 1;
    caption.innerHTML = 'There ' + (one ? 'is ' : 'are ') + k.n + ' <img class="bullet" src="/assets/bullets/' + sc.route + '.svg" alt="' + sc.route + '" width="18" height="18"> train' + (one ? '' : 's') + ' running right now! Refresh to see a different line.';
  }

  (async () => {
    await window.__pageTransitionFinished;
    if (disposed || suspended) return;
    if (!(await ensureHydra())) return disposed ? undefined : remove('hydra-synth did not load from jsDelivr or unpkg');
    if (disposed || suspended) return;
    // Create the renderer and compile the shader graph now, so the only work left when the snapshot lands is one rebuild with real numbers.
    try { createRenderer(); buildGraph(); hydra.tick(16); }
    catch (e) { return remove('renderer failed (WebGL?): ' + e); }
    const pre = window.__subway || null;
    let stations;
    try { stations = await (pre && pre.stations ? pre.stations : fetch(STATIONS_URL).then(r => { if (!r.ok) throw new Error(r.status); return r.json(); })); } catch (e) { return remove('station file failed: ' + e); }
    if (disposed || suspended) return;
    let attempts = 0;
    const connect = () => {
    if (disposed || suspended) return;
    attempts++;
    // First attempt: adopt the socket the page opened in <head>, replaying anything it already queued.
    const early = attempts === 1 && pre && pre.ws && pre.closed === null ? pre : null;
    let ws;
    if (early) ws = early.ws; else { try { ws = new WebSocket(WS_URL); } catch (e) { return remove('WebSocket constructor failed: ' + e); } }
    activeSocket = ws;
    const elapsed = early ? performance.now() - early.t0 : 0;
    const timer = socketTimer = setTimeout(() => { if (!disposed && !scene) { try { ws.close(); } catch (e) {} remove('no snapshot within 20 s'); } }, Math.max(2000, 20000 - elapsed));
    const subway = t => (t.system || 'subway') === 'subway';
    let lastBuild = 0, dirty = false;
    ws.onmessage = ev => {
      if (disposed || suspended) return;
      let m; try { m = JSON.parse(ev.data); } catch (e) { return; }
      if (m.type === 'snapshot' && !scene) {
        clearTimeout(timer);
        const counts = {}; m.trains.filter(t => subway(t) && running(t)).forEach(t => { counts[t.routeId] = (counts[t.routeId] || 0) + 1; });
        const pool = CANDIDATES.filter(r => (counts[r] || 0) >= 3);
        if (!pool.length) { try { ws.close(); } catch (e) {} return remove('no line with 3+ trains in the snapshot'); }
        const route = pool[Math.floor(Math.random() * pool.length)];
        scene = { route, stations, trains: new Map(), all: new Map(), alerts: 0, serverTime: m.serverTime, receivedAt: performance.now() };
        m.trains.forEach(t => { if (!subway(t)) return; scene.all.set(t.tripId, t); if (t.routeId === route) scene.trains.set(t.tripId, t); });
        scene.alerts = m.alerts.filter(a => (a.system || 'subway') === 'subway' && a.routeIds.includes(route)).length;
        drawInputs(scene); const k = knobs(scene); applyKnobs(k); describe(scene, k, true); settle(); lastBuild = performance.now();
      } else if (!scene) return;
      else if (m.type === 'trains') { m.updated.forEach(t => { if (!subway(t)) return; scene.all.set(t.tripId, t); if (t.routeId === scene.route) scene.trains.set(t.tripId, t); }); m.removed.forEach(id => { scene.trains.delete(id); scene.all.delete(id); }); dirty = true; }
      else if (m.type === 'alerts') { scene.alerts = m.alerts.filter(a => (a.system || 'subway') === 'subway' && a.routeIds.includes(scene.route)).length; dirty = true; }
      else return;
      scene.serverTime = m.serverTime; scene.receivedAt = performance.now();
      if (dirty && performance.now() - lastBuild > 20000) { const k = knobs(scene); applyKnobs(k); describe(scene, k, true); lastBuild = performance.now(); dirty = false; }
    };
    // Before the first snapshot, any failure means "no figure". After it, the last state simply stays on screen.
    ws.onerror = () => {};
    ws.onclose = ev => {
      if (disposed || suspended) return;
      if (scene) return describe(scene, knobs(scene), false);
      clearTimeout(timer);
      if (attempts < 2) retryTimer = setTimeout(connect, 1500); else remove('socket closed before a snapshot (code ' + ev.code + ')');
    };
    if (early) { ws.removeEventListener('message', early.onmsg); const q = early.queue.splice(0); q.forEach(d => ws.onmessage({ data: d })); if (early.closed !== null && !scene) ws.onclose({ code: early.closed }); }
    };
    connect();
  })();
};
window.xyzMountProjects();
