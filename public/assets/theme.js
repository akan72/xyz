// Light/dark theme. Loaded as a blocking script at the top of <head> so the
// theme is set before the page paints:
// <script src="/assets/theme.js"></script>
//
// <html data-theme> always holds the theme in use: the visitor's saved choice
// if they've switched, otherwise their system setting. Pages style dark mode
// off it, and other scripts (like the screensaver) can read it and watch it
// for changes. Any element with data-theme-toggle switches the theme on click.

(() => {
    const STORAGE_KEY = 'theme';
    const BAR_COLORS = { light: '#f4f4f4', dark: '#161616' }; // browser UI tint, matches the homepage background

    const root = document.documentElement;
    const systemDark = matchMedia('(prefers-color-scheme: dark)');

    function saved() {
        try {
            const theme = localStorage.getItem(STORAGE_KEY);
            return theme === 'light' || theme === 'dark' ? theme : null;
        } catch (e) {
            return null;
        }
    }

    function apply() {
        const theme = saved() ?? (systemDark.matches ? 'dark' : 'light');
        root.dataset.theme = theme;
        document.querySelector('meta[name="theme-color"]')?.setAttribute('content', BAR_COLORS[theme]);
    }

    function toggle() {
        const next = root.dataset.theme === 'dark' ? 'light' : 'dark';
        try {
            localStorage.setItem(STORAGE_KEY, next);
        } catch (e) {}
        apply();
    }

    apply();
    systemDark.addEventListener('change', apply);
    // Another tab switched the theme
    addEventListener('storage', (e) => {
        if (e.key === STORAGE_KEY) apply();
    });
    document.addEventListener('DOMContentLoaded', () => {
        apply(); // the theme-color tag is parsed after this script runs
        for (const el of document.querySelectorAll('[data-theme-toggle]')) {
            el.addEventListener('click', toggle);
        }
    });
})();
