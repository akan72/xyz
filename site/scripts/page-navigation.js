// Keep the header, theme controls, and screensaver alive between the four pages.
// HTML stays server-rendered: failed requests and ordinary links still navigate normally.
// Chosen over Astro's <ClientRouter /> for being faster and keeping the header
// clickable during the fade; see https://github.com/akan72/xyz/pull/35.
(() => {
    const routes = new Set(['/', '/ideology', '/projects', '/contact']);
    const header = document.querySelector('.site-header');
    let main = document.querySelector('main');
    if (!header || !main || !routes.has(location.pathname) || location.search) return;

    const shell = document.createElement('div');
    shell.className = 'page-shell';
    main.before(shell);
    shell.append(main);
    document.body.dataset.navigation = 'persistent';
    // Every <style> in <head> is the page's CSS (Astro inlines it); swap them all on navigation
    document.querySelectorAll('head > style').forEach(s => s.dataset.pageStyle = '');

    const cache = new Map();
    const scrolls = new Map();
    let request = 0, finishFade = () => {}, projectsScript;
    let currentPath = location.pathname;
    const newKey = () => crypto.randomUUID();
    let key = newKey();
    const historyState = k => ({ ...history.state, xyzNavigation: { key: k } });
    history.replaceState(historyState(key), '', location.href);
    history.scrollRestoration = 'manual';

    function target(link, event) {
        if (!link || event.defaultPrevented || event.button !== 0 || event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) return null;
        if (link.hasAttribute('download') || (link.target && link.target !== '_self')) return null;
        const url = new URL(link.href, location.href);
        return url.origin === location.origin && routes.has(url.pathname) && !url.search && !url.hash ? url : null;
    }

    function page(url) {
        if (!cache.has(url.pathname)) {
            const controller = new AbortController();
            const timer = setTimeout(() => controller.abort(), 4000);
            const loading = fetch(url.href, { signal: controller.signal, headers: { Accept: 'text/html' } })
                .then(async response => {
                    if (!response.ok || !response.headers.get('content-type')?.includes('text/html') || (new URL(response.url).origin !== url.origin || new URL(response.url).pathname !== url.pathname)) throw new Error('Not a site page');
                    const doc = new DOMParser().parseFromString(await response.text(), 'text/html');
                    if (!doc.querySelector('main') || !doc.querySelector('.site-header') || !doc.title) throw new Error('Missing page content');
                    return doc;
                })
                .catch(error => { cache.delete(url.pathname); throw error; })
                .finally(() => clearTimeout(timer));
            cache.set(url.pathname, loading);
        }
        return cache.get(url.pathname);
    }

    function metadata(doc) {
        document.title = doc.title;
        for (const selector of ['meta[name="description"]', 'link[rel="canonical"]', 'link[rel="alternate"][type="text/markdown"]', 'script[type="application/ld+json"]']) {
            document.head.querySelectorAll(selector).forEach(el => el.remove());
            doc.head.querySelectorAll(selector).forEach(el => document.head.append(document.importNode(el, true)));
        }
    }

    async function mountProjects(content, finished) {
        await finished;
        if (main !== content || currentPath !== '/projects') return;
        if (window.xyzMountProjects) window.xyzMountProjects();
        else {
            projectsScript ??= new Promise((resolve, reject) => {
                const script = document.createElement('script');
                script.src = '/assets/subway-vis.js';
                script.onload = resolve;
                script.onerror = () => { projectsScript = null; script.remove(); reject(new Error('Projects script failed')); };
                document.head.append(script);
            });
            try { await projectsScript; }
            catch { if (main === content) main.querySelector('#subway-vis-caption').textContent = 'Live transit preview unavailable. Visit istheldown.com for the current map.'; }
        }
    }

    async function navigate(url, options = {}) {
        const id = ++request;
        if (url.pathname === currentPath) { finishFade(); return; }
        let doc;
        try { doc = await page(url); }
        catch { if (id === request) location.assign(url.href); return; }
        if (id !== request) return;

        // Decode homepage images before exposing them; no shaders or feed scripts run here.
        const incoming = document.importNode(doc.querySelector('main'), true);
        incoming.querySelectorAll('script').forEach(script => script.remove());
        await Promise.race([
            Promise.all(Array.from(incoming.querySelectorAll('img'), async img => {
                img.src = new URL(img.getAttribute('src'), url).href;
                const preload = new Image();
                preload.src = img.src;
                try { await preload.decode(); } catch { /* A broken image must not block navigation. */ }
            })),
            new Promise(resolve => setTimeout(resolve, 1200)),
        ]);
        if (id !== request) return;

        finishFade();
        scrolls.set(key, [scrollX, scrollY]);
        if (options.pop) key = options.key || newKey();
        else { key = newKey(); history.pushState(historyState(key), '', url.href); }
        currentPath = url.pathname;

        const outgoing = main;
        const oldStyles = Array.from(document.querySelectorAll('head > style[data-page-style]'));
        doc.querySelectorAll('head > style').forEach(style => {
            const copy = document.importNode(style, true);
            copy.dataset.pageStyle = '';
            document.head.append(copy);
        });
        metadata(doc);
        window.xyzPauseProjects?.();
        const dispose = window.xyzDisposeProjects;
        window.xyzDisposeProjects = null;
        outgoing.inert = true;
        outgoing.setAttribute('aria-hidden', 'true');
        outgoing.dataset.outgoingPage = '';
        outgoing.removeAttribute('id');
        outgoing.querySelectorAll('[id]').forEach(el => el.removeAttribute('id'));
        shell.append(incoming);
        main = incoming;
        header.querySelectorAll('a').forEach(link => {
            if (new URL(link.href).pathname === currentPath) link.setAttribute('aria-current', 'page');
            else link.removeAttribute('aria-current');
        });
        const position = options.pop ? scrolls.get(key) || [0, 0] : [0, 0];
        scrollTo({ left: position[0], top: position[1], behavior: 'instant' });
        if (options.keyboard || options.pop) { main.tabIndex = -1; main.focus({ preventScroll: true }); }
        document.dispatchEvent(new Event('xyz:navigated'));

        let resolveFinished;
        const finished = new Promise(resolve => { resolveFinished = resolve; });
        window.__pageTransitionFinished = finished;
        let animation;
        finishFade = () => {
            animation?.cancel();
            outgoing.remove();
            oldStyles.forEach(style => style.remove());
            dispose?.();
            resolveFinished();
            finishFade = () => {};
        };
        if (!matchMedia('(prefers-reduced-motion: reduce)').matches && outgoing.animate) {
            animation = outgoing.animate([{ opacity: 1 }, { opacity: 0 }], { duration: 240, easing: 'ease-out', fill: 'both' });
            animation.finished.then(finishFade, () => {});
        } else finishFade();
        if (currentPath === '/projects') void mountProjects(incoming, finished);
    }

    document.addEventListener('click', event => {
        const url = target(event.target.closest?.('a'), event);
        if (!url) return;
        event.preventDefault();
        void navigate(url, { keyboard: event.detail === 0 });
    });
    document.addEventListener('pointerover', event => {
        const url = target(event.target.closest?.('a'), { button: 0 });
        if (url && url.pathname !== currentPath) void page(url).catch(() => {});
    });
    addEventListener('popstate', event => {
        const url = new URL(location.href);
        if (!routes.has(url.pathname) || url.search || url.hash) { location.reload(); return; }
        void navigate(url, { pop: true, key: event.state?.xyzNavigation?.key });
    });
})();
