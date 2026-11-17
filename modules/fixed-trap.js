/*
 * Persona Library — keeps `position: fixed` overlays pinned to the SCREEN.
 *
 * The gallery's windows (persona editor, compare, dialogs, enlarged image)
 * are deliberately mounted inside SillyTavern's Persona drawer so that
 * SillyTavern doesn't treat a click on them as "outside the drawer" and close
 * it (see the long note above `container.appendChild(detail)` in gallery.js).
 *
 * The catch: SillyTavern's drawer (.drawer-content) has a `backdrop-filter`
 * and scrolls (overflow-y: auto) once enough personas are loaded. A
 * backdrop-filter — like filter, perspective, or a transform — makes the
 * element the containing block for `position: fixed` descendants. The windows
 * then anchor to the drawer's scrolling box instead of the screen: scroll the
 * list down and the editor stays behind at the top of it, partly or fully
 * off-screen, and you have to scroll back up to find it.
 *
 * Fix, applied only while one of our overlays is actually open: switch off
 * whichever of those properties is trapping fixed positioning on the
 * ancestors above the container, then put each one back exactly as it was the
 * moment the last overlay closes. The DOM doesn't change, so the drawer's
 * outside-click logic is untouched, and nothing is touched while no overlay is
 * open. Only properties that are safe to drop for a moment are handled (blur
 * and filters are purely cosmetic behind the dark scrim; a transform is only
 * dropped when it's an identity transform that does nothing but create the
 * trap, never one that actually positions something).
 *
 * Releasing the trap alone would make the windows cover the WHOLE screen —
 * including anything that sits above the drawer, such as the tab bar added by
 * "Probably Too Many Tabs" (PTMT), which would then draw on top of them. So
 * the windows keep covering exactly the area the trapping drawer covers on
 * screen (its box clipped to the viewport), the same area they filled before,
 * just measured live so scrolling the drawer can't move them. The edges are
 * handed to the CSS as --pl-fx-top/right/bottom/left on the container.
 */

/** Selector matching any overlay of ours that is currently shown. */
const OPEN_OVERLAY = [
    '.pl-detail:not([hidden])',
    '.pl-text-focus-overlay:not([hidden])',
    '.pl-dialog:not([hidden])',
    '.pl-compare:not([hidden])',
    '.pl-lightbox:not([hidden])',
].join(',');

const isIdentityTransform = (t) => {
    if (!t || t === 'none') return true;
    const m = /^matrix(3d)?\(([^)]*)\)$/.exec(t);
    if (!m) return false;
    const v = m[2].split(',').map((n) => Number(n.trim()));
    const identity = m[1] ? [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1] : [1, 0, 0, 1, 0, 0];
    return v.length === identity.length && v.every((n, i) => Math.abs(n - identity[i]) < 1e-6);
};

/** The inline overrides that would release this element's grip on fixed descendants. */
function overridesFor(el) {
    const cs = getComputedStyle(el);
    const out = [];
    const none = (v) => !v || v === 'none';
    if (!none(cs.backdropFilter) || !none(cs.webkitBackdropFilter)) {
        out.push(['backdrop-filter', 'none'], ['-webkit-backdrop-filter', 'none']);
    }
    if (!none(cs.filter)) out.push(['filter', 'none']);
    if (!none(cs.perspective)) out.push(['perspective', 'none']);
    if (/transform|perspective|filter/.test(cs.willChange ?? '')) out.push(['will-change', 'auto']);
    if (!none(cs.transform) && isIdentityTransform(cs.transform)) out.push(['transform', 'none']);
    return out;
}

/**
 * @param {HTMLElement} container where the overlays are mounted
 * @returns {{ destroy: () => void }}
 */
export function watchFixedOverlays(container) {
    /** @type {{el: HTMLElement, prop: string, value: string, priority: string}[]} */
    let saved = [];
    let applied = false;

    let trapper = null;
    const FX = ['top', 'right', 'bottom', 'left'];

    /** Cover what the trapping drawer covers on screen (clipped to the viewport). */
    function placeEdges() {
        if (!trapper) return;
        const r = trapper.getBoundingClientRect();
        const w = document.documentElement.clientWidth || window.innerWidth;
        const h = document.documentElement.clientHeight || window.innerHeight;
        const edges = {
            top: Math.max(0, r.top), left: Math.max(0, r.left),
            right: Math.max(0, w - r.right), bottom: Math.max(0, h - r.bottom),
        };
        for (const k of FX) container.style.setProperty(`--pl-fx-${k}`, `${Math.round(edges[k])}px`);
    }

    function apply() {
        if (applied) return;
        applied = true;
        trapper = null;
        for (let el = container.parentElement; el && el !== document.documentElement; el = el.parentElement) {
            const ov = overridesFor(el);
            if (ov.length && !trapper) { trapper = el; placeEdges(); }
            for (const [prop, value] of ov) {
                saved.push({ el, prop, value: el.style.getPropertyValue(prop), priority: el.style.getPropertyPriority(prop) });
                el.style.setProperty(prop, value, 'important');
            }
        }
    }

    function restore() {
        if (!applied) return;
        applied = false;
        for (const { el, prop, value, priority } of saved.reverse()) {
            if (value) el.style.setProperty(prop, value, priority); else el.style.removeProperty(prop);
        }
        saved = [];
        trapper = null;
        for (const k of FX) container.style.removeProperty(`--pl-fx-${k}`);
    }

    const sync = () => { if (container.querySelector(OPEN_OVERLAY)) apply(); else restore(); };
    // Attribute changes to `hidden` (windows opening/closing) anywhere inside,
    // plus windows being added/removed. Runs as a microtask — before the next paint.
    const observer = new MutationObserver(sync);
    observer.observe(container, { subtree: true, childList: true, attributes: true, attributeFilter: ['hidden'] });
    sync();
    window.addEventListener('resize', placeEdges);

    return {
        destroy() {
            observer.disconnect();
            window.removeEventListener('resize', placeEdges);
            restore();
        },
    };
}
