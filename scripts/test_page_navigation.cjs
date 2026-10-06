const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const source = fs.readFileSync(require('node:path').join(__dirname, '../site/scripts/page-navigation.js'), 'utf8');
const flush = () => new Promise(resolve => setImmediate(resolve));

// A small DOM fixture exercises the real navigation controller, not a second router.
function app(reduced = false) {
  const events = {}, browserEvents = {}, requests = [], animations = [], assigned = [];
  let counter = 0, mounts = 0, disposals = 0;
  class Element {
    constructor(tag) { this.tag = tag; this.children = []; this.dataset = {}; this.attrs = {}; }
    append(el) { el.remove(); this.children.push(el); el.parent = this; }
    before(el) { const siblings = this.parent.children; siblings.splice(siblings.indexOf(this), 0, el); el.parent = this.parent; }
    remove() { if (this.parent) this.parent.children.splice(this.parent.children.indexOf(this), 1); this.parent = null; }
    setAttribute(k, v) { this.attrs[k] = v; }
    removeAttribute(k) { delete this.attrs[k]; }
    hasAttribute(k) { return Object.hasOwn(this.attrs, k); }
    focus() { document.focused = this; }
    querySelectorAll(selector) { return selector === 'a' ? this.links || [] : []; }
    querySelector() { return null; }
    animate() {
      let resolve, reject;
      const animation = { finished: new Promise((yes, no) => { resolve = yes; reject = no; }), cancel() { reject(new Error('cancelled')); }, finish: () => resolve() };
      animations.push(animation);
      return animation;
    }
  }
  const body = new Element('body'), head = new Element('head'), header = new Element('header'), initialMain = new Element('main');
  header.links = ['/', '/ideology', '/projects', '/contact'].map(path => {
    const link = new Element('a'); link.href = 'https://example.test' + path; link.target = ''; link.closest = () => link; return link;
  });
  body.append(header); body.append(initialMain);
  const initialStyle = new Element('style');
  head.append(initialStyle);
  const mains = () => body.children.flatMap(el => el.tag === 'main' ? [el] : el.children.filter(child => child.tag === 'main'));
  const pageStyles = () => head.children.filter(el => el.tag === 'style' && Object.hasOwn(el.dataset, 'pageStyle'));
  const document = {
    body, head, title: 'Main',
    querySelector(selector) { if (selector === '.site-header') return header; if (selector === 'main') return mains()[0]; return null; },
    querySelectorAll(selector) { if (selector === 'head > style') return [initialStyle]; return pageStyles(); },
    createElement: tag => new Element(tag),
    importNode(el) { const copy = new Element(el.tag); copy.path = el.path; copy.dataset = { ...el.dataset }; return copy; },
    addEventListener: (name, fn) => { events[name] = fn; },
    dispatchEvent: event => { document.lastEvent = event.type; },
  };
  const location = new URL('https://example.test/');
  location.assign = url => assigned.push(url);
  location.reload = () => assigned.push(location.href);
  const history = { state: { unrelated: 'preserved' }, entries: [], replaceState(state) { this.state = state; }, pushState(state, _, url) { this.state = state; this.entries.push({ state, url }); location.href = url; } };
  const context = vm.createContext({
    document, location, history, URL, Event, AbortController,
    crypto: { randomUUID: () => String(++counter) }, scrollX: 0, scrollY: 0,
    scrollTo: pos => { context.scrollX = pos.left; context.scrollY = pos.top; },
    matchMedia: () => ({ matches: reduced }), setTimeout: () => 1, clearTimeout() {},
    addEventListener: (name, fn) => { browserEvents[name] = fn; },
    window: { xyzMountProjects() { mounts++; context.window.xyzDisposeProjects = () => { disposals++; }; }, xyzPauseProjects() {} },
    fetch: url => new Promise((resolve, reject) => requests.push({ url, resolve, reject })),
    DOMParser: class {
      parseFromString(path) {
        const main = new Element('main'); main.path = path;
        const style = new Element('style');
        return { title: path, head: { querySelectorAll: () => [] }, querySelector: selector => selector === 'main' ? main : header, querySelectorAll: () => [style] };
      }
    },
  });
  head.querySelectorAll = () => [];
  vm.runInContext(source, context);
  return {
    header, initialMain, body, head, document, history, location, requests, assigned, mains, pageStyles,
    get position() { return [context.scrollX, context.scrollY]; },
    get mounts() { return mounts; }, get disposals() { return disposals; },
    click(path, extra = {}) {
      const link = header.links.find(link => new URL(link.href).pathname === path) || { href: 'https://elsewhere.test/', hasAttribute: () => false, closest() { return this; } };
      const event = { target: link, button: 0, detail: 1, preventDefault() { this.defaultPrevented = true; }, ...extra };
      events.click(event); return event;
    },
    respond(path, ok = true) { requests.find(r => new URL(r.url).pathname === path).resolve({ ok, url: 'https://example.test' + path, headers: { get: () => 'text/html' }, text: async () => path }); },
    async settle() { animations.splice(0).forEach(a => a.finish()); await flush(); },
    async back(path, state) { location.href = 'https://example.test' + path; browserEvents.popstate({ state }); await flush(); },
    scroll(x, y) { context.scrollX = x; context.scrollY = y; },
  };
}

test('header and controls remain the same nodes while content, title, and URL change', async () => {
  const a = app(); const links = a.header.links;
  assert.equal(a.click('/ideology').defaultPrevented, true);
  a.respond('/ideology'); await flush();
  assert.equal(a.body.children[0], a.header);
  assert.equal(a.header.links, links);
  assert.equal(a.document.title, '/ideology');
  assert.equal(a.location.pathname, '/ideology');
  assert.equal(a.header.links[1].attrs['aria-current'], 'page');
  assert.equal(a.history.state.unrelated, 'preserved');
  assert.equal(a.document.lastEvent, 'xyz:navigated');
  await a.settle();
  assert.equal(a.mains().length, 1);
  assert.equal(a.pageStyles().length, 1);
});

test('a slower earlier response cannot replace the last clicked page', async () => {
  const a = app(); a.click('/ideology'); a.click('/contact');
  a.respond('/contact'); await flush(); a.respond('/ideology'); await flush();
  assert.equal(a.location.pathname, '/contact');
  assert.equal(a.document.title, '/contact');
  assert.equal(a.history.entries.length, 1);
});

test('failed requests fall back to the original link without losing visible content', async () => {
  const a = app(); a.click('/ideology'); a.respond('/ideology', false); await flush();
  assert.deepEqual(a.assigned, ['https://example.test/ideology']);
  assert.equal(a.mains()[0], a.initialMain);
});

test('modified, prevented, and external clicks retain ordinary browser behavior', () => {
  const a = app();
  for (const extra of [{ metaKey: true }, { ctrlKey: true }, { shiftKey: true }, { altKey: true }, { button: 1 }, { defaultPrevented: true }]) a.click('/projects', extra);
  a.click('/outside');
  assert.equal(a.requests.length, 0);
});

test('Back restores content and scroll without pushing another history entry', async () => {
  const a = app(); const initialState = a.history.state;
  a.scroll(0, 250); a.click('/ideology'); a.respond('/ideology'); await flush(); await a.settle();
  a.click('/contact'); a.respond('/contact'); await flush(); await a.settle();
  const ideologyState = a.history.entries[0].state;
  await a.back('/ideology', ideologyState); await a.settle();
  assert.equal(a.document.title, '/ideology');
  assert.equal(a.history.entries.length, 2);
  assert.equal(a.document.focused, a.mains()[0]);
  await a.back('/', initialState); a.respond('/'); await flush(); await a.settle();
  assert.equal(a.location.pathname, '/');
  assert.deepEqual(a.position, [0, 250]);
});

test('clicking Projects twice still mounts its renderer, and leaving disposes it once', async () => {
  const a = app(); a.click('/projects'); a.respond('/projects'); await flush();
  a.click('/projects'); await flush();
  assert.equal(a.mounts, 1);
  a.click('/contact'); a.respond('/contact'); await flush(); await a.settle();
  assert.equal(a.disposals, 1);
  assert.equal(a.mains().length, 1);
});

test('reduced motion swaps content immediately without leaving an outgoing page', async () => {
  const a = app(true); a.click('/projects'); a.respond('/projects'); await flush();
  assert.equal(a.mains().length, 1);
  assert.equal(a.pageStyles().length, 1);
  assert.equal(a.mounts, 1);
});
