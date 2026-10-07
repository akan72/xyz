// Light obfuscation against simple harvesting, not encryption. Decode only on
// activation, and keep the address out of the generated HTML/Markdown copies.
const decodeEmail = (row: HTMLElement) => atob(row.dataset.emailCode!);

function mountEmail() {
    document.querySelectorAll<HTMLButtonElement>('[data-email-reveal]').forEach(button => {
        button.hidden = false;
    });
}

document.addEventListener('xyz:navigated', mountEmail);
mountEmail();

document.addEventListener('click', async event => {
    if (!(event.target instanceof Element)) return;
    const control = event.target.closest<HTMLButtonElement>('[data-email-reveal], [data-email-copy]');
    const row = control?.closest<HTMLElement>('[data-email-contact]');
    if (!control || !row) return;
    const result = row.querySelector<HTMLElement>('[data-email-result]')!;
    const status = row.querySelector<HTMLElement>('[data-email-status]')!;

    if (control.hasAttribute('data-email-copy')) {
        try {
            await navigator.clipboard.writeText(decodeEmail(row));
            if (row.isConnected) status.textContent = 'Copied';
        } catch {
            if (row.isConnected) status.textContent = 'Select the address to copy it.';
        }
        return;
    }

    if (row.dataset.revealing) return;
    row.dataset.revealing = 'true';
    const address = decodeEmail(row);
    const reveal = () => {
        if (!row.isConnected) return;
        const focused = document.activeElement === control;
        const link = document.createElement('a');
        link.href = `mailto:${address}`;
        link.textContent = address;
        result.replaceChildren(link);
        control.hidden = true;
        row.querySelector<HTMLButtonElement>('[data-email-copy]')!.hidden = false;
        if (focused) link.focus({ preventScroll: true });
    };

    if (matchMedia('(prefers-reduced-motion: reduce)').matches) {
        reveal();
        return;
    }

    control.setAttribute('aria-label', 'Revealing email address');
    const glyphs = 'abcdefghijklmnopqrstuvwxyz0123456789#%&?';
    const started = performance.now();
    const animation = setInterval(() => {
        if (!row.isConnected) { clearInterval(animation); return; }
        const progress = (performance.now() - started) / 650;
        if (progress >= 1) { clearInterval(animation); reveal(); return; }
        const resolved = Math.floor(progress * address.length);
        control.textContent = [...address].map((char, index) =>
            index < resolved ? char : glyphs[Math.floor(Math.random() * glyphs.length)]
        ).join('');
    }, 45);
});
