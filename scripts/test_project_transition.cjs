const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const path = require('node:path');
const root = path.resolve(__dirname, '..');
const html = fs.readFileSync(path.join(root, 'public/projects.html'), 'utf8');
const head = html.match(/<script>\s*([\s\S]*?)<\/script>/)[1];
const renderer = fs.readFileSync(path.join(root, 'public/assets/subway-vis.js'), 'utf8');

function page(supported = true) {
  let reveal;
  const scripts = [];
  const context = vm.createContext({
    window: { ...(supported ? { onpagereveal: null } : {}), addEventListener: (_, fn) => { reveal = fn; } },
    document: {
      getElementById: id => id === 'subway-vis' ? { parentElement: { closest: () => ({ dataset: {} }) } } : id === 'subway-vis-caption' ? { parentElement: {} } : null,
      createElement: kind => kind === 'canvas' ? { getContext: () => ({}) } : {},
      head: { appendChild: script => scripts.push(script) },
      addEventListener() {}, removeEventListener() {}, hidden: false,
    },
    WebSocket: class { constructor() { throw new Error('No feed in lifecycle test'); } },
    IntersectionObserver: class { observe() {} disconnect() {} },
    matchMedia: () => ({ matches: false }), location: { search: '' },
    setTimeout: () => 0, clearTimeout() {}, cancelAnimationFrame() {}, console,
  });
  vm.runInContext(head, context);
  vm.runInContext(renderer, context);
  return { scripts, reveal: event => reveal(event), pause: () => context.window.xyzPauseProjects() };
}
const flush = () => new Promise(resolve => setImmediate(resolve));

test('Hydra is not evaluated while the incoming page is fading', async () => {
  const p = page();
  await flush();
  assert.equal(p.scripts.length, 0);
  let finish;
  p.reveal({ viewTransition: { finished: new Promise(resolve => { finish = resolve; }) } });
  await flush();
  assert.equal(p.scripts.length, 0);
  finish();
  await flush();
  assert.equal(p.scripts.length, 1);
  assert.match(p.scripts[0].src, /cdn\.jsdelivr\.net/);
});

test('leaving before reveal prevents late renderer startup during the outgoing fade', async () => {
  const p = page();
  p.pause();
  p.reveal({ viewTransition: null });
  await flush();
  assert.equal(p.scripts.length, 0);
});

test('a skipped transition still starts the live preview', async () => {
  const p = page();
  p.reveal({ viewTransition: { finished: Promise.reject(new Error('Skipped')) } });
  await flush();
  assert.equal(p.scripts.length, 1);
});

test('direct loads and reduced-motion navigation do not wait for a transition', async () => {
  const p = page();
  p.reveal({ viewTransition: null });
  await flush();
  assert.equal(p.scripts.length, 1);
});

test('browsers without pagereveal keep the live preview', async () => {
  const p = page(false);
  await flush();
  assert.equal(p.scripts.length, 1);
});

test('a failed CDN starts the fallback loader after the transition', async () => {
  const p = page(false);
  await flush();
  p.scripts[0].onerror();
  await flush();
  assert.equal(p.scripts.length, 2);
  assert.match(p.scripts[1].src, /unpkg\.com/);
});

// Exercise the real frame scheduler without WebGL or a live network feed.
function scheduler(reduced = false) {
  const callbacks = new Map();
  let next = 1, ticks = 0, shown = 0, destroyed = 0, intersect, visibility;
  const context = vm.createContext({
    hydra: { tick() { ticks++; }, regl: { destroy() { destroyed++; } } },
    window: {}, disposed: false, suspended: false, activeSocket: null, socketTimer: null, retryTimer: null, clearTimeout() {},
    document: { hidden: false, addEventListener: (_, fn) => { visibility = fn; }, removeEventListener() {} },
    matchMedia: () => ({ matches: reduced }), performance: { now: () => 0 },
    requestAnimationFrame: fn => { const id = next++; callbacks.set(id, fn); return id; },
    cancelAnimationFrame: id => callbacks.delete(id),
    IntersectionObserver: class { constructor(fn) { intersect = fn; } observe() {} disconnect() {} },
    box: {}, show() { shown++; }, drawInputs() {},
  });
  const loop = renderer.slice(renderer.indexOf('  // --- frame loop:'), renderer.indexOf('  // --- data:'));
  vm.runInContext(loop + '\nthis.begin = () => { scene = {}; settle(); }; this.start = start;', context);
  return {
    begin: () => context.begin(), start: () => context.start(),
    step(t = 16) { const [id, fn] = callbacks.entries().next().value; callbacks.delete(id); fn(t); },
    visible(value) { intersect([{ isIntersecting: value }]); },
    hidden(value) { context.document.hidden = value; visibility(); },
    pause: () => context.window.xyzPauseProjects(), dispose: () => context.window.xyzDisposeProjects(),
    get destroyed() { return destroyed; }, get ticks() { return ticks; }, get shown() { return shown; }, get pending() { return callbacks.size; },
  };
}

test('the preview settles across frames and reveals only when the feedback is ready', () => {
  const s = scheduler();
  s.start();
  assert.equal(s.pending, 0, 'no animation before the first snapshot');
  s.begin();
  assert.equal(s.ticks, 0, 'startup must yield before rendering');
  for (let i = 1; i <= 24; i++) {
    s.step(i * 16);
    assert.equal(s.ticks, i, 'one warmup tick per animation frame');
    assert.equal(s.shown, i === 24 ? 1 : 0);
    assert.equal(s.pending, 1, 'one loop, including after reveal');
  }
  s.step(400);
  assert.equal(s.ticks, 25, 'normal animation continues');
  assert.equal(s.shown, 1, 'no repeated reveal');
});

test('reduced motion settles a static preview and leaves no ongoing frame loop', () => {
  const s = scheduler(true);
  s.begin();
  for (let i = 0; i < 24; i++) s.step();
  assert.equal(s.ticks, 24);
  assert.equal(s.shown, 1);
  assert.equal(s.pending, 0);
  s.hidden(true); s.hidden(false); s.visible(false); s.visible(true);
  assert.equal(s.pending, 0);
});

test('warmup pauses offscreen and on hidden tabs, then resumes without a second loop', () => {
  const s = scheduler();
  s.begin(); s.step();
  s.visible(false);
  assert.equal(s.pending, 0);
  assert.equal(s.ticks, 1);
  s.visible(true); s.start();
  assert.equal(s.pending, 1);
  s.step(); s.hidden(true);
  assert.equal(s.pending, 0);
  s.hidden(false); s.start();
  assert.equal(s.pending, 1);
  for (let i = 2; i < 24; i++) s.step();
  assert.equal(s.ticks, 24);
  assert.equal(s.shown, 1);
});

test('leaving Projects cancels rendering permanently and returning creates a fresh scheduler', () => {
  const first = scheduler();
  first.begin(); first.step(); first.pause();
  assert.equal(first.pending, 0);
  first.visible(true); first.hidden(false);
  assert.equal(first.pending, 0);
  first.dispose(); first.dispose();
  assert.equal(first.destroyed, 1, "paused renderer releases WebGL resources exactly once");
  first.start();
  assert.equal(first.pending, 0);
  const second = scheduler(); second.begin(); second.step();
  assert.equal(second.ticks, 1);
  assert.equal(second.pending, 1);
});
