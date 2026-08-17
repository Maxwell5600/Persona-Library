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
 *   getSettings()        -> { sort, tile, query, tags }
 *   saveSettings(patch)  -> void
 *   subscribe(cb)        -> unsubscribe fn        (optional)
 *   setActive(id)        -> Promise<void>
 *   updatePersona(id, patch)   -> Promise<void>   (optional; omit to disable editing)
 *   duplicatePersona(id)       -> Promise<void>   (optional)
 *   deletePersona(id)          -> Promise<void>   (optional)
 *   replaceAvatar(id, File)    -> Promise<void>   (optional)
 *   confirm(message)     -> Promise<boolean>      (optional)
 *
 * Persona: { id, name, image, description, position, depth, role,
 *            lorebook, connections: string[], tags: string[],
 *            created: number, lastUsed: number }
 */

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
    { name: 'Common Characteristics', fields: ['Name', 'Species', 'Sex', 'Age', 'Birthdate'] },
    { name: 'Appearance', fields: ['Eyes', 'Hair', 'Height', 'Weight', 'Tattoos', 'Clothes', 'Physique', 'Birthmarks', 'Detailed Appearance'] },
    { name: 'Mentality', fields: ['Personality', 'Sexuality', 'Speech', 'Intelligence', 'Special traits'] },
    { name: 'Characteristic Aesthetics', fields: ['Epithets', 'Nicknames', 'Notable habits', 'Personal motto', 'Appearance Overview'] },
    { name: 'Character Lore', fields: ['Background', 'Titles', 'Officially held jobs', 'Religion', 'Family', 'Children', 'Spouse'] },
    { name: 'Character Statistics', fields: ['Skills', 'Talents', 'Powers', 'Drawbacks', 'Weaknesses'] },
    { name: 'Equipment Statistics', fields: ['Clothing', 'Artifacts', 'Weapons', 'Miscellaneous items'] },
    { name: 'Social Relationships', fields: ['Marital Status', 'Romantically Involved', 'Friends', 'Allies', 'Enemies'] },
    { name: 'Lewd Info', fields: ['Virginity', 'Fetishes', 'Sex experience', 'Lewdity/Promiscuity', 'Pectoral Size', 'Breast Size', 'Pussy', 'Ass', 'Penis Size (Flaccid)', 'Penis Size (Erect)', 'Semen Production', 'Squirt Production'] },
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
        { sort: 'name', tile: 150, query: '', tags: [] },
        adapter.getSettings?.() ?? {},
    );

    let selectedId = null;
    let dirty = false;
    let note = '';
    // Working copy of { core, sections } for whichever persona's detail view
    // is open. Reloaded fresh from the adapter each time selection changes.
    let sectionsDraft = null;
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

    const tagBar = el('div', { class: 'pl-tags' });
    const grid = el('div', { class: 'pl-grid' });
    const gridWrap = el('div', { class: 'pl-grid-wrap' }, [grid]);
    const detail = el('div', { class: 'pl-detail pl-root', hidden: true });
    detail.addEventListener('click', (e) => {
        if (e.target === detail) { selectedId = null; renderGrid(); renderDetail(); }
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
    // Mounting `.pl-detail` directly on `document.body` sidesteps that
    // entirely — it also carries the `.pl-root` class so it still picks up
    // the same theme variables and box-sizing reset.
    document.body.appendChild(detail);

    root.append(
        el('div', { class: 'pl-toolbar' }, [newBtn, search, sort, size, count].filter(Boolean)),
        tagBar,
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
            if (settings.tags.length && !settings.tags.every((t) => (p.tags ?? []).includes(t))) return false;
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

    function renderTags() {
        const all = new Set();
        for (const p of adapter.getPersonas() ?? []) for (const t of p.tags ?? []) all.add(t);
        tagBar.replaceChildren();
        const tags = [...all].sort((a, b) => a.localeCompare(b));
        tagBar.hidden = tags.length === 0;
        for (const t of tags) {
            tagBar.append(el('button', {
                class: `pl-tag${settings.tags.includes(t) ? ' pl-on' : ''}`,
                type: 'button',
                text: t,
                onclick: () => {
                    const next = settings.tags.includes(t)
                        ? settings.tags.filter((x) => x !== t)
                        : [...settings.tags, t];
                    persist({ tags: next });
                    renderTags();
                    renderGrid();
                },
            }));
        }
    }

    function renderGrid() {
        const list = visiblePersonas();
        const activeId = adapter.getActiveId?.() ?? null;
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
    }

    function select(id) {
        if (dirty && id !== selectedId) {
            // keep it simple: unsaved edits are discarded on switch, but warn once
            note = '';
            dirty = false;
        }
        selectedId = id;
        sectionsDraft = null; // force a fresh reload for the newly selected persona
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

        function renderList() {
            list.replaceChildren();
            draft.sections.forEach((s, i) => {
                const titleInput = el('input', {
                    class: 'pl-section-title', type: 'text', value: s.title,
                    oninput: () => { dirty = true; s.title = titleInput.value; },
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

                const head = el('div', { class: 'pl-section-row-head' }, [enabledBox, titleInput, removeBtn]);

                let body;
                if (Array.isArray(s.fields)) {
                    // -- structured, field-per-line body (character-sheet category) --
                    const fieldsWrap = el('div', { class: 'pl-section-fields' });
                    const renderFields = () => {
                        fieldsWrap.replaceChildren(...s.fields.map((f, fi) => {
                            const labelInput = el('input', {
                                class: 'pl-field-label', type: 'text', value: f.label,
                                oninput: () => { dirty = true; f.label = labelInput.value; s.content = fieldsToContent(s.fields); },
                            });
                            const valueInput = el('input', {
                                class: 'pl-field-value', type: 'text', value: f.value ?? '', placeholder: '\u2014',
                                oninput: () => { dirty = true; f.value = valueInput.value; s.content = fieldsToContent(s.fields); },
                            });
                            const removeFieldBtn = el('button', {
                                class: 'pl-icon-btn pl-icon-danger pl-field-remove', type: 'button', title: 'Remove field',
                                onclick: () => { dirty = true; s.fields.splice(fi, 1); s.content = fieldsToContent(s.fields); renderFields(); },
                            }, [el('i', { class: 'fa-solid fa-xmark' })]);
                            if (!canEdit) { for (const f2 of [labelInput, valueInput]) f2.setAttribute('disabled', ''); removeFieldBtn.setAttribute('disabled', ''); }
                            return el('div', { class: 'pl-field-row' }, [labelInput, valueInput, removeFieldBtn]);
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
                    body = contentInput;
                }

                if (!canEdit) {
                    for (const f of [titleInput, enabledBox]) f.setAttribute('disabled', '');
                    removeBtn.setAttribute('disabled', '');
                }

                list.append(el('div', { class: 'pl-section-row' }, [head, body]));
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

        const tagsRow = (p.tags ?? []).length
            ? el('div', { class: 'pl-details-tags' }, p.tags.map((t) => el('span', { class: 'pl-tag-chip', text: t })))
            : null;

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

        wrap.append(...[metaBar, tagsRow, ...blocks, metaRow].filter(Boolean));
        return wrap;
    }

    /**
     * Read-only "Details" tab — mirrors CharLib's own detail modal: a small
     * metadata line, tag chips, then each part of the description (core +
     * enabled sections) as its own labeled block, instead of one raw
     * editable blob.
     */
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

        async function run(fn, ok, fail) {
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
            refresh();
        }

        // -- header: name + icon actions + close, mirroring a CharLib-style entry header --
        const iconBtn = (icon, title, onclick, extraClass = '') => el('button', {
            class: `pl-icon-btn ${extraClass}`.trim(), type: 'button', title, onclick,
        }, [el('i', { class: `fa-solid ${icon}` })]);

        const headerActions = el('div', { class: 'pl-header-actions' }, [
            iconBtn('fa-check', p.id === activeId ? 'In use' : 'Use this persona', () => use(p.id), p.id === activeId ? 'pl-icon-active' : 'pl-icon-primary'),
            adapter.replaceAvatar && iconBtn('fa-image', 'Replace image', () => fileInput.click()),
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
                    await adapter.updatePersona(p.id, {
                        name: nameInput.value.trim() || p.name,
                        position: posSelect.value === '' ? undefined : Number(posSelect.value),
                        depth: Number(depthInput.value),
                        role: Number(roleSelect.value),
                    });
                }, 'Saved.', 'Could not save.'),
            }),
            el('button', {
                class: 'pl-detail-close', type: 'button', title: 'Close',
                onclick: () => { selectedId = null; renderGrid(); renderDetail(); },
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
        ].filter(Boolean));

        const connections = (p.connections ?? []).filter(Boolean);

        const editFields = el('div', { class: 'pl-detail-fields' }, [
            el('div', { class: 'pl-detail-sub', text: p.id }),
            el('div', { class: 'pl-field' }, [el('label', { text: 'Core Description' }), coreInput]),
            buildSectionsEditor(sectionsDraft, canEdit),
            el('div', { class: 'pl-field' }, [el('label', { text: 'Injection position' }), posSelect]),
            el('div', { class: 'pl-row' }, [
                el('div', { class: 'pl-field' }, [el('label', { text: 'Depth' }), depthInput]),
                el('div', { class: 'pl-field' }, [el('label', { text: 'Role' }), roleSelect]),
            ]),
            el('div', { class: 'pl-meta' }, [
                el('div', {}, [el('b', { text: 'Lorebook: ' }), document.createTextNode(p.lorebook || 'none')]),
                el('div', {}, [el('b', { text: 'Connections: ' }), document.createTextNode(connections.length ? connections.join(', ') : 'none')]),
                (p.tags ?? []).length ? el('div', {}, [el('b', { text: 'Tags: ' }), document.createTextNode(p.tags.join(', '))]) : null,
            ].filter(Boolean)),
            noteEl,
            fileInput,
        ]);

        const tabContent = (detailTab === 'edit' && canEdit) ? editFields : buildDetailsView(p, connections);

        const heroImg = personaImg({ class: 'pl-detail-hero', alt: p.name, src: p.image }, p.id, adapter);
        const heroWrap = el('div', { class: 'pl-detail-hero-wrap' }, [heroImg]);

        // Size the frame to the image's OWN aspect ratio via JS measurement
        // rather than relying on flexbox to shrink-wrap it — that hit a
        // circular-sizing case (width depends on height, height depends on
        // width) that left a black margin on some images.
        function syncHeroWidth() {
            if (!heroImg.naturalWidth || !heroImg.naturalHeight) return;
            const h = heroWrap.clientHeight;
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

        const navPrev = canNav && el('button', {
            class: 'pl-nav-btn pl-nav-prev', type: 'button', title: 'Previous persona', onclick: () => step(-1),
        }, [el('i', { class: 'fa-solid fa-chevron-left' })]);
        const navNext = canNav && el('button', {
            class: 'pl-nav-btn pl-nav-next', type: 'button', title: 'Next persona', onclick: () => step(1),
        }, [el('i', { class: 'fa-solid fa-chevron-right' })]);

        const modal = el('div', { class: 'pl-detail-modal' }, [header, tabBar, body, navPrev, navNext].filter(Boolean));
        detail.replaceChildren(modal);
    }

    function refresh() {
        const ids = new Set((adapter.getPersonas() ?? []).map((p) => p.id));
        if (selectedId && !ids.has(selectedId)) selectedId = null;
        renderTags();
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
            detail.remove();
            root.remove();
        },
    };
}
