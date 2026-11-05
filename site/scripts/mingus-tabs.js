// The mingus figure's "3D map" / "Query with SQL" tabs (site/components/MingusEmbed.astro).
// The SQL frame is created on its first selection, since it downloads DuckDB.
// Listens on the document so it also works when page-navigation.js brings the
// projects page in without a reload.
function select(tab) {
    const figure = tab.closest('.mingus-embed');
    for (const other of figure.querySelectorAll('[role="tab"]')) {
        const on = other === tab;
        other.setAttribute('aria-selected', String(on));
        other.tabIndex = on ? 0 : -1;
        figure.querySelector('#' + other.getAttribute('aria-controls')).hidden = !on;
    }
    const panel = figure.querySelector('#' + tab.getAttribute('aria-controls'));
    if (panel.dataset.src && !panel.querySelector('iframe')) {
        const frame = document.createElement('iframe');
        frame.src = panel.dataset.src;
        frame.title = 'mingus: query my listening history with DuckDB SQL, in your browser';
        frame.referrerPolicy = 'no-referrer';
        panel.append(frame);
    }
}

document.addEventListener('click', event => {
    const tab = event.target.closest?.('.mingus-embed [role="tab"]');
    if (tab) select(tab);
});
document.addEventListener('keydown', event => {
    const tab = event.target.closest?.('.mingus-embed [role="tab"]');
    if (!tab || !['ArrowLeft', 'ArrowRight', 'Home', 'End'].includes(event.key)) return;
    const tabs = [...tab.parentElement.querySelectorAll('[role="tab"]')];
    const i = tabs.indexOf(tab);
    const next = tabs[event.key === 'Home' ? 0 : event.key === 'End' ? tabs.length - 1
        : (i + (event.key === 'ArrowRight' ? 1 : -1) + tabs.length) % tabs.length];
    event.preventDefault();
    next.focus();
    select(next);
});
