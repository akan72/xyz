// Idle screensaver: after IDLE_MS with no input, a full-screen overlay fades in
// with the XYZ logo bouncing around the viewport, changing color on every edge
// hit. Any input dismisses it. Pages include it with
// <script type="module" src="/assets/screensaver.js"></script>.

// Set to false to turn the screensaver off on every page.
const ENABLED = true;

const IDLE_MS = 5000;
const FADE_MS = 400;
const SPEED = 100; // px/s along the diagonal
const STILL_COLOR_MS = 3000; // prefers-reduced-motion: the logo sits centered and only changes color
const BACKGROUND_OPACITY = 0.6; // 1 is solid; lower lets the page show through
const LOGO_HALO = true; // soft glow in the background color around the logo
const MAX_FRAME_MS = 100;
const LOGO_URL = new URL('./xyz-logo/xyz-currentcolor.svg', import.meta.url);

// Palettes from xyz-logo/README.md, cycled in order. Light has no yellow: it
// can't reach readable contrast on the light background.
const THEMES = {
    dark: {
        background: '#111214',
        palette: ['#45D66B', '#3CE6FF', '#FF4FD8', '#FF4D4D', '#FFE14D', '#FF8A3D', '#A98BFF'],
    },
    light: {
        background: '#FAFAF7',
        palette: ['#018535', '#057F8F', '#D212AF', '#DE2831', '#BA5702', '#7F5FCE'],
    },
};

const ACTIVITY_EVENTS = ['mousemove', 'mousedown', 'keydown', 'touchstart', 'wheel', 'scroll'];
const AXES = ['x', 'y'];

const darkMode = matchMedia('(prefers-color-scheme: dark)');
const reducedMotion = matchMedia('(prefers-reduced-motion: reduce)');

let overlay, logo, fade;
let active = false;
let still = false;
let idleTimer, colorTimer, frame, last;
let colorIndex = 0;
let heldKey = null;
const pos = { x: 0, y: 0 };
const vel = { x: 0, y: 0 };
const max = { x: 0, y: 0 };

if (ENABLED) {
    init().catch((err) => console.warn('screensaver disabled:', err));
}

async function init() {
    const res = await fetch(LOGO_URL);
    if (!res.ok) throw new Error(`${LOGO_URL} returned ${res.status}`);

    overlay = document.createElement('div');
    overlay.hidden = true;
    overlay.setAttribute('aria-hidden', 'true');
    overlay.style.cssText = 'position: fixed; inset: 0; z-index: 2147483647; overflow: hidden; cursor: none;';

    // ~180px wide, 28% of the viewport width on small screens. The vh cap keeps
    // it well inside very short viewports so it always has room to bounce.
    logo = document.createElement('div');
    logo.style.cssText = 'position: absolute; top: 0; left: 0; width: min(180px, 28vw, 60vh); will-change: transform;';
    logo.innerHTML = await res.text();
    logo.firstElementChild.style.cssText = 'display: block; width: 100%; height: auto;';

    overlay.append(logo);
    document.body.append(overlay);

    // Only keydown is canceled from here; the overlay cancels pointer input itself.
    for (const type of ACTIVITY_EVENTS) {
        addEventListener(type, onActivity, { capture: true, passive: type !== 'keydown' });
    }
    addEventListener('keydown', onHeldKey, true);
    addEventListener('keyup', onHeldKey, true);
    addEventListener('resize', onResize);
    // Stops the idle timer while the tab is hidden and restarts it on return.
    document.addEventListener('visibilitychange', () => {
        if (!active) resetIdleTimer();
    });
    darkMode.addEventListener('change', paint);
    reducedMotion.addEventListener('change', () => {
        if (active) {
            stopMotion();
            startMotion();
        }
    });

    // While it's up, pointer input lands on the overlay. Cancel it so the
    // dismissing press or swipe can't focus, click, scroll, or open a menu.
    for (const type of ['mousedown', 'touchstart', 'touchend', 'wheel', 'contextmenu']) {
        overlay.addEventListener(type, (e) => e.preventDefault(), { passive: false });
    }

    resetIdleTimer();
}

function resetIdleTimer() {
    clearTimeout(idleTimer);
    if (!document.hidden) idleTimer = setTimeout(start, IDLE_MS);
}

function onActivity(e) {
    // Content changing under a still cursor can fire a mousemove that isn't input.
    if (e.type === 'mousemove' && e.movementX === 0 && e.movementY === 0) return;
    if (active) dismiss(e);
    resetIdleTimer();
}

function start() {
    if (document.hidden) return;
    active = true;
    colorIndex = Math.floor(Math.random() * currentTheme().palette.length);
    paint();
    overlay.style.opacity = '';
    overlay.hidden = false;
    startMotion();
    fade = overlay.animate([{ opacity: 0 }, { opacity: 1 }], { duration: FADE_MS, easing: 'ease-out' });
}

function dismiss(e) {
    active = false;
    stopMotion();
    fade.cancel();
    if (e.type === 'keydown') {
        // Swallow the key that woke the screensaver so it can't follow a focused
        // link or press a focused button. onHeldKey swallows its repeats and keyup.
        heldKey = e.code;
        e.preventDefault();
        e.stopImmediatePropagation();
    }
    if (e.type === 'mousedown') {
        // Go invisible now, but stay in place until the button is released so
        // the rest of the click lands on the overlay instead of the page.
        overlay.style.opacity = '0';
        addEventListener('mouseup', () => setTimeout(() => {
            if (!active) overlay.hidden = true;
        }), { capture: true, once: true });
    } else {
        overlay.hidden = true;
    }
}

function onHeldKey(e) {
    if (e.code !== heldKey || !(e.repeat || e.type === 'keyup')) return;
    if (e.type === 'keyup') heldKey = null;
    e.preventDefault();
    e.stopImmediatePropagation();
}

function startMotion() {
    still = reducedMotion.matches;
    measure();
    for (const axis of AXES) {
        pos[axis] = still ? max[axis] / 2 : Math.random() * max[axis];
        vel[axis] = (Math.random() < 0.5 ? -1 : 1) * SPEED / Math.SQRT2;
    }
    draw();
    if (still) {
        colorTimer = setInterval(nextColor, STILL_COLOR_MS);
    } else {
        last = undefined;
        frame = requestAnimationFrame(step);
    }
}

function stopMotion() {
    cancelAnimationFrame(frame);
    clearInterval(colorTimer);
}

function step(now) {
    last ??= now;
    // Time-based so the speed is the same at any refresh rate. Capped so a
    // stalled or backgrounded tab doesn't make the logo jump.
    const dt = Math.min(now - last, MAX_FRAME_MS) / 1000;
    last = now;
    let hitEdge = false;
    for (const axis of AXES) {
        pos[axis] += vel[axis] * dt;
        if (pos[axis] < 0 || pos[axis] > max[axis]) {
            vel[axis] = pos[axis] < 0 ? Math.abs(vel[axis]) : -Math.abs(vel[axis]);
            pos[axis] = clamp(pos[axis], 0, max[axis]);
            hitEdge = true;
        }
    }
    // Once per frame, so hitting a corner is a single color change.
    if (hitEdge) nextColor();
    draw();
    frame = requestAnimationFrame(step);
}

function onResize() {
    if (!active) return;
    measure();
    for (const axis of AXES) {
        pos[axis] = still ? max[axis] / 2 : clamp(pos[axis], 0, max[axis]);
    }
    draw();
}

function measure() {
    max.x = overlay.clientWidth - logo.offsetWidth;
    max.y = overlay.clientHeight - logo.offsetHeight;
}

function draw() {
    logo.style.transform = `translate(${pos.x}px, ${pos.y}px)`;
}

function currentTheme() {
    return darkMode.matches ? THEMES.dark : THEMES.light;
}

// Also runs when the OS theme changes, so a running screensaver switches immediately.
function paint() {
    const { background, palette } = currentTheme();
    colorIndex %= palette.length;
    overlay.style.background = `color-mix(in srgb, ${background} ${BACKGROUND_OPACITY * 100}%, transparent)`;
    logo.style.color = palette[colorIndex];
    // Keeps the palette at the contrast it was designed for, whatever page
    // content shows through the background.
    logo.style.filter = LOGO_HALO ? `drop-shadow(0 0 2px ${background}) drop-shadow(0 0 6px ${background})` : '';
}

function nextColor() {
    colorIndex++;
    paint();
}

function clamp(value, lo, hi) {
    return Math.min(Math.max(value, lo), hi);
}
