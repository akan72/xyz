const { test } = require('node:test');
const assert = require('node:assert/strict');
const vm = require('node:vm');
const fs = require('node:fs');
const source = fs.readFileSync(require('node:path').join(__dirname, '../site/scripts/screensaver.js'), 'utf8');
const flush = () => new Promise(resolve => setImmediate(resolve));

async function saver() {
  const events = {}, timers = new Map(), overlays = [], browserEvents = {};
  let next = 0;
  const context = vm.createContext({
    URL, import: undefined, console,
    fetch: async () => ({ ok: true, text: async () => '<svg />' }),
    matchMedia: () => ({ matches: false, addEventListener() {} }),
    MutationObserver: class { observe() {} },
    document: {
      hidden: false, documentElement: { dataset: { theme: 'light' } },
      body: { append: el => overlays.push(el) },
      addEventListener: (type, fn) => { events[type] = fn; },
      createElement: () => ({
        style: {}, firstElementChild: { style: {} }, clientWidth: 390, clientHeight: 844, offsetWidth: 100, offsetHeight: 50,
        setAttribute() {}, append() {}, addEventListener() {}, animate: () => ({ cancel() {} }),
      }),
    },
    setTimeout: (fn, ms = 0) => { timers.set(++next, { fn, ms }); return next; },
    clearTimeout: id => timers.delete(id), setInterval: () => 0, clearInterval() {},
    requestAnimationFrame: () => 1, cancelAnimationFrame() {},
    addEventListener: (type, fn) => { (browserEvents[type] ||= []).push(fn); },
  });
  // Only substitute the module's static URL resolution; run its real idle/dismiss logic.
  vm.runInContext(source, context);
  await flush();
  return { events, timers, overlays, browserEvents,
    idle() { const [id, timer] = [...timers].find(([, timer]) => timer.ms === 5000); timers.delete(id); timer.fn(); },
  };
}

test('content navigation starts the same five-second idle period without another overlay', async () => {
  const s = await saver(); const originalTimer = [...s.timers.keys()][0];
  s.events['xyz:navigated'](); s.events['xyz:navigated']();
  assert.equal(s.timers.has(originalTimer), false);
  assert.equal(s.timers.size, 1);
  assert.equal([...s.timers.values()][0].ms, 5000);
  assert.equal(s.overlays.length, 1);
});

test('Back/Forward navigation dismisses an active saver as a new document would', async () => {
  const s = await saver(); s.idle();
  assert.equal(s.overlays[0].hidden, false);
  s.events['xyz:navigated']();
  assert.equal(s.overlays[0].hidden, true);
  assert.equal([...s.timers.values()][0].ms, 5000);
});

test('the first pointer press still dismisses the saver and consumes the rest of that click', async () => {
  const s = await saver(); s.idle();
  s.browserEvents.mousedown[0]({ type: 'mousedown' });
  assert.equal(s.overlays[0].style.opacity, '0');
  assert.equal(s.overlays[0].hidden, false, 'overlay stays through mouse release');
  s.browserEvents.mouseup[0]();
  [...s.timers.values()].find(timer => timer.ms === 0).fn();
  assert.equal(s.overlays[0].hidden, true);
});
