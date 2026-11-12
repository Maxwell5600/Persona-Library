/*
 * Persona Library — bridge between the chat-bar Quick Switcher and the
 * gallery.
 *
 * The Quick Switcher lives in the chat bar and deliberately works without
 * the gallery being mounted or the Persona Management drawer being open.
 * Its right-click actions that need real windows (Edit, Open image gallery,
 * Compare with…, Manage incarnations) therefore do NOT drive the gallery
 * inside the drawer. Instead they use a second, headless "overlay" instance
 * of the very same gallery code (see the `overlay` option of
 * createPersonaLibrary): it has no grid and no toolbar, just the editor /
 * compare / incarnation windows, mounted on <body> so they open right over
 * the chat. The gallery's own right-click menu is untouched and keeps using
 * its own windows inside the drawer.
 *
 * index.js registers the factory here. No import cycle, no globals.
 *
 * Because there can be two live instances, they tell each other when
 * something changed (a save, a favorite, a delete…) through the tiny
 * pub/sub at the bottom, so neither ever shows stale data.
 */

let library = null;
let overlayFactory = null;
let overlayLib = null;
let overlayHost = null;

export function setLibrary(api) { library = api ?? null; }
export function getLibrary() { return library; }

/** index.js: how to build an overlay instance onto a given host element. */
export function setOverlayFactory(factory) { overlayFactory = typeof factory === 'function' ? factory : null; }

/**
 * The chat-bar overlay instance, created lazily on first use. Independent of
 * the drawer: works even if the Persona Management tab was never opened.
 * Returns null only if the factory isn't registered or construction fails.
 */
export function getOverlayLibrary() {
    if (overlayLib) return overlayLib;
    if (!overlayFactory) return null;
    const host = document.createElement('div');
    host.id = 'persona-library-chat-host';
    document.body.append(host);
    try {
        overlayLib = overlayFactory(host);
        overlayHost = host;
    } catch (e) {
        console.error('[PersonaLibrary] could not create the chat-bar overlay', e);
        host.remove();
        overlayLib = null;
        overlayHost = null;
    }
    return overlayLib;
}

export function destroyOverlayLibrary() {
    try { overlayLib?.destroy(); } catch { /* ignore */ }
    overlayHost?.remove();
    overlayLib = null;
    overlayHost = null;
}

/* ---- cross-instance change notifications ---- */

const listeners = new Set();

/** @returns {() => void} unsubscribe */
export function onLibraryChanged(cb) {
    listeners.add(cb);
    return () => listeners.delete(cb);
}

/** Tell every OTHER subscriber that persona data / favorites changed. */
export function emitLibraryChanged(source) {
    for (const cb of [...listeners]) {
        try { cb(source); } catch (e) { console.error('[PersonaLibrary] change listener failed', e); }
    }
}
