const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const path = require('node:path');
const script = fs.readFileSync(path.resolve(__dirname, '../site/scripts/mingus-tabs.js'), 'utf8');
const SRC = 'https://alexkan.xyz/mingus/sql?embed';

// The figure in site/components/MingusEmbed.astro, with just what mingus-tabs.js reads
function page(observed = false) {
  const listeners = {};
  const panel = (src, hidden) => ({
    dataset: src ? { src } : {}, hidden, frames: [],
    querySelector(selector) { return selector === 'iframe' ? this.frames[0] ?? null : null; },
    append(child) { this.frames.push(child); },
  });
  const panels = { 'mingus-panel-map': panel('https://alexkan.xyz/mingus/?embed', false), 'mingus-panel-sql': panel(SRC, true) };
  const figure = { querySelector: selector => panels[selector.slice(1)], querySelectorAll: () => tabs };
  const tablist = { querySelectorAll: () => tabs };
  const tab = (controls, selected) => ({
    attrs: { 'aria-controls': controls, 'aria-selected': String(selected) }, tabIndex: selected ? 0 : -1, parentElement: tablist,
    getAttribute(name) { return this.attrs[name]; }, setAttribute(name, value) { this.attrs[name] = value; }, focus() {},
    closest(selector) { return selector === '.mingus-embed' ? figure : selector === '.mingus-embed [role="tab"]' ? this : null; },
  });
  const tabs = [tab('mingus-panel-map', true), tab('mingus-panel-sql', false)];
  let intersection;
  let disconnected = 0;
  const stage = { isConnected: true, closest: () => null, querySelector: figure.querySelector };
  vm.runInContext(script, vm.createContext({
    IntersectionObserver: class {
      constructor(fn) { intersection = value => fn([{ intersectionRatio: value ? 1 : 0 }], this); }
      observe(target) { assert.equal(target, stage); }
      disconnect() { disconnected++; }
    },
    document: {
      querySelector: () => observed ? stage : null,
      addEventListener: (type, fn, capture = false) => { listeners[type] = { fn, capture }; },
      createElement: () => ({}),
    },
  }));
  const fire = (type, target, extra = {}) => listeners[type].fn({ target, preventDefault() {}, ...extra });
  return { listeners, fire, intersect: value => intersection(value), get disconnected() { return disconnected; }, map: { tab: tabs[0], panel: panels['mingus-panel-map'] }, sql: { tab: tabs[1], panel: panels['mingus-panel-sql'] } };
}

test('the default map starts near the viewport and observes incoming pages', () => {
  const p = page(true);
  p.intersect(false);
  assert.equal(p.map.panel.frames.length, 0);
  p.fire('xyz:navigated');
  assert.equal(p.disconnected, 1);
  p.intersect(true);
  assert.equal(p.map.panel.frames.length, 1);
  assert.equal(p.map.panel.frames[0].src, 'https://alexkan.xyz/mingus/?embed');
  assert.equal(p.sql.panel.frames.length, 0);
});

test('hovering the SQL tab starts its frame behind the map, and nothing loads before that', () => {
  const p = page();
  assert.equal(p.sql.panel.frames.length, 0);
  p.fire('pointerenter', { closest: () => null });
  p.fire('pointerenter', p.map.tab);
  assert.equal(p.sql.panel.frames.length, 0);
  p.fire('pointerenter', p.sql.tab);
  assert.equal(p.sql.panel.frames.length, 1);
  assert.equal(p.sql.panel.frames[0].src, SRC);
  assert.equal(p.sql.panel.hidden, true);
  assert.equal(p.map.panel.hidden, false);
  assert.equal(p.sql.tab.attrs['aria-selected'], 'false');
  // pointerenter and focus don't bubble, so the document only sees them while capturing
  assert.equal(p.listeners.pointerenter.capture, true);
  assert.equal(p.listeners.focus.capture, true);
});

test('focusing the SQL tab also starts the frame, and selecting it shows that same frame', () => {
  const p = page();
  p.fire('focus', p.sql.tab);
  const frame = p.sql.panel.frames[0];
  assert.ok(frame);
  p.fire('pointerenter', p.sql.tab);
  p.fire('click', p.sql.tab);
  assert.deepEqual(p.sql.panel.frames, [frame]);
  assert.equal(p.sql.panel.hidden, false);
  assert.equal(p.map.panel.hidden, true);
  assert.equal(p.sql.tab.attrs['aria-selected'], 'true');
  assert.equal(p.sql.tab.tabIndex, 0);
});

test('a click or arrow key with no hover first still creates the frame', () => {
  const clicked = page();
  clicked.fire('click', clicked.sql.tab);
  assert.equal(clicked.sql.panel.frames.length, 1);
  assert.equal(clicked.sql.panel.hidden, false);
  const keyed = page();
  keyed.fire('keydown', keyed.map.tab, { key: 'ArrowRight' });
  assert.equal(keyed.sql.panel.frames.length, 1);
  assert.equal(keyed.sql.tab.attrs['aria-selected'], 'true');
});
