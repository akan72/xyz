// The mingus figure's "3D map" / "Query with SQL" tabs (site/components/MingusEmbed.astro).
// The SQL frame downloads DuckDB, so it is created only when its tab is
// hovered, focused or selected: hovering starts DuckDB in the gap before the
// click. Until the tab is selected the frame sits in its hidden panel, which
// keeps it out of the focus order, and the framed page skips its own focus
// under ?embed, so a prewarmed frame neither takes focus nor scrolls the page.
// Listens on the document so it also works when page-navigation.js brings the
// projects page in without a reload.
const tabAt = target => target.closest?.('.mingus-embed [role="tab"]');
const panelOf = tab => tab.closest('.mingus-embed').querySelector('#' + tab.getAttribute('aria-controls'));

function addFrame(panel) {
    if (!panel.dataset.src || panel.querySelector('iframe')) return;
    const frame = document.createElement('iframe');
    frame.src = panel.dataset.src;
    frame.title = 'mingus: query my listening history with DuckDB SQL, in your browser';
    frame.referrerPolicy = 'no-referrer';
    panel.append(frame);
}

function select(tab) {
    for (const other of tab.parentElement.querySelectorAll('[role="tab"]')) {
        const on = other === tab;
        other.setAttribute('aria-selected', String(on));
        other.tabIndex = on ? 0 : -1;
        panelOf(other).hidden = !on;
    }
    addFrame(panelOf(tab));
}

// Neither event bubbles, so both are caught on the way down
for (const type of ['pointerenter', 'focus']) {
    document.addEventListener(type, event => {
        const tab = tabAt(event.target);
        if (tab) addFrame(panelOf(tab));
    }, true);
}
document.addEventListener('click', event => {
    const tab = tabAt(event.target);
    if (tab) select(tab);
});
document.addEventListener('keydown', event => {
    const tab = tabAt(event.target);
    if (!tab || !['ArrowLeft', 'ArrowRight', 'Home', 'End'].includes(event.key)) return;
    const tabs = [...tab.parentElement.querySelectorAll('[role="tab"]')];
    const i = tabs.indexOf(tab);
    const next = tabs[event.key === 'Home' ? 0 : event.key === 'End' ? tabs.length - 1
        : (i + (event.key === 'ArrowRight' ? 1 : -1) + tabs.length) % tabs.length];
    event.preventDefault();
    next.focus();
    select(next);
});
