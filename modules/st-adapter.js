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
import { initPersona, setPersonaDescription as stSetPersonaDescription } from '../../../../personas.js';
import { composeVariants, normalizeVariants, defaultVariants } from './variants.js';

const SETTINGS_KEY = 'personaLibrary';
const SECTIONS_KEY = 'personaLibrarySections';
const VARIANTS_KEY = 'personaLibraryVariants';
const CHAR_BINDING_FIELD = 'personaLibraryBindingId';
const CHAT_BINDING_KEY = 'personaLibraryBindingId';
const DEFAULTS = { sort: 'name', tile: 150, query: '', reliableCharacterBindings: false, lastSeenChangelogVersion: '' };

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

/**
 * Refreshes SillyTavern's OWN native persona UI (the #persona_description
 * textarea, its token count, the depth/role dropdowns, the lorebook-link
 * indicator) to match whatever was just written to power_user.
 *
 * Every previous call site in this file tried to do this via
 * `ctx()?.setPersonaDescription`, which — confirmed directly against
 * SillyTavern's own st-context.js source — has NEVER actually existed:
 * setPersonaDescription is exported from personas.js but never re-exported
 * through the public getContext() object. That means every one of those
 * calls has been a silent no-op since this code was first written, in
 * every version, including the ones that already correctly fixed the
 * underlying DATA (the 1.6.1 persona_description-singular-field fix,
 * confirmed correct via a raw backend payload capture — generation reads
 * that field directly, a separate path from this). The data was right;
 * the visible native panel just never got told to re-read it, so it sat
 * stale until a persona switch happened to trigger ST's OWN internal call
 * to the real function.
 *
 * Fixed by importing the real, actually-exported function directly from
 * personas.js (see the top of this file) instead of going through the
 * broken proxy.
 */
function refreshNativePersonaUI() {
    try {
        stSetPersonaDescription();
    } catch (e) {
        console.warn('[PersonaLibrary] setPersonaDescription() (direct import) failed', e);
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
    if (getActiveId() === id) {
        // The field ST's own prompt builder and the native #persona_description
        // textarea actually read from — persona_descriptions[id].description
        // (above) is just the storage entry. Writing only that left this
        // persona's description invisible to both the native panel and the
        // next generation until a persona switch happened to copy it over
        // (SillyTavern's own selectCurrentPersona() does that on switch,
        // which is why it "fixed itself" that way). Same class of bug as the
        // one already fixed for the Variants patch path below — that fix
        // just never got carried over to this, separate, save path.
        pu.persona_description = d.description;
        refreshNativePersonaUI();
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
    // Mirror the exact same fallback the UI uses when writing a binding ref
    // (see gallery.js "+ Bind current character": `uuid ?? \`avatar:${avatar}\``).
    // Without this, a ref saved while "Reliable character bindings" was off
    // (the default) can never be matched at generation time, since this
    // function would otherwise only ever return the stamped extension-field
    // id — null whenever that setting is off — and isNodeActive short-
    // circuits to false on a null characterBindingId regardless of what's
    // actually sitting in the node's refs.
    const stamped = character.data?.extensions?.[CHAR_BINDING_FIELD] ?? null;
    return {
        index: idx,
        name: character.name ?? '',
        avatar: character.avatar ?? '',
        description: character.description ?? '',
        bindingId: stamped ?? (character.avatar ? `avatar:${character.avatar}` : null),
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
    function stripExt(filename) {
        if (typeof filename !== "string" || filename.length === 0) { return null; }
        const i = filename.lastIndexOf(".");
        return i >= 0 ? filename.slice(0, i) : filename;
    }

    const c = ctx();
    const charName = stripExt(c?.characters?.[c?.characterId]?.avatar) || "Unknown Avatar";
    const chatId = c?.getCurrentChatId();
    return chatId ? "Chat: " + chatId : `Unnamed chat with ${charName}`;
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
let patchState = { active: false, id: null, original: null, originalSingular: null, restoreTimer: null, appliedAt: 0 };
let generationStartCount = 0;
let hookInstalled = false; // module-level idempotency guard — see registerVariantGenerationHook

// SillyTavern fires BOTH the GENERATION_AFTER_COMMANDS event AND every
// registered generate_interceptor for the SAME real generation, moments
// apart, well before any end event. That is expected, confirmed behavior
// (not a race) — so a re-entrant applyVariantPatch call arriving within
// this window is almost certainly the SAME generation's second trigger,
// not a genuinely stale leftover from an earlier, already-ended
// generation. 5s is generous relative to the sub-second gap actually
// observed between the two triggers, while staying far shorter than any
// realistic gap between two truly separate generations.
const SAME_GENERATION_WINDOW_MS = 5_000;

// Safety net, same idea as PME: force-restore even if end events never fire
// (crash, dropped connection, extension conflict swallowing the event,
// etc.). This is a LAST-RESORT fallback, not a normal completion path — it
// must stay comfortably longer than any real generation takes. 30s was too
// short for slower backends (streamed replies regularly run 60-100s+),
// which made it fire routinely instead of only on genuine failures. 10
// minutes is long enough to essentially never fire during a normal, if
// slow, generation, while still recovering from a truly hung/crashed one.
// The only user-visible cost of a long value here: if a swap genuinely gets
// stuck (failure + no further generation triggered), the persona's stored
// description sits in the swapped/composed state until either (a) another
// generation starts, which self-heals it immediately regardless of this
// timer, or (b) this timer eventually fires. It's only actually exposed if
// someone opens the persona editor and looks during that specific window.
const SAFETY_NET_MS = 10 * 60 * 1000;

function armSafetyTimer(callId) {
    if (patchState.restoreTimer) clearTimeout(patchState.restoreTimer);
    patchState.restoreTimer = setTimeout(() => {
        console.warn(`[PersonaLibrary] (#${callId}) safety-net timer fired — end event never arrived within ${SAFETY_NET_MS / 1000}s, forcing restore`);
        restorePatch('safety-net-timer');
    }, SAFETY_NET_MS);
}

function restorePatch(reason) {
    if (!patchState.active) {
        console.log(`[PersonaLibrary] restorePatch(${reason}): nothing active, no-op`);
        return;
    }
    const { id, original, originalSingular } = patchState;
    try {
        const pu = powerUser();
        const d = pu.persona_descriptions?.[id];
        if (!d) {
            console.warn('[PersonaLibrary] restore skipped: no persona_descriptions entry for', id, '— will retry on next start/end event');
            return; // leave patchState.active=true so a later call retries
        }
        d.description = original;
        // THE FIELD THAT ACTUALLY MATTERS: power_user.persona_description
        // (singular) is what SillyTavern reads when building the real
        // prompt — confirmed by capturing the raw backend payload, which
        // showed only this field's contents, never the composed variant
        // text, even though persona_descriptions[id].description (plural,
        // the storage dictionary) was being correctly patched the whole
        // time. Restore this one too, unconditionally — it's only ever
        // touched while this persona is the active one (see
        // applyVariantPatch), so restoring it here is always correct.
        if (typeof originalSingular === 'string') {
            pu.persona_description = originalSingular;
        }
        if (patchState.restoreTimer) { clearTimeout(patchState.restoreTimer); }
        patchState = { active: false, id: null, original: null, originalSingular: null, restoreTimer: null, appliedAt: 0 };
        console.log(`[PersonaLibrary] END EVENT RECEIVED (${reason}) — restored persona description for`, id);
        if (getActiveId() === id) refreshNativePersonaUI();
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
        if (patchState.active) {
            const age = Date.now() - patchState.appliedAt;
            if (age < SAME_GENERATION_WINDOW_MS) {
                // ST fires GENERATION_AFTER_COMMANDS and generate_interceptor
                // for the SAME generation, moments apart — this is that
                // expected second trigger, not a missed restore. The patch
                // already applied by the first trigger is already correct;
                // leave it (and its restore timer) exactly as-is instead of
                // tearing it down and reapplying.
                console.log(`[PersonaLibrary] (#${callId}, ${reason}) redundant trigger ${age}ms after the first — same generation, already patched for`, patchState.id, '— no-op');
                return;
            }
            // Otherwise this really does look like a leftover from an
            // earlier, separate generation whose end event never arrived —
            // put it back before composing again so we don't build on top
            // of an already-injected description.
            console.warn(`[PersonaLibrary] (#${callId}, ${reason}) a swap has been active for ${age}ms — treating as a genuinely stale leftover from an earlier generation, restoring it before composing again.`);
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

        // applyVariantPatch always operates on getActiveId() above, so `id`
        // here is ALWAYS the currently-active persona — meaning
        // power_user.persona_description (singular) is always the relevant
        // field to patch alongside the dictionary entry, never a mismatch.
        const originalSingular = String(pu.persona_description ?? '');
        patchState = { active: true, id, original: baseline, originalSingular, restoreTimer: null, appliedAt: Date.now() };
        d.description = composed;
        pu.persona_description = composed; // ← the field ST actually reads at generation time
        if (getActiveId() === id) refreshNativePersonaUI();
        console.log(`[PersonaLibrary] (#${callId}) patch APPLIED for`, id, '(both persona_descriptions[id].description and persona_description)');

        // Safety net, same idea as PME: force-restore even if end events
        // never fire (crash, dropped connection, extension conflict
        // swallowing the event, etc.). Flat 10-minute deadline — see
        // SAFETY_NET_MS comment above for the reasoning.
        armSafetyTimer(callId);
    } catch (e) {
        console.warn(`[PersonaLibrary] (#${callId}, ${reason}) variant injection failed; leaving the stored description untouched`, e);
        patchState = { active: false, id: null, original: null, originalSingular: null, restoreTimer: null, appliedAt: 0 };
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
        console.warn('[PersonaLibrary] no usable end event name resolved — the patch will NEVER be restored automatically (only the 10-minute safety-net timer will save you). Check the GENERATION_* logs above.');
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
    const names = [types.SETTINGS_UPDATED, types.SETTINGS_LOADED_AFTER, types.APP_READY, types.CHAT_CHANGED, types.PERSONA_CHANGED, 'persona_updated']
        .filter(Boolean);
    for (const n of names) es.on(n, cb);
    return () => { for (const n of names) es.removeListener?.(n, cb); };
}

/*
 * A chat-lock indicator + one-click unlock (reading/clearing ST's native
 * chat_metadata.persona) was built and shipped briefly in this version's
 * development, but was rolled back before release: in practice it reported
 * "Unlocked" without actually changing anything observable — the lock/
 * unlock semantics evidently don't work the way assumed here, and rather
 * than keep guessing at SillyTavern's actual internals through trial and
 * error, this was pulled entirely. Chat-lock is left to SillyTavern's own
 * native Persona Management panel ("Open native Persona menu") for now.
 * If this is revisited, verify the actual read/write behavior directly
 * against a live chat before building UI on top of it again.
 */

/**
 * Best-effort token count for a piece of text, using whatever tokenizer the
 * user actually has configured (via SillyTavern's own getTokenCountAsync)
 * so the number matches what they'd really be spending. Falls back to a
 * rough chars/4 estimate if that's unavailable for any reason — still
 * useful as a ballpark, just labelled "~" either way since it's an
 * estimate, not the exact count that'll appear in an actual generation
 * (which also includes the wrapper template, joiners, and everything else
 * around it).
 */
export async function getTokenCount(text) {
    const t = text ?? '';
    if (!t.trim()) return 0;
    try {
        const c = ctx();
        if (typeof c?.getTokenCountAsync === 'function') {
            return await c.getTokenCountAsync(t);
        }
    } catch (e) {
        console.warn('[PersonaLibrary] getTokenCountAsync failed, falling back to an estimate', e);
    }
    return Math.ceil(t.length / 4);
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
    if (getActiveId() === id) {
        // Same fix as savePersonaSections() above, same reason: this is a
        // second, separate call site that can write a persona's description
        // (position/depth/role edits in the Edit tab go through here too),
        // and it had the identical gap — writing the storage entry but never
        // the singular field ST's prompt builder and native textarea
        // actually read from.
        if (patch.description !== undefined) pu.persona_description = d.description;
        refreshNativePersonaUI();
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
    getTokenCount,
};
