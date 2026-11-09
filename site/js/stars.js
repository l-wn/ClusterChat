// The header's GitHub button: "Star" until the count arrives from
// /stars.json (kept by the signaling server, so the browser never asks
// GitHub), then "53 stars". A missing count leaves it as it is.
(() => {
    const spots = document.querySelectorAll('[data-stars]');
    if (!spots.length) return;
    fetch('/stars.json').then((r) => (r.ok ? r.json() : null)).then((d) => {
        const n = d?.stars;
        if (!Number.isInteger(n)) return;
        const shown = n >= 1000 ? `${(n / 1000).toFixed(n >= 10000 ? 0 : 1).replace(/\.0$/, '')}k` : String(n);
        for (const el of spots) el.textContent = `${shown} ${n === 1 ? 'star' : 'stars'}`;
    }).catch(() => {});
})();
