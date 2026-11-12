/*
 * Persona Library — image viewer (the lightbox).
 *
 * A real viewer rather than an enlarged thumbnail: scroll-wheel zoom around
 * the cursor, click-and-drag panning once zoomed in, pinch-zoom and drag on
 * touch screens, double-click to jump between "fit" and a closer look, and
 * Fit / 1:1 buttons. 1:1 shows the image at its true pixel size, which is the
 * quickest way to check fine detail.
 *
 * It only ever shows the URL it is handed, so the caller decides which file
 * that is — callers should pass the ORIGINAL image, never a thumbnail. To
 * keep that honest the viewer shows the loaded file's real pixel size, and
 * flags it when the file it ended up with is a low-res `/thumbnail` URL.
 *
 * Framework-free and independent of the gallery: it mounts one overlay on
 * `container` (same mounting rules as the other overlays — see gallery.js)
 * and exposes open / close / isOpen / destroy.
 */

const MAX_ZOOM = 8;

const make = (tag, className, text) => {
    const n = document.createElement(tag);
    if (className) n.className = className;
    if (text) n.textContent = text;
    return n;
};

const iconBtn = (icon, title, onClick) => {
    const b = make('button', 'pl-lv-btn');
    b.type = 'button';
    b.title = title;
    b.setAttribute('aria-label', title);
    const i = make('i', `fa-solid ${icon}`);
    b.append(i);
    b.addEventListener('click', onClick);
    return b;
};

const textBtn = (label, title, onClick) => {
    const b = make('button', 'pl-lv-btn pl-lv-btn-text', label);
    b.type = 'button';
    b.title = title;
    b.addEventListener('click', onClick);
    return b;
};

/** @param {HTMLElement} container */
export function createImageViewer(container) {
    const img = make('img', 'pl-lightbox-img');
    img.alt = '';
    img.draggable = false;
    const stage = make('div', 'pl-lv-stage');
    stage.append(img);

    const status = make('div', 'pl-lv-status');
    const pct = make('span', 'pl-lv-pct', '100%');
    const info = make('span', 'pl-lv-info');
    const fitBtn = textBtn('Fit', 'Fit to screen (0)', () => zoomTo('fit'));
    const actualBtn = textBtn('1:1', 'Actual pixels (1)', () => zoomTo(1));
    const bar = make('div', 'pl-lv-bar');
    bar.append(
        iconBtn('fa-magnifying-glass-minus', 'Zoom out (-)', () => zoomBy(1 / 1.5)),
        pct,
        iconBtn('fa-magnifying-glass-plus', 'Zoom in (+)', () => zoomBy(1.5)),
        fitBtn,
        actualBtn,
        info,
    );
    const closeBtn = make('button', 'pl-lightbox-close');
    closeBtn.type = 'button';
    closeBtn.title = 'Close';
    closeBtn.append(make('i', 'fa-solid fa-xmark'));
    closeBtn.addEventListener('click', () => close());

    const root = make('div', 'pl-lightbox pl-root');
    root.hidden = true;
    root.append(stage, status, bar, closeBtn);
    container.appendChild(root);

    let nw = 0;
    let nh = 0;
    let scale = 1;
    let x = 0;
    let y = 0;
    let fit = 1;
    let loadToken = 0;

    const stageSize = () => {
        const r = stage.getBoundingClientRect();
        return [r.width, r.height];
    };
    const minZoom = () => fit;
    const maxZoom = () => Math.max(MAX_ZOOM, fit);

    function clampPan() {
        const [W, H] = stageSize();
        const w = nw * scale;
        const h = nh * scale;
        x = w <= W ? (W - w) / 2 : Math.min(0, Math.max(W - w, x));
        y = h <= H ? (H - h) / 2 : Math.min(0, Math.max(H - h, y));
    }

    function apply() {
        clampPan();
        img.style.transform = `translate(${x}px, ${y}px) scale(${scale})`;
        pct.textContent = `${Math.round(scale * 100)}%`;
        const atFit = Math.abs(scale - fit) < 0.001;
        fitBtn.classList.toggle('pl-lv-on', atFit);
        actualBtn.classList.toggle('pl-lv-on', Math.abs(scale - 1) < 0.001);
        stage.classList.toggle('pl-lv-zoomed', !atFit);
    }

    function computeFit() {
        const [W, H] = stageSize();
        // Never upscales past 100%: "fit" shows the real pixels, not a blur.
        fit = W && H && nw && nh ? Math.min(1, W / nw, H / nh) : 1;
    }

    /** Zoom to `next`, keeping the point (cx, cy) in stage coordinates still. */
    function zoomAt(next, cx, cy) {
        const target = Math.min(maxZoom(), Math.max(minZoom(), next));
        const k = target / scale;
        x = cx - (cx - x) * k;
        y = cy - (cy - y) * k;
        scale = target;
        apply();
    }

    function zoomBy(factor) {
        const [W, H] = stageSize();
        zoomAt(scale * factor, W / 2, H / 2);
    }

    function zoomTo(value) {
        const [W, H] = stageSize();
        if (value === 'fit') { zoomAt(fit, W / 2, H / 2); return; }
        zoomAt(value, W / 2, H / 2);
    }

    function show(src, fallbackSrc, token, triedFallback) {
        img.onload = () => {
            if (token !== loadToken) return;
            nw = img.naturalWidth || stageSize()[0] || 1;
            nh = img.naturalHeight || stageSize()[1] || 1;
            computeFit();
            scale = fit;
            x = 0; y = 0;
            apply();
            img.style.visibility = 'visible';
            status.hidden = true;
            const thumb = /\/thumbnail\?/.test(img.currentSrc || img.src);
            info.textContent = `${nw} × ${nh} px${thumb ? ' • low-res thumbnail' : ''}`;
            info.classList.toggle('pl-lv-warn', thumb);
        };
        img.onerror = () => {
            if (token !== loadToken) return;
            if (fallbackSrc && !triedFallback && fallbackSrc !== src) { show(fallbackSrc, null, token, true); return; }
            status.textContent = 'Could not load this image.';
            status.hidden = false;
        };
        img.src = src;
    }

    /**
     * @param {{ src: string, alt?: string, fallbackSrc?: string }} opts
     * `fallbackSrc` is only tried if `src` fails to load (e.g. a gallery file
     * gone missing), so the viewer still shows something rather than nothing.
     */
    function open({ src, alt = '', fallbackSrc = '' }) {
        if (!src) return;
        const token = ++loadToken;
        img.alt = alt;
        img.style.visibility = 'hidden';
        img.style.transform = '';
        info.textContent = '';
        info.classList.remove('pl-lv-warn');
        status.textContent = 'Loading full-size image…';
        status.hidden = false;
        root.hidden = false;
        document.addEventListener('keydown', onKeydown, true);
        show(src, fallbackSrc, token, false);
    }

    function close() {
        if (root.hidden) return;
        loadToken++;
        root.hidden = true;
        img.onload = null;
        img.onerror = null;
        img.removeAttribute('src');
        pointers.clear();
        document.removeEventListener('keydown', onKeydown, true);
    }

    // -- wheel: zoom around the cursor --
    stage.addEventListener('wheel', (e) => {
        e.preventDefault();
        const dy = e.deltaMode === 1 ? e.deltaY * 16 : e.deltaY;
        const r = stage.getBoundingClientRect();
        zoomAt(scale * Math.exp(-dy * (e.ctrlKey ? 0.01 : 0.002)), e.clientX - r.left, e.clientY - r.top);
    }, { passive: false });

    // -- pointer: drag to pan, two fingers to pinch --
    const pointers = new Map();
    let moved = false;
    let last = null; // { dist, mx, my } for a pinch in progress

    const pinchState = () => {
        const [a, b] = [...pointers.values()];
        const r = stage.getBoundingClientRect();
        return { dist: Math.hypot(a.x - b.x, a.y - b.y) || 1, mx: (a.x + b.x) / 2 - r.left, my: (a.y + b.y) / 2 - r.top };
    };

    stage.addEventListener('pointerdown', (e) => {
        if (e.button !== undefined && e.button !== 0) return;
        pointers.set(e.pointerId, { x: e.clientX, y: e.clientY, sx: e.clientX, sy: e.clientY });
        try { stage.setPointerCapture(e.pointerId); } catch { /* ignore */ }
        if (pointers.size === 1) moved = false;
        if (pointers.size === 2) { last = pinchState(); moved = true; }
        if (scale > fit + 0.001) stage.classList.add('pl-lv-dragging');
    });

    stage.addEventListener('pointermove', (e) => {
        const p = pointers.get(e.pointerId);
        if (!p) return;
        const dx = e.clientX - p.x;
        const dy = e.clientY - p.y;
        p.x = e.clientX;
        p.y = e.clientY;
        if (pointers.size >= 2 && last) {
            const now = pinchState();
            const k = now.dist / last.dist;
            x += now.mx - last.mx;
            y += now.my - last.my;
            zoomAt(scale * k, now.mx, now.my);
            last = now;
            return;
        }
        if (Math.hypot(e.clientX - p.sx, e.clientY - p.sy) > 4) moved = true;
        if (scale > fit + 0.001) { x += dx; y += dy; apply(); }
    });

    const endPointer = (e) => {
        pointers.delete(e.pointerId);
        last = null;
        if (!pointers.size) stage.classList.remove('pl-lv-dragging');
        try { stage.releasePointerCapture(e.pointerId); } catch { /* ignore */ }
    };
    stage.addEventListener('pointerup', endPointer);
    stage.addEventListener('pointercancel', endPointer);

    // A click on the empty backdrop closes — but never the click that merely
    // ends a drag or pinch, even if the pointer finished over the backdrop.
    stage.addEventListener('click', (e) => {
        if (e.target === stage && !moved) close();
        moved = false;
    });

    stage.addEventListener('dblclick', (e) => {
        if (e.target !== img) return;
        const r = stage.getBoundingClientRect();
        const atFit = Math.abs(scale - fit) < 0.001;
        zoomAt(atFit ? (fit < 1 ? 1 : 2) : fit, e.clientX - r.left, e.clientY - r.top);
    });

    function onKeydown(e) {
        if (root.hidden) return;
        const step = 80;
        switch (e.key) {
            case 'Escape': close(); break;
            case '+': case '=': zoomBy(1.5); break;
            case '-': case '_': zoomBy(1 / 1.5); break;
            case '0': case 'f': case 'F': zoomTo('fit'); break;
            case '1': zoomTo(1); break;
            case 'ArrowLeft': x += step; apply(); break;
            case 'ArrowRight': x -= step; apply(); break;
            case 'ArrowUp': y += step; apply(); break;
            case 'ArrowDown': y -= step; apply(); break;
            default: return;
        }
        e.preventDefault();
        e.stopPropagation();
    }

    // Keep "fit" correct when the window (or the mobile keyboard/toolbar) resizes.
    let ro = null;
    if (typeof ResizeObserver === 'function') {
        ro = new ResizeObserver(() => {
            if (root.hidden || !nw) return;
            const wasFit = Math.abs(scale - fit) < 0.001;
            computeFit();
            if (wasFit || scale < fit) scale = fit;
            apply();
        });
        ro.observe(stage);
    }

    return {
        open,
        close,
        isOpen: () => !root.hidden,
        destroy() {
            close();
            try { ro?.disconnect(); } catch { /* ignore */ }
            root.remove();
        },
    };
}
