/*
 * Persona Library — entry point.
 * Mounts the gallery inside SillyTavern's Persona Management block and hides
 * the native avatar strip. Any failure leaves the native UI untouched.
 */

import { createPersonaLibrary } from './modules/gallery.js';
import { stAdapter, ctx, registerVariantGenerationHook } from './modules/st-adapter.js';
import { mountSettingsPanel } from './modules/settings-panel.js';

const HOST_ID = 'persona-library-host';
let instance = null;
let observer = null;
let mountQueued = false;
let unregisterVariantHook = null;

function personaBlock() {
    // #PersonaManagement is SillyTavern's actual drawer-content wrapper for
    // the whole Persona's tab — it holds the title/Usage-Stats/Backup/Restore
    // row AND #persona-management-block (both columns), plus whatever any
    // other extension (e.g. PTMT's dialogue colorizer) injects alongside it.
    // Mounting here and hiding every OTHER direct child is what actually
    // takes over the tab, instead of hiding individual pieces one at a time.
    return document.querySelector('#PersonaManagement')
        ?? document.querySelector('#persona-management-block')
        ?? document.querySelector('#user_avatar_block')?.parentElement
        ?? null;
}

function mount() {
    if (document.getElementById(HOST_ID)) return true;
    const block = personaBlock();
    const nativeList = document.querySelector('#user_avatar_block');
    if (!block || !nativeList) return false;

    const host = document.createElement('div');
    host.id = HOST_ID;
    block.prepend(host);

    try {
        instance = createPersonaLibrary(host, stAdapter);
        document.body.classList.add('pl-active');
        return true;
    } catch (e) {
        console.error('[PersonaLibrary] mount failed, keeping the native list', e);
        host.remove();
        document.body.classList.remove('pl-active');
        instance = null;
        return false;
    }
}

function unmount() {
    try { instance?.destroy(); } catch { /* ignore */ }
    instance = null;
    document.getElementById(HOST_ID)?.remove();
    document.body.classList.remove('pl-active');
}

function watch() {
    if (observer) return;
    observer = new MutationObserver(() => {
        // Never refresh in response to DOM mutations. Gallery rendering itself
        // mutates this subtree, so doing so creates an endless redraw loop.
        mountSettingsPanel(); // idempotent (bails via getElementById) — cheap to retry
        if (document.getElementById(HOST_ID) || mountQueued) return;
        mountQueued = true;
        setTimeout(() => {
            mountQueued = false;
            mount();
        }, 0);
    });
    // Watch the stable document body so a drawer replaced or moved by PTMT can
    // be mounted again. Existing hosts need no work when merely reparented.
    observer.observe(document.body, { childList: true, subtree: true });
}

async function boot() {
    for (let i = 0; i < 60 && !mount(); i++) {
        await new Promise((r) => setTimeout(r, 500));
    }
    if (instance) watch();
    mountSettingsPanel();
    if (!unregisterVariantHook) {
        try { unregisterVariantHook = registerVariantGenerationHook(); } catch (e) { console.error('[PersonaLibrary] could not register variant generation hook', e); }
    }
    window.addEventListener('resize', () => instance?.refresh(), { passive: true });
}

function safeBoot() {
    // Never let this extension reject or block SillyTavern's init sequence.
    Promise.resolve().then(boot).catch((e) => console.error('[PersonaLibrary]', e));
}

function start() {
    try {
        const c = ctx();
        const es = c?.eventSource;
        const types = c?.eventTypes ?? c?.event_types ?? {};
        if (es?.on && types.APP_READY) es.on(types.APP_READY, safeBoot);
    } catch (e) {
        console.error('[PersonaLibrary] context unavailable at load', e);
    }
    safeBoot();
}

// Defer past the extension loader so nothing here can stall initialization.
setTimeout(() => {
    try { start(); } catch (e) { console.error('[PersonaLibrary]', e); }
}, 0);

export async function onEnable() { safeBoot(); }
export async function onDisable() { unmount(); try { unregisterVariantHook?.(); } catch { /* ignore */ } unregisterVariantHook = null; }
export async function onDelete() { unmount(); try { unregisterVariantHook?.(); } catch { /* ignore */ } unregisterVariantHook = null; }
