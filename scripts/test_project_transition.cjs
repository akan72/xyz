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
      addEventListener() {}, hidden: false,
    },
    WebSocket: class { constructor() { throw new Error('No feed in lifecycle test'); } },
    IntersectionObserver: class { observe() {} },
    matchMedia: () => ({ matches: false }), location: { search: '' },
    setTimeout: () => 0, clearTimeout() {}, console,
  });
  vm.runInContext(head, context);
  vm.runInContext(renderer, context);
  return { scripts, reveal: event => reveal(event) };
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
