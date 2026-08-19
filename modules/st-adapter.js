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
import { setUserAvatar as stSetUserAvatar, user_avatar as activeUserAvatar, default_user_avatar, setUserName } from '../../../../../script.js';
import { initPersona } from '../../../../personas.js';
import { composeVariants, normalizeVariants, defaultVariants } from './variants.js';

const SETTINGS_KEY = 'personaLibrary';
const SECTIONS_KEY = 'personaLibrarySections';
const VARIANTS_KEY = 'personaLibraryVariants';
const CHAR_BINDING_FIELD = 'personaLibraryBindingId';
const CHAT_BINDING_KEY = 'personaLibraryBindingId';
const DEFAULTS = { sort: 'name', tile: 150, query: '', reliableCharacterBindings: false };

export const ctx = () => globalThis.SillyTavern?.getContext?.() ?? null;

/**
 * SillyTavern's own code emits event_types.PERSONA_UPDATED after any
 * rename/description/avatar change — that's what the chat header, the
 * {{user}} macro re-render, and other native UI actually listen for. We
 * were mutating power_user data directly without ever emitting it, so
 * nothing outside our own gallery knew a persona had changed until a full
 * page reload forced everything to re-read from scratch.
 */
function notifyPersonaUpdated(id) {
    const c = ctx();
    try {
        c?.eventSource?.emit?.(c?.event_types?.PERSONA_UPDATED, id);
    } catch (e) {
        console.warn('[PersonaLibrary] could not emit PERSONA_UPDATED', e);
    }
}

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
    // IMPORTANT: if a variant swap is currently active for THIS persona,
    // persona_descriptions[id].description is temporarily the composed
    // (core+variants) text, not the real core — falling back to it directly
    // here would let composed text leak into the Edit tab as if it were the
    // real saved value. Use the live PATCH SNAPSHOT in that case instead
    // (see patchState below) — NOT a separately-cached copy, so this always
    // reflects whatever was actually saved, however it got there (native ST
    // panel, another extension, an import, etc.).
    const pu = powerUser();
    const existing = (patchState.active && patchState.id === id)
        ? patchState.original
        : (pu.persona_descriptions?.[id]?.description ?? '');
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
    notifyPersonaUpdated(id);
}

/*
 * Variants — see modules/variants.js for the pure data model. Everything
 * here is the SillyTavern-specific half: where the per-persona variant tree
 * is stored, how "this character" / "this chat" get a stable identity, and
 * the generation-time hook that composes them in and reverts them back out
 * without ever touching the persona's real, saved description.
 */
function variantsStore() {
    const c = ctx();
    if (!c?.extensionSettings) return {};
    c.extensionSettings[VARIANTS_KEY] = c.extensionSettings[VARIANTS_KEY] ?? {};
    return c.extensionSettings[VARIANTS_KEY];
}

export function getPersonaVariants(id) {
    const store = variantsStore();
    return normalizeVariants(store[id] ?? defaultVariants());
}

export function savePersonaVariants(id, data) {
    const store = variantsStore();
    store[id] = normalizeVariants(data);
    ctx()?.saveSettingsDebounced?.();
}

export function getReliableCharacterBindings() {
    return !!getSettings().reliableCharacterBindings;
}

/**
 * Info about whatever character is currently open, including its Persona
 * Library binding id IF one has already been stamped — this never writes
 * anything, it only reads. Returns null if no character is open.
 */
export function getCurrentCharacterInfo() {
    const c = ctx();
    const idx = c?.characterId;
    if (idx === undefined || idx === null || idx === '') return null;
    const character = c?.characters?.[idx];
    if (!character) return null;
    return {
        index: idx,
        name: character.name ?? '',
        avatar: character.avatar ?? '',
        description: character.description ?? '',
        bindingId: character.data?.extensions?.[CHAR_BINDING_FIELD] ?? null,
    };
}

/** Read-only accessor used during generation — never stamps anything itself. */
export function getCharacterBindingId() {
    return getCurrentCharacterInfo()?.bindingId ?? null;
}

/**
 * Returns a stable id for the currently-open character, reusing an existing
 * stamp if one's already there (from ANY variant, any persona — the id lives
 * on the character, not on our data). Only mints and writes a new one if the
 * "Reliable character bindings" setting is on; otherwise returns null so
 * callers fall back to avatar-filename matching, same as native ST.
 */
export async function ensureCharacterBindingId() {
    const c = ctx();
    const info = getCurrentCharacterInfo();
    if (!info) return null;
    if (info.bindingId) return info.bindingId;
    if (!getReliableCharacterBindings()) return null;
    if (typeof c?.writeExtensionField !== 'function') {
        console.warn('[PersonaLibrary] writeExtensionField is unavailable in this ST version; cannot stamp a reliable character binding.');
        return null;
    }
    const uuid = crypto.randomUUID();
    try {
        await c.writeExtensionField(info.index, CHAR_BINDING_FIELD, uuid);
        return uuid;
    } catch (e) {
        console.warn('[PersonaLibrary] could not stamp character binding id', e);
        return null;
    }
}

/** Read-only — the current chat's binding id, if one's already been stamped. */
export function getChatBindingId() {
    return ctx()?.chatMetadata?.[CHAT_BINDING_KEY] ?? null;
}

/**
 * Mints and persists a stable id for the CURRENT chat, stored inside the
 * chat's own chat_metadata — content that travels with the chat file itself,
 * not its (renameable) filename, and survives /renamechat plus export and
 * re-import for the same reason ST's own native chat-lock feature does.
 */
export async function ensureChatBindingId() {
    const c = ctx();
    if (!c?.chatMetadata) return null;
    if (c.chatMetadata[CHAT_BINDING_KEY]) return c.chatMetadata[CHAT_BINDING_KEY];
    const uuid = crypto.randomUUID();
    c.chatMetadata[CHAT_BINDING_KEY] = uuid;
    try {
        await c.saveMetadata?.();
    } catch (e) {
        console.warn('[PersonaLibrary] could not save chat binding id', e);
    }
    return uuid;
}

/** Best-effort human-readable label for the current chat, display only — never used for matching. */
export function getCurrentChatLabel() {
    const c = ctx();
    const charName = c?.characters?.[c?.characterId]?.name;
    return charName ? `Current chat with ${charName}` : 'Current chat';
}

function activeVariantContext() {
    const info = getCurrentCharacterInfo();
    return {
        characterBindingId: info?.bindingId ?? null,
        chatBindingId: getChatBindingId(),
        characterDescription: info?.description ?? '',
    };
}

// --- PME-style runtime patch state -----------------------------------
// Mirrors PME's src/injector.js patchState exactly: `original` is always a
// LIVE snapshot of d.description taken at the moment of the swap — never a
// separately-cached value (that was the bug in the previous "fallback-fix"
// build: it sourced restore from the Sections cache, which can silently
// drift out of sync with the real, live persona description).
// Only one swap is tracked at a time, same as PME.
let patchState = { active: false, id: null, original: null, restoreTimer: null };
let generationStartCount = 0;
let hookInstalled = false; // module-level idempotency guard — see registerVariantGenerationHook

function restorePatch(reason) {
    if (!patchState.active) {
        console.log(`[PersonaLibrary] restorePatch(${reason}): nothing active, no-op`);
        return;
    }
    const { id, original } = patchState;
    try {
        const pu = powerUser();
        const d = pu.persona_descriptions?.[id];
        if (!d) {
            console.warn('[PersonaLibrary] restore skipped: no persona_descriptions entry for', id, '— will retry on next start/end event');
            return; // leave patchState.active=true so a later call retries
        }
        d.description = original;
        if (patchState.restoreTimer) { clearTimeout(patchState.restoreTimer); }
        patchState = { active: false, id: null, original: null, restoreTimer: null };
        console.log(`[PersonaLibrary] END EVENT RECEIVED (${reason}) — restored persona description for`, id);
        if (getActiveId() === id && typeof ctx()?.setPersonaDescription === 'function') {
            try { ctx().setPersonaDescription(); } catch (e) { console.warn('[PersonaLibrary] setPersonaDescription() failed during restore', e); }
        }
    } catch (e) {
        console.warn('[PersonaLibrary] could not restore persona description; will retry', e);
        // Do NOT clear patchState here — keep the swap tracked so the next
        // start/end event (or the safety-net timer) tries again.
    }
}

function applyVariantPatch(reason) {
    generationStartCount += 1;
    const callId = generationStartCount;
    try {
        // Put back any swap a previous, still-outstanding call left in
        // place FIRST, so composing again never builds on top of an
        // already-injected description (prevents duplicate-compounding).
        if (patchState.active) {
            console.warn(`[PersonaLibrary] (#${callId}, ${reason}) a swap was still active from a previous generation — restoring it before composing again. If you see this on EVERY generation, the end event is not reliably reaching us.`);
            restorePatch('pre-empted-by-new-start');
        }

        const id = getActiveId();
        if (!id) return;
        const pu = powerUser();
        const d = pu.persona_descriptions?.[id];
        if (!d) return;
        const variants = getPersonaVariants(id);
        if (!variants.nodes.length) return; // nothing configured, don't touch anything

        // LIVE snapshot — exactly what PME does. This is the actual,
        // currently-saved description, whatever wrote it last (native ST
        // panel, this extension's Sections editor, an import, etc.) — never
        // a separately-cached copy that could have drifted stale.
        const baseline = String(d.description ?? '');
        const composed = composeVariants(baseline, variants, activeVariantContext());

        console.log(`[PersonaLibrary] (#${callId}, ${reason}) applyVariantPatch for`, id,
            '\n  live baseline preview:', JSON.stringify(baseline.slice(0, 120)),
            '\n  composed preview:', JSON.stringify(composed.slice(0, 120)));

        if (composed === baseline) {
            console.log(`[PersonaLibrary] (#${callId}) nothing to do — no variants currently match`);
            return;
        }

        patchState = { active: true, id, original: baseline, restoreTimer: null };
        d.description = composed;
        if (getActiveId() === id && typeof ctx()?.setPersonaDescription === 'function') {
            try { ctx().setPersonaDescription(); } catch { /* ignore */ }
        }
        console.log(`[PersonaLibrary] (#${callId}) patch APPLIED for`, id);

        // Safety net, same as PME: force-restore even if end events never
        // fire (crash, dropped connection, extension conflict swallowing
        // the event, etc.) instead of leaving the live description swapped
        // forever.
        patchState.restoreTimer = setTimeout(() => {
            console.warn(`[PersonaLibrary] (#${callId}) safety-net timer fired — end event never arrived within 30s, forcing restore`);
            restorePatch('safety-net-timer');
        }, 30_000);
    } catch (e) {
        console.warn(`[PersonaLibrary] (#${callId}, ${reason}) variant injection failed; leaving the stored description untouched`, e);
        patchState = { active: false, id: null, original: null, restoreTimer: null };
    }
}

/**
 * Wires the temporary-swap-and-restore behavior into ST's own generation
 * lifecycle. Call once at boot; returns an unregister function.
 *
 * Heavily instrumented on purpose: this logs the resolved event NAMES at
 * registration time, whether eventSource.on() actually accepted each
 * listener, and fires a log line inside every callback so you can see in
 * the console whether events are being delivered at all before assuming
 * anything about pendingRestore/patchState logic.
 */
export function registerVariantGenerationHook() {
    // Idempotency guard: index.js's start()/boot() can legitimately call
    // this twice under a race (safeBoot() is invoked directly AND again on
    // APP_READY — if APP_READY fires while the first boot() is still stuck
    // in its up-to-30s mount-retry loop, both calls can reach index.js's
    // own `if (!unregisterVariantHook)` check before either has set it).
    // Guarding HERE, at the actual listener-registration site, closes that
    // race regardless of index.js's timing — this is the same pattern PME
    // uses (`hooksInstalled`) and for the same reason: duplicate listeners
    // would mean duplicate apply/restore cycles per generation.
    if (hookInstalled) {
        console.log('[PersonaLibrary] registerVariantGenerationHook called again — already installed, skipping (this is expected if boot() ran more than once)');
        return () => {};
    }

    console.log('[PersonaLibrary] Variant hook registering');

    const c = ctx();
    if (!c) {
        console.warn('[PersonaLibrary] registerVariantGenerationHook: getContext() returned null/undefined — cannot register anything');
        return () => {};
    }

    const es = c.eventSource;
    if (!es?.on) {
        console.warn('[PersonaLibrary] registerVariantGenerationHook: context.eventSource.on is not a function — cannot register anything', { eventSource: es });
        return () => {};
    }

    // Try BOTH property spellings and log which one actually resolved,
    // rather than silently falling through to {} if neither exists.
    const typesSrc = c.eventTypes ?? c.event_types;
    if (!typesSrc) {
        console.warn('[PersonaLibrary] registerVariantGenerationHook: neither context.eventTypes nor context.event_types exists — event name lookup will fail for everything');
    }
    const types = typesSrc ?? {};

    const GENERATION_STARTED = types.GENERATION_STARTED;
    const GENERATION_AFTER_COMMANDS = types.GENERATION_AFTER_COMMANDS;
    const GENERATION_ENDED = types.GENERATION_ENDED;
    const GENERATION_STOPPED = types.GENERATION_STOPPED;

    console.log('[PersonaLibrary] GENERATION_STARTED =', GENERATION_STARTED);
    console.log('[PersonaLibrary] GENERATION_AFTER_COMMANDS =', GENERATION_AFTER_COMMANDS);
    console.log('[PersonaLibrary] GENERATION_ENDED =', GENERATION_ENDED);
    console.log('[PersonaLibrary] GENERATION_STOPPED =', GENERATION_STOPPED);

    // Prefer GENERATION_AFTER_COMMANDS if this ST build has it (PME uses
    // this specifically because persona text gets read for prompt-building
    // before GENERATION_STARTED-triggered interceptors run in some builds).
    // Fall back to GENERATION_STARTED if AFTER_COMMANDS isn't available.
    const startEvents = [GENERATION_AFTER_COMMANDS ?? GENERATION_STARTED].filter(Boolean);
    const endEvents = [GENERATION_ENDED, GENERATION_STOPPED].filter(Boolean);

    if (!startEvents.length) {
        console.warn('[PersonaLibrary] no usable start event name resolved — the patch will NEVER be applied. Check the GENERATION_* logs above.');
    }
    if (!endEvents.length) {
        console.warn('[PersonaLibrary] no usable end event name resolved — the patch will NEVER be restored automatically (only the 30s safety-net timer will save you). Check the GENERATION_* logs above.');
    }

    const onStart = (...args) => {
        console.log('[PersonaLibrary] START EVENT RECEIVED', args?.[2] === true ? '(dryRun=true, skipping)' : '');
        if (args?.[2] === true) return; // dryRun / quiet generation — don't touch the persona
        applyVariantPatch('generation-start-event');
    };
    const onEnd = (reason) => () => {
        console.log('[PersonaLibrary] END EVENT RECEIVED', `(${reason})`);
        restorePatch(reason);
    };

    for (const n of startEvents) {
        try {
            es.on(n, onStart);
            console.log('[PersonaLibrary] START listener registered for event:', n);
        } catch (e) {
            console.warn('[PersonaLibrary] FAILED to register START listener for event:', n, e);
        }
    }
    for (const n of endEvents) {
        try {
            es.on(n, onEnd(n));
            console.log('[PersonaLibrary] END listener registered for event:', n);
        } catch (e) {
            console.warn('[PersonaLibrary] FAILED to register END listener for event:', n, e);
        }
    }

    hookInstalled = true;

    // Safety-net path, same idea as PME's generate_interceptor global hook.
    // ST calls this by name (see manifest.json "generate_interceptor") on
    // every generation regardless of whether the eventSource listeners
    // above ever fire — this is what to add if START/END EVENT RECEIVED
    // never show up in the console at all.
    globalThis.personaLibraryGenerateInterceptor = async () => {
        console.log('[PersonaLibrary] generate_interceptor safety-net fired');
        applyVariantPatch('generate_interceptor');
    };
    console.log('[PersonaLibrary] generate_interceptor safety-net registered as globalThis.personaLibraryGenerateInterceptor (requires manifest.json "generate_interceptor" field to actually be called by ST)');

    return () => {
        for (const n of startEvents) es.removeListener?.(n, onStart);
        // NOTE: onEnd(n) above creates a new closure per call, so this
        // won't actually remove the exact listener instance. Left as a
        // known limitation — unregistering only matters on extension
        // disable/reload, which is rare enough not to block on right now.
        hookInstalled = false;
        console.log('[PersonaLibrary] Variant hook unregister requested');
    };
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
    notifyPersonaUpdated(id);
}

export async function updatePersona(id, patch) {
    const c = ctx();
    const pu = powerUser();
    if (!pu.personas) throw new Error('Persona storage unavailable');
    const renamed = patch.name && patch.name !== pu.personas[id];
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
    // The chat display name (message headers, the input box's name tag,
    // already-rendered messages) is driven by a separate global, `name1`,
    // NOT by power_user.personas — setUserName() is the actual function
    // that propagates a rename to it. Renaming without calling this is
    // exactly why the chat kept showing the old name until a full reload.
    console.log('[PersonaLibrary] rename check', { id, patchName: patch.name, renamed, activeId: getActiveId(), match: getActiveId() === id });
    if (renamed && getActiveId() === id) {
        console.log('[PersonaLibrary] calling setUserName ->', patch.name);
        try {
            setUserName(patch.name, { toastPersonaNameChange: false });
            console.log('[PersonaLibrary] setUserName returned OK, #your_name now shows:', document.getElementById('your_name')?.textContent);
        } catch (e) { console.warn('[PersonaLibrary] setUserName failed', e); }
    } else if (renamed) {
        console.log('[PersonaLibrary] renamed, but this is NOT the active persona — skipping setUserName by design');
    }
    c?.saveSettingsDebounced?.();
    if (renamed) {
        try {
            c?.eventSource?.emit?.(c?.event_types?.PERSONA_RENAMED, { avatarId: id, newName: patch.name });
        } catch (e) { console.warn('[PersonaLibrary] could not emit PERSONA_RENAMED', e); }
    }
    notifyPersonaUpdated(id);
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
    notifyPersonaUpdated(id);
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
    notifyPersonaUpdated(savedName);
}

export async function deletePersona(id) {
    const pu = powerUser();
    const name = pu.personas?.[id];
    const res = await fetch('/api/avatars/delete', {
        method: 'POST',
        headers: await headers(true),
        body: JSON.stringify({ avatar: id }),
    });
    if (!res.ok) throw new Error(`Delete failed: ${res.status}`);
    delete pu.personas?.[id];
    delete pu.persona_descriptions?.[id];
    ctx()?.saveSettingsDebounced?.();
    try {
        ctx()?.eventSource?.emit?.(ctx()?.event_types?.PERSONA_DELETED, { avatarId: id, name });
    } catch (e) {
        console.warn('[PersonaLibrary] could not emit PERSONA_DELETED', e);
    }
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
    composeDescription,
    getPersonaVariants,
    savePersonaVariants,
    getReliableCharacterBindings,
    getCurrentCharacterInfo,
    getCharacterBindingId,
    ensureCharacterBindingId,
    getChatBindingId,
    ensureChatBindingId,
    getCurrentChatLabel,
    composeVariants,
};
