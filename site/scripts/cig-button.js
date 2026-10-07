// The cig_scraper project's "Get Random Cig" button: ask the Worker for a random cig's
// URL (/image), preload it, then swap it in. Listens on the document so it
// also works when page-navigation.js brings the projects page in without a reload.
document.addEventListener('click', event => {
    const button = event.target.closest?.('#cig-button');
    if (!button) return;
    button.disabled = true;
    fetch('/image')
        .then(r => r.text())
        .then(url => {
            const temp = new Image();
            temp.onload = () => {
                document.getElementById('cig').src = url;
                button.disabled = false;
            };
            temp.src = url;
        });
});
