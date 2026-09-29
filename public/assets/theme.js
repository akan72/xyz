// Light/dark theme and remix styles. Loaded as a blocking script at the top
// of <head> so both are set before the page paints:
// <script src="/assets/theme.js"></script>
//
// <html data-theme> always holds the light/dark theme in use: the visitor's
// saved choice if they've switched, otherwise their system setting. A remix
// style overrides it with the style's own scheme. Pages style dark mode off
// it, and other scripts (like the screensaver) can read it and watch it for
// changes. Any element with data-theme-toggle switches the theme on click and
// gets an aria-label/title describing what it will do.
//
// <html data-remix> holds the remix style the visitor picked (see REMIXES);
// the default style, gm, leaves it unset. A style's CSS, and the fonts and
// images it references, load only while that style is in use. On the
// homepage, [data-remix-select] picks a style, [data-remix-shuffle] picks a
// random different one, and [data-remix-picker] (hidden in the HTML, since it
// needs this script) is shown.

(() => {
    const STORAGE_KEY = 'theme';
    const REMIX_KEY = 'remix';
    const BAR_COLORS = { light: '#f4f4f4', dark: '#161616' }; // browser UI tint, matches the homepage background
    // Each style's light/dark scheme and page color (shown while its CSS loads)
    const REMIXES = {
        kvlt: { scheme: 'dark', color: '#0b0b0b' },
        takeout: { scheme: 'light', color: '#f1ede4' },
        tvdinner: { scheme: 'light', color: '#f7ebd0' },
    };
    const MAX_HIDE_MS = 3000; // longest the page stays hidden waiting for a style's CSS

    const root = document.documentElement;
    const systemDark = matchMedia('(prefers-color-scheme: dark)');

    function read(key) {
        try {
            return localStorage.getItem(key);
        } catch (e) {
            return null;
        }
    }

    function write(key, value) {
        try {
            if (value === null) localStorage.removeItem(key);
            else localStorage.setItem(key, value);
        } catch (e) {}
    }

    function saved() {
        const theme = read(STORAGE_KEY);
        return theme === 'light' || theme === 'dark' ? theme : null;
    }

    function savedRemix() {
        const remix = read(REMIX_KEY);
        return Object.hasOwn(REMIXES, remix ?? '') ? remix : null;
    }

    // Adds a style's stylesheet once; resolves when it has loaded or failed.
    const sheets = {};
    function load(remix) {
        sheets[remix] ??= new Promise((resolve) => {
            const link = document.createElement('link');
            link.rel = 'stylesheet';
            link.href = `/assets/remix/${remix}.css`;
            link.onload = link.onerror = resolve;
            document.head.append(link);
        });
        return sheets[remix];
    }

    function apply() {
        const remix = savedRemix();
        const theme = remix ? REMIXES[remix].scheme : saved() ?? (systemDark.matches ? 'dark' : 'light');
        root.dataset.theme = theme;
        if (remix) root.dataset.remix = remix;
        else delete root.dataset.remix;
        document.querySelector('meta[name="theme-color"]')?.setAttribute('content', remix ? REMIXES[remix].color : BAR_COLORS[theme]);
        const label = theme === 'dark' ? 'Switch to light mode' : 'Switch to dark mode';
        for (const el of document.querySelectorAll('[data-theme-toggle]')) {
            el.setAttribute('aria-label', label);
            el.title = label;
        }
        for (const el of document.querySelectorAll('[data-remix-select]')) el.value = remix ?? 'gm';
    }

    // Applies the saved style once its CSS is in, so switching never shows the page unstyled.
    function refresh() {
        const remix = savedRemix();
        (remix ? load(remix) : Promise.resolve()).then(() => {
            if (savedRemix() === remix) apply();
        });
    }

    function pick(style) {
        write(REMIX_KEY, Object.hasOwn(REMIXES, style) ? style : null);
        refresh();
    }

    function toggle() {
        const next = root.dataset.theme === 'dark' ? 'light' : 'dark';
        write(STORAGE_KEY, next);
        apply();
    }

    // A saved style hides the page until its CSS arrives instead of flashing the default style.
    const initial = savedRemix();
    if (initial) {
        const hide = document.createElement('style');
        hide.textContent = `html{background:${REMIXES[initial].color}}body{visibility:hidden}`;
        document.head.append(hide);
        const show = () => hide.remove();
        load(initial).then(show);
        setTimeout(show, MAX_HIDE_MS);
    }

    apply();
    systemDark.addEventListener('change', apply);
    // Another tab switched the theme or style
    addEventListener('storage', (e) => {
        if (e.key === STORAGE_KEY || e.key === REMIX_KEY || e.key === null) refresh();
    });
    // Back/forward cache restores the page as it was; pick up changes made since
    addEventListener('pageshow', (e) => {
        if (e.persisted) refresh();
    });
    document.addEventListener('DOMContentLoaded', () => {
        for (const el of document.querySelectorAll('[data-theme-toggle]')) {
            el.addEventListener('click', toggle);
        }
        for (const el of document.querySelectorAll('[data-remix-select]')) {
            el.addEventListener('change', () => pick(el.value));
        }
        for (const el of document.querySelectorAll('[data-remix-shuffle]')) {
            el.addEventListener('click', () => {
                const current = savedRemix() ?? 'gm';
                const others = ['gm', ...Object.keys(REMIXES)].filter((style) => style !== current);
                pick(others[Math.floor(Math.random() * others.length)]);
            });
        }
        for (const el of document.querySelectorAll('[data-remix-picker]')) el.hidden = false;
        apply(); // the theme-color tag, toggles and picker are parsed after this script first runs
    });
})();
