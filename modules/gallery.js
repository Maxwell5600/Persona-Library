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
 *            created: number, lastUsed: number }
 */

import { newItem, newGroup, cloneNode, normalizeVariants, composeVariants, collectBindingRefs } from './variants.js';

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

export function createPersonaLibrary(container, adapter) {
    const settings = Object.assign(
        { sort: 'name', tile: 150, query: '' },
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
    // 'details' (read-only, CharLib-style) or 'edit' (the form). Resets to
    // 'details' whenever a different persona is opened.
    let detailTab = 'details';

    const root = el('div', { class: 'pl-root', 'data-persona-library': '' });
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
    ]);
    sort.value = settings.sort;

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
    // scrollable panel (Details/Edit/Preview) hits its own top or bottom.
    // This is purely additive on top of the deliberate `position: fixed`
    // mounting fix above/below (see the container.appendChild(detail)
    // comment) — it doesn't touch where or how the modal is mounted, it
    // only stops the wheel/touch EVENT from bubbling past this element.
    // CSS alone (`overscroll-behavior: contain` on the individual
    // scrollable panels, added alongside this) only stops chaining once
    // an inner scrollable region's own bounds are hit — it doesn't cover
    // scrolling while the cursor is over a non-scrollable part of the
    // modal (the header, the photo) where there's no inner scroll
    // container to "contain" against in the first place, so the delta
    // would otherwise bubble straight past this element with nothing to
    // stop it. stopPropagation (not preventDefault) is deliberate: it
    // still lets whatever inner scrollable region the cursor happens to
    // be over scroll completely normally, it just stops the leftover
    // delta from reaching anything outside the modal.
    detail.addEventListener('wheel', (e) => e.stopPropagation(), { passive: true });
    detail.addEventListener('touchmove', (e) => e.stopPropagation(), { passive: true });

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

    // -- click-to-enlarge lightbox for the hero image, above the detail modal --
    const lightboxImg = el('img', { class: 'pl-lightbox-img', alt: '' });
    const lightboxClose = el('button', {
        class: 'pl-lightbox-close', type: 'button', title: 'Close',
        onclick: () => closeLightbox(),
    }, [el('i', { class: 'fa-solid fa-xmark' })]);
    const lightbox = el('div', { class: 'pl-lightbox pl-root', hidden: true }, [lightboxClose, lightboxImg]);
    lightbox.addEventListener('click', (e) => {
        if (e.target === lightbox) closeLightbox();
    });
    function openLightbox(src, alt) {
        lightboxImg.src = src;
        lightboxImg.alt = alt ?? '';
        lightbox.hidden = false;
    }
    function closeLightbox() {
        lightbox.hidden = true;
        lightboxImg.src = '';
    }
    const onLightboxKeydown = (e) => {
        if (e.key === 'Escape' && !lightbox.hidden) closeLightbox();
    };
    document.addEventListener('keydown', onLightboxKeydown);

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
        class: 'pl-text-focus-area', spellcheck: 'false',
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
    container.appendChild(lightbox);
    container.appendChild(textFocus);

    root.append(
        el('div', { class: 'pl-toolbar' }, [newBtn, search, sort, size, count, loreBtn].filter(Boolean)),
        el('div', { class: 'pl-body' }, [gridWrap]),
    );

    function persist(patch) {
        Object.assign(settings, patch);
        try { adapter.saveSettings?.(patch); } catch (e) { console.warn('[PersonaLibrary] saveSettings failed', e); }
    }

    function visiblePersonas() {
        const all = adapter.getPersonas() ?? [];
        const q = norm(settings.query).trim();
        let list = all.filter((p) => {
            if (!q) return true;
            return norm(p.name).includes(q) || norm(p.description).includes(q);
        });
        const by = {
            'name': (a, b) => norm(a.name).localeCompare(norm(b.name)),
            'name-desc': (a, b) => norm(b.name).localeCompare(norm(a.name)),
            'recent': (a, b) => (b.lastUsed ?? 0) - (a.lastUsed ?? 0),
            'created': (a, b) => (b.created ?? 0) - (a.created ?? 0),
        }[settings.sort] ?? (() => 0);
        list = list.slice().sort(by);
        return list;
    }

    function renderGrid() {
        const list = visiblePersonas();
        const activeId = adapter.getActiveId?.() ?? null;
        const scrollTop = gridWrap.scrollTop;
        grid.replaceChildren();
        count.textContent = `${list.length} persona${list.length === 1 ? '' : 's'}`;

        if (!list.length) {
            gridWrap.replaceChildren(el('div', {
                class: 'pl-empty',
                text: (adapter.getPersonas() ?? []).length ? 'No personas match your filters.' : 'No personas yet.',
            }));
            return;
        }
        if (!gridWrap.contains(grid)) gridWrap.replaceChildren(grid);

        for (const p of list) {
            const tile = el('button', {
                class: `pl-tile${p.id === selectedId ? ' pl-selected' : ''}${p.id === activeId ? ' pl-active' : ''}`,
                type: 'button',
                title: p.name,
                onclick: () => select(p.id),
                ondblclick: () => use(p.id),
            }, [
                personaImg({ alt: p.name, loading: 'lazy', decoding: 'async', src: p.image }, p.id, adapter),
                el('span', { class: 'pl-tile-name', text: p.name }),
            ]);
            grid.append(tile);
        }
        gridWrap.scrollTop = scrollTop;
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
        detailTab = 'details';
        renderGrid();
        renderDetail();
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

                const head = el('div', { class: 'pl-section-row-head' }, [handle, enabledBox, titleInput, removeBtn]);

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
                    const contentInput = el('textarea', {
                        class: 'pl-section-content', spellcheck: 'false', placeholder: 'Details for this section\u2026',
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

        const templateSelect = el('select', { class: 'pl-select' },
            SECTION_TEMPLATES.map((t) => el('option', { value: t.name, text: t.name })));

        const addTemplateBtn = el('button', {
            class: 'pl-btn', type: 'button', text: '+ Add category',
            onclick: () => {
                dirty = true;
                const tpl = SECTION_TEMPLATES.find((t) => t.name === templateSelect.value);
                if (!tpl) return;
                const fields = tpl.fields.map((label) => ({ label, value: '' }));
                draft.sections.push({ title: tpl.name, enabled: true, fields, content: fieldsToContent(fields) });
                renderList();
            },
        });

        const addRow = el('div', { class: 'pl-sections-add' }, canEdit ? [addBtn] : []);
        const addTemplateRow = el('div', { class: 'pl-sections-add' }, canEdit ? [templateSelect, addTemplateBtn] : []);

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
                class: 'pl-section-content', spellcheck: 'false', placeholder: 'What gets added when this is active\u2026',
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

    function renderDetail() {
        const p = (adapter.getPersonas() ?? []).find((x) => x.id === selectedId);
        if (!p) { detail.hidden = true; detail.replaceChildren(); return; }
        detail.hidden = false;

        const canEdit = typeof adapter.updatePersona === 'function';
        const activeId = adapter.getActiveId?.() ?? null;
        const list = visiblePersonas();
        const canNav = list.length > 1;

        const nameInput = el('input', { class: 'pl-name-input', type: 'text', value: p.name, oninput: () => { dirty = true; } });

        if (!sectionsDraft) {
            sectionsDraft = adapter.getPersonaSections?.(p.id) ?? { core: p.description ?? '', sections: [] };
        }
        if (!variantsDraft) {
            variantsDraft = normalizeVariants(adapter.getPersonaVariants?.(p.id));
        }

        const coreInput = el('textarea', { spellcheck: 'false', oninput: () => { dirty = true; sectionsDraft.core = coreInput.value; } });
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
                await run(() => adapter.replaceAvatar(p.id, file), 'Image replaced.', 'Could not replace the image.');
            },
        });

        async function run(fn, ok, fail, { forceRerender = false } = {}) {
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
        }

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
            // Composite icon, same pattern as the Chat Lock badge above:
            // fa-table-cells (a small 2x2 grid) as the main shape — reads
            // as "the gallery" — with a small fa-arrow-left badge tucked
            // into the corner for "go back." A single icon on its own kept
            // needing a caption to be unambiguous: fa-table-cells alone
            // reads as neutral "grid view," not specifically "go back,"
            // and fa-arrow-left alone doesn't say *where* it's going. NOT
            // fa-grip (already used elsewhere in this file, the Sections
            // drag handle, to mean "drag me") and NOT a single fa-image
            // (too similar to the separate "Replace image" button right
            // next to this one — confusable at a glance). No text label:
            // the hover title above still says what it does.
        }, [
            el('span', { class: 'fa-layers pl-back-to-grid-icon-stack' }, [
                el('i', { class: 'fa-solid fa-table-cells' }),
                el('i', { class: 'fa-solid fa-arrow-left pl-back-to-grid-icon-badge' }),
            ]),
        ]);

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

        const lockBtn = (type, label) => {
            const locked = adapter.isPersonaLocked?.(p.id, type) ?? false;
            const title = !lockable
                ? `${label} (select this persona first to change its lock)`
                : locked ? `${label}: locked \u2014 click to unlock` : `${label}: not locked \u2014 click to lock`;
            return el('button', {
                class: `pl-icon-btn pl-lock-btn${locked ? ' pl-lock-active' : ''}${!lockable ? ' pl-lock-disabled' : ''}`,
                type: 'button',
                title,
                onclick: lockable ? () => run(
                    () => adapter.setPersonaLockState(p.id, type, !locked),
                    locked ? `${label} unlocked.` : `${label} locked.`,
                    `Could not change ${label.toLowerCase()} lock.`,
                    // Locks aren't part of getPersonas()/getActiveId(), the
                    // two things refresh()'s fingerprint hashes to decide
                    // whether a re-render is even needed — so a lock toggle
                    // alone produces an identical fingerprint and refresh()
                    // bails out before renderDetail() ever runs. The native
                    // lock still succeeds (hence the correct toast, and the
                    // correct button state if you close and reopen — that
                    // path calls renderDetail() directly, not through this
                    // memo), it just doesn't get reflected live. Forcing the
                    // memo to invalidate here makes it match immediately.
                    { forceRerender: true },
                ) : undefined,
            }, [lockIcon(type)]);
        };

        const headerActions = el('div', { class: 'pl-header-actions' }, [
            backToGridBtn,
            iconBtn('fa-check', p.id === activeId ? 'In use' : 'Use this persona', () => use(p.id), p.id === activeId ? 'pl-icon-active' : 'pl-icon-primary'),
            adapter.replaceAvatar && iconBtn('fa-image', 'Replace image', () => fileInput.click()),
            adapter.setPersonaLockState && lockBtn('default', 'Default Persona Lock'),
            adapter.setPersonaLockState && lockBtn('character', 'Character Lock'),
            adapter.setPersonaLockState && lockBtn('chat', 'Chat Lock'),
            iconBtn('fa-book-bookmark', 'Persona Lore (native)', () => openPersonaLore(p.id, p.name)),
            adapter.duplicatePersona && iconBtn('fa-clone', 'Duplicate', () => run(() => adapter.duplicatePersona(p.id), 'Duplicated.', 'Could not duplicate.')),
            adapter.deletePersona && iconBtn('fa-trash', 'Delete', async () => {
                const ask = adapter.confirm ?? (async (m) => window.confirm(m));
                if (!await ask(`Delete persona "${p.name}"? This cannot be undone.`)) return;
                selectedId = null;
                await run(() => adapter.deletePersona(p.id), 'Deleted.', 'Could not delete.');
            }, 'pl-icon-danger'),
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
                onclick: () => closeDetail(() => document.querySelector('.drawer-icon[title="Persona Management"]')?.click()),
            }, [el('i', { class: 'fa-solid fa-xmark' })]),
        ].filter(Boolean));

        const header = el('div', { class: 'pl-detail-header' }, [
            el('div', { class: 'pl-detail-header-title' }, [
                p.id === activeId ? el('span', { class: 'pl-active-pill', text: 'ACTIVE' }) : null,
                nameInput,
            ].filter(Boolean)),
            headerActions,
        ]);

        const tabBar = el('div', { class: 'pl-detail-tabs' }, [
            el('button', {
                class: `pl-detail-tab${detailTab === 'details' ? ' active' : ''}`, type: 'button', text: 'Details',
                onclick: () => { detailTab = 'details'; renderDetail(); },
            }),
            canEdit && el('button', {
                class: `pl-detail-tab${detailTab === 'edit' ? ' active' : ''}`, type: 'button', text: 'Edit',
                onclick: () => { detailTab = 'edit'; renderDetail(); },
            }),
            el('button', {
                class: `pl-detail-tab${detailTab === 'preview' ? ' active' : ''}`, type: 'button', text: 'Preview',
                title: 'Exactly what gets folded into the prompt the AI receives',
                onclick: () => { detailTab = 'preview'; renderDetail(); },
            }),
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
                : buildDetailsView(p, connections);

        const heroImg = personaImg({ class: 'pl-detail-hero', alt: p.name, src: p.image, title: 'Click to enlarge' }, p.id, adapter);
        heroImg.addEventListener('click', () => openLightbox(heroImg.src, p.name));
        const heroImgArea = el('div', { class: 'pl-hero-img-area' }, [heroImg]);

        const navPrev = canNav && el('button', {
            class: 'pl-hero-nav-btn', type: 'button', title: 'Previous persona', onclick: () => step(-1),
        }, [el('i', { class: 'fa-solid fa-chevron-left' })]);
        const navNext = canNav && el('button', {
            class: 'pl-hero-nav-btn', type: 'button', title: 'Next persona', onclick: () => step(1),
        }, [el('i', { class: 'fa-solid fa-chevron-right' })]);
        // A separate strip BELOW the photo, not overlaid on top of it —
        // sitting directly on the image read as messy/disconnected from
        // the rest of the UI, especially in the stacked mobile layout
        // where the photo is full-width and the circular buttons used to
        // land right on the subject's face/body. This also sidesteps the
        // vertical-centering problem entirely (no more "centered on what,
        // exactly?" question — see the old comment this replaced) since
        // the bar just sits in normal flex flow under the image, not
        // absolutely positioned against anything.
        const navBar = canNav && el('div', { class: 'pl-hero-nav-bar' }, [navPrev, navNext].filter(Boolean));

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
    refresh();

    return {
        refresh,
        destroy() {
            try { unsubscribe?.(); } catch { /* ignore */ }
            document.removeEventListener('keydown', onLightboxKeydown);
            lightbox.remove();
            detail.remove();
            root.remove();
        },
    };
}
