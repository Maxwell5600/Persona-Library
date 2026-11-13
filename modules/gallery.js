/*
 * Persona Library — gallery renderer.
 *
 * Framework-free. Driven entirely by an adapter object so the same code runs
 * inside SillyTavern (st-adapter.js) and in the workspace preview route
 * (mock adapter over fixtures).
 *
 * Adapter contract:
 *   getPersonas()        -> Persona[]
 *   getActiveId()        -> string | null
 *   getSettings()        -> { sort, tile, query }
 *   saveSettings(patch)  -> void
 *   subscribe(cb)        -> unsubscribe fn        (optional)
 *   setActive(id)        -> Promise<void>
 *   updatePersona(id, patch)   -> Promise<void>   (optional; omit to disable editing)
 *   duplicatePersona(id)       -> Promise<void>   (optional)
 *   deletePersona(id)          -> Promise<void>   (optional)
 *   replaceAvatar(id, File)    -> Promise<void>   (optional)
 *   confirm(message)     -> Promise<boolean>      (optional)
 *   getPersonaVariants(id)         -> Variants    (optional; omit to disable the Variants editor)
 *   savePersonaVariants(id, data)  -> Promise<void> (optional)
 *   getCurrentCharacterInfo()  -> { index, name, avatar, description, bindingId } | null (optional)
 *   ensureCharacterBindingId() -> Promise<string|null>  (optional)
 *   getChatBindingId()         -> string | null   (optional)
 *   ensureChatBindingId()      -> Promise<string|null>  (optional)
 *   getCurrentChatLabel()      -> string          (optional)
 *   composeVariants(base, variants, ctx) -> string (optional; falls back to the local pure fn)
 *
 * Persona: { id, name, image, description, position, depth, role,
 *            lorebook, connections: string[],
 *            created: number, lastUsed: number, modified: number }
 *
 * Optional adapter members used by the newer features (each one simply
 * hides its UI when the adapter lacks it):
 *   getPersonaGalleryImages / reorderPersonaGalleryImages  (Gallery tab, reordering)
 *   getPersonaSections / composeDescription / getTokenCount  (comparison window)
 *   avatarUrl(id)        -> full-size portrait URL
 *   getPersonaIncarnations / createPersonaIncarnation / switchPersonaIncarnation /
 *   deletePersonaIncarnation   (Incarnations dropdown; hidden when absent)
 *   setPersonaImageBindings / setPersonaDefaultImage   (image bindings in the Gallery tab)
 */

import { newItem, newGroup, cloneNode, normalizeVariants, composeVariants, collectBindingRefs } from './variants.js';
import { sortPersonas, createTokenCounter, isTokenSort } from './persona-sort.js';
import { diffText } from './text-diff.js';
import { createImageViewer } from './image-viewer.js';
import { createContextMenu, personaMenuItems } from './persona-menu.js';
import { onLibraryChanged, emitLibraryChanged } from './library-bridge.js';

const POSITIONS = [
    ['', 'Default (In Prompt)'],
    ['0', 'In Story String / Prompt Manager'],
    ['1', 'Top of Author\u2019s Note'],
    ['2', 'Bottom of Author\u2019s Note'],
    ['3', 'In-chat @ Depth'],
    ['4', 'None (disabled)'],
];

const ROLES = [
    ['0', 'System'],
    ['1', 'User'],
    ['2', 'Assistant'],
];

// Ready-made multi-field character-sheet categories. Each field is its own
// labeled input in the UI, but they still fold into one "Label: value" block
// of text per section when composed — same injection path as a freeform
// section, just structured while you're filling it in.
const SECTION_TEMPLATES = [
    { name: 'Common Characteristics', fields: ['Name', 'Species', 'Nationality', 'Sex', 'Gender', 'Age', 'Birthdate', 'Languages'] },
    { name: 'Appearance Overview', fields: ['Eyes', 'Hair', 'Height', 'Weight', 'Skin Tone', 'Tattoos', 'Physique', 'Birthmarks', 'Detailed Appearance'] },
    { name: 'Mentality', fields: ['Intelligence', 'Personality', 'Sexuality', 'Notable Habits', 'Personal Motto', 'Quirks', 'Voice', 'Speech', 'Fears', 'Desires', 'Likes', 'Dislikes'] },
    { name: 'Character Lore', fields: ['Background', 'Education', 'Career/Job', 'Reputation', 'Goals', 'Motivations', 'Secrets', 'Titles', 'Epithets', 'Nicknames'] },
    { name: 'Beliefs & Values', fields: ['Ethics', 'Morals', 'Worldview', 'Spirituality', 'Superstitions', 'Religion/Faith', 'Political Ideology', 'Cultural Traditions', 'Personal Principles', 'Personal Philosophy'] },
    { name: 'Character Statistics', fields: ['Skills', 'Talents', 'Powers', 'Special Traits', 'Drawbacks', 'Weaknesses'] },
    { name: 'Equipment Statistics', fields: ['Clothing', 'Artifacts', 'Weapons', 'Miscellaneous Items'] },
    { name: 'Social Relationships', fields: ['Family', 'Children', 'Spouse', 'Marital Status', 'Romantically Involved', 'Friends', 'Allies', 'Enemies'] },
    { name: 'Lewd Info', fields: ['Virginity', 'Fetishes', 'Sex Experience', 'Lewdity/Promiscuity', 'Pectoral Size', 'Breast Size', 'Pussy', 'Ass', 'Penis Size (Flaccid)', 'Penis Size (Erect)', 'Semen Production', 'Squirt Production'] },
];

function fieldsToContent(fields) {
    return (fields ?? [])
        .filter((f) => (f.value ?? '').trim())
        .map((f) => `${f.label}: ${f.value.trim()}`)
        .join('\n');
}

const el = (tag, props = {}, children = []) => {
    const node = document.createElement(tag);
    for (const [k, v] of Object.entries(props)) {
        if (k === 'class') node.className = v;
        else if (k === 'text') node.textContent = v;
        else if (k.startsWith('on')) node.addEventListener(k.slice(2), v);
        else if (v !== undefined && v !== null && v !== false) node.setAttribute(k, v === true ? '' : String(v));
    }
    for (const c of [].concat(children)) if (c) node.append(c);
    return node;
};

/** Build an <img> that falls back to adapter.fallbackImage(id) once, on error. */
function personaImg(props, id, adapter) {
    const img = el('img', props);
    if (typeof adapter.fallbackImage === 'function') {
        img.addEventListener('error', () => {
            img.src = adapter.fallbackImage(id);
        }, { once: true });
    }
    return img;
}

const norm = (s) => (s ?? '').toString().toLowerCase();

function stripExt(filename) {
    if (typeof filename !== 'string' || filename.length === 0) return null;
    const i = filename.lastIndexOf('.');
    return i >= 0 ? filename.slice(0, i) : filename;
}

const positionLabelOf = (p) => POSITIONS.find(([v]) => v === (p.position === undefined || p.position === null ? '' : String(p.position)))?.[1] ?? 'Default';
const roleLabelOf = (p) => ROLES.find(([v]) => v === String(p.role ?? 0))?.[1] ?? 'System';

/**
 * @param {HTMLElement} container
 * @param {object} adapter
 * @param {{ overlay?: boolean }} [options]
 *   overlay: build only the windows (editor, compare, incarnation dialog) —
 *   no grid/toolbar — for the chat-bar Quick Switcher, which mounts this on
 *   <body> so those windows open right over the chat instead of inside the
 *   Persona Management drawer.
 */
export function createPersonaLibrary(container, adapter, options = {}) {
    const overlayMode = !!options.overlay;
    // Identity token for the cross-instance change channel (library-bridge.js).
    const changeSource = {};
    const settings = Object.assign(
        { sort: 'name', tile: 150, query: '', favorites: [], favoritesOnly: false, detailTab: 'details', scrollTop: 0 },
        adapter.getSettings?.() ?? {},
    );

    let selectedId = null;
    let dirty = false;
    let note = '';
    // Working copy of { core, sections } for whichever persona's detail view
    // is open. Reloaded fresh from the adapter each time selection changes.
    let sectionsDraft = null;
    // Working copy of the Variants tree (see modules/variants.js), same
    // reload-on-select lifecycle as sectionsDraft.
    let variantsDraft = null;
    // 'details' (read-only, CharLib-style), 'edit' (the form), 'preview' or
    // 'gallery'. Remembered: opening another persona keeps whichever tab you
    // were on, and it survives a reload (see setDetailTab / validTab).
    let detailTab = settings.detailTab || 'details';
    // Persona id the "Compare with\u2026" menu entry was used on, while the
    // gallery waits for a second persona to be picked; null otherwise.
    let compareFrom = null;

    const root = el('div', { class: 'pl-root', 'data-persona-library': '' });
    if (overlayMode) root.style.display = 'none'; // windows only — nothing to show in the host itself
    container.append(root);

    // -- toolbar (built once, kept alive so the search box never loses focus) --
    const search = el('input', {
        class: 'pl-search',
        type: 'search',
        placeholder: 'Search personas\u2026',
        value: settings.query,
        oninput: () => { persist({ query: search.value }); renderGrid(); },
    });

    const sort = el('select', {
        class: 'pl-select',
        onchange: () => { persist({ sort: sort.value }); renderGrid(); },
    }, [
        el('option', { value: 'name', text: 'Name (A\u2013Z)' }),
        el('option', { value: 'name-desc', text: 'Name (Z\u2013A)' }),
        el('option', { value: 'recent', text: 'Recently used' }),
        el('option', { value: 'created', text: 'Recently created' }),
        el('option', { value: 'modified', text: 'Recently modified' }),
        el('option', { value: 'tokens-desc', text: 'Token count (highest first)' }),
        el('option', { value: 'tokens-asc', text: 'Token count (lowest first)' }),
        el('option', { value: 'favorites', text: 'Favorites first' }),
    ]);
    sort.value = settings.sort;
    if (sort.value !== settings.sort) { sort.value = 'name'; settings.sort = 'name'; } // unknown/legacy saved value

    // Only shown once at least one persona is a favorite, so people who never
    // use favorites never see another toolbar button.
    const favFilterBtn = el('button', {
        class: 'pl-icon-btn pl-fav-filter', type: 'button', hidden: true,
        title: 'Show favorites only',
        onclick: () => { persist({ favoritesOnly: !settings.favoritesOnly }); renderGrid(); },
    }, [el('i', { class: 'fa-solid fa-star' })]);

    const size = el('input', {
        class: 'pl-size',
        type: 'range',
        min: '90',
        max: '260',
        step: '1',
        value: String(settings.tile),
        title: 'Tile size',
        oninput: () => {
            persist({ tile: Number(size.value) });
            root.style.setProperty('--pl-tile', `${settings.tile}px`);
        },
    });

    const count = el('span', { class: 'pl-count' });

    // -- passthroughs to native ST UI that this extension doesn't (yet)
    // reimplement itself, e.g. persona-bound lorebook assignment and the
    // native Persona Management panel's own remaining functions. Rather
    // than reimplement those here, just click through to the real thing.
    //
    // IMPORTANT CAVEAT: these are best-effort selector guesses, not
    // confirmed against a live SillyTavern DOM. Native element IDs vary
    // across ST versions/forks and I don't have a way to inspect yours
    // directly. If a button here doesn't do anything, open devtools,
    // right-click the real native button/tab you want it to reach ->
    // Inspect, and send me its id/class so this can be corrected to the
    // exact selector for your build \u2014 same approach that nailed down the
    // GENERATION_STARTED/etc event names earlier.
    function clickThrough(candidates, label) {
        for (const sel of candidates) {
            const target = document.querySelector(sel);
            if (target) {
                console.log(`[PersonaLibrary] passthrough "${label}": found via selector "${sel}", clicking`, target);
                target.click();
                return true;
            }
        }
        console.warn(`[PersonaLibrary] passthrough "${label}": none of these selectors matched anything \u2014`, candidates,
            '\u2014 inspect the real native button and tell Claude its id/class so this can be corrected.');
        globalThis.toastr?.warning?.(`Couldn't find the native "${label}" button \u2014 see console for how to fix this.`, 'Persona Library');
        return false;
    }

    const loreBtn = el('button', {
        class: 'pl-icon-btn', type: 'button', title: 'Open Worlds/Lorebooks (native)',
        onclick: () => clickThrough([
            '#WIDrawerIcon',
            '#WorldInfo',
            '#world_info_button',
            '.drawer-icon[data-target="#WorldInfo"]',
            '#world-info-button',
        ], 'Worlds/Lorebooks'),
    }, [el('i', { class: 'fa-solid fa-book' })]);

    // -- passthrough for a single persona's native "Persona Lore" binding.
    // Confirmed against the live DOM (2026-08-20): the native control is a
    // single, non-repeated element,
    //   <div id="persona_lore_button" class="menu_button fa-solid fa-globe interactable" ...>
    // and confirmed by the person testing it directly: shift-clicking it
    // opens the "Persona Lorebook for <name>" popup (World Info select +
    // OK), acting on whichever persona is currently selected in the native
    // list. That's the actual attach/change-a-lorebook-for-this-persona UI.
    // (A plain click only opens the popup when nothing is linked yet — once
    // a lorebook IS linked, plain click "loads" it instead of reopening the
    // picker, which is why shift-click is used unconditionally below.)
    //
    // Because the control acts on "whichever persona is currently selected
    // in the native list", not on a persona we can address directly, this
    // is still a two-step passthrough:
    //   1. Find and click this persona's entry in the native (CSS-hidden)
    //      avatar strip, #user_avatar_block, so it becomes the selected one.
    //   2. Click #persona_lore_button, which then opens the popup for it.
    // REMAINING CAVEAT: step 2 is now confirmed working; step 1 (finding
    // this persona's specific entry in #user_avatar_block) is still a
    // best-effort guess — I haven't seen that markup. If the popup opens
    // for the wrong persona, open devtools, inspect this persona's entry
    // in the native avatar list, and send me its id/class/attributes so
    // step 1 can be corrected too.
    function openPersonaLore(id, name) {
        const avatarCandidates = [
            `#user_avatar_block [imgfile="${CSS.escape(id)}"]`,
            `#user_avatar_block [data-avatar="${CSS.escape(id)}"]`,
            `#user_avatar_block .avatar-container[title="${CSS.escape(id)}"]`,
            `#user_avatar_block img[src*="${CSS.escape(id)}"]`,
        ];
        let avatarEl = null;
        for (const sel of avatarCandidates) {
            const found = document.querySelector(sel);
            if (found) { avatarEl = found; break; }
        }
        if (!avatarEl) {
            console.warn(`[PersonaLibrary] passthrough "Persona Lore": couldn't find "${name}"'s entry in the native avatar list using`, avatarCandidates,
                '\u2014 inspect the native list (#user_avatar_block) and tell Claude the right selector.');
            globalThis.toastr?.warning?.(`Couldn't locate "${name}" in the native list \u2014 see console for how to fix this.`, 'Persona Library');
            return;
        }
        // The element matched by the selector is sometimes the container,
        // sometimes a child <img> inside it — click the closest
        // .avatar-container so any native handler bound at that level
        // definitely fires.
        (avatarEl.closest('.avatar-container') ?? avatarEl).click();

        // Give the native UI a tick to update its "currently selected
        // persona" state before we act on #persona_lore_button.
        setTimeout(() => {
            const loreBtn = document.querySelector('#persona_lore_button');
            if (!loreBtn) {
                console.warn('[PersonaLibrary] passthrough "Persona Lore": #persona_lore_button not found in the DOM.');
                globalThis.toastr?.warning?.('Couldn\'t find the native Persona Lore button \u2014 see console.', 'Persona Library');
                return;
            }
            // Plain click is state-dependent: if this persona has no
            // lorebook linked yet, a plain click opens the "Link to Persona
            // Lorebook" popup (which is why the first test worked) — but
            // once one IS linked, a plain click just "loads" it instead of
            // reopening the popup to change it. Per the native tooltip,
            // shift/alt-click (or long-press) opens the popup regardless of
            // state, so dispatch a synthetic shift-click unconditionally —
            // that way this button always opens the picker, whether or not
            // a lorebook is already attached.
            loreBtn.dispatchEvent(new MouseEvent('click', {
                bubbles: true,
                cancelable: true,
                view: window,
                shiftKey: true,
            }));
        }, 50);
    }

    // NOTE: there's no equivalent "native Persona Management" button here.
    // That panel isn't reached by clicking through to something else — it's
    // the actual #PersonaManagement drawer Persona Library mounts inside of
    // and hides via CSS (see index.js/persona-library.css). Reaching it is
    // a toggle (index.js's #persona-library-native-toggle button, always
    // visible above the gallery), not a click-through, so it lives there
    // instead of here.

    const newBtn = adapter.createPersona && el('button', {
        class: 'pl-btn pl-primary pl-new-btn', type: 'button',
        onclick: async () => {
            const name = (await (adapter.promptText?.('Enter a name for this persona:', '') ?? Promise.resolve(window.prompt('Enter a name for this persona:', '')))) ?? '';
            const trimmed = name.trim();
            if (!trimmed) return;
            try {
                const id = await adapter.createPersona(trimmed);
                globalThis.toastr?.success?.('Persona created.', 'Persona Library');
                refresh();
                select(id);
            } catch (e) {
                console.error('[PersonaLibrary] create failed', e);
                globalThis.toastr?.error?.('Could not create persona.', 'Persona Library');
            }
        },
    }, [el('i', { class: 'fa-solid fa-plus' }), el('span', { text: 'New Persona' })]);

    const grid = el('div', { class: 'pl-grid' });
    const gridWrap = el('div', { class: 'pl-grid-wrap' }, [grid]);
    const detail = el('div', { class: 'pl-detail pl-root', hidden: true });

    // Stops wheel/touch scroll gestures from leaking past this overlay
    // into whatever's behind it (the persona gallery grid) once an inner
    // scrollable panel hits its own top or bottom. This is purely additive
    // on top of the deliberate `position: fixed` mounting fix above/below
    // (see the container.appendChild(detail) comment) — it doesn't touch
    // where or how the modal is mounted, it only stops the wheel/touch
    // EVENT from bubbling past this element.
    //
    // Only intercepts when there's genuinely NO scrollable ancestor
    // between the touch/cursor point and this element — i.e. only over
    // truly "dead" areas like the header, where CSS overscroll-behavior:
    // contain (on the actual scrollable panels) has nothing local to lean
    // on. Deliberately checks by WALKING UP FOR A REAL overflow:auto
    // ancestor with actual overflow, rather than a hardcoded class name:
    // which element is/isn't a scroll container changes between wide and
    // narrow layouts (the hero image sits beside a scrollable column on
    // wide screens, but INSIDE one on narrow screens, since the scroll-trap
    // fix folded it into .pl-detail-body's own scroll area there) — a
    // class-name check would only be correct for one of those two cases.
    // This adapts to whichever is actually active instead of assuming one.
    //
    // PERF: this used to call getComputedStyle() on every ancestor, on
    // EVERY wheel/touchmove event, with no caching at all — a mouse wheel
    // or trackpad can fire dozens of these a second, and getComputedStyle
    // forces the browser to run a synchronous style recalc each time. That
    // was the actual source of the scroll stutter reported in the Preview
    // tab (`.pl-preview-view`) and elsewhere in this modal: every single
    // tick of a scroll gesture was paying for a full style-recalc walk up
    // the tree before the scroll itself could even happen.
    //
    // Fixed with a short-lived cache per starting node (a WeakMap so
    // entries for nodes removed by the next renderDetail() are simply
    // garbage-collected, no manual cleanup needed) instead of computing
    // fresh every time. A cached answer is reused for CACHE_MS — long
    // enough to collapse a whole burst of same-target wheel ticks (which
    // land within a few ms of each other) down to one real computation,
    // short enough that it can't meaningfully go stale: the only thing that
    // changes which element the walk lands on is a layout/breakpoint flip
    // (narrow vs wide) or content height crossing the scrollable threshold,
    // neither of which happens mid-scroll-gesture in practice.
    const scrollContainerCache = new WeakMap();
    const SCROLL_CACHE_MS = 50;
    function nearestScrollContainer(node) {
        const startNode = node;
        const cached = scrollContainerCache.get(startNode);
        const now = performance.now();
        if (cached && now - cached.at < SCROLL_CACHE_MS) return cached.result;
        let n = node;
        let result = null;
        while (n && n !== detail) {
            const style = getComputedStyle(n);
            if ((style.overflowY === 'auto' || style.overflowY === 'scroll') && n.scrollHeight > n.clientHeight) {
                result = n;
                break;
            }
            n = n.parentElement;
        }
        scrollContainerCache.set(startNode, { result, at: now });
        return result;
    }
    detail.addEventListener('wheel', (e) => { if (!nearestScrollContainer(e.target)) e.stopPropagation(); }, { passive: true });
    detail.addEventListener('touchmove', (e) => { if (!nearestScrollContainer(e.target)) e.stopPropagation(); }, { passive: true });

    // Shared by every way of leaving the detail view (backdrop click, Back
    // to Grid, the X button) so unsaved edits can never be discarded
    // silently through one path just because the warning was only wired
    // into another. `afterClose` lets a specific path (the X button) still
    // do its own extra thing (closing the native tab) — only AFTER the
    // person has actually confirmed discarding, never before.
    function closeDetail(afterClose) {
        const proceed = () => {
            dirty = false;
            selectedId = null;
            renderGrid();
            renderDetail();
            afterClose?.();
        };
        if (!dirty) { proceed(); return; }
        const ask = adapter.confirm ?? (async (m) => window.confirm(m));
        Promise.resolve(ask('You have unsaved changes. Discard them?')).then((ok) => { if (ok) proceed(); });
    }

    detail.addEventListener('click', (e) => {
        if (e.target === detail) closeDetail();
    });

    // -- image viewer (zoom / pan lightbox), above the detail modal --
    // See modules/image-viewer.js. It shows exactly the URL it is given, so
    // callers pass ORIGINAL files, never thumbnails (see originalPortraitUrl).
    const viewer = createImageViewer(container);
    function openLightbox(src, alt, fallbackSrc) {
        viewer.open({ src, alt, fallbackSrc });
    }

    // -- "expand to full screen" editor for a long single-line/text field --
    // Deliberately NOT the Core/Custom-section drag-to-resize handle: that
    // grows the row in place (still competing for space with everything
    // else in the list), this instead opens a temporary, focused,
    // full-viewport textarea — same overlay pattern as the image lightbox
    // above — so someone writing a long value can actually see what they
    // wrote without leaving the compact list layout behind. Sections stay
    // the slim default list either way; this is purely an alternate way to
    // EDIT a value, not a change to how the list itself looks.
    //
    // Built on a plain getValue/setValue pair rather than hardcoding
    // "a section's content" specifically — that's what lets the SAME
    // overlay back both a Custom section's content blob AND a single
    // built-in-category field's value (a plain single-line <input>, which
    // is the actually-cramped case: those have no way to grow at all,
    // unlike Custom sections which already have their own drag-resize).
    let textFocusTarget = null; // { setValue, compactEl } while open
    const textFocusTitle = el('div', { class: 'pl-text-focus-title' });
    const textFocusArea = el('textarea', {
        class: 'pl-text-focus-area', spellcheck: 'true',
        oninput: () => {
            if (!textFocusTarget) return;
            dirty = true;
            textFocusTarget.setValue(textFocusArea.value);
            // Keep the compact row's own input/textarea in sync live, not
            // just on close — if something else re-renders the list while
            // this is open, the compact value backing it is already
            // current, and its own oninput never needs to fire separately.
            textFocusTarget.compactEl.value = textFocusArea.value;
        },
    });
    const textFocusClose = el('button', {
        class: 'pl-lightbox-close', type: 'button', title: 'Done',
        onclick: () => closeTextFocus(),
    }, [el('i', { class: 'fa-solid fa-xmark' })]);
    const textFocus = el('div', { class: 'pl-text-focus-overlay pl-root', hidden: true }, [
        el('div', { class: 'pl-text-focus-bar' }, [textFocusTitle, textFocusClose]),
        textFocusArea,
    ]);
    textFocus.addEventListener('click', (e) => {
        if (e.target === textFocus) closeTextFocus();
    });
    /** @param {{ value: string, setValue: (v: string) => void, compactEl: HTMLElement, title: string, editable: boolean }} opts */
    function openTextFocus({ value, setValue, compactEl, title, editable }) {
        textFocusTarget = { setValue, compactEl };
        textFocusTitle.textContent = title || 'Section';
        textFocusArea.value = value ?? '';
        textFocusArea.disabled = !editable;
        textFocus.hidden = false;
        textFocusArea.focus();
    }
    function closeTextFocus() {
        textFocus.hidden = true;
        textFocusTarget = null;
    }
    document.addEventListener('keydown', (e) => {
        if (e.key === 'Escape' && !textFocus.hidden) closeTextFocus();
    });

    root.style.setProperty('--pl-tile', `${settings.tile}px`);

    // -- true fixed-viewport overlay, like CharacterLibrary's own modal --
    // `.pl-root` sets `container-type: inline-size` for the @container
    // breakpoints elsewhere in this file, but that quietly gives it CSS
    // layout containment too — which makes it the containing block for any
    // `position: fixed` descendant, same as `position: relative` would.
    // So nesting the modal inside `.pl-root`/`.pl-body` and setting it to
    // `position: fixed` never actually reached the real browser viewport;
    // it stayed trapped inside whatever (undefined) size `.pl-root` had.
    //
    // Mounting on `container` (== #persona-library-host, one level up from
    // `.pl-root`, with none of that containment CSS) sidesteps that just as
    // well — AND, unlike mounting on `document.body`, keeps the modal a
    // real DOM descendant of SillyTavern's own drawer wrapper
    // (#PersonaManagement). That matters: SillyTavern's native "click
    // outside the open drawer closes it" logic checks DOM containment
    // against that wrapper. `document.body` placement put every click
    // anywhere in this modal — Back to Grid, Duplicate, Delete, Save, all
    // of it — structurally outside that wrapper despite rendering visually
    // on top of it, so SillyTavern treated each one as a background click
    // and closed the whole Persona drawer. `container` is still inside
    // #PersonaManagement (index.js prepends the host there), so this fixes
    // that at the root instead of trying to intercept/stop each click.
    //
    // Bonus: this also means the modal now correctly hides itself when the
    // native-override toggle is used, since that hides #persona-library-host
    // wholesale — on document.body it sat outside that rule and could stay
    // floating on top of the native UI while switched over.
    container.appendChild(detail);
    container.appendChild(textFocus);

    // Slim hint shown only while "Compare with\u2026" is waiting for a second pick.
    const compareBarText = el('span', { class: 'pl-compare-bar-text' });
    const compareBar = el('div', { class: 'pl-compare-bar', hidden: true }, [
        compareBarText,
        el('button', { class: 'pl-btn', type: 'button', text: 'Cancel', onclick: () => cancelCompare() }),
    ]);

    root.append(
        el('div', { class: 'pl-toolbar' }, [newBtn, search, sort, favFilterBtn, size, count, loreBtn].filter(Boolean)),
        compareBar,
        el('div', { class: 'pl-body' }, [gridWrap]),
    );

    function persist(patch) {
        Object.assign(settings, patch);
        try { adapter.saveSettings?.(patch); } catch (e) { console.warn('[PersonaLibrary] saveSettings failed', e); }
    }

    // Shared with the Quick Switcher's sorting (see modules/persona-sort.js):
    // one comparator and one async token-count cache for both.
    const tokenCounter = createTokenCounter();

    // -- favorites: a list of persona ids in the extension's own settings --
    // Read from the saved settings every time (not just this instance's
    // startup copy) because the chat-bar overlay instance can change them too.
    const favoriteSet = () => {
        const live = adapter.getSettings?.()?.favorites;
        const list = Array.isArray(live) ? live : settings.favorites;
        return new Set(Array.isArray(list) ? list : []);
    };

    function toggleFavorite(id) {
        const favs = favoriteSet();
        if (favs.has(id)) favs.delete(id); else favs.add(id);
        persist({ favorites: [...favs] });
        renderGrid();
        emitLibraryChanged(changeSource);
    }

    // -- detail tab: remembered, but never to a tab this adapter can't show --
    const validTab = (tab) => {
        if (tab === 'edit') return typeof adapter.updatePersona === 'function' ? 'edit' : 'details';
        if (tab === 'gallery') return typeof adapter.getPersonaGalleryImages === 'function' ? 'gallery' : 'details';
        return tab === 'preview' ? 'preview' : 'details';
    };
    function setDetailTab(tab) {
        detailTab = validTab(tab);
        persist({ detailTab });
    }

    function visiblePersonas() {
        const all = adapter.getPersonas() ?? [];
        // The overlay has no search box / favorites filter, so its ‹ › stepping
        // cycles through everyone rather than a stale copy of the gallery's filter.
        const q = overlayMode ? '' : norm(settings.query).trim();
        const favs = favoriteSet();
        const list = all.filter((p) => {
            if (!overlayMode && settings.favoritesOnly && !favs.has(p.id)) return false;
            if (!q) return true;
            if (norm(p.name).includes(q) || norm(p.description).includes(q)) return true;
            // Searching "Steve M" should still find Steve, whichever incarnation is live.
            return !!adapter.getPersonaIncarnations?.(p.id)?.list?.some((inc) => norm(inc.name).includes(q));
        });
        return sortPersonas(list, settings.sort, {
            activeId: adapter.getActiveId?.() ?? null,
            favorites: favs,
            tokensOf: (p) => tokenCounter.get(p),
        });
    }

    // -- remembered scroll position --------------------------------------
    // The grid's scroll offset is lost whenever its drawer is hidden
    // (display:none), so it is restored once the grid is visible again, not
    // just once at startup. Scroll events are ignored while a restore is
    // pending so the reset-to-0 can never overwrite the remembered value.
    let savedScroll = Number(settings.scrollTop) || 0;
    let restorePending = savedScroll > 0;
    let scrollTimer = null;

    function applyScrollRestore() {
        if (!restorePending || !gridWrap.clientHeight || !grid.childElementCount || !gridWrap.contains(grid)) return;
        restorePending = false;
        gridWrap.scrollTop = savedScroll;
    }

    gridWrap.addEventListener('scroll', () => {
        if (restorePending || !gridWrap.clientHeight) return;
        savedScroll = gridWrap.scrollTop;
        clearTimeout(scrollTimer);
        scrollTimer = setTimeout(() => persist({ scrollTop: Math.round(savedScroll) }), 500);
    }, { passive: true });

    let gridWasHidden = !gridWrap.clientHeight;
    const gridObserver = typeof ResizeObserver === 'function'
        ? new ResizeObserver(() => {
            const visible = gridWrap.clientHeight > 0;
            if (visible && gridWasHidden && savedScroll > 0) restorePending = true;
            gridWasHidden = !visible;
            applyScrollRestore();
        })
        : null;
    gridObserver?.observe(gridWrap);

    function renderGrid() {
        if (overlayMode) return; // no grid in the chat-bar overlay
        const all = adapter.getPersonas() ?? [];
        const favs = favoriteSet();
        const favCount = all.reduce((n, p) => n + (favs.has(p.id) ? 1 : 0), 0);
        // The filter can't outlive its last favorite (e.g. it was deleted).
        if (!favCount && settings.favoritesOnly) persist({ favoritesOnly: false });
        favFilterBtn.hidden = !favCount;
        favFilterBtn.classList.toggle('pl-icon-active', !!settings.favoritesOnly);
        favFilterBtn.setAttribute('aria-pressed', settings.favoritesOnly ? 'true' : 'false');
        favFilterBtn.title = settings.favoritesOnly ? 'Showing favorites only — click to show everyone' : 'Show favorites only';
        // Resolve token counts only when they're actually the sort key; the
        // counter re-renders once when they land and never loops.
        if (isTokenSort(settings.sort)) tokenCounter.ensure(all, adapter, () => renderGrid());

        const list = visiblePersonas();
        const activeId = adapter.getActiveId?.() ?? null;
        const scrollTop = gridWrap.scrollTop;
        grid.replaceChildren();
        count.textContent = `${list.length} persona${list.length === 1 ? '' : 's'}`;

        if (!list.length) {
            gridWrap.replaceChildren(el('div', {
                class: 'pl-empty',
                text: all.length ? 'No personas match your filters.' : 'No personas yet.',
            }));
            return;
        }
        if (!gridWrap.contains(grid)) gridWrap.replaceChildren(grid);

        for (const p of list) {
            const fav = favs.has(p.id);
            const tile = el('button', {
                class: `pl-tile${p.id === selectedId ? ' pl-selected' : ''}${p.id === activeId ? ' pl-active' : ''}${p.id === compareFrom ? ' pl-compare-source' : ''}`,
                type: 'button',
                title: p.incarnationCount > 1 ? `${p.name} \u00b7 ${p.incarnationCount} incarnations` : p.name,
                onclick: () => (compareFrom ? finishCompare(p.id) : select(p.id)),
                ondblclick: () => { if (!compareFrom) use(p.id); },
            }, [
                personaImg({ alt: p.name, loading: 'lazy', decoding: 'async', src: p.image }, p.id, adapter),
                el('span', { class: 'pl-tile-name', text: p.name }),
            ]);
            // The "more" indicator: three white dots on hover (so people know
            // a menu is there), or three little yellow stars once the persona
            // is a favorite. Either way a click opens the same menu as a
            // right-click, where favoriting lives. A sibling of the tile, not
            // a child: a <button> inside a <button> is invalid and unreliable
            // across browsers. Inline SVG so it never depends on icon fonts.
            const STAR = 'M5 .6l1.2 2.9 3.1.3-2.4 2 .8 3.1L5 7.4 2.3 8.9l.8-3.1-2.4-2 3.1-.3z';
            const star = el('button', {
                class: `pl-tile-star${fav ? ' pl-fav' : ''}`, type: 'button',
                title: fav ? 'Favorite \u2014 click for menu' : 'More actions',
                'aria-haspopup': 'menu',
                onclick: (e) => { e.stopPropagation(); openTileMenu(e, p); },
            });
            // Stars are drawn ~1.3x their box so a star carries the same visual
            // weight as a solid dot (a star fills far less of its bounding box).
            const STAR_AT = (cy) => `<path transform="translate(7 ${cy}) scale(1.28) translate(-5 -4.75)" d="${STAR}"/>`;
            star.innerHTML = `<svg viewBox="0 0 14 44" width="7" height="22" aria-hidden="true" fill="currentColor">${fav
                ? [7, 22, 37].map(STAR_AT).join('')
                : [7, 22, 37].map((cy) => `<circle cx="7" cy="${cy}" r="3.7"/>`).join('')}</svg>`;
            // Shown only for personas that actually have incarnations. A
            // sibling (like the star) and non-interactive, so it never
            // changes how the tile itself is clicked.
            const incBadge = p.incarnationCount > 1 && el('span', {
                class: 'pl-tile-inc',
                title: `${p.incarnationCount} incarnations${p.incarnationOriginalName ? ` of ${p.incarnationOriginalName}` : ''}`,
            }, [el('i', { class: 'fa-solid fa-layer-group' }), el('span', { text: String(p.incarnationCount) })]);
            grid.append(el('div', {
                class: 'pl-tile-cell',
                oncontextmenu: (e) => openTileMenu(e, p),
            }, [tile, star, incBadge]));
        }
        if (restorePending) applyScrollRestore();
        else gridWrap.scrollTop = scrollTop;
    }

    function select(id) {
        if (dirty && id !== selectedId) {
            // keep it simple: unsaved edits are discarded on switch, but warn once
            note = '';
            dirty = false;
        }
        selectedId = id;
        sectionsDraft = null; // force a fresh reload for the newly selected persona
        variantsDraft = null;
        detailTab = validTab(detailTab); // keep the last-used tab
        renderGrid();
        renderDetail();
    }

    /** Opens a persona's detail view straight onto `tab` (also remembered). */
    function openPersona(id, tab) {
        if (tab) setDetailTab(tab);
        select(id);
    }

    function step(delta) {
        const list = visiblePersonas();
        if (!list.length) return;
        const idx = list.findIndex((p) => p.id === selectedId);
        const next = list[(idx + delta + list.length) % list.length];
        if (next) select(next.id);
    }

    async function use(id) {
        try {
            await adapter.setActive(id);
            note = 'Persona activated.';
            globalThis.toastr?.success?.(note, 'Persona Library');
        } catch (e) {
            console.error('[PersonaLibrary] setActive failed', e);
            note = 'Could not switch persona.';
            globalThis.toastr?.error?.(note, 'Persona Library');
        }
        refresh();
        emitLibraryChanged(changeSource);
    }

    /**
     * Runs a persona action with the standard toast + refresh handling.
     * Shared by the detail view's buttons and the tile right-click menu so
     * both behave identically.
     */
    async function runAction(fn, ok, fail, { forceRerender = false } = {}) {
        try {
            await fn();
            note = ok;
            dirty = false;
            globalThis.toastr?.success?.(ok, 'Persona Library');
        } catch (e) {
            console.error('[PersonaLibrary]', e);
            note = fail;
            globalThis.toastr?.error?.(fail, 'Persona Library');
        }
        if (forceRerender) lastFingerprint = null;
        refresh();
        emitLibraryChanged(changeSource);
    }

    const duplicateFlow = (p) => runAction(() => adapter.duplicatePersona(p.id), 'Duplicated.', 'Could not duplicate.');

    async function deleteFlow(p) {
        const ask = adapter.confirm ?? (async (m) => window.confirm(m));
        const galCount = adapter.getPersonaGalleryImages?.(p.id)?.images?.length ?? 0;
        const galNote = galCount ? ` Its ${galCount} gallery image${galCount === 1 ? '' : 's'} will be deleted too.` : '';
        if (!await ask(`Delete persona "${p.name}"?${galNote} This cannot be undone.`)) return;
        if (selectedId === p.id) selectedId = null;
        await runAction(async () => {
            await adapter.deletePersona(p.id);
            // Only after the persona itself is gone; failure here is harmless.
            try { await adapter.deletePersonaGallery?.(p.id); } catch (e) { console.warn('[PersonaLibrary] gallery cleanup failed', e); }
            if (favoriteSet().has(p.id)) persist({ favorites: [...favoriteSet()].filter((id) => id !== p.id) });
        }, 'Deleted.', 'Could not delete.');
    }

    // -- right-click menu on a gallery tile --------------------------------
    // The menu itself (rendering, positioning, keyboard handling) and its
    // item list live in persona-menu.js and are shared with the chat-bar
    // Quick Switcher; this just says what each action does HERE. Mounted on
    // `container` like the other overlays (see the note above
    // container.appendChild(detail)) so SillyTavern doesn't treat a click on
    // it as a click outside its drawer.
    const ctxMenu = createContextMenu(container);
    const closeMenu = () => ctxMenu.close();

    const menuActions = {
        use: (p) => use(p.id),
        edit: typeof adapter.updatePersona === 'function' ? (p) => openPersona(p.id, 'edit') : null,
        duplicate: adapter.duplicatePersona ? (p) => duplicateFlow(p) : null,
        gallery: adapter.getPersonaGalleryImages ? (p) => openPersona(p.id, 'gallery') : null,
        toggleFavorite: (p) => toggleFavorite(p.id),
        compare: (p) => startCompare(p.id),
        remove: adapter.deletePersona ? (p) => deleteFlow(p) : null,
        switchIncarnation: adapter.switchPersonaIncarnation ? (p, key) => switchIncarnationFlow(p.id, key) : null,
        manageIncarnations: adapter.createPersonaIncarnation ? (p) => manageIncarnations(p.id) : null,
    };

    function openTileMenu(e, p) {
        e.preventDefault();
        ctxMenu.open({
            x: e.clientX,
            y: e.clientY,
            anchorRect: e.currentTarget.getBoundingClientRect(),
            items: personaMenuItems(p, {
                isActive: p.id === (adapter.getActiveId?.() ?? null),
                isFav: favoriteSet().has(p.id),
                canCompare: (adapter.getPersonas() ?? []).length > 1,
                incarnations: adapter.getPersonaIncarnations?.(p.id) ?? null,
                actions: menuActions,
            }),
            extraDismissTargets: [gridWrap],
        });
    }

    // -- generic centered dialog (Incarnations, image bindings) ------------
    const dialog = el('div', { class: 'pl-dialog pl-root', hidden: true });
    container.appendChild(dialog);
    let dialogBusy = false;
    const closeDialog = () => {
        if (dialogBusy) return;
        dialog.hidden = true;
        dialog.replaceChildren();
    };
    dialog.addEventListener('click', (e) => { if (e.target === dialog) closeDialog(); });
    const onDialogKey = (e) => { if (e.key === 'Escape' && !dialog.hidden) { e.stopPropagation(); closeDialog(); } };
    document.addEventListener('keydown', onDialogKey, true);
    function openDialog(content) {
        dialog.replaceChildren(content);
        dialog.hidden = false;
    }

    // -- Incarnations -------------------------------------------------------
    // See the big comment above "Persona Incarnations" in st-adapter.js. The
    // live incarnation is the persona's ordinary data, so everything in the
    // detail view (Details / Edit / Preview / Gallery) always shows and edits
    // whichever incarnation is currently selected in the bar.
    const askConfirm = (m) => (adapter.confirm ?? (async (msg) => window.confirm(msg)))(m);
    let incBusy = false;

    async function confirmDiscardIfDirty(id) {
        if (id !== selectedId || !dirty) return true;
        return Boolean(await askConfirm('You have unsaved changes. Discard them?'));
    }

    /** Runs an incarnation operation with the standard guards, toasts and a full redraw. */
    async function incarnationAction(id, fn, ok, fail, { skipDirtyCheck = false } = {}) {
        if (incBusy) return false;
        if (!skipDirtyCheck && !(await confirmDiscardIfDirty(id))) return false;
        incBusy = true;
        let success = false;
        // The data is about to change underneath any open drafts; drop them
        // now so no render in the middle of the operation can show (or later
        // save) the old incarnation's text against the new one.
        if (id === selectedId) { sectionsDraft = null; variantsDraft = null; }
        try {
            await fn();
            success = true;
            if (id === selectedId) dirty = false;
            globalThis.toastr?.success?.(ok, 'Persona Library');
        } catch (e) {
            console.error('[PersonaLibrary] incarnation', e);
            globalThis.toastr?.error?.(`${fail} ${e?.message ?? ''}`.trim(), 'Persona Library');
        } finally {
            incBusy = false;
        }
        // The persona's data changed underneath any open drafts — reload them.
        if (id === selectedId) { sectionsDraft = null; variantsDraft = null; }
        note = '';
        lastFingerprint = null;
        refresh();
        emitLibraryChanged(changeSource);
        return success;
    }

    const switchIncarnationFlow = (id, key) => incarnationAction(
        id, () => adapter.switchPersonaIncarnation(id, key), 'Switched incarnation.', 'Could not switch incarnation.',
    );

    async function deleteIncarnationFlow(p, inc) {
        const n = inc.imageCount ? ` and ${inc.imageCount} gallery image${inc.imageCount === 1 ? '' : 's'}` : '';
        const back = inc.active ? ' You will be returned to the original.' : '';
        if (!await askConfirm(`Delete incarnation \u201c${inc.name}\u201d? Its description, sections, variants, bindings${n} are deleted permanently.${back} The original and any other incarnations are not affected.`)) return;
        await incarnationAction(p.id, () => adapter.deletePersonaIncarnation(p.id, inc.key), 'Incarnation deleted.', 'Could not delete incarnation.', { skipDirtyCheck: !inc.active });
    }

    /** "Manage incarnations…" / "Add incarnation…" from a menu. */
    function manageIncarnations(id) {
        openPersona(id);
        if (!adapter.getPersonaIncarnations?.(id)) openIncarnationDialog(id);
    }

    async function openIncarnationDialog(id) {
        if (!adapter.createPersonaIncarnation) return;
        const p = (adapter.getPersonas() ?? []).find((x) => x.id === id);
        if (!p) return;
        if (!await confirmDiscardIfDirty(id)) return;
        const info = adapter.getPersonaIncarnations?.(id) ?? null;

        const nameInput = el('input', { type: 'text', class: 'pl-name-input', placeholder: `e.g. ${p.name} Z`, maxlength: '120' });
        const modeBlank = el('input', { type: 'radio', name: 'pl-inc-mode', value: 'blank', checked: true });
        const modeCopy = el('input', { type: 'radio', name: 'pl-inc-mode', value: 'copy' });
        const COPY_OPTIONS = [
            ['core', 'Core description', true],
            ['sections', 'Additional sections (appearance, personality, etc.)', true],
            ['variants', 'Variants', true],
            ['images', 'Portrait & image gallery', true],
            ['settings', 'Injection position, depth, role & lorebook', true],
        ];
        const checks = Object.fromEntries(COPY_OPTIONS.map(([k, , on]) => [k, el('input', { type: 'checkbox', checked: on })]));
        const sourceSelect = info && el('select', { class: 'pl-select' }, info.list.map((inc) => el('option', { value: inc.key, text: inc.name, selected: inc.active })));
        const copyBox = el('div', { class: 'pl-dialog-copy', hidden: true }, [
            sourceSelect && el('div', { class: 'pl-field' }, [el('label', { text: 'Copy from' }), sourceSelect]),
            el('div', { class: 'pl-dialog-checks' }, COPY_OPTIONS.map(([k, label]) => el('label', { class: 'pl-dialog-check' }, [checks[k], el('span', { text: label })]))),
            el('div', { class: 'pl-sections-hint', text: 'This is a one-time copy. Once created, the new incarnation is completely independent — editing either one never changes the other. Character connections and bindings are not copied.' }),
        ].filter(Boolean));
        const syncMode = () => { copyBox.hidden = !modeCopy.checked; };
        modeBlank.addEventListener('change', syncMode);
        modeCopy.addEventListener('change', syncMode);

        const createBtn = el('button', { class: 'pl-btn pl-primary', type: 'button', text: 'Create & switch' });
        const cancelBtn = el('button', { class: 'pl-btn', type: 'button', text: 'Cancel', onclick: () => closeDialog() });
        createBtn.onclick = async () => {
            const name = nameInput.value.trim();
            if (!name) { globalThis.toastr?.warning?.('Give the incarnation a name.', 'Persona Library'); nameInput.focus(); return; }
            const copy = modeCopy.checked ? Object.fromEntries(COPY_OPTIONS.map(([k]) => [k, checks[k].checked])) : null;
            dialogBusy = true;
            createBtn.disabled = true; cancelBtn.disabled = true;
            createBtn.textContent = 'Creating\u2026';
            const okd = await incarnationAction(id,
                () => adapter.createPersonaIncarnation(id, { name, sourceKey: sourceSelect?.value, copy }),
                'Incarnation created.', 'Could not create incarnation.', { skipDirtyCheck: true });
            dialogBusy = false;
            if (okd) closeDialog();
            else { createBtn.disabled = false; cancelBtn.disabled = false; createBtn.textContent = 'Create & switch'; }
        };
        nameInput.addEventListener('keydown', (e) => { if (e.key === 'Enter') createBtn.click(); });

        openDialog(el('div', { class: 'pl-dialog-modal' }, [
            el('div', { class: 'pl-dialog-title', text: `New incarnation of \u201c${info?.list?.find((x) => x.isOriginal)?.name ?? p.name}\u201d` }),
            el('div', { class: 'pl-dialog-body' }, [
                el('div', { class: 'pl-field' }, [el('label', { text: 'Name' }), nameInput]),
                el('label', { class: 'pl-dialog-check' }, [modeBlank, el('span', { text: 'Start with a blank slate' })]),
                el('label', { class: 'pl-dialog-check' }, [modeCopy, el('span', { text: 'Copy from an existing incarnation' })]),
                copyBox,
            ]),
            el('div', { class: 'pl-dialog-actions' }, [cancelBtn, createBtn]),
        ]));
        nameInput.focus();
    }

    /**
     * Minimal incarnation switcher: a slim caret attached to the right of the
     * "Use this persona" check in the detail header (a split button) that opens
     * a dropdown (the same menu component as the right-click menus) to switch,
     * add or delete incarnations. No bar, no pills, no extra square.
     * The button is tinted when the persona actually has incarnations so it's
     * easy to notice without adding any text.
     */
    function buildIncarnationMenuBtn(p) {
        const info = adapter.getPersonaIncarnations?.(p.id) ?? null;
        const count = info?.list?.length ?? 0;
        const activeName = info?.list?.find((i) => i.active)?.name ?? '';
        const btn = el('button', {
            class: `pl-icon-btn pl-inc-menu-btn${count > 1 ? ' pl-has-incarnations' : ''}`, type: 'button',
            title: count > 1 ? `Incarnations (${count}) \u00b7 showing \u201c${activeName}\u201d` : 'Incarnations \u2014 add a separate version of this persona',
            'aria-haspopup': 'menu',
        }, [el('i', { class: 'fa-solid fa-caret-down' })]);
        btn.addEventListener('click', (e) => {
            e.stopPropagation();
            const fresh = adapter.getPersonaIncarnations?.(p.id) ?? null;
            const r = btn.getBoundingClientRect();
            const items = [{ title: 'Incarnations' }];
            for (const inc of fresh?.list ?? []) {
                items.push({
                    icon: inc.active ? 'fa-circle-dot' : 'fa-circle',
                    label: inc.isOriginal ? `${inc.name} (original)` : inc.name,
                    disabled: inc.active,
                    onClick: () => switchIncarnationFlow(p.id, inc.key),
                });
            }
            if (fresh?.list?.length) items.push('sep');
            items.push({ icon: 'fa-plus', label: 'New incarnation\u2026', onClick: () => openIncarnationDialog(p.id) });
            const deletable = (fresh?.list ?? []).filter((i) => !i.isOriginal);
            if (deletable.length) {
                items.push('sep');
                for (const inc of deletable) {
                    items.push({ icon: 'fa-trash', label: `Delete \u201c${inc.name}\u201d\u2026`, danger: true, onClick: () => deleteIncarnationFlow(p, inc) });
                }
            }
            ctxMenu.open({ x: r.left, y: r.bottom + 4, anchorRect: r, items });
        });
        return btn;
    }

    // -- comparison: pick two personas, inspect them side by side ----------
    // Deliberately a read-only window, not an editor. Entered from a tile's
    // right-click menu ("Compare with…") and then a click on a second
    // tile; either side can be changed (or the two swapped) once it's open.
    const cmp = el('div', { class: 'pl-compare pl-root', hidden: true });
    container.appendChild(cmp);
    cmp.addEventListener('click', (e) => { if (e.target === cmp) closeCompare(); });
    let cmpIds = [null, null];
    let cmpRun = 0; // guards async token counts against a newer render

    /**
     * Chat-bar flow: there's no grid to click a second persona in, so show a
     * searchable list to pick from, then open the compare window. (The gallery
     * keeps its own "click another tile" flow, below.)
     */
    function openComparePicker(id) {
        const all = adapter.getPersonas() ?? [];
        const src = all.find((x) => x.id === id);
        if (!src || all.length < 2) return;
        const activeId = adapter.getActiveId?.() ?? null;
        const others = sortPersonas(all.filter((x) => x.id !== id), 'name');

        const search = el('input', { type: 'search', class: 'pl-search pl-pick-search', placeholder: 'Search personas…' });
        const listEl = el('div', { class: 'pl-pick-list' });
        const pick = (otherId) => { closeDialog(); openCompare(id, otherId); };
        const renderPickList = () => {
            const q = norm(search.value).trim();
            const rows = others.filter((x) => !q || norm(x.name).includes(q));
            listEl.replaceChildren(...(rows.length ? rows.map((x) => el('button', {
                class: 'pl-pick-row', type: 'button', onclick: () => pick(x.id),
            }, [
                personaImg({ class: 'pl-pick-thumb', alt: x.name, loading: 'lazy', decoding: 'async', src: x.image }, x.id, adapter),
                el('span', { class: 'pl-pick-name', text: x.name }),
                x.id === activeId ? el('span', { class: 'pl-active-pill', text: 'ACTIVE' }) : null,
            ].filter(Boolean))) : [el('div', { class: 'pl-pick-empty', text: 'No personas match.' })]));
        };
        search.addEventListener('input', renderPickList);
        search.addEventListener('keydown', (e) => {
            if (e.key === 'Enter') listEl.querySelector('.pl-pick-row')?.click();
        });
        renderPickList();

        openDialog(el('div', { class: 'pl-dialog-modal' }, [
            el('div', { class: 'pl-dialog-title', text: `Compare “${src.name}” with…` }),
            el('div', { class: 'pl-dialog-body pl-pick-body' }, [search, listEl]),
            el('div', { class: 'pl-dialog-actions' }, [el('button', { class: 'pl-btn', type: 'button', text: 'Cancel', onclick: () => closeDialog() })]),
        ]));
        search.focus();
    }

    function startCompare(id) {
        if (overlayMode) { openComparePicker(id); return; }
        const p = (adapter.getPersonas() ?? []).find((x) => x.id === id);
        compareFrom = id;
        compareBarText.textContent = `Comparing “${p?.name ?? id}” — click another persona to compare it with.`;
        compareBar.hidden = false;
        renderGrid();
    }

    function cancelCompare() {
        compareFrom = null;
        compareBar.hidden = true;
        renderGrid();
    }

    function finishCompare(id) {
        if (id === compareFrom) {
            globalThis.toastr?.info?.('Pick a different persona to compare with.', 'Persona Library');
            return;
        }
        const first = compareFrom;
        cancelCompare();
        openCompare(first, id);
    }

    function openCompare(aId, bId) {
        cmpIds = [aId, bId];
        cmp.hidden = false;
        renderCompare();
    }

    function closeCompare() {
        cmpRun++;
        cmp.hidden = true;
        cmp.replaceChildren();
    }

    /** The text a persona actually injects (core + enabled sections), plus those sections' names. */
    function composedFor(p) {
        const data = adapter.getPersonaSections?.(p.id) ?? { core: p.description ?? '', sections: [] };
        const text = adapter.composeDescription
            ? adapter.composeDescription(data.core ?? '', data.sections ?? [])
            : (data.core ?? '');
        const sections = (data.sections ?? []).filter((x) => x.enabled && (x.content ?? '').trim()).map((x) => x.title || 'Section');
        return { text, sections };
    }

    function renderCompare() {
        const all = adapter.getPersonas() ?? [];
        const pa = all.find((x) => x.id === cmpIds[0]);
        const pb = all.find((x) => x.id === cmpIds[1]);
        if (!pa || !pb) { closeCompare(); return; }
        const run = ++cmpRun;
        const A = { p: pa, ...composedFor(pa) };
        const B = { p: pb, ...composedFor(pb) };
        const byName = sortPersonas(all, 'name');

        const grid = el('div', { class: 'pl-cmp-grid' });

        const headCell = (side, idx) => {
            const sel = el('select', {
                class: 'pl-select pl-cmp-select', title: 'Choose a persona',
                onchange: () => { cmpIds[idx] = sel.value; renderCompare(); },
            }, byName.map((x) => el('option', { value: x.id, text: x.name })));
            sel.value = cmpIds[idx];
            return el('div', { class: 'pl-cmp-cell pl-cmp-head' }, [
                personaImg({ class: 'pl-cmp-thumb', alt: side.p.name, src: side.p.image }, side.p.id, adapter),
                sel,
            ]);
        };
        grid.append(headCell(A, 0), headCell(B, 1));

        const fact = (label, va, vb) => {
            const mk = (v) => el('div', { class: 'pl-cmp-cell pl-cmp-fact' }, [
                el('span', { class: 'pl-cmp-label', text: label }),
                el('span', { class: 'pl-cmp-value', text: v }),
            ]);
            const cells = [mk(va), mk(vb)];
            if (va !== vb) cells.forEach((c) => c.classList.add('pl-cmp-diff'));
            grid.append(...cells);
            return cells;
        };
        const dateOf = (ts) => (Number(ts) > 1e12 ? new Date(Number(ts)).toLocaleString() : '—');

        const [tokA, tokB] = fact('Tokens', '…', '…');
        fact('Characters', A.text.length.toLocaleString(), B.text.length.toLocaleString());
        fact('Injection', positionLabelOf(pa), positionLabelOf(pb));
        fact('Depth', String(pa.depth ?? 2), String(pb.depth ?? 2));
        fact('Role', roleLabelOf(pa), roleLabelOf(pb));
        fact('Lorebook', pa.lorebook || 'none', pb.lorebook || 'none');
        fact('Sections', A.sections.join(', ') || 'none', B.sections.join(', ') || 'none');
        fact('Modified', dateOf(pa.modified), dateOf(pb.modified));

        if (typeof adapter.getTokenCount === 'function') {
            Promise.all([adapter.getTokenCount(A.text), adapter.getTokenCount(B.text)]).then(([na, nb]) => {
                if (run !== cmpRun) return;
                const set = (cell, t) => { cell.querySelector('.pl-cmp-value').textContent = t; };
                const d = nb - na;
                set(tokA, `~${na.toLocaleString()}`);
                set(tokB, `~${nb.toLocaleString()}${d ? ` (${d > 0 ? '+' : '−'}${Math.abs(d).toLocaleString()})` : ''}`);
                if (d) { tokA.classList.add('pl-cmp-diff'); tokB.classList.add('pl-cmp-diff'); }
            }).catch(() => {
                if (run !== cmpRun) return;
                tokA.querySelector('.pl-cmp-value').textContent = '?';
                tokB.querySelector('.pl-cmp-value').textContent = '?';
            });
        }

        const diff = diffText(A.text, B.text);
        grid.append(el('div', {
            class: 'pl-cmp-wide pl-cmp-section-title',
            text: diff.identical ? 'Description — identical' : 'Description — differing words are highlighted',
        }));
        const pane = (segments, text) => {
            const box = el('div', { class: 'pl-cmp-cell pl-cmp-text' });
            if (!text.trim()) { box.append(el('span', { class: 'pl-cmp-empty', text: '(empty)' })); return box; }
            for (const sg of segments) box.append(sg.changed ? el('mark', { class: 'pl-cmp-mark', text: sg.text }) : document.createTextNode(sg.text));
            return box;
        };
        grid.append(pane(diff.a, A.text), pane(diff.b, B.text));
        grid.append(el('div', {
            class: 'pl-cmp-wide pl-sections-hint',
            text: 'Compares what actually gets injected: the core description plus enabled sections. Variants only apply while generating, so they aren’t included.',
        }));

        const header = el('div', { class: 'pl-cmp-header' }, [
            el('div', { class: 'pl-cmp-title', text: 'Compare personas' }),
            el('div', { class: 'pl-cmp-actions' }, [
                el('button', {
                    class: 'pl-icon-btn', type: 'button', title: 'Swap sides',
                    onclick: () => { cmpIds = [cmpIds[1], cmpIds[0]]; renderCompare(); },
                }, [el('i', { class: 'fa-solid fa-right-left' })]),
                el('button', {
                    class: 'pl-icon-btn', type: 'button', title: 'Close',
                    onclick: () => closeCompare(),
                }, [el('i', { class: 'fa-solid fa-xmark' })]),
            ]),
        ]);
        cmp.replaceChildren(el('div', { class: 'pl-cmp-modal' }, [header, el('div', { class: 'pl-cmp-body' }, [grid])]));
    }

    const onGalleryKeydown = (e) => {
        if (e.key !== 'Escape') return;
        if (!cmp.hidden) { closeCompare(); e.stopPropagation(); }
        else if (compareFrom) cancelCompare();
    };
    document.addEventListener('keydown', onGalleryKeydown);

    // -- section category templates -------------------------------------
    // The nine built-in categories (SECTION_TEMPLATES) plus anything the user
    // saves. Stored in the extension's own settings as
    //   { custom: [{ name, fields: [label…] }],   // user-made categories
    //     edited: { [builtinName]: [label…] },    // built-ins with their fields changed
    //     hidden: [name…] }                       // names removed from the dropdown
    // Only the structure (title + field labels) is ever stored, never the text
    // typed into the fields, so a template stays a template. Read live from the
    // saved settings every time so the gallery, the chat-bar editor and every
    // persona always see the same list.
    const sameName = (a, b) => norm(a).trim() === norm(b).trim();
    const cleanLabels = (labels) => [...new Set((labels ?? []).map((l) => String(l ?? '').trim()).filter(Boolean))];

    function readTemplateStore() {
        const live = adapter.getSettings?.()?.sectionTemplates ?? settings.sectionTemplates ?? {};
        return {
            custom: Array.isArray(live.custom) ? live.custom.filter((t) => t && t.name && Array.isArray(t.fields)) : [],
            edited: live.edited && typeof live.edited === 'object' ? { ...live.edited } : {},
            hidden: Array.isArray(live.hidden) ? [...live.hidden] : [],
        };
    }
    const writeTemplateStore = (store) => persist({ sectionTemplates: store });

    /** Every template, built-in and custom, with its current fields and state. */
    function allTemplates() {
        const store = readTemplateStore();
        const out = SECTION_TEMPLATES.map((t) => {
            const edited = Array.isArray(store.edited[t.name]);
            return { name: t.name, fields: edited ? store.edited[t.name] : t.fields, builtin: true, edited, hidden: store.hidden.some((h) => sameName(h, t.name)) };
        });
        for (const t of store.custom) {
            out.push({ name: t.name, fields: t.fields, builtin: false, edited: false, hidden: store.hidden.some((h) => sameName(h, t.name)) });
        }
        return out;
    }

    /** Save a structured section's title + field labels as a template (or update the one with that name). */
    function saveSectionAsTemplate(section) {
        const name = (section.title ?? '').trim();
        const labels = cleanLabels((section.fields ?? []).map((f) => f.label));
        if (!name) { globalThis.toastr?.warning?.('Give the section a title first — that becomes the template’s name.', 'Persona Library'); return false; }
        if (!labels.length) { globalThis.toastr?.warning?.('Add at least one field label first.', 'Persona Library'); return false; }
        const store = readTemplateStore();
        const builtin = SECTION_TEMPLATES.find((t) => sameName(t.name, name));
        let verb = 'Saved as template';
        if (builtin) {
            if (JSON.stringify(labels) === JSON.stringify(builtin.fields)) delete store.edited[builtin.name];
            else store.edited[builtin.name] = labels;
            store.hidden = store.hidden.filter((h) => !sameName(h, builtin.name));
            verb = 'Template updated:';
        } else {
            const i = store.custom.findIndex((t) => sameName(t.name, name));
            if (i >= 0) { store.custom[i] = { name: store.custom[i].name, fields: labels }; verb = 'Template updated:'; }
            else store.custom.push({ name, fields: labels });
            store.hidden = store.hidden.filter((h) => !sameName(h, name));
        }
        writeTemplateStore(store);
        globalThis.toastr?.success?.(`${verb} \u201c${builtin?.name ?? name}\u201d.`, 'Persona Library');
        return true;
    }

    function setTemplateHidden(name, hidden) {
        const store = readTemplateStore();
        store.hidden = store.hidden.filter((h) => !sameName(h, name));
        if (hidden) store.hidden.push(name);
        writeTemplateStore(store);
    }
    function resetBuiltinTemplate(name) {
        const store = readTemplateStore();
        delete store.edited[name];
        writeTemplateStore(store);
    }
    function deleteCustomTemplate(name) {
        const store = readTemplateStore();
        store.custom = store.custom.filter((t) => !sameName(t.name, name));
        store.hidden = store.hidden.filter((h) => !sameName(h, name));
        writeTemplateStore(store);
    }

    /**
     * Editable list of extra labeled blocks (Outfit, Scene Details, Lore,
     * Rules, Mood, or a custom title) layered on top of the core
     * description. Mutates `draft.sections` directly via closures so the
     * Save handler always reads the latest state without needing its own
     * re-render wiring.
     */
    function buildSectionsEditor(draft, canEdit) {
        const wrap = el('div', { class: 'pl-sections' });
        const list = el('div', { class: 'pl-sections-list' });
        let dragIndex = null;
        let refreshTemplateSelect = null; // set below, once the dropdown exists

        function renderList() {
            list.replaceChildren();
            draft.sections.forEach((s, i) => {
                const handle = el('span', {
                    class: 'pl-drag-handle', title: 'Drag to reorder',
                    draggable: canEdit ? 'true' : 'false',
                    ondragstart: (e) => {
                        dragIndex = i;
                        e.dataTransfer.effectAllowed = 'move';
                        try { e.dataTransfer.setData('text/plain', String(i)); } catch { /* ignore */ }
                        handle.closest('.pl-section-row')?.classList.add('pl-dragging');
                    },
                    ondragend: () => {
                        dragIndex = null;
                        list.querySelectorAll('.pl-dragging').forEach((n) => n.classList.remove('pl-dragging'));
                    },
                }, [el('i', { class: 'fa-solid fa-grip-vertical' })]);

                let contentInput = null; // the freeform body's textarea, once built below
                const titleInput = el('input', {
                    class: 'pl-section-title', type: 'text', value: s.title,
                    oninput: () => {
                        dirty = true;
                        s.title = titleInput.value;
                        if (textFocusTarget?.compactEl === contentInput) textFocusTitle.textContent = titleInput.value || 'Section';
                    },
                });
                const enabledBox = el('input', {
                    type: 'checkbox', title: 'Include in prompt',
                    oninput: () => { dirty = true; s.enabled = enabledBox.checked; },
                });
                enabledBox.checked = s.enabled !== false;
                const removeBtn = el('button', {
                    class: 'pl-icon-btn pl-icon-danger', type: 'button', title: 'Remove section',
                    onclick: () => { dirty = true; draft.sections.splice(i, 1); renderList(); },
                }, [el('i', { class: 'fa-solid fa-xmark' })]);

                // Structured (character-sheet) sections get a tiny bookmark: save this
                // title + field set as a template, or update the template of that name.
                const saveTplBtn = canEdit && Array.isArray(s.fields) ? el('button', {
                    class: 'pl-icon-btn pl-section-tpl-btn', type: 'button',
                    title: 'Save as template (reusable in every persona)',
                    onclick: () => { if (saveSectionAsTemplate(s)) refreshTemplateSelect?.(); },
                }, [el('i', { class: 'fa-regular fa-bookmark' })]) : null;
                const head = el('div', { class: 'pl-section-row-head' }, [handle, enabledBox, titleInput, saveTplBtn, removeBtn]);

                let body;
                if (Array.isArray(s.fields)) {
                    // -- structured, field-per-line body (character-sheet category) --
                    const fieldsWrap = el('div', { class: 'pl-section-fields' });
                    const renderFields = () => {
                        fieldsWrap.replaceChildren(...s.fields.map((f, fi) => {
                            const labelInput = el('input', {
                                class: 'pl-field-label', type: 'text', value: f.label,
                                oninput: () => {
                                    dirty = true;
                                    f.label = labelInput.value;
                                    s.content = fieldsToContent(s.fields);
                                    if (textFocusTarget?.compactEl === valueInput) {
                                        textFocusTitle.textContent = `${titleInput.value || s.title || 'Section'} \u2014 ${labelInput.value || 'Field'}`;
                                    }
                                },
                            });
                            const valueInput = el('input', {
                                class: 'pl-field-value', type: 'text', value: f.value ?? '', placeholder: '\u2014',
                                oninput: () => { dirty = true; f.value = valueInput.value; s.content = fieldsToContent(s.fields); },
                            });
                            const expandFieldBtn = el('button', {
                                class: 'pl-icon-btn pl-field-expand', type: 'button', title: 'Expand to full screen',
                                onclick: () => openTextFocus({
                                    value: f.value,
                                    setValue: (v) => { f.value = v; s.content = fieldsToContent(s.fields); },
                                    compactEl: valueInput,
                                    title: `${titleInput.value || s.title || 'Section'} \u2014 ${labelInput.value || f.label || 'Field'}`,
                                    editable: canEdit,
                                }),
                            }, [el('i', { class: 'fa-solid fa-up-right-and-down-left-from-center' })]);
                            const removeFieldBtn = el('button', {
                                class: 'pl-icon-btn pl-icon-danger pl-field-remove', type: 'button', title: 'Remove field',
                                onclick: () => { dirty = true; s.fields.splice(fi, 1); s.content = fieldsToContent(s.fields); renderFields(); },
                            }, [el('i', { class: 'fa-solid fa-xmark' })]);
                            if (!canEdit) { for (const f2 of [labelInput, valueInput]) f2.setAttribute('disabled', ''); removeFieldBtn.setAttribute('disabled', ''); }
                            return el('div', { class: 'pl-field-row' }, [labelInput, valueInput, expandFieldBtn, removeFieldBtn]);
                        }));
                    };
                    renderFields();
                    const addFieldBtn = el('button', {
                        class: 'pl-btn pl-add-field', type: 'button', text: '+ Field',
                        onclick: () => { dirty = true; s.fields.push({ label: '', value: '' }); renderFields(); },
                    });
                    body = el('div', {}, [fieldsWrap, canEdit ? addFieldBtn : null].filter(Boolean));
                    if (!canEdit) addFieldBtn?.setAttribute?.('disabled', '');
                } else {
                    // -- plain freeform textarea body --
                    contentInput = el('textarea', {
                        class: 'pl-section-content', spellcheck: 'true', placeholder: 'Details for this section\u2026',
                        oninput: () => { dirty = true; s.content = contentInput.value; },
                    });
                    contentInput.value = s.content ?? '';
                    if (!canEdit) contentInput.setAttribute('disabled', '');
                    const expandBtn = el('button', {
                        class: 'pl-section-expand-btn', type: 'button', title: 'Expand to full screen',
                        onclick: () => openTextFocus({
                            value: s.content,
                            setValue: (v) => { s.content = v; },
                            compactEl: contentInput,
                            title: titleInput.value || s.title || 'Section',
                            editable: canEdit,
                        }),
                    }, [el('i', { class: 'fa-solid fa-up-right-and-down-left-from-center' })]);
                    body = el('div', { class: 'pl-section-content-wrap' }, [contentInput, expandBtn]);
                }

                if (!canEdit) {
                    for (const f of [titleInput, enabledBox]) f.setAttribute('disabled', '');
                    removeBtn.setAttribute('disabled', '');
                }

                list.append(el('div', {
                    class: 'pl-section-row',
                    ondragover: (e) => {
                        if (dragIndex === null || !canEdit) return;
                        e.preventDefault();
                        e.dataTransfer.dropEffect = 'move';
                    },
                    ondrop: (e) => {
                        e.preventDefault();
                        if (dragIndex === null || dragIndex === i) return;
                        const [moved] = draft.sections.splice(dragIndex, 1);
                        draft.sections.splice(dragIndex < i ? i - 1 : i, 0, moved);
                        dragIndex = null;
                        dirty = true;
                        renderList();
                    },
                }, [head, body]));
            });
        }
        renderList();

        const addBtn = el('button', {
            class: 'pl-btn', type: 'button', text: '+ Add custom section',
            onclick: () => {
                dirty = true;
                draft.sections.push({ title: 'Custom', content: '', enabled: true });
                renderList();
            },
        });

        const templateSelect = el('select', { class: 'pl-select' });
        const addTemplateBtn = el('button', {
            class: 'pl-btn', type: 'button', text: '+ Add category',
            onclick: () => {
                const tpl = allTemplates().find((t) => !t.hidden && t.name === templateSelect.value);
                if (!tpl) return;
                dirty = true;
                const fields = tpl.fields.map((label) => ({ label, value: '' }));
                draft.sections.push({ title: tpl.name, enabled: true, fields, content: fieldsToContent(fields) });
                renderList();
            },
        });
        // Rebuild the dropdown from the live template list (hidden ones left out).
        refreshTemplateSelect = () => {
            const keep = templateSelect.value;
            const visible = allTemplates().filter((t) => !t.hidden);
            templateSelect.replaceChildren(...visible.map((t) => el('option', { value: t.name, text: t.name })));
            if (visible.some((t) => t.name === keep)) templateSelect.value = keep;
            templateSelect.disabled = addTemplateBtn.disabled = !visible.length;
            if (!visible.length) templateSelect.append(el('option', { text: 'No templates shown' }));
        };

        // The manager is deliberately just a small \u22ef beside the dropdown: a menu
        // where a tick shows/hides a template, with reset (edited built-ins) and
        // delete (your own) below it. Reopens after each click so several can be done at once.
        function openTemplateManager(anchor) {
            const r = anchor.getBoundingClientRect();
            const all = allTemplates();
            const items = [{ title: 'Templates \u2014 tick to show in the list' }];
            const again = () => { refreshTemplateSelect(); openTemplateManager(anchor); };
            for (const t of all) {
                items.push({ icon: 'fa-table-list', label: t.name + (t.edited ? ' (edited)' : ''), checked: !t.hidden, onClick: () => { setTemplateHidden(t.name, !t.hidden); again(); } });
            }
            const edited = all.filter((t) => t.edited);
            const custom = all.filter((t) => !t.builtin);
            if (edited.length || custom.length) items.push('sep');
            for (const t of edited) items.push({ icon: 'fa-rotate-left', label: `Reset \u201c${t.name}\u201d to default`, onClick: () => { resetBuiltinTemplate(t.name); again(); } });
            for (const t of custom) items.push({ icon: 'fa-trash', label: `Delete \u201c${t.name}\u201d`, danger: true, onClick: () => { deleteCustomTemplate(t.name); again(); } });
            ctxMenu.open({ x: r.left, y: r.bottom + 4, anchorRect: r, items });
        }
        const manageTemplatesBtn = el('button', {
            class: 'pl-icon-btn pl-tpl-manage-btn', type: 'button', title: 'Manage category templates',
            'aria-haspopup': 'menu',
            onclick: (e) => { e.stopPropagation(); openTemplateManager(manageTemplatesBtn); },
        }, [el('i', { class: 'fa-solid fa-ellipsis' })]);
        refreshTemplateSelect();

                const addRow = el('div', { class: 'pl-sections-add' }, canEdit ? [addBtn] : []);
        const addTemplateRow = el('div', { class: 'pl-sections-add' }, canEdit ? [templateSelect, addTemplateBtn, manageTemplatesBtn] : []);

        wrap.append(
            el('h4', { text: 'Additional Sections' }),
            el('div', { class: 'pl-sections-hint', text: 'Pick a character-sheet category for labeled fields, or add a custom freeform block for anything that reads better as a paragraph.' }),
            list,
            el('div', { class: 'pl-sections-hint', text: 'Ready-made character-sheet category:' }),
            addTemplateRow,
            addRow,
        );
        return wrap;
    }

    /**
     * One node's binding control: how it decides whether it's "on" right
     * now. Manual is a plain checkbox (today's Additional Sections
     * behavior); Default is an always-on fallback; Character/Chat bind to a
     * specific one via adapter-resolved stable ids (never raw names); Match
     * tests the current character's Description field.
     */
    function buildBindingEditor(node, canEdit, markDirty) {
        const wrap = el('div', { class: 'pl-binding' });
        const modeSelect = el('select', { class: 'pl-select pl-binding-mode' }, [
            el('option', { value: 'manual', text: 'Manual toggle' }),
            el('option', { value: 'bound', text: 'Automatic Bindings' }),
        ]);
        modeSelect.value = node.mode ?? 'manual';

        const body = el('div', { class: 'pl-binding-body' });

        function renderBody() {
            function stripExt(filename) {
                if (typeof filename !== "string" || filename.length === 0) { return null; }
                const i = filename.lastIndexOf(".");
                return i >= 0 ? filename.slice(0, i) : filename;
            }

            body.replaceChildren();
            const mode = node.mode ?? 'manual';

            if (mode === 'manual') {
                const chk = el('input', {
                    type: 'checkbox',
                    oninput: () => { markDirty(); node.enabled = chk.checked; },
                });
                chk.checked = node.enabled !== false;
                if (!canEdit) chk.setAttribute('disabled', '');
                body.append(el('label', { class: 'pl-binding-manual' }, [chk, document.createTextNode(' Enabled')]));
                return;
            }

            if (mode === 'bound'){

                node.binding.character.refs = node.binding?.character?.refs ?? [];
                node.binding.chat.refs = node.binding?.chat?.refs ?? [];
                node.binding.match.pattern = node.binding?.match?.pattern ?? '';

                const refsList = el('div', { class: 'pl-binding-refs' });

                const renderRefs = () => {
                    const allRefs = [...new Map([...node.binding?.character?.refs, ...node.binding.chat.refs].map(r => [r.uuid, r])).values()];
                    refsList.replaceChildren(...allRefs.map((r, i) => el('span', {class:'pl-binding-ref'}, [
                        el('span', { class: 'pl-binding-ref-label', text: r.label || '(unnamed)' }),
                        el('button', {
                            class: 'pl-binding-ref-remove', type: 'button', title: 'Unbind',
                            onclick: () => {
                                markDirty();
                                const uuid = r.uuid;
                                const charIdx = node.binding.character.refs.findIndex(x => x.uuid === uuid);
                                if (charIdx !== -1) node.binding.character.refs.splice(charIdx, 1);
                                const chatIdx = node.binding.chat.refs.findIndex(x => x.uuid === uuid);
                                if (chatIdx !== -1) node.binding.chat.refs.splice(chatIdx, 1);
                                renderRefs();
                            },
                        }, [el('i', { class: 'fa-solid fa-xmark' })]),
                    ])))
                }
                renderRefs()

                const charBindBtn = el('button', {
                    class: 'pl-btn', type: 'button',
                    text: '+ Bind current character',
                    title: 'Activate whenever the current character is the one currently loaded.',
                    onclick: async () => {
                        try {
                                const info = adapter.getCurrentCharacterInfo?.();
                                if (!info) { globalThis.toastr?.warning?.('No character is currently open.', 'Persona Library'); return; }
                                const uuid = await adapter.ensureCharacterBindingId?.();
                                const key = uuid ?? `avatar:${info.avatar}`;
                                if (!node.binding.character.refs.some((r) => r.uuid === key)) {
                                    markDirty();
                                    node.binding.character.refs.push({ uuid: key, label: "Char: " + (stripExt(info.avatar) ?? ((stripExt(info.name)  ?? " Card Name Error")+"*"))});
                                }
                        } catch (e) {
                            console.error('[PersonaLibrary]', e);
                            globalThis.toastr?.error?.('Could not bind.', 'Persona Library');
                        }
                        renderRefs();
                    },
                });
                if (!canEdit)  { charBindBtn.setAttribute('disabled', '');}

                const chatBindBtn = el('button', {
                    class: 'pl-btn', type: 'button',
                    text: '+ Bind current chat',
                    title: 'Activate whenever the current chat is the one currently loaded.',
                    onclick: async () => {
                        try {
                            const uuid = await adapter.ensureChatBindingId?.();
                            if (!uuid) { globalThis.toastr?.warning?.('No chat is currently open.', 'Persona Library'); return; }
                            const label = adapter.getCurrentChatLabel?.() ?? 'Current chat';
                            if (!node.binding.chat.refs.some((r) => r.uuid === uuid)) {
                                markDirty();
                                node.binding.chat.refs.push({ uuid, label });
                            }
                        } catch (e) {
                            console.error('[PersonaLibrary]', e);
                            globalThis.toastr?.error?.('Could not bind.', 'Persona Library');
                        }
                        renderRefs();
                    },
                });
                if (!canEdit)  { chatBindBtn.setAttribute('disabled', '');}
                const matchInput = el('input', {
                    type: 'text', class: 'pl-binding-match', placeholder: 'text or /regex/flags…',
                    value: node.binding.match.pattern ?? '',
                    oninput: () => { markDirty(); node.binding.match.pattern = matchInput.value; },
                });
                if (!canEdit) matchInput.setAttribute('disabled', '');

                body.append(refsList, canEdit ? charBindBtn : null, canEdit ? chatBindBtn : null, matchInput, el('div', { class: 'pl-sections-hint', text: 'Activate when text in card description matches this pattern.' }));
            }
            return;
        }

        modeSelect.onchange = () => {
            markDirty();
            node.mode = modeSelect.value;
            renderBody();
        };
        if (!canEdit) modeSelect.setAttribute('disabled', '');
        renderBody();

        wrap.append(modeSelect, body);
        return wrap;
    }

    /**
     * Variants editor: items and one level of groups, each independently
     * bound to default / manual / a specific character / a specific chat /
     * a match rule against the current character. NEVER baked into the
     * persona's stored description (unlike Additional Sections above) —
     * composed fresh only at generation time and reverted right after, so
     * switching characters/chats can never corrupt the saved persona.
     */
    function buildVariantsEditor(draft, canEdit) {
        const wrap = el('div', { class: 'pl-variants' });
        const list = el('div', { class: 'pl-variants-list' });
        const markDirty = () => { dirty = true; };

        // Filters the list below by title/content match. Purely a display
        // filter — it never touches draft.nodes, so it can't affect what
        // gets saved or composed. A group is shown if its own title
        // matches OR any child matches. Most useful once a persona has a
        // lot of variants; harmless and stays out of the way otherwise.
        let searchQuery = '';
        // Word-boundary matching, not plain substring — "Ear" as a search
        // should match "Ear", "Ears", "Earring", but NOT "Beard" or "Year"
        // just because they happen to contain the letters e-a-r somewhere
        // in the middle. Only anchors the START of the match (not the
        // end), so prefix matches within a longer word (Ear -> Earring)
        // still work; it just won't match mid-word.
        // Deliberately NOT using regex \b here — \b is ASCII-only in JS, so
        // it silently misclassifies accented/non-Latin letters (é, ü, 日,
        // etc.) as "not word characters", which breaks this exact same
        // fix for anything but plain ASCII titles. Using a Unicode-aware
        // negative lookbehind (\p{L}/\p{N}) instead so accented and
        // non-Latin persona/variant names get the same correct behavior.
        // And boundary anchoring only makes sense when the query ITSELF
        // starts with a letter/number/underscore — a query starting with
        // punctuation (e.g. "(test)") has no valid boundary position
        // directly before it and would silently never match if forced on;
        // falls back to plain substring matching for those instead, which
        // is the sensible behavior there anyway.
        function wordBoundaryMatch(haystack, query) {
            if (!query) return true;
            const escaped = query.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
            const startsWithWordChar = /^[\p{L}\p{N}_]/u.test(query);
            const pattern = startsWithWordChar ? `(?<![\\p{L}\\p{N}_])${escaped}` : escaped;
            return new RegExp(pattern, 'iu').test(haystack);
        }
        function nodeMatches(n) {
            if (!searchQuery) return true;
            if (wordBoundaryMatch(n.title ?? '', searchQuery)) return true;
            if (n.kind === 'item' && wordBoundaryMatch(n.content ?? '', searchQuery)) return true;
            if (n.kind === 'group') return (n.children ?? []).some((c) => nodeMatches(c));
            return false;
        }
        const searchInput = el('input', {
            type: 'search', class: 'pl-variants-search', placeholder: 'Filter variants by title or text\u2026',
            oninput: () => { searchQuery = searchInput.value.trim().toLowerCase(); renderList(); },
        });

        // Token counts — a best-effort estimate (see adapter.getTokenCount,
        // which uses whatever tokenizer is actually configured) of what
        // each block costs, plus a running total across EVERYTHING
        // configured here regardless of whether it's currently active —
        // "if all of this were switched on, here's the ceiling." What's
        // actually being spent right now, for just the variants currently
        // matching, is shown separately on the Preview tab instead — this
        // total is about inventory, that one's about live cost.
        const totalTokensEl = el('span', { class: 'pl-variants-token-total' });
        let tokenRunId = 0;
        async function refreshTokenCounts() {
            if (!adapter.getTokenCount) return;
            const myRun = ++tokenRunId;
            const badges = Array.from(list.querySelectorAll('[data-pl-token-badge]'));
            let total = 0;
            for (const badge of badges) {
                const text = badge.getAttribute('data-pl-token-text') ?? '';
                const count = text.trim() ? await adapter.getTokenCount(text) : 0;
                if (myRun !== tokenRunId) return; // superseded by a newer render/edit — drop stale results
                total += count;
                badge.textContent = text.trim() ? `~${count} tok` : '';
            }
            if (myRun !== tokenRunId) return;
            totalTokensEl.textContent = total ? `~${total} tokens total across everything configured here` : '';
        }
        let tokenDebounceTimer = null;
        const scheduleTokenRefresh = () => { clearTimeout(tokenDebounceTimer); tokenDebounceTimer = setTimeout(refreshTokenCounts, 400); };

        function renderItemRow(node, container, onRemove, onDuplicate) {
            const titleInput = el('input', {
                class: 'pl-section-title', type: 'text', value: node.title,
                oninput: () => { markDirty(); node.title = titleInput.value; },
            });
            const badge = el('span', {
                class: 'pl-token-badge', 'data-pl-token-badge': '', 'data-pl-token-text': node.content ?? '',
            });
            const dupBtn = el('button', {
                class: 'pl-icon-btn', type: 'button', title: 'Duplicate', onclick: onDuplicate,
            }, [el('i', { class: 'fa-solid fa-copy' })]);
            const removeBtn = el('button', {
                class: 'pl-icon-btn pl-icon-danger', type: 'button', title: 'Remove variant', onclick: onRemove,
            }, [el('i', { class: 'fa-solid fa-xmark' })]);
            const contentInput = el('textarea', {
                class: 'pl-section-content', spellcheck: 'true', placeholder: 'What gets added when this is active\u2026',
                oninput: () => {
                    markDirty();
                    node.content = contentInput.value;
                    badge.setAttribute('data-pl-token-text', contentInput.value);
                    scheduleTokenRefresh();
                },
            });
            contentInput.value = node.content ?? '';
            const binding = buildBindingEditor(node, canEdit, markDirty);
            if (!canEdit) {
                titleInput.setAttribute('disabled', '');
                dupBtn.setAttribute('disabled', '');
                removeBtn.setAttribute('disabled', '');
                contentInput.setAttribute('disabled', '');
            }
            container.append(el('div', { class: 'pl-variant-item' }, [
                el('div', { class: 'pl-section-row-head' }, [titleInput, badge, dupBtn, removeBtn]),
                contentInput,
                binding,
            ]));
        }

        function renderList() {
            list.replaceChildren();
            draft.nodes.forEach((n, i) => {
                if (searchQuery && !nodeMatches(n)) return;
                if (n.kind === 'group') {
                    const isCollapsed = !!n.collapsed;
                    // While actively searching, always show a matching
                    // group's contents regardless of its stored collapsed
                    // state — otherwise a search result could be hidden
                    // behind a collapsed group with no way to see what
                    // actually matched. Clearing the search reverts to
                    // whatever the group's own stored state was.
                    const effectivelyCollapsed = isCollapsed && !searchQuery;
                    const titleInput = el('input', {
                        class: 'pl-section-title', type: 'text', value: n.title,
                        oninput: () => { markDirty(); n.title = titleInput.value; },
                    });
                    const collapseBtn = el('button', {
                        class: 'pl-icon-btn pl-variant-group-collapse-btn', type: 'button',
                        title: isCollapsed ? 'Expand group' : 'Collapse group',
                        'aria-expanded': isCollapsed ? 'false' : 'true',
                        onclick: () => {
                            // Saved like any other field (title, binding,
                            // etc.) — click Save to persist across
                            // reopening the editor or reloading the page.
                            // Never read by isNodeActive/composeVariants;
                            // purely display state.
                            n.collapsed = !isCollapsed;
                            markDirty();
                            renderList();
                        },
                    }, [el('i', { class: `fa-solid ${isCollapsed ? 'fa-chevron-right' : 'fa-chevron-down'}` })]);
                    const dupBtn = el('button', {
                        class: 'pl-icon-btn', type: 'button', title: 'Duplicate group (and everything in it)',
                        onclick: () => { markDirty(); draft.nodes.splice(i + 1, 0, cloneNode(n)); renderList(); },
                    }, [el('i', { class: 'fa-solid fa-copy' })]);
                    const removeBtn = el('button', {
                        class: 'pl-icon-btn pl-icon-danger', type: 'button', title: 'Remove group',
                        onclick: () => { markDirty(); draft.nodes.splice(i, 1); renderList(); },
                    }, [el('i', { class: 'fa-solid fa-xmark' })]);
                    const binding = buildBindingEditor(n, canEdit, markDirty);
                    const childrenWrap = el('div', { class: 'pl-variant-group-children' });
                    const renderChildren = () => {
                        childrenWrap.replaceChildren();
                        (n.children ?? []).forEach((child, ci) => {
                            if (searchQuery && !nodeMatches(child) && !wordBoundaryMatch(n.title ?? '', searchQuery)) return;
                            renderItemRow(
                                child, childrenWrap,
                                () => { markDirty(); n.children.splice(ci, 1); renderChildren(); },
                                () => { markDirty(); n.children.splice(ci + 1, 0, cloneNode(child)); renderChildren(); },
                            );
                        });
                        refreshTokenCounts();
                    };
                    if (!effectivelyCollapsed) renderChildren();
                    const addChildBtn = el('button', {
                        class: 'pl-btn', type: 'button', text: '+ Item in group',
                        onclick: () => { markDirty(); n.children = n.children ?? []; n.children.push(newItem('New item')); renderChildren(); },
                    });
                    if (!canEdit) { titleInput.setAttribute('disabled', ''); dupBtn.setAttribute('disabled', ''); removeBtn.setAttribute('disabled', ''); addChildBtn.setAttribute('disabled', ''); }
                    const childCount = (n.children ?? []).length;
                    list.append(el('div', { class: `pl-variant-group${effectivelyCollapsed ? ' pl-variant-group-collapsed' : ''}` }, [
                        el('div', { class: 'pl-section-row-head' }, [
                            collapseBtn,
                            el('i', { class: 'fa-solid fa-folder' }),
                            titleInput,
                            effectivelyCollapsed ? el('span', { class: 'pl-variant-group-count', text: `${childCount} item${childCount === 1 ? '' : 's'}` }) : null,
                            dupBtn,
                            removeBtn,
                        ].filter(Boolean)),
                        effectivelyCollapsed ? null : binding,
                        effectivelyCollapsed ? null : childrenWrap,
                        effectivelyCollapsed ? null : (canEdit ? addChildBtn : null),
                    ].filter(Boolean)));
                } else {
                    renderItemRow(
                        n, list,
                        () => { markDirty(); draft.nodes.splice(i, 1); renderList(); },
                        () => { markDirty(); draft.nodes.splice(i + 1, 0, cloneNode(n)); renderList(); },
                    );
                }
            });
            refreshTokenCounts();
        }
        renderList();

        const addItemBtn = el('button', {
            class: 'pl-btn', type: 'button', text: '+ Item',
            onclick: () => { markDirty(); draft.nodes.push(newItem('New variant')); renderList(); },
        });
        const addGroupBtn = el('button', {
            class: 'pl-btn', type: 'button', text: '+ Group',
            onclick: () => { markDirty(); draft.nodes.push(newGroup('New group')); renderList(); },
        });

        const joinerInput = el('input', {
            type: 'text', class: 'pl-variants-joiner', value: (draft.joiner.replace(/\\/g, '\\\\').replace(/\n/g, '\\n').replace(/\t/g, '\\t')) ?? '\n\n',
            oninput: () => { markDirty(); draft.joiner = joinerInput.value.replace(/\\n/g, '\n').replace(/\\t/g, '\t').replace(/\\\\/g, '\\') },
        });
        const wrapperToggle = el('input', {
            type: 'checkbox',
            oninput: () => { markDirty(); draft.wrapper.enabled = wrapperToggle.checked; },
        });
        wrapperToggle.checked = !!draft.wrapper?.enabled;
        const wrapperTemplate = el('textarea', {
            class: 'pl-variants-wrapper-template', spellcheck: 'false',
            oninput: () => { markDirty(); draft.wrapper.template = wrapperTemplate.value; },
        });
        wrapperTemplate.value = draft.wrapper?.template ?? '<system>{{PROMPT}}</system>';

        if (!canEdit) {
            for (const inp of [addItemBtn, addGroupBtn, joinerInput, wrapperToggle, wrapperTemplate, searchInput]) inp.setAttribute('disabled', '');
        }

        wrap.append(
            el('h4', { text: 'Variants' }),
            el('div', {
                class: 'pl-sections-hint',
                text: 'Blocks that only apply for generation \u2014 unlike Additional Sections above, these are never written into the persona\u2019s saved description. Bind an item or group to a specific character or chat, or leave it manual.',
            }),
            searchInput,
            list,
            el('div', { class: 'pl-sections-add' }, canEdit ? [addItemBtn, addGroupBtn] : []),
            totalTokensEl,
            el('div', { class: 'pl-variants-settings' }, [
                el('div', { class: 'pl-field' }, [el('label', { text: 'Joiner between active blocks' }), joinerInput]),
                el('label', { class: 'pl-variants-wrapper-toggle' }, [wrapperToggle, document.createTextNode(' Wrap the final composed result in a template')]),
                wrapperTemplate,
                el('div', { class: 'pl-sections-hint', text: 'Only used if the toggle above is on. Must contain {{PROMPT}} \u2014 that\u2019s where the composed text (core + sections + active variants) gets inserted.' }),
            ]),
        );
        return wrap;
    }

    // -- Persona image gallery ------------------------------------------
    // One action at a time across the whole UI (tiles AND the « » hero
    // buttons), so rapid clicks can never overlap two avatar writes.
    let galleryBusy = false;

    /**
     * @param {() => Promise<any>} fn
     * @param {{ ok?: string, fail?: string, changesAvatar?: boolean }} opts
     * changesAvatar: the action rewrites the persona's portrait, which
     * re-renders the detail view — refuse while there are unsaved edits so
     * they can't be silently wiped by that re-render.
     */
    async function galleryAction(fn, { ok, fail = 'Gallery action failed.', changesAvatar = false } = {}) {
        if (galleryBusy) return false;
        if (changesAvatar && dirty) {
            globalThis.toastr?.warning?.('You have unsaved edits \u2014 save them (Edit tab) before changing the image.', 'Persona Library');
            return false;
        }
        galleryBusy = true;
        let success = false;
        try {
            await fn();
            success = true;
            if (ok) globalThis.toastr?.success?.(ok, 'Persona Library');
        } catch (e) {
            console.error('[PersonaLibrary] gallery', e);
            globalThis.toastr?.error?.(`${fail} ${e?.message ?? ''}`.trim(), 'Persona Library');
        } finally {
            galleryBusy = false;
        }
        return success;
    }

    /**
     * Per-image bindings editor: characters and chats this image should be
     * used for, plus the optional "default image" flag. Edits a local copy
     * and only writes on Save.
     */
    function openImageBindingEditor(p, im, g) {
        const draft = {
            characters: (im.bindings?.characters ?? []).map((r) => ({ ...r })),
            chats: (im.bindings?.chats ?? []).map((r) => ({ ...r })),
        };
        const wasDefault = g.defaultKey === im.key;
        const defaultChk = el('input', { type: 'checkbox', checked: wasDefault });
        const refsList = el('div', { class: 'pl-binding-refs' });
        const renderRefs = () => {
            const chips = [
                ...draft.characters.map((r) => ({ r, list: draft.characters, icon: 'fa-user' })),
                ...draft.chats.map((r) => ({ r, list: draft.chats, icon: 'fa-message' })),
            ];
            refsList.replaceChildren(...(chips.length ? chips.map(({ r, list, icon }) => el('span', { class: 'pl-binding-ref' }, [
                el('i', { class: `fa-solid ${icon}` }),
                el('span', { class: 'pl-binding-ref-label', text: r.label || '(unnamed)' }),
                el('button', {
                    class: 'pl-binding-ref-remove', type: 'button', title: 'Unbind',
                    onclick: () => { list.splice(list.indexOf(r), 1); renderRefs(); },
                }, [el('i', { class: 'fa-solid fa-xmark' })]),
            ])) : [el('div', { class: 'pl-sections-hint', text: 'Not bound to anything yet.' })]));
        };
        renderRefs();

        const bindChar = el('button', {
            class: 'pl-btn', type: 'button', text: '+ Bind current character',
            title: 'Use this image whenever the character currently open is the one you are chatting with.',
            onclick: async () => {
                try {
                    const info = adapter.getCurrentCharacterInfo?.();
                    if (!info) { globalThis.toastr?.warning?.('No character is currently open.', 'Persona Library'); return; }
                    const uuid = await adapter.ensureCharacterBindingId?.();
                    const key = uuid ?? `avatar:${info.avatar}`;
                    if (!draft.characters.some((r) => r.uuid === key)) {
                        draft.characters.push({ uuid: key, label: 'Char: ' + (stripExt(info.avatar) ?? ((stripExt(info.name) ?? ' Card Name Error') + '*')) });
                    }
                } catch (e) {
                    console.error('[PersonaLibrary]', e);
                    globalThis.toastr?.error?.('Could not bind.', 'Persona Library');
                }
                renderRefs();
            },
        });
        const bindChat = el('button', {
            class: 'pl-btn', type: 'button', text: '+ Bind current chat',
            title: 'Use this image only in the chat that is currently open.',
            onclick: async () => {
                try {
                    const uuid = await adapter.ensureChatBindingId?.();
                    if (!uuid) { globalThis.toastr?.warning?.('No chat is currently open.', 'Persona Library'); return; }
                    if (!draft.chats.some((r) => r.uuid === uuid)) draft.chats.push({ uuid, label: adapter.getCurrentChatLabel?.() ?? 'Current chat' });
                } catch (e) {
                    console.error('[PersonaLibrary]', e);
                    globalThis.toastr?.error?.('Could not bind.', 'Persona Library');
                }
                renderRefs();
            },
        });

        const saveBtn = el('button', { class: 'pl-btn pl-primary', type: 'button', text: 'Save' });
        const cancelBtn = el('button', { class: 'pl-btn', type: 'button', text: 'Cancel', onclick: () => closeDialog() });
        saveBtn.onclick = async () => {
            dialogBusy = true;
            saveBtn.disabled = true; cancelBtn.disabled = true;
            const okd = await galleryAction(async () => {
                await adapter.setPersonaImageBindings(p.id, im.key, draft);
                if (defaultChk.checked && !wasDefault) await adapter.setPersonaDefaultImage?.(p.id, im.key);
                else if (!defaultChk.checked && wasDefault) await adapter.setPersonaDefaultImage?.(p.id, null);
            }, { ok: 'Bindings saved.', fail: 'Could not save the bindings.', changesAvatar: true });
            dialogBusy = false;
            if (okd) { closeDialog(); if (!dirty) renderDetail(); }
            else { saveBtn.disabled = false; cancelBtn.disabled = false; }
        };

        openDialog(el('div', { class: 'pl-dialog-modal' }, [
            el('div', { class: 'pl-dialog-title', text: `Bindings \u2014 ${im.name}` }),
            el('div', { class: 'pl-dialog-body' }, [
                el('img', { class: 'pl-dialog-thumb', src: im.url, alt: im.name }),
                el('div', { class: 'pl-sections-hint', text: 'While this persona is active and one of these matches, this image becomes the portrait. A chat binding wins over a character binding.' }),
                refsList,
                el('div', { class: 'pl-dialog-row' }, [bindChar, bindChat]),
                el('label', { class: 'pl-dialog-check' }, [defaultChk, el('span', { text: 'Use as the default image (shown when no binding matches)' })]),
            ]),
            el('div', { class: 'pl-dialog-actions' }, [cancelBtn, saveBtn]),
        ]));
    }

    /**
     * "Gallery" tab: per-persona image set. Click a tile to make it the
     * portrait; drop image files anywhere on the tab to add them; drag a
     * tile's grip to reorder (the « » buttons step through this order).
     * `onCount(n)` keeps the tab's own "Gallery (n)" label in step.
     */
    function buildGalleryView(p, onCount) {
        const wrap = el('div', { class: 'pl-gallery-view' });
        const fileInput = el('input', { type: 'file', accept: 'image/*', multiple: true, style: 'display:none' });
        const addBtn = el('button', { class: 'pl-btn pl-primary', type: 'button', text: '+ Add images' });
        addBtn.onclick = () => fileInput.click();
        const canReorder = typeof adapter.reorderPersonaGalleryImages === 'function';
        const hint = el('div', {
            class: 'pl-sections-hint',
            text: `Click an image to make it this persona’s portrait. Drop image files here to add them${canReorder ? ', and drag a tile’s grip to reorder' : ''}. The « » buttons under the portrait step through this set. Removing an image here never changes or deletes the persona itself.`,
        });
        const canBind = typeof adapter.setPersonaImageBindings === 'function';
        const bindHint = canBind && el('div', {
            class: 'pl-sections-hint',
            text: 'Use the link button on an image to bind it to characters or chats. While this persona is active, the matching image becomes its portrait automatically (chat binding first, then character, then the default image). Bindings belong to this incarnation only.',
        });
        const grid = el('div', { class: 'pl-gal-grid' });
        wrap.append(el('div', { class: 'pl-gal-toolbar' }, [addBtn]), hint, bindHint, grid, fileInput);

        let dragKey = null;
        const clearMarks = () => grid.querySelectorAll('.pl-gal-drop-before, .pl-gal-drop-after, .pl-gal-dragging')
            .forEach((n) => n.classList.remove('pl-gal-drop-before', 'pl-gal-drop-after', 'pl-gal-dragging'));

        function render() {
            const g = adapter.getPersonaGalleryImages(p.id);
            grid.replaceChildren();
            onCount?.(g?.images?.length ?? 0);
            if (!g || !g.images.length) {
                grid.append(el('div', { class: 'pl-details-empty', text: 'No gallery images yet — add some. Your current portrait is saved into the gallery automatically the first time.' }));
                return;
            }
            for (const im of g.images) {
                const isCurrent = im.key === g.currentKey;
                const isDefault = im.key === g.defaultKey;
                const bindCount = (im.bindings?.characters?.length ?? 0) + (im.bindings?.chats?.length ?? 0);
                const img = el('img', { class: 'pl-gal-img', src: im.url, alt: im.name, loading: 'lazy', draggable: 'false', title: isCurrent ? 'Current portrait' : 'Use as portrait' });
                img.addEventListener('error', () => { tile.classList.add('pl-gal-missing'); img.title = 'File missing on the server'; }, { once: true });
                img.addEventListener('click', () => {
                    if (isCurrent) return;
                    galleryAction(() => adapter.setPersonaGalleryCurrent(p.id, im.key), { fail: 'Could not switch the image.', changesAvatar: true })
                        .then((okd) => { if (okd && !dirty) renderDetail(); });
                });
                // `im.url` is the stored ORIGINAL, so the viewer zooms real pixels.
                const zoom = el('button', { class: 'pl-gal-btn', type: 'button', title: 'View full size (zoom)', onclick: (e) => { e.stopPropagation(); openLightbox(im.url, im.name); } },
                    [el('i', { class: 'fa-solid fa-magnifying-glass-plus' })]);
                const bindBtn = canBind && el('button', {
                    class: 'pl-gal-btn', type: 'button', title: 'Bind to characters / chats',
                    onclick: (e) => { e.stopPropagation(); openImageBindingEditor(p, im, g); },
                }, [el('i', { class: 'fa-solid fa-link' })]);
                const del = el('button', {
                    class: 'pl-gal-btn pl-gal-del', type: 'button', title: 'Remove from gallery',
                    onclick: async (e) => {
                        e.stopPropagation();
                        if (galleryBusy) return;
                        const ask = adapter.confirm ?? (async (m) => window.confirm(m));
                        if (!await ask('Remove this image from the gallery? The persona itself is not affected.')) return;
                        await galleryAction(() => adapter.removePersonaGalleryImage(p.id, im.key), { fail: 'Could not remove the image.' });
                        render();
                    },
                }, [el('i', { class: 'fa-solid fa-trash' })]);
                const handle = canReorder && g.images.length > 1 && el('span', {
                    class: 'pl-gal-btn pl-gal-handle', title: 'Drag to reorder', draggable: 'true',
                    ondragstart: (e) => {
                        dragKey = im.key;
                        e.dataTransfer.effectAllowed = 'move';
                        try { e.dataTransfer.setData('text/plain', im.key); } catch { /* ignore */ }
                        try { e.dataTransfer.setDragImage(tile, 24, 24); } catch { /* ignore */ }
                        tile.classList.add('pl-gal-dragging');
                    },
                    ondragend: () => { dragKey = null; clearMarks(); },
                }, [el('i', { class: 'fa-solid fa-grip-vertical' })]);
                const tile = el('div', { class: `pl-gal-tile${isCurrent ? ' pl-gal-current' : ''}` }, [
                    img,
                    isCurrent ? el('span', { class: 'pl-gal-badge', text: 'CURRENT' }) : null,
                    (bindCount || isDefault) ? el('div', { class: 'pl-gal-flags' }, [
                        isDefault ? el('span', { class: 'pl-gal-flag', title: 'Default image \u2014 shown when no binding matches' }, [el('i', { class: 'fa-solid fa-star' })]) : null,
                        bindCount ? el('span', { class: 'pl-gal-flag', title: `${bindCount} binding${bindCount === 1 ? '' : 's'}` }, [el('i', { class: 'fa-solid fa-link' }), document.createTextNode(` ${bindCount}`)]) : null,
                    ].filter(Boolean)) : null,
                    el('div', { class: 'pl-gal-actions' }, [handle, bindBtn, zoom, del].filter(Boolean)),
                ].filter(Boolean));

                const dropSide = (e) => {
                    const r = tile.getBoundingClientRect();
                    return e.clientX > r.left + r.width / 2 ? 'after' : 'before';
                };
                tile.addEventListener('dragover', (e) => {
                    if (!dragKey || dragKey === im.key) return;
                    e.preventDefault();
                    e.dataTransfer.dropEffect = 'move';
                    clearMarks();
                    tile.classList.add(`pl-gal-drop-${dropSide(e)}`);
                });
                tile.addEventListener('drop', (e) => {
                    if (!dragKey || dragKey === im.key) return;
                    e.preventDefault();
                    e.stopPropagation();
                    const moving = dragKey;
                    const side = dropSide(e);
                    dragKey = null;
                    clearMarks();
                    const keys = g.images.map((x) => x.key).filter((k) => k !== moving);
                    keys.splice(keys.indexOf(im.key) + (side === 'after' ? 1 : 0), 0, moving);
                    galleryAction(() => adapter.reorderPersonaGalleryImages(p.id, keys), { fail: 'Could not reorder the images.' })
                        .then(() => render());
                });
                grid.append(tile);
            }
        }

        async function uploadFiles(files) {
            if (!files.length) return;
            addBtn.disabled = true;
            await galleryAction(async () => {
                const r = await adapter.addPersonaGalleryImages(p.id, files);
                if (r?.failed) globalThis.toastr?.warning?.(`${r.failed} image(s) failed to upload.`, 'Persona Library');
            }, { ok: 'Added to gallery.', fail: 'Could not add images.' });
            addBtn.disabled = false;
            render();
        }

        fileInput.onchange = () => {
            const files = Array.from(fileInput.files ?? []);
            fileInput.value = '';
            uploadFiles(files);
        };

        // Drag-and-drop uploads. Only reacts to real files from outside the
        // page, so the tile-reordering drag above (which carries no files)
        // can never be mistaken for an upload.
        const hasFiles = (e) => Array.from(e.dataTransfer?.types ?? []).includes('Files');
        let dragDepth = 0;
        wrap.addEventListener('dragenter', (e) => {
            if (!hasFiles(e)) return;
            e.preventDefault();
            dragDepth++;
            wrap.classList.add('pl-gal-dropping');
        });
        wrap.addEventListener('dragover', (e) => {
            if (!hasFiles(e)) return;
            e.preventDefault();
            e.dataTransfer.dropEffect = 'copy';
        });
        wrap.addEventListener('dragleave', (e) => {
            if (!hasFiles(e)) return;
            dragDepth = Math.max(0, dragDepth - 1);
            if (!dragDepth) wrap.classList.remove('pl-gal-dropping');
        });
        wrap.addEventListener('drop', (e) => {
            if (!hasFiles(e)) return;
            e.preventDefault();
            dragDepth = 0;
            wrap.classList.remove('pl-gal-dropping');
            const all = Array.from(e.dataTransfer.files ?? []);
            const images = all.filter((f) => (f.type || '').startsWith('image/'));
            if (images.length < all.length) globalThis.toastr?.warning?.('Only image files can be added.', 'Persona Library');
            uploadFiles(images);
        });

        render();
        return wrap;
    }

    /**
     * Read-only "Details" tab — mirrors CharLib's own detail modal: a small
     * metadata line, tag chips, then each part of the description (core +
     * enabled sections) as its own labeled block, instead of one raw
     * editable blob.
     */
    function buildDetailsView(p, connections) {
        const wrap = el('div', { class: 'pl-details-view' });

        const createdTs = Number(p.created);
        const createdText = createdTs > 1e12 ? new Date(createdTs).toLocaleDateString() : null;

        const metaBar = el('div', { class: 'pl-details-metabar' }, [
            createdText ? el('span', { text: `Created ${createdText}` }) : null,
            el('span', { class: 'pl-details-id', text: p.id }),
        ].filter(Boolean));

        const sectionsData = adapter.getPersonaSections?.(p.id) ?? { core: p.description ?? '', sections: [] };
        const blocks = [];

        if ((sectionsData.core ?? '').trim()) {
            blocks.push(el('div', { class: 'pl-detail-block' }, [
                el('div', { class: 'pl-detail-block-title' }, [el('i', { class: 'fa-solid fa-feather' }), el('span', { text: 'Core Description' })]),
                el('div', { class: 'pl-detail-block-body', text: sectionsData.core.trim() }),
            ]));
        }
        for (const s of sectionsData.sections ?? []) {
            if (s.enabled === false) continue;
            const content = Array.isArray(s.fields) ? fieldsToContent(s.fields) : (s.content ?? '');
            if (!content.trim()) continue;
            blocks.push(el('div', { class: 'pl-detail-block' }, [
                el('div', { class: 'pl-detail-block-title' }, [el('i', { class: 'fa-solid fa-layer-group' }), el('span', { text: s.title || 'Section' })]),
                el('div', { class: 'pl-detail-block-body', text: content }),
            ]));
        }
        if (!blocks.length) {
            blocks.push(el('div', { class: 'pl-details-empty', text: 'No description yet \u2014 switch to Edit to add one.' }));
        }

        const positionLabel = POSITIONS.find(([v]) => v === (p.position === undefined || p.position === null ? '' : String(p.position)))?.[1] ?? 'Default';
        const roleLabel = ROLES.find(([v]) => v === String(p.role ?? 0))?.[1] ?? 'System';

        const metaRow = el('div', { class: 'pl-meta pl-details-meta' }, [
            el('div', {}, [el('b', { text: 'Injection: ' }), document.createTextNode(positionLabel)]),
            el('div', {}, [el('b', { text: 'Depth / Role: ' }), document.createTextNode(`${p.depth ?? 2} / ${roleLabel}`)]),
            el('div', {}, [el('b', { text: 'Lorebook: ' }), document.createTextNode(p.lorebook || 'none')]),
            el('div', {}, [el('b', { text: 'Connections: ' }), document.createTextNode(connections?.length ? connections.join(', ') : 'none')]),
        ]);

        wrap.append(...[metaBar, ...blocks, metaRow].filter(Boolean));
        return wrap;
    }

    /**
     * Read-only "Details" tab — mirrors CharLib's own detail modal: a small
     * metadata line, tag chips, then each part of the description (core +
     * enabled sections) as its own labeled block, instead of one raw
     * editable blob.
     */
    /**
     * "Preview" tab — shows exactly what composeDescription() produces from
     * the LIVE draft (including unsaved edits), i.e. exactly the text that
     * ends up in the persona's actual injected description. Macros like
     * {{user}}/{{char}} are shown unresolved, same as they're stored — they
     * only get substituted at generation time, not here.
     */
    function buildPreviewView(p, draft, variants, adapter) {
        const wrap = el('div', { class: 'pl-preview-view' });

        const baseComposed = adapter.composeDescription
            ? adapter.composeDescription(draft?.core ?? '', draft?.sections ?? [])
            : (draft?.core ?? '');

        const positionLabel = POSITIONS.find(([v]) => v === (p.position === undefined || p.position === null ? '' : String(p.position)))?.[1] ?? 'Default';
        const roleLabel = ROLES.find(([v]) => v === String(p.role ?? 0))?.[1] ?? 'System';

        let previewMode = 'combined';
        const modeSelect = el('select', { class: 'pl-select' }, [
            el('option', { value: 'default', text: 'Preview as: Default (no character/chat)' }),
            el('option', { value: 'character', text: 'Preview as: This Character' }),
            el('option', { value: 'chat', text: 'Preview as: This Chat' }),
            el('option', { SELECTED: true, value: 'combined', text: 'Preview as: Everything (this chat + this character, combined \u2014 closest to a real generation)' }),
        ]);

        const infoBar = el('div', { class: 'pl-preview-info' });
        const output = el('pre', { class: 'pl-preview-output' });

        function contextFor(mode) {
            const info = adapter.getCurrentCharacterInfo?.();
            const characterBindingId = info?.bindingId ?? (info ? `avatar:${info.avatar}` : null);
            const chatBindingId = adapter.getChatBindingId?.() ?? null;
            const characterDescription = info?.description ?? '';
            if (mode === 'character') {
                return { characterBindingId, chatBindingId: null, characterDescription };
            }
            if (mode === 'chat') {
                return { characterBindingId: null, chatBindingId, characterDescription: '' };
            }
            if (mode === 'combined') {
                // The actual real-generation context: BOTH the open
                // character's binding AND the open chat's binding populated
                // at once, exactly what activeVariantContext() builds in
                // st-adapter.js at real generation time. The 'character'
                // and 'chat' modes above deliberately null out the other
                // field so each binding type can be tested in isolation \u2014
                // this mode instead pools all three (manual, character,
                // chat, default, match) together, same as a real message.
                return { characterBindingId, chatBindingId, characterDescription };
            }
            return { characterBindingId: null, chatBindingId: null, characterDescription: '' };
        }

        const expandBtn = el('button', {
            class: 'pl-btn', type: 'button', title: 'Toggle a larger preview box',
            text: 'Expand',
        });
        expandBtn.onclick = () => {
            const nowExpanded = output.classList.toggle('pl-expanded');
            expandBtn.textContent = nowExpanded ? 'Collapse' : 'Expand';
        };

        function render() {
            const finalText = (adapter.composeVariants ?? composeVariants)(baseComposed, variants, contextFor(previewMode));
            const tokenEl = el('span', { class: 'pl-preview-tokens', text: '' });
            infoBar.replaceChildren(
                el('span', { text: `Injected via: ${positionLabel}` }),
                el('span', { text: `Depth ${p.depth ?? 2} \u2022 Role: ${roleLabel}` }),
                el('span', { text: `${finalText.length.toLocaleString()} characters` }),
                tokenEl,
            );
            output.replaceChildren(document.createTextNode(finalText || '(Nothing yet \u2014 add a core description, an enabled section, or an active variant.)'));
            // Live cost for exactly what's active right now, as opposed to
            // the Edit tab's running total (which counts EVERYTHING
            // configured, active or not) — this number is the real, current
            // spend for whichever "Preview as" mode is selected above.
            if (adapter.getTokenCount && finalText.trim()) {
                const myText = finalText;
                adapter.getTokenCount(myText).then((count) => {
                    if (output.textContent !== myText) return; // stale, a newer render already replaced this
                    tokenEl.textContent = `~${count} tokens (currently active)`;
                });
            }
        }
        modeSelect.onchange = () => { previewMode = modeSelect.value; render(); };
        render();

        const hint = el('div', {
            class: 'pl-sections-hint',
            text: 'This is the exact text that gets folded into the prompt \u2014 core description, enabled sections, and (only while generating, for real) any variants matching the picker above. "Default/Character/Chat" test one binding type in isolation; "Everything" pools all of them together the way a real generation actually would. Macros like {{user}}/{{char}} are resolved later, at generation time, so they show up unresolved here. Drag the bottom-right corner of the box, or use Expand, to see more at once.',
        });

        wrap.append(infoBar, hint, el('div', { class: 'pl-preview-toolbar' }, [modeSelect, expandBtn]), output);

        // --- Per-target previews -------------------------------------
        // The dropdown above only ever answers "what if THIS chat/character
        // (the one currently open) were active" \u2014 useless if a persona has
        // variants bound to several different chats/characters at once,
        // since you can only have one of them open at a time. This section
        // instead enumerates EVERY distinct binding target referenced
        // anywhere in the variant tree and composes a preview for each one
        // directly, without needing that chat/character to be open. Pure
        // read of the draft + composeVariants \u2014 doesn't touch
        // activeVariantContext(), applyVariantPatch, or anything else in
        // the real generation path.
        const manualNodes = [];
        const collectManual = (n) => {
            if (!n) return;
            if (n.kind === 'group') {
                for (const c of n.children ?? []) collectManual(c);
            } else if ((n.mode ?? 'manual') === 'manual') {
                manualNodes.push(n);
            }
        };
        for (const n of variants?.nodes ?? []) collectManual(n);

        if (manualNodes.length) {
            const manualList = el('div', { class: 'pl-preview-target-list' },
                manualNodes.map((n) => el('div', { class: 'pl-preview-target-chip' }, [
                    el('span', { text: n.title || (n.kind === 'group' ? 'Group' : 'Variant') }),
                    el('span', {
                        class: 'pl-preview-target-status',
                        text: (!!n.enabled ? 'Manual: On' : 'Manual: Off'),
                    }),
                ])),
            );
            wrap.append(
                el('h4', { text: 'Manual variants' }),
                el('div', { class: 'pl-sections-hint', text: 'These apply regardless of which chat or character is active \u2014 already reflected in every preview above, listed here for a quick at-a-glance check.' }),
                manualList,
            );
        }

        function buildTargetSection(mode, heading, emptyHint) {
            const refs = collectBindingRefs(variants?.nodes ?? [], mode);
            if (!refs.length) return null;
            const section = el('div', { class: 'pl-preview-targets' });
            section.append(el('h4', { text: heading }));
            for (const ref of refs) {
                const targetCtx = mode === 'character'
                    ? { characterBindingId: ref.uuid, chatBindingId: null, characterDescription: '' }
                    : { characterBindingId: null, chatBindingId: ref.uuid, characterDescription: '' };
                const finalText = (adapter.composeVariants ?? composeVariants)(baseComposed, variants, targetCtx);
                const details = el('details', { class: 'pl-preview-target' });
                details.append(
                    el('summary', {}, [
                        el('span', { class: 'pl-preview-target-label', text: ref.label || ref.uuid }),
                        el('span', { class: 'pl-preview-target-meta', text: `${finalText.length.toLocaleString()} characters` }),
                    ]),
                    el('pre', { class: 'pl-preview-output', text: finalText || '(Nothing yet.)' }),
                );
                section.append(details);
            }
            return section;
        }

        const charSection = buildTargetSection('character', 'Bound to specific characters',
            'No variants are bound to any specific character yet.');
        const chatSection = buildTargetSection('chat', 'Bound to specific chats',
            'No variants are bound to any specific chat yet.');

        if (charSection) wrap.append(charSection);
        if (chatSection) wrap.append(chatSection);

        if (!charSection && !chatSection && !manualNodes.length) {
            wrap.append(el('div', { class: 'pl-sections-hint', text: 'No variants configured yet \u2014 add one in the Edit tab to see it here.' }));
        }

        return wrap;
    }

    /**
     * The best full-size file for a persona's portrait. SillyTavern stores
     * the portrait itself at a fixed, modest size, but when the current
     * portrait came from this persona's Gallery, the untouched original is
     * still there — prefer it so zooming in shows real detail instead of
     * magnifying the stored copy. Falls back to the avatar file (the viewer
     * also retries it if the gallery file is missing).
     */
    function originalPortraitUrl(p) {
        const g = adapter.getPersonaGalleryImages?.(p.id);
        const current = g?.images?.find((im) => im.key === g.currentKey);
        return current?.url ?? adapter.avatarUrl?.(p.id) ?? p.image;
    }

    function renderDetail() {
        const p = (adapter.getPersonas() ?? []).find((x) => x.id === selectedId);
        if (!p) { detail.hidden = true; detail.replaceChildren(); return; }
        detail.hidden = false;

        const canEdit = typeof adapter.updatePersona === 'function';
        const activeId = adapter.getActiveId?.() ?? null;
        const list = visiblePersonas();
        const canNav = list.length > 1;
        detailTab = validTab(detailTab);

        const nameInput = el('input', { class: 'pl-name-input', type: 'text', value: p.name, oninput: () => { dirty = true; } });

        if (!sectionsDraft) {
            sectionsDraft = adapter.getPersonaSections?.(p.id) ?? { core: p.description ?? '', sections: [] };
        }
        if (!variantsDraft) {
            variantsDraft = normalizeVariants(adapter.getPersonaVariants?.(p.id));
        }

        const coreInput = el('textarea', { spellcheck: 'true', oninput: () => { dirty = true; sectionsDraft.core = coreInput.value; } });
        coreInput.value = sectionsDraft.core ?? '';

        const posSelect = el('select', { onchange: () => { dirty = true; } },
            POSITIONS.map(([v, l]) => el('option', { value: v, text: l })));
        posSelect.value = p.position === undefined || p.position === null ? '' : String(p.position);

        const depthInput = el('input', { type: 'number', min: '0', max: '999', value: String(p.depth ?? 2), oninput: () => { dirty = true; } });

        const roleSelect = el('select', { onchange: () => { dirty = true; } },
            ROLES.map(([v, l]) => el('option', { value: v, text: l })));
        roleSelect.value = String(p.role ?? 0);

        if (!canEdit) {
            for (const f of [nameInput, coreInput, posSelect, depthInput, roleSelect]) f.setAttribute('disabled', '');
        }

        const noteEl = el('div', { class: 'pl-note', text: note });

        const fileInput = el('input', {
            type: 'file',
            accept: 'image/*',
            style: 'display:none',
            onchange: async () => {
                const file = fileInput.files?.[0];
                if (!file) return;
                await run(async () => {
                    // If this persona already has a gallery, the new portrait
                    // becomes a gallery entry too (so it isn't lost to the next
                    // swap). No gallery yet -> nothing to sync; it's seeded from
                    // whatever the portrait is when the gallery is first used.
                    const hasGallery = !!adapter.getPersonaGalleryImages?.(p.id);
                    await adapter.replaceAvatar(p.id, file);
                    if (hasGallery) {
                        try {
                            await adapter.addPersonaGalleryImages(p.id, [file], { markLastCurrent: true });
                        } catch (e) { console.warn('[PersonaLibrary] could not add the new portrait to the gallery', e); }
                    }
                }, 'Image replaced.', 'Could not replace the image.');
            },
        });

        const run = runAction;

        // -- header: name + icon actions + close, mirroring a CharLib-style entry header --
        const iconBtn = (icon, title, onclick, extraClass = '') => el('button', {
            class: `pl-icon-btn ${extraClass}`.trim(), type: 'button', title, onclick,
        }, [el('i', { class: `fa-solid ${icon}` })]);

        const backToGridBtn = el('button', {
            class: 'pl-icon-btn pl-back-to-grid', type: 'button', title: 'Back to grid',
            // The earlier version of this button worked around the whole
            // drawer closing by stopping propagation on every early event
            // type (pointerdown/mousedown/touchstart/click). That masked
            // the symptom on this one button without touching the actual
            // cause, which turned out to be structural: this modal was
            // mounted on document.body, outside SillyTavern's own drawer
            // wrapper, so ANY click anywhere in the modal read as a
            // background click to SillyTavern — not just this button. Now
            // fixed at the source (see the `container.appendChild(detail)`
            // comment above), so this can go back to being a plain click.
            onclick: () => closeDetail(),
        }, []);
        // Hand-drawn inline SVG instead of stacked Font Awesome icons. The
        // fa-layers approach (a grid glyph + a small arrow glyph badged on
        // top of it, same pattern the Chat Lock icon uses) rendered
        // unreliably here — undersized and missing its badge entirely —
        // and fa-layers is really meant to be driven by FA's own SVG+JS
        // engine with explicit data-fa-transform attributes, neither of
        // which this codebase uses; it was borrowed CSS-only and never had
        // solid footing. Two small hand-drawn shapes sidestep that
        // entirely — there's no font glyph to fail to load or size
        // unpredictably, just plain vector paths this file fully owns.
        // Set via innerHTML (not the el() helper) because el() creates
        // elements with document.createElement, which does NOT correctly
        // create SVG/rect/path elements — they need the SVG namespace,
        // which the browser's HTML parser only applies correctly when
        // parsing markup that already contains a <svg> tag, e.g. via
        // innerHTML, not via createElement('svg') one tag at a time.
        backToGridBtn.innerHTML = `
            <span class="pl-back-to-grid-icon-stack">
                <svg viewBox="0 0 24 24" fill="currentColor" aria-hidden="true">
                    <rect x="2" y="2" width="9" height="9" rx="2"></rect>
                    <rect x="13" y="2" width="9" height="9" rx="2"></rect>
                    <rect x="2" y="13" width="9" height="9" rx="2"></rect>
                    <rect x="13" y="13" width="9" height="9" rx="2"></rect>
                </svg>
                <span class="pl-back-to-grid-icon-badge">
                    <svg viewBox="0 0 24 24" fill="currentColor" aria-hidden="true">
                        <path d="M17 4 L5 12 L17 20 Z"></path>
                    </svg>
                </span>
            </span>
        `;

        // -- native persona locks (default / character / chat) — see the
        // comment above isPersonaLockable() in st-adapter.js. Only live
        // and clickable for the currently-ACTIVE persona, same restriction
        // native ST itself has (you must select a persona before locking
        // it). For any other persona card, shown greyed-out with a tooltip
        // explaining why, rather than silently switching personas on click.
        const lockable = adapter.isPersonaLockable ? adapter.isPersonaLockable(p.id) : p.id === activeId;
        // icon content per lock type:
        //  - character: a single person-with-lock glyph (fa-user-lock)
        //  - default:   a plain lock (fa-lock)
        //  - chat:      a page/message glyph with a small lock badge on top
        //    (fa-file-lock isn't in the Font Awesome FREE set — confirmed
        //    it's an unfulfilled icon request upstream, so it silently
        //    renders as an empty box — this stacks fa-message + fa-lock
        //    instead, which are both guaranteed present)
        function lockIcon(type) {
            if (type === 'chat') {
                return el('span', { class: 'fa-layers pl-lock-icon-stack' }, [
                    el('i', { class: 'fa-solid fa-message' }),
                    el('i', { class: 'fa-solid fa-lock pl-lock-icon-badge' }),
                ]);
            }
            if (type === 'default') {
                // Wrapped in its own scoped span rather than a bare
                // <i class="fa-lock">, same fix as the chat icon above —
                // a bare .fa-lock rendered blank in testing, almost
                // certainly because ST's own native persona-lock buttons
                // (added alongside isPersonaLocked/setPersonaLockState)
                // already use that class with their own state-toggle CSS,
                // and something in that scoping caught ours too. This span
                // + the forced CSS below sidesteps that regardless of the
                // exact native rule at fault.
                return el('span', { class: 'pl-lock-icon-plain' }, [
                    el('i', { class: 'fa-solid fa-lock' }),
                ]);
            }
            return el('i', { class: 'fa-solid fa-user-lock' });
        }

        // -- the three locks live in ONE dropdown: a padlock with a small arrow.
        // Clicking it opens a menu with the Default / Character / Chat locks
        // (each with its own icon and an on/off tick). Saves two header
        // buttons' worth of room without dropping any function.
        const LOCKS = [['default', 'Default Persona Lock'], ['character', 'Character Lock'], ['chat', 'Chat Lock']];
        const lockState = (type) => adapter.isPersonaLocked?.(p.id, type) ?? false;

        function openLockMenu(anchor) {
            const r = anchor.getBoundingClientRect();
            const items = [{ title: lockable ? 'Persona locks' : 'Persona locks — select this persona first' }];
            for (const [type, label] of LOCKS) {
                const locked = lockState(type);
                items.push({
                    iconNode: () => lockIcon(type),
                    label,
                    checked: locked,
                    disabled: !lockable,
                    onClick: async () => {
                        await run(
                            () => adapter.setPersonaLockState(p.id, type, !locked),
                            locked ? `${label} unlocked.` : `${label} locked.`,
                            `Could not change ${label.toLowerCase()} lock.`,
                            // Locks aren't part of getPersonas()/getActiveId(), the
                            // two things refresh()'s fingerprint hashes to decide
                            // whether a re-render is even needed, so a lock toggle
                            // alone would bail out before renderDetail() ever runs.
                            // Forcing the memo to invalidate makes it show live.
                            { forceRerender: true },
                        );
                        // The header was just rebuilt; keep the menu open on the
                        // new button so several locks can be set in one go.
                        if (lockMenuHandle?.btn.isConnected) lockMenuHandle.open();
                    },
                });
            }
            ctxMenu.open({ x: r.left, y: r.bottom + 4, anchorRect: r, items });
        }

        function buildLockMenuBtn() {
            const states = LOCKS.map(([type, label]) => `${label.replace(/ Lock$/, '')}: ${lockState(type) ? 'on' : 'off'}`).join(' · ');
            const anyLocked = LOCKS.some(([type]) => lockState(type));
            const btn = el('button', {
                class: `pl-icon-btn pl-lock-btn pl-lock-menu-btn${anyLocked ? ' pl-lock-active' : ''}${!lockable ? ' pl-lock-dim' : ''}`,
                type: 'button',
                title: `Persona locks — ${states}${lockable ? '' : ' (select this persona first to change them)'}`,
                'aria-haspopup': 'menu',
            }, []);
            // Hand-drawn SVG (padlock + small arrow), not Font Awesome glyphs:
            // bare .fa-lock is hidden by SillyTavern's own persona-lock CSS
            // (see lockIcon() above), and the SVG sidesteps that entirely.
            // The padlock body has its keyhole cut out via an even-odd fill.
            btn.innerHTML = `
                <svg class="pl-lockmenu-padlock" viewBox="0 0 24 24" aria-hidden="true">
                    <path d="M7.5 10.5V7.5a4.5 4.5 0 0 1 9 0v3" fill="none" stroke="currentColor" stroke-width="2.3" stroke-linecap="round"></path>
                    <path fill="currentColor" fill-rule="evenodd" d="M6.5 10h11a2.5 2.5 0 0 1 2.5 2.5v7a2.5 2.5 0 0 1-2.5 2.5h-11A2.5 2.5 0 0 1 4 19.5v-7A2.5 2.5 0 0 1 6.5 10zM12 13.6a1.8 1.8 0 1 0 0 3.6 1.8 1.8 0 0 0 0-3.6z"></path>
                </svg>
                <svg class="pl-lockmenu-arrow" viewBox="0 0 10 10" aria-hidden="true">
                    <path d="M2 3.6 5 6.6 8 3.6" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round"></path>
                </svg>`;
            btn.addEventListener('click', (e) => { e.stopPropagation(); openLockMenu(btn); });
            lockMenuHandle = { btn, open: () => openLockMenu(btn) };
            return btn;
        }
        const lockMenuBtn = adapter.setPersonaLockState ? buildLockMenuBtn() : null;

        // Incarnations: a slim caret attached to the right edge of the
        // "use" check (a split button), so no extra square in the header.
        const incMenuBtn = adapter.createPersonaIncarnation && buildIncarnationMenuBtn(p);
        const useBtn = iconBtn(
            'fa-check', p.id === activeId ? 'In use' : 'Use this persona', () => use(p.id),
            `${p.id === activeId ? 'pl-icon-active' : 'pl-icon-primary'}${incMenuBtn ? ' pl-split-main' : ''}`,
        );
        const headerActions = el('div', { class: 'pl-header-actions' }, [
            // The chat-bar overlay has no grid to go back to; its X closes it.
            !overlayMode && backToGridBtn,
            incMenuBtn ? el('div', { class: 'pl-split' }, [useBtn, incMenuBtn]) : useBtn,
            lockMenuBtn,
            iconBtn('fa-book-bookmark', 'Persona Lore (native)', () => openPersonaLore(p.id, p.name)),
            adapter.duplicatePersona && iconBtn('fa-clone', 'Duplicate', () => duplicateFlow(p)),
            adapter.deletePersona && iconBtn('fa-trash', 'Delete', () => deleteFlow(p), 'pl-icon-danger'),
            canEdit && detailTab === 'edit' && el('button', {
                class: 'pl-btn pl-primary', type: 'button', text: 'Save',
                onclick: () => run(async () => {
                    sectionsDraft.core = coreInput.value;
                    await adapter.savePersonaSections(p.id, sectionsDraft);
                    await adapter.savePersonaVariants?.(p.id, variantsDraft);
                    await adapter.updatePersona(p.id, {
                        name: nameInput.value.trim() || p.name,
                        position: posSelect.value === '' ? undefined : Number(posSelect.value),
                        depth: Number(depthInput.value),
                        role: Number(roleSelect.value),
                    });
                }, 'Saved \u2713', 'Could not save.'),
            }),
            el('button', {
                class: 'pl-detail-close', type: 'button', title: 'Close',
                // Reset our own state back to the grid first (so if the
                // native toggle below doesn't fire for some reason, or the
                // person reopens the tab, they land on the grid rather than
                // back inside whatever detail view they were just in) —
                // then click SillyTavern's own drawer-icon toggle to
                // actually close the tab. That's the real, separate control
                // for that (title="Persona Management", down in the main
                // nav) — confirmed against the live DOM, not a guess.
                // Routed through closeDetail() so an unsaved-changes prompt
                // still gets a chance to fire first; the native-tab-close
                // only happens once that's resolved (or wasn't needed).
                // In the chat-bar overlay there is no drawer to close — the
                // X just closes the window and leaves you in the chat.
                onclick: () => (overlayMode
                    ? closeDetail()
                    : closeDetail(() => document.querySelector('.drawer-icon[title="Persona Management"]')?.click())),
            }, [el('i', { class: 'fa-solid fa-xmark' })]),
        ].filter(Boolean));

        const header = el('div', { class: 'pl-detail-header' }, [
            el('div', { class: 'pl-detail-header-title' }, [
                p.id === activeId ? el('span', { class: 'pl-active-pill', text: 'ACTIVE' }) : null,
                nameInput,
            ].filter(Boolean)),
            headerActions,
        ]);

        const galleryTabLabel = (n) => (n ? `Gallery (${n})` : 'Gallery');
        const galleryTabBtn = adapter.getPersonaGalleryImages && el('button', {
            class: `pl-detail-tab${detailTab === 'gallery' ? ' active' : ''}`, type: 'button',
            text: galleryTabLabel(adapter.getPersonaGalleryImages(p.id)?.images?.length ?? 0),
            title: 'This persona\u2019s set of swappable portraits',
            onclick: () => { setDetailTab('gallery'); renderDetail(); },
        });

        const tabBar = el('div', { class: 'pl-detail-tabs' }, [
            el('button', {
                class: `pl-detail-tab${detailTab === 'details' ? ' active' : ''}`, type: 'button', text: 'Details',
                onclick: () => { setDetailTab('details'); renderDetail(); },
            }),
            canEdit && el('button', {
                class: `pl-detail-tab${detailTab === 'edit' ? ' active' : ''}`, type: 'button', text: 'Edit',
                onclick: () => { setDetailTab('edit'); renderDetail(); },
            }),
            el('button', {
                class: `pl-detail-tab${detailTab === 'preview' ? ' active' : ''}`, type: 'button', text: 'Preview',
                title: 'Exactly what gets folded into the prompt the AI receives',
                onclick: () => { setDetailTab('preview'); renderDetail(); },
            }),
            galleryTabBtn,
        ].filter(Boolean));

        const connections = (p.connections ?? []).filter(Boolean);

        const editFields = el('div', { class: 'pl-detail-fields' }, [
            el('div', { class: 'pl-detail-sub', text: p.id }),
            el('div', { class: 'pl-field' }, [el('label', { text: 'Core Description' }), coreInput]),
            buildSectionsEditor(sectionsDraft, canEdit),
            buildVariantsEditor(variantsDraft, canEdit),
            el('div', { class: 'pl-field' }, [el('label', { text: 'Injection position' }), posSelect]),
            el('div', { class: 'pl-row' }, [
                el('div', { class: 'pl-field' }, [el('label', { text: 'Depth' }), depthInput]),
                el('div', { class: 'pl-field' }, [el('label', { text: 'Role' }), roleSelect]),
            ]),
            el('div', { class: 'pl-meta' }, [
                el('div', {}, [el('b', { text: 'Lorebook: ' }), document.createTextNode(p.lorebook || 'none')]),
                el('div', {}, [el('b', { text: 'Connections: ' }), document.createTextNode(connections.length ? connections.join(', ') : 'none')]),
            ]),
            noteEl,
            fileInput,
        ]);

        const tabContent = detailTab === 'edit' && canEdit
            ? editFields
            : detailTab === 'preview'
                ? buildPreviewView(p, sectionsDraft, variantsDraft, adapter)
                : (detailTab === 'gallery' && adapter.getPersonaGalleryImages)
                    ? buildGalleryView(p, (n) => { galleryTabBtn.textContent = galleryTabLabel(n); })
                    : buildDetailsView(p, connections);

        const heroImg = personaImg({ class: 'pl-detail-hero', alt: p.name, src: p.image, title: 'Click to enlarge' }, p.id, adapter);
        heroImg.addEventListener('click', () => openLightbox(originalPortraitUrl(p), p.name, p.image));
        const heroImgArea = el('div', { class: 'pl-hero-img-area' }, [heroImg]);

        const navPrev = canNav && el('button', {
            class: 'pl-hero-nav-btn', type: 'button', title: 'Previous persona', onclick: () => step(-1),
        }, [el('i', { class: 'fa-solid fa-chevron-left' })]);
        const navNext = canNav && el('button', {
            class: 'pl-hero-nav-btn', type: 'button', title: 'Next persona', onclick: () => step(1),
        }, [el('i', { class: 'fa-solid fa-chevron-right' })]);
        // Lives here, next to the photo it actually affects, rather than
        // in the header actions row — moved per direct request. Kept OFF
        // the photo itself (not an overlay icon on top of it) for the
        // exact same reason the prev/next buttons aren't: see the comment
        // below, landing controls directly on the subject's face/body read
        // as messy in the stacked mobile layout. This row's own visibility
        // can no longer be gated on canNav alone, though — a persona with
        // no adjacent siblings to navigate to would otherwise lose the
        // ability to change its portrait entirely.
        const changePortraitBtn = adapter.replaceAvatar && el('button', {
            class: 'pl-hero-nav-btn', type: 'button', title: 'Change portrait',
            onclick: () => fileInput.click(),
        }, [el('i', { class: 'fa-solid fa-image' })]);
        // A separate strip BELOW the photo, not overlaid on top of it —
        // sitting directly on the image read as messy/disconnected from
        // the rest of the UI, especially in the stacked mobile layout
        // where the photo is full-width and the circular buttons used to
        // land right on the subject's face/body. This also sidesteps the
        // vertical-centering problem entirely (no more "centered on what,
        // exactly?" question — see the old comment this replaced) since
        // the bar just sits in normal flex flow under the image, not
        // absolutely positioned against anything.
        // « » step through THIS persona's gallery images (‹ › above still
        // switch personas). Outermost on each side.
        const canGallery = typeof adapter.stepPersonaGallery === 'function';
        const galleryStepBtn = (delta) => el('button', {
            class: 'pl-hero-nav-btn pl-hero-gal-btn', type: 'button',
            title: delta < 0 ? 'Previous gallery image' : 'Next gallery image',
            onclick: async () => {
                let moved = true;
                const okd = await galleryAction(async () => {
                    const r = await adapter.stepPersonaGallery(p.id, delta);
                    moved = r?.moved !== false;
                }, { fail: 'Could not switch the image.', changesAvatar: true });
                if (okd && !moved) globalThis.toastr?.info?.('Add more images in the Gallery tab first.', 'Persona Library');
                if (okd && !dirty) renderDetail();
            },
        }, [el('i', { class: `fa-solid ${delta < 0 ? 'fa-angles-left' : 'fa-angles-right'}` })]);
        const navBar = (canNav || changePortraitBtn || canGallery) && el('div', { class: 'pl-hero-nav-bar' }, [
            canGallery && galleryStepBtn(-1), navPrev, changePortraitBtn, navNext, canGallery && galleryStepBtn(1),
        ].filter(Boolean));

        const heroWrap = el('div', { class: 'pl-detail-hero-wrap' }, [heroImgArea, navBar].filter(Boolean));

        // Size the frame to the image's OWN aspect ratio via JS measurement
        // rather than relying on flexbox to shrink-wrap it — that hit a
        // circular-sizing case (width depends on height, height depends on
        // width) that left a black margin on some images.
        //
        // Only does this in the side-by-side (desktop) layout. In the
        // stacked mobile layout (.pl-detail-body switches to
        // flex-direction: column below the narrow-screen threshold),
        // heroWrap is meant to be full-width per that CSS rule — but this
        // function was unconditionally writing an inline `style.width`
        // capped at 45% of the OLD side-by-side parent width regardless of
        // which layout was active, and an inline style always wins over a
        // stylesheet rule. That's what was leaving a large empty gap next
        // to the photo on narrow screens: CSS said "full width," but this
        // was quietly overriding it back down to a fraction of that. Checking
        // the actual computed layout mode (rather than duplicating the
        // breakpoint's pixel value here too, which would just be one more
        // number to keep in sync) and skipping the override when stacked
        // fixes it without touching the breakpoint itself.
        function syncHeroWidth() {
            if (!heroImg.naturalWidth || !heroImg.naturalHeight) return;
            const stacked = getComputedStyle(body).flexDirection === 'column';
            if (stacked) {
                heroWrap.style.flex = '';
                heroWrap.style.width = '';
                return;
            }
            const h = heroImgArea.clientHeight;
            if (!h) return;
            const maxW = (heroWrap.parentElement?.clientWidth ?? 0) * 0.45;
            const w = Math.round((heroImg.naturalWidth / heroImg.naturalHeight) * h);
            heroWrap.style.flex = '0 0 auto';
            heroWrap.style.width = `${maxW ? Math.min(w, maxW) : w}px`;
        }
        if (heroImg.complete && heroImg.naturalWidth) {
            requestAnimationFrame(syncHeroWidth);
        } else {
            heroImg.addEventListener('load', () => requestAnimationFrame(syncHeroWidth), { once: true });
        }

        const body = el('div', { class: 'pl-detail-body' }, [heroWrap, tabContent]);
        // syncHeroWidth() reads `body`'s computed flex-direction, so it has
        // to run after `body` exists — re-measure now that it does, in
        // addition to the load-driven calls above.
        requestAnimationFrame(syncHeroWidth);

        const modal = el('div', { class: 'pl-detail-modal' }, [header, tabBar, body].filter(Boolean));
        detail.replaceChildren(modal);
    }

    let lastFingerprint = null;
    // Set by renderDetail(): the live lock-dropdown button + a function that
    // reopens its menu (used to keep the menu open after toggling a lock).
    var lockMenuHandle = null;
    function refresh() {
         function fingerprint() {
            return JSON.stringify({
                activeId: adapter.getActiveId?.() ?? null,
                personas: adapter.getPersonas?.() ?? [],
            });
        }
        const fp = fingerprint();
        if (fp === lastFingerprint) { return; } // nothing the gallery cares about changed
        lastFingerprint = fp;
        const ids = new Set((adapter.getPersonas() ?? []).map((p) => p.id));
        if (selectedId && !ids.has(selectedId)) selectedId = null;
        renderGrid();
        renderDetail();
        note = '';
    }

    const unsubscribe = adapter.subscribe?.(refresh);
    // The other instance (gallery <-> chat-bar overlay) changed something:
    // force a redraw so favorites, names, locks, incarnations never go stale.
    // The detail view is left alone while it holds unsaved edits.
    const unsubscribeChanges = onLibraryChanged((src) => {
        if (src === changeSource) return;
        lastFingerprint = null;
        if (dirty) { renderGrid(); return; }
        refresh();
    });
    refresh();

    const byId = (id) => (adapter.getPersonas() ?? []).find((x) => x.id === id);

    return {
        refresh,
        // Driven by the chat-bar Quick Switcher's right-click menu (see
        // library-bridge.js), so both menus run the exact same flows.
        openPersona: (id, tab) => { if (byId(id)) openPersona(id, tab); },
        startCompare: (id) => { if (byId(id)) { if (overlayMode) startCompare(id); else { closeDetail(); startCompare(id); } } },
        toggleFavorite: (id) => toggleFavorite(id),
        isFavorite: (id) => favoriteSet().has(id),
        duplicate: (id) => { const p = byId(id); return p ? duplicateFlow(p) : undefined; },
        remove: (id) => { const p = byId(id); return p ? deleteFlow(p) : undefined; },
        switchIncarnation: (id, key) => switchIncarnationFlow(id, key),
        manageIncarnations: (id) => { if (byId(id)) manageIncarnations(id); },
        destroy() {
            try { unsubscribe?.(); } catch { /* ignore */ }
            try { unsubscribeChanges?.(); } catch { /* ignore */ }
            document.removeEventListener('keydown', onGalleryKeydown);
            document.removeEventListener('keydown', onDialogKey, true);
            closeMenu();
            dialog.remove();
            clearTimeout(scrollTimer);
            try { gridObserver?.disconnect(); } catch { /* ignore */ }
            viewer.destroy();
            ctxMenu.destroy();
            cmp.remove();
            detail.remove();
            textFocus.remove();
            root.remove();
        },
    };
}
