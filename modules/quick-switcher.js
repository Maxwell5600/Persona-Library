/*
 * Persona Library — Quick Switcher.
 *
 * A small, self-contained layer inspired by SillyTavern's own
 * Extension-QuickPersona (github.com/SillyTavern/Extension-QuickPersona):
 * a single icon mounted next to the chat input that opens a compact popup
 * for switching the active persona without leaving the chat, without
 * opening the Persona's tab at all.
 *
 * Deliberately NOT the same code path as the main gallery (modules/gallery.js
 * / index.js's host-mounting): this has nothing to do with the Persona's tab
 * being open, replaces nothing, and has to keep working (or at least fail
 * silently) regardless of whether the gallery is mounted, in native-override
 * mode, or the tab has never been opened this session at all. It only reads
 * personas + switches the active one via st-adapter's existing exports —
 * same underlying data, no second source of truth.
 *
 * Differences from the original QuickPersona this is modeled on, all
 * deliberate, all per direct request:
 *   - Circular avatar crops -> small full-resolution RECTANGLES, matching
 *     the rectangular tiles used everywhere else in this extension.
 *   - A solid (not glassy/translucent) popup background, so it stays
 *     readable sitting on top of a busy chat log.
 *   - A sort control inside the popup itself (name / reverse-name / recently
 *     created / token count ascending or descending), independent of the
 *     main gallery's own sort.
 *   - Mounted at the end of the chat-bar icon row (after the wand icon),
 *     via the same `order` CSS trick SillyTavern's own Extension-QuickPersona
 *     uses for its own button, rather than at the front of it.
 *   - The button's own face is the active persona's avatar (falling back to
 *     a generic icon when there's no active persona yet), not a static icon.
 *   - Off by default, with its own Extensions-panel toggle (settings-panel.js)
 *     — the one thing Persona Library puts in the chat UI itself rather than
 *     the Persona's tab, so it doesn't show up uninvited.
 */

const BUTTON_ID = 'persona-library-quickswitch-button';
const PANEL_ID = 'persona-library-quickswitch-panel';

// Best-effort mount points for SillyTavern's chat-input icon row, tried in
// order. Matches SillyTavern's own Extension-QuickPersona, which mounts the
// exact same way: `$('#leftSendForm').append(...)`, no hunting for the
// extensions/wand icon specifically. That works because #leftSendForm is a
// flex row and QuickPersona's own CSS gives its button `order: 10` so it
// renders at the END of that row regardless of DOM insertion order — see
// `.pl-qs-button`'s `order` in persona-library.css. We do the same here.
const MOUNT_CANDIDATES = [
    '#leftSendForm',
    '#rightSendForm',
    '#send_form',
];

const SORTS = [
    ['name', 'Name (A\u2013Z)'],
    ['name-desc', 'Name (Z\u2013A)'],
    ['created', 'Recently created'],
    ['tokens-asc', 'Token count (lowest first)'],
    ['tokens-desc', 'Token count (highest first)'],
];

let panel = null;
let button = null;
let outsideClickHandler = null;
let escHandler = null;
// Cache of persona id -> resolved token count, keyed by the exact
// description text it was computed from so a later edit invalidates itself
// automatically (a stale count just never matches `desc` again, no manual
// bookkeeping needed). Cleared on every popup open — this is a "while
// you're looking at it" cache, not meant to outlive the popup.
let tokenCache = new Map();
let tokenRunId = 0;
// Unsubscribe fn for the adapter.subscribe() hook that keeps the button's
// face in sync with the active persona independent of DOM-mutation timing
// (see mountQuickSwitcher/unmountQuickSwitcher below).
let unsubscribeActive = null;

function closePanel() {
    panel?.remove();
    panel = null;
    if (outsideClickHandler) document.removeEventListener('pointerdown', outsideClickHandler, true);
    if (escHandler) document.removeEventListener('keydown', escHandler, true);
    outsideClickHandler = null;
    escHandler = null;
    button?.setAttribute('aria-expanded', 'false');
}

function buildRow(p, adapter, activeId, onPick) {
    const row = document.createElement('button');
    row.type = 'button';
    row.className = `pl-qs-row${p.id === activeId ? ' pl-qs-active' : ''}`;
    row.title = p.name;

    const img = document.createElement('img');
    img.className = 'pl-qs-thumb';
    img.src = p.image;
    img.alt = p.name;
    img.loading = 'lazy';
    img.decoding = 'async';
    if (typeof adapter.fallbackImage === 'function') {
        img.addEventListener('error', () => { img.src = adapter.fallbackImage(p.id); }, { once: true });
    }

    const name = document.createElement('span');
    name.className = 'pl-qs-name';
    name.textContent = p.name;

    row.append(img, name);
    if (p.id === activeId) {
        const check = document.createElement('i');
        check.className = 'fa-solid fa-check pl-qs-check';
        row.append(check);
    }
    row.addEventListener('click', () => onPick(p.id));
    return row;
}

function sortPersonas(list, sortKey) {
    const byName = (a, b) => (a.name ?? '').toLowerCase().localeCompare((b.name ?? '').toLowerCase());
    const tokensOf = (p) => tokenCache.get(p.id)?.count ?? -1;
    switch (sortKey) {
        case 'name-desc': return list.slice().sort((a, b) => byName(b, a));
        case 'created': return list.slice().sort((a, b) => (b.created ?? 0) - (a.created ?? 0));
        case 'tokens-asc': return list.slice().sort((a, b) => tokensOf(a) - tokensOf(b));
        // Legacy 'tokens' value (pre-dating the asc/desc split) is treated as
        // the highest-first direction, matching its original behavior.
        case 'tokens-desc':
        case 'tokens': return list.slice().sort((a, b) => tokensOf(b) - tokensOf(a));
        case 'name':
        default: return list.slice().sort(byName);
    }
}

/**
 * Resolves (and caches) token counts for whichever personas don't have a
 * fresh one yet, then re-renders the list once they land. Mirrors the same
 * run-id-guard pattern gallery.js already uses for its own async token
 * badges (modules/gallery.js's refreshTokenCounts/tokenRunId) so a fast
 * popup close + reopen, or a sort-mode switch mid-flight, can't have a
 * stale batch overwrite a newer one.
 */
function ensureTokenCounts(list, adapter, onSettled) {
    if (typeof adapter.getTokenCount !== 'function') return;
    const myRun = ++tokenRunId;
    const pending = list.filter((p) => tokenCache.get(p.id)?.desc !== (p.description ?? ''));
    if (!pending.length) return;
    Promise.all(pending.map((p) => adapter.getTokenCount(p.description ?? '')
        .then((count) => { tokenCache.set(p.id, { desc: p.description ?? '', count }); })
        .catch(() => { tokenCache.set(p.id, { desc: p.description ?? '', count: 0 }); })))
        .then(() => { if (myRun === tokenRunId) onSettled(); });
}

function openPanel(adapter) {
    if (panel) { closePanel(); return; }

    panel = document.createElement('div');
    panel.id = PANEL_ID;
    panel.className = 'pl-qs-panel';

    const header = document.createElement('div');
    header.className = 'pl-qs-header';
    const title = document.createElement('span');
    title.className = 'pl-qs-title';
    title.textContent = 'Switch Persona';
    const sortSelect = document.createElement('select');
    sortSelect.className = 'pl-select pl-qs-sort';
    sortSelect.title = 'Sort personas';
    for (const [value, label] of SORTS) {
        const opt = document.createElement('option');
        opt.value = value;
        opt.textContent = label;
        sortSelect.append(opt);
    }
    const settings = adapter.getSettings?.() ?? {};
    sortSelect.value = settings.quickSwitcherSort ?? 'name';
    header.append(title, sortSelect);

    const list = document.createElement('div');
    list.className = 'pl-qs-list';

    function renderList() {
        const all = adapter.getPersonas?.() ?? [];
        const activeId = adapter.getActiveId?.() ?? null;
        const sortKey = sortSelect.value;
        const ordered = sortPersonas(all, sortKey);
        list.replaceChildren();
        if (!ordered.length) {
            const empty = document.createElement('div');
            empty.className = 'pl-qs-empty';
            empty.textContent = 'No personas yet.';
            list.append(empty);
            return;
        }
        for (const p of ordered) {
            list.append(buildRow(p, adapter, activeId, async (id) => {
                try {
                    await adapter.setActive(id);
                    updateButtonImage(adapter);
                    globalThis.toastr?.success?.('Persona activated.', 'Persona Library');
                } catch (e) {
                    console.error('[PersonaLibrary] Quick Switcher: setActive failed', e);
                    globalThis.toastr?.error?.('Could not switch persona.', 'Persona Library');
                }
                closePanel();
            }));
        }
        if (sortKey === 'tokens-asc' || sortKey === 'tokens-desc' || sortKey === 'tokens') {
            ensureTokenCounts(all, adapter, renderList);
        }
    }

    sortSelect.addEventListener('change', () => {
        adapter.saveSettings?.({ quickSwitcherSort: sortSelect.value });
        renderList();
    });

    tokenCache = new Map();
    renderList();

    panel.append(header, list);
    document.body.append(panel);
    positionPanel();
    button?.setAttribute('aria-expanded', 'true');

    outsideClickHandler = (e) => {
        if (panel && !panel.contains(e.target) && e.target !== button && !button?.contains(e.target)) closePanel();
    };
    escHandler = (e) => { if (e.key === 'Escape') closePanel(); };
    // Deferred so the click that opened the panel doesn't immediately
    // re-trigger this same listener and close it right back.
    setTimeout(() => {
        document.addEventListener('pointerdown', outsideClickHandler, true);
        document.addEventListener('keydown', escHandler, true);
    }, 0);
}

/**
 * Anchors the panel above/below the button, whichever side actually has
 * room — the button lives at the bottom of the screen, next to the chat
 * input, so "open downward" (the CSS default for a dropdown) would usually
 * push it half off-screen.
 */
function positionPanel() {
    if (!panel || !button) return;
    const btnRect = button.getBoundingClientRect();
    const panelRect = panel.getBoundingClientRect();
    const margin = 8;
    const openUpward = btnRect.top - panelRect.height - margin > 0;
    let left = btnRect.left;
    left = Math.min(left, window.innerWidth - panelRect.width - margin);
    left = Math.max(left, margin);
    panel.style.left = `${left}px`;
    panel.style.top = openUpward
        ? `${Math.max(margin, btnRect.top - panelRect.height - margin)}px`
        : `${Math.min(window.innerHeight - panelRect.height - margin, btnRect.bottom + margin)}px`;
}

function newButton(adapter) {
    const btn = document.createElement('div');
    btn.id = BUTTON_ID;
    btn.setAttribute('role', 'button');
    btn.setAttribute('tabindex', '0');
    btn.setAttribute('aria-expanded', 'false');

    // Generic fallback icon, shown whenever there's no active persona (or
    // its image fails to load) so the button never renders a broken image.
    const icon = document.createElement('i');
    icon.className = 'fa-solid fa-images pl-qs-button-icon';
    // The active persona's own avatar, per direct request \u2014 same
    // full-resolution rectangle treatment as the popup's own row thumbnails
    // (.pl-qs-thumb), just filling the button instead of a fixed size.
    const img = document.createElement('img');
    img.className = 'pl-qs-button-avatar';
    img.alt = '';
    img.loading = 'lazy';
    img.decoding = 'async';
    img.style.display = 'none';
    btn.append(icon, img);

    const activate = (e) => { e.preventDefault(); openPanel(adapter); };
    btn.addEventListener('click', activate);
    btn.addEventListener('keydown', (e) => { if (e.key === 'Enter' || e.key === ' ') activate(e); });
    return btn;
}

/**
 * Syncs the button's face with whichever persona is currently active,
 * falling back to the generic icon when there's no active persona, no
 * image for it, or the image fails to load (same fallbackImage() pattern
 * the popup rows already use). Cheap and idempotent, safe to call on
 * every mount/mutation pass and from the adapter.subscribe() hook below.
 *
 * Shows the avatar OPTIMISTICALLY (assume success) rather than showing the
 * generic icon first and only swapping to it once `load` fires. Icon-first
 * was correct but visibly laggy: on a real page load the browser has to
 * actually fetch the avatar file, and during that fetch the generic icon
 * would flash in first, then get replaced a beat later. Optimistic display
 * avoids that two ways: on a persona SWITCH, the <img> already has a
 * previous src, so the browser keeps rendering that previous frame right
 * up until the new one decodes -- a clean swap, no flash. On a genuinely
 * first load, the box is briefly blank instead of showing the wrong icon
 * and then correcting itself a moment later. `onerror` still falls back to
 * fallbackImage(), then the generic icon if even that fails, so a persona
 * with no working avatar never ends up rendering a broken-image glyph.
 */
function updateButtonImage(adapter) {
    if (!button) return;
    const img = button.querySelector('.pl-qs-button-avatar');
    const icon = button.querySelector('.pl-qs-button-icon');
    if (!img || !icon) return;

    const showIconOnly = () => {
        img.onerror = null;
        img.removeAttribute('src');
        img.style.display = 'none';
        icon.style.display = 'flex';
    };

    try {
        const activeId = adapter.getActiveId?.() ?? null;
        if (!activeId) {
            showIconOnly();
            button.title = 'Quick-switch persona (Persona Library)';
            return;
        }

        // Resolve the image straight from the active id via avatarUrl(),
        // the same way QuickPersona's own getImageUrl(user_avatar) does —
        // NOT by requiring activeId to show up in getPersonas() first.
        // getPersonas() only lists NAMED personas (power_user.personas);
        // most users' current avatar was never explicitly named, so an
        // active-but-unnamed persona would otherwise never get an image
        // here at all. getPersonas() is still used for a nicer display
        // name when one exists, falling back to the raw id otherwise —
        // matching their own `power_user.personas[userAvatar] || userAvatar`.
        const named = (adapter.getPersonas?.() ?? []).find((p) => p.id === activeId);
        const imageUrl = typeof adapter.avatarUrl === 'function' ? adapter.avatarUrl(activeId) : named?.image;
        const displayName = named?.name ?? activeId;

        if (!imageUrl) {
            showIconOnly();
            button.title = `Switch persona (current: ${displayName})`;
            return;
        }

        const fallbackUrl = typeof adapter.fallbackImage === 'function' ? adapter.fallbackImage(activeId) : null;
        let triedFallback = false;

        icon.style.display = 'none';
        img.style.display = 'block';
        img.onerror = () => {
            if (!triedFallback && fallbackUrl && img.src !== fallbackUrl) {
                triedFallback = true;
                img.src = fallbackUrl; // re-fires onerror above if this also fails
                return;
            }
            showIconOnly();
        };

        img.alt = displayName;
        img.src = imageUrl;
        button.title = `Switch persona (current: ${displayName})`;
    } catch (e) {
        console.error('[PersonaLibrary] Quick Switcher: updateButtonImage failed, showing generic icon', e);
        showIconOnly();
    }
}

/**
 * Mounts into a real chat-bar candidate — same technique as SillyTavern's
 * own Extension-QuickPersona: append, don't hunt for a specific sibling
 * icon to insert after. Visual placement at the END of that row (i.e.
 * after the wand) comes from `.pl-qs-button`'s `order: 10` in CSS, which
 * makes DOM position irrelevant. Reuses the existing button node (keeps
 * its DOM identity/listeners) if one already exists — including one
 * previously created by ensureFallbackButton() below, in which case this
 * also strips the floating-specific class back off it.
 *
 * updateButtonImage() is ONLY called here when the button is actually being
 * (re)created, not on every idempotent call — this function runs on every
 * single DOM mutation (see mountQuickSwitcher's caller in index.js), which
 * during normal chat activity can be many times a second. Re-running the
 * avatar load/onload cycle that often previously raced against itself:
 * each call reset the button to "icon showing, image hidden" before the
 * PREVIOUS call's onload had necessarily fired, which is exactly what
 * produced the reported flashing/blanking. Real persona changes are
 * already covered by the adapter.subscribe() hook wired up in
 * mountQuickSwitcher below, which fires only on actual persona-change
 * events, not on unrelated DOM churn.
 */
function ensureButton(container, adapter) {
    const isNew = !button || !document.body.contains(button);
    if (isNew) button = newButton(adapter);
    button.className = 'interactable pl-qs-button';
    if (button.parentElement !== container) container.append(button);
    if (isNew) updateButtonImage(adapter);
}

// Fallback mount used only when NONE of MOUNT_CANDIDATES exist yet (an
// unrecognized ST build/fork) — a small floating pill fixed near the
// bottom-right corner, so the feature is still reachable rather than
// silently doing nothing. Prefer the real chat-bar candidates whenever any
// of them exist; this only kicks in if every single one is missing.
function ensureFallbackButton(adapter) {
    const isNew = !button || !document.body.contains(button);
    if (isNew) button = newButton(adapter);
    button.className = 'pl-qs-button pl-qs-button-floating';
    button.title = 'Quick-switch persona (Persona Library) \u2014 couldn\u2019t find the chat input icon row, mounted here instead';
    if (button.parentElement !== document.body) document.body.append(button);
    if (isNew) updateButtonImage(adapter);
}

/** Idempotent — safe to call repeatedly (e.g. from index.js's MutationObserver). */
export function mountQuickSwitcher(adapter) {
    const enabled = !!adapter.getSettings?.().quickSwitcherEnabled;
    if (!enabled) {
        unmountQuickSwitcher();
        return;
    }
    if (!unsubscribeActive) unsubscribeActive = adapter.subscribe?.(() => updateButtonImage(adapter)) ?? null;
    for (const sel of MOUNT_CANDIDATES) {
        const container = document.querySelector(sel);
        if (container) { ensureButton(container, adapter); return; }
    }
    ensureFallbackButton(adapter);
}

export function unmountQuickSwitcher() {
    closePanel();
    button?.remove();
    button = null;
    unsubscribeActive?.();
    unsubscribeActive = null;
}
