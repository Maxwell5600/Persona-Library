/*
 * Persona Library — SillyTavern data adapter.
 * Reads and writes persona state through SillyTavern's own context/settings,
 * so nothing diverges from the native persona UI.
 */

// getContext() does NOT expose persona-switching (setUserAvatar) or the
// active persona id (user_avatar) — verified directly against ST's source.
// Both ARE genuine module exports of script.js though, just not routed
// through the context wrapper, so we import them directly instead of
// guessing at DOM selectors or context properties that don't exist.
import { setUserAvatar as stSetUserAvatar, user_avatar as activeUserAvatar, default_user_avatar } from '../../../../../script.js';
import { initPersona } from '../../../../personas.js';

const SETTINGS_KEY = 'personaLibrary';
const SECTIONS_KEY = 'personaLibrarySections';
const DEFAULTS = { sort: 'name', tile: 150, query: '', tags: [] };

export const ctx = () => globalThis.SillyTavern?.getContext?.() ?? null;

function powerUser() {
    const c = ctx();
    return c?.powerUserSettings ?? globalThis.power_user ?? {};
}

async function headers(json = true) {
    const c = ctx();
    let h = {};
    try { h = { ...(c?.getRequestHeaders?.() ?? {}) }; } catch { /* ignore */ }
    if (!h['X-CSRF-Token']) {
        try {
            const res = await fetch('/csrf-token');
            if (res.ok) h['X-CSRF-Token'] = (await res.json()).token;
        } catch { /* ignore */ }
    }
    if (json) h['Content-Type'] = 'application/json';
    else delete h['Content-Type'];
    return h;
}

// Cache-busting tokens, keyed by persona id. avatarUrl() consults this on
// every call, so a re-render after a replace still gets the fresh image —
// patching only the currently-visible <img> tags wasn't enough, since the
// very next re-render rebuilds them from a plain (cacheable) URL.
const avatarCacheBust = {};

export function avatarUrl(id) {
    const v = avatarCacheBust[id];
    return `/User%20Avatars/${encodeURIComponent(id)}${v ? `?v=${v}` : ''}`;
}

export function avatarThumbFallback(id) {
    return `/thumbnail?type=persona&file=${encodeURIComponent(id)}`;
}

function tagsFor(id, desc) {
    if (Array.isArray(desc?.tags)) return desc.tags.map(String);
    const c = ctx();
    const ids = c?.tagMap?.[id];
    if (!Array.isArray(ids) || !Array.isArray(c?.tags)) return [];
    return ids.map((t) => c.tags.find((x) => x.id === t)?.name).filter(Boolean);
}

/*
 * Sections: an extensible layer on top of the plain persona description —
 * a "core" block plus any number of labeled, toggleable blocks (Outfit,
 * Scene Details, Lore, Rules, Mood, or custom ones). We keep the source of
 * truth for these here, under our own extension settings, and RECOMPOSE the
 * final text into SillyTavern's native persona_descriptions[id].description
 * whenever something changes — that's the field ST actually injects into
 * the prompt, so nothing new needs to hook into generation directly.
 *
 * Trade-off: only the composed result round-trips through ST's own backup/
 * restore and the native persona editor. The core/sections breakdown lives
 * only in this extension's settings.
 */
function sectionsStore() {
    const c = ctx();
    if (!c?.extensionSettings) return {};
    c.extensionSettings[SECTIONS_KEY] = c.extensionSettings[SECTIONS_KEY] ?? {};
    return c.extensionSettings[SECTIONS_KEY];
}

export function getPersonaSections(id) {
    const store = sectionsStore();
    if (store[id]) return structuredClone(store[id]);
    // First time we've touched this persona: treat its existing native
    // description as the "core" text, with no extra sections yet.
    const pu = powerUser();
    const existing = pu.persona_descriptions?.[id]?.description ?? '';
    return { core: existing, sections: [] };
}

export function composeDescription(core, sections) {
    const parts = [(core ?? '').trim()];
    for (const s of sections ?? []) {
        if (!s.enabled || !(s.content ?? '').trim()) continue;
        parts.push(`[${s.title || 'Section'}: ${s.content.trim()}]`);
    }
    return parts.filter(Boolean).join('\n\n');
}

export async function savePersonaSections(id, { core, sections }) {
    const store = sectionsStore();
    store[id] = { core, sections };
    const pu = powerUser();
    pu.persona_descriptions = pu.persona_descriptions ?? {};
    const d = pu.persona_descriptions[id] ?? { position: 0, depth: 2, role: 0, lorebook: '' };
    d.description = composeDescription(core, sections);
    pu.persona_descriptions[id] = d;
    if (getActiveId() === id && typeof ctx()?.setPersonaDescription === 'function') {
        try { ctx().setPersonaDescription(); } catch { /* ignore */ }
    }
    ctx()?.saveSettingsDebounced?.();
}

export function getPersonas() {
    const pu = powerUser();
    const personas = pu.personas ?? {};
    const descs = pu.persona_descriptions ?? {};
    const store = sectionsStore();
    return Object.entries(personas).map(([id, name], index) => {
        const d = descs[id] ?? {};
        return {
            id,
            name: typeof name === 'string' ? name : (name?.name ?? id),
            image: avatarUrl(id),
            // Prefer the clean "core" text for previews if we have one, so
            // section markup ([Outfit: ...] etc.) doesn't clutter the grid.
            description: store[id]?.core ?? d.description ?? '',
            position: d.position,
            depth: d.depth ?? 2,
            role: d.role ?? 0,
            lorebook: d.lorebook ?? '',
            connections: Array.isArray(d.connections)
                ? d.connections.map((x) => (typeof x === 'string' ? x : x?.name ?? x?.id ?? '')).filter(Boolean)
                : [],
            tags: tagsFor(id, d),
            created: d.date_added ?? index,
            lastUsed: d.date_last_used ?? d.date_added ?? index,
        };
    });
}

export function getActiveId() {
    return activeUserAvatar ?? null;
}

export function getSettings() {
    const c = ctx();
    const stored = c?.extensionSettings?.[SETTINGS_KEY] ?? {};
    return { ...DEFAULTS, ...stored };
}

export function saveSettings(patch) {
    const c = ctx();
    if (!c?.extensionSettings) return;
    c.extensionSettings[SETTINGS_KEY] = { ...getSettings(), ...patch };
    c.saveSettingsDebounced?.();
}

export function subscribe(cb) {
    const c = ctx();
    const es = c?.eventSource;
    const types = c?.eventTypes ?? c?.event_types ?? {};
    if (!es?.on) return () => {};
    const names = [types.SETTINGS_UPDATED, types.SETTINGS_LOADED_AFTER, types.APP_READY, 'persona_updated']
        .filter(Boolean);
    for (const n of names) es.on(n, cb);
    return () => { for (const n of names) es.removeListener?.(n, cb); };
}

export async function setActive(id) {
    const pu = powerUser();
    // The real native switch function: reloads avatars, updates UI state,
    // selects the persona, re-triggers first message if needed, saves, and
    // emits PERSONA_CHANGED — same path the native click handler uses.
    await stSetUserAvatar(id, { toastPersonaNameChange: true });
    if (pu.persona_descriptions?.[id]) pu.persona_descriptions[id].date_last_used = Date.now();
    ctx()?.saveSettingsDebounced?.();
}

export async function updatePersona(id, patch) {
    const c = ctx();
    const pu = powerUser();
    if (!pu.personas) throw new Error('Persona storage unavailable');
    if (patch.name) pu.personas[id] = patch.name;
    pu.persona_descriptions = pu.persona_descriptions ?? {};
    const d = pu.persona_descriptions[id] ?? { description: '', position: 0, depth: 2, role: 0, lorebook: '' };
    if (patch.description !== undefined) d.description = patch.description;
    if (patch.position !== undefined) d.position = patch.position;
    if (patch.depth !== undefined && !Number.isNaN(patch.depth)) d.depth = patch.depth;
    if (patch.role !== undefined && !Number.isNaN(patch.role)) d.role = patch.role;
    pu.persona_descriptions[id] = d;
    if (getActiveId() === id && typeof c?.setPersonaDescription === 'function') {
        try { c.setPersonaDescription(); } catch { /* ignore */ }
    }
    c?.saveSettingsDebounced?.();
}

export async function replaceAvatar(id, file) {
    const form = new FormData();
    form.append('avatar', file);
    form.append('overwrite_name', id); // must be a form field, not a query param
    const res = await fetch('/api/avatars/upload', {
        method: 'POST',
        headers: await headers(false),
        cache: 'no-cache',
        body: form,
    });
    if (!res.ok) throw new Error(`Upload failed: ${res.status}`);
    // Every future avatarUrl(id) call — including the re-render that fires
    // right after this — will now include a fresh token automatically.
    avatarCacheBust[id] = Date.now();
}

export async function duplicatePersona(id) {
    const pu = powerUser();
    const blob = await (await fetch(`/User Avatars/${encodeURIComponent(id)}`)).blob();
    const newId = `${Date.now()}-${id}`.replace(/[^\w.\-]/g, '_');
    const form = new FormData();
    form.append('avatar', new File([blob], newId, { type: blob.type || 'image/png' }));
    form.append('overwrite_name', newId); // must be a form field, not a query param
    const res = await fetch('/api/avatars/upload', {
        method: 'POST',
        headers: await headers(false),
        cache: 'no-cache',
        body: form,
    });
    if (!res.ok) throw new Error(`Duplicate failed: ${res.status}`);
    const savedName = (await res.json().catch(() => ({})))?.path ?? newId;
    pu.personas[savedName] = `${pu.personas[id] ?? id} (copy)`;
    pu.persona_descriptions = pu.persona_descriptions ?? {};
    pu.persona_descriptions[savedName] = { ...(pu.persona_descriptions[id] ?? {}), date_added: Date.now() };
    ctx()?.saveSettingsDebounced?.();
}

export async function deletePersona(id) {
    const pu = powerUser();
    const res = await fetch('/api/avatars/delete', {
        method: 'POST',
        headers: await headers(true),
        body: JSON.stringify({ avatar: id }),
    });
    if (!res.ok) throw new Error(`Delete failed: ${res.status}`);
    delete pu.personas?.[id];
    delete pu.persona_descriptions?.[id];
    ctx()?.saveSettingsDebounced?.();
}

export async function confirmDialog(message) {
    const c = ctx();
    if (typeof c?.callGenericPopup === 'function' && c?.POPUP_TYPE?.CONFIRM !== undefined) {
        return Boolean(await c.callGenericPopup(message, c.POPUP_TYPE.CONFIRM));
    }
    return window.confirm(message);
}

export async function promptText(message, defaultValue = '') {
    const c = ctx();
    if (typeof c?.callGenericPopup === 'function' && c?.POPUP_TYPE?.INPUT !== undefined) {
        const result = await c.callGenericPopup(message, c.POPUP_TYPE.INPUT, defaultValue);
        return typeof result === 'string' ? result : null;
    }
    return window.prompt(message, defaultValue);
}

export async function createPersona(name) {
    const trimmed = (name ?? '').trim();
    if (!trimmed) throw new Error('A name is required.');
    // Mirror the native "New Persona" id scheme: timestamp + sanitized name.
    const avatarId = `${Date.now()}-${trimmed.replace(/[^a-zA-Z0-9]/g, '')}.png`;
    await initPersona(avatarId, trimmed, '', '');
    // Seed a real backing image (a copy of ST's own default persona avatar)
    // so the new entry isn't a broken image until the user replaces it.
    try {
        const blob = await (await fetch(default_user_avatar)).blob();
        const form = new FormData();
        form.append('avatar', new File([blob], avatarId, { type: blob.type || 'image/png' }));
        form.append('overwrite_name', avatarId);
        await fetch('/api/avatars/upload', {
            method: 'POST',
            headers: await headers(false),
            cache: 'no-cache',
            body: form,
        });
    } catch (e) {
        console.warn('[PersonaLibrary] could not seed a default avatar image for the new persona', e);
    }
    ctx()?.saveSettingsDebounced?.();
    return avatarId;
}

export const stAdapter = {
    getPersonas,
    getActiveId,
    getSettings,
    saveSettings,
    subscribe,
    setActive,
    updatePersona,
    replaceAvatar,
    duplicatePersona,
    deletePersona,
    createPersona,
    confirm: confirmDialog,
    promptText,
    fallbackImage: avatarThumbFallback,
    getPersonaSections,
    savePersonaSections,
};
