// Play muted decorative videos (e.g. VestaPreview) only when near the viewport
// so offscreen videos don't compete with embeds above them on initial load.
const reducedMotion = matchMedia('(prefers-reduced-motion: reduce)');
const observer = 'IntersectionObserver' in window
    ? new IntersectionObserver(entries => {
        for (const entry of entries) {
            const video = entry.target;
            if (entry.isIntersecting && !reducedMotion.matches) video.play().catch(() => {});
            else video.pause();
        }
    }, { rootMargin: '200px 0px' })
    : null;

function observeVideos() {
    for (const video of document.querySelectorAll('video[data-autoplay-visible]:not([data-video-observed])')) {
        video.dataset.videoObserved = '';
        if (observer) observer.observe(video);
        else if (!reducedMotion.matches) video.play().catch(() => {});
    }
}

observeVideos();
document.addEventListener('xyz:navigated', observeVideos);
