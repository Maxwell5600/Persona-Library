/*
 * Persona Library — Variants.
 *
 * A "variant" is a labeled block of text, just like an Additional Section,
 * except it is NEVER baked into the persona's stored description. It's
 * composed fresh at generation time (core + baked sections + whichever
 * variant nodes currently match) and reverted the instant generation ends —
 * same guarantee PME's "Additional Descriptions" makes. This file is the
 * pure, framework-free half of that: data shapes, matching, composition.
 * No SillyTavern imports here on purpose, so it's usable from both the real
 * generation hook (st-adapter.js) and the gallery's own Preview tab without
 * either one needing a live ST context.
 *
 * Node shapes:
 *   Item:  { kind: 'item',  id, title, content, binding: Binding }
 *   Group: { kind: 'group', id, title, children: Item[], binding: Binding }
 *     — one level of nesting only (matches PME's items/groups model).
 *     A group's own binding gates the WHOLE group; if the group is active,
 *     each child is then still independently evaluated by its own binding,
 *     so a child can be manually off (or bound elsewhere) even inside an
 *     active group.
 *
 * Binding shapes:
 *   { mode: 'manual',    enabled: boolean }
 *   { mode: 'default' }                                  — always active
 *   { mode: 'character', refs: [{ uuid, label }] }
 *   { mode: 'chat',      refs: [{ uuid, label }] }
 *   { mode: 'match', pattern: string }                    — text or /re/flags
 *     matched against the CURRENT character's Description field.
 */

const uid = () => (globalThis.crypto?.randomUUID?.() ?? `v-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`);

export function newItem(title = 'New variant') {
    //return { kind: 'item', id: uid(), title, content: '', binding: { mode: 'manual', enabled: true } };
    return {kind: 'item', id: uid(), title, content: '', mode: 'manual', enabled: true, binding: {chat: { refs:[] },character:{ refs:[] },match:{pattern: ''} }}
}

export function newGroup(title = 'New group') {
    //return { kind: 'group', id: uid(), title, children: [], binding: { mode: 'manual', enabled: true }, collapsed: false };
    return   {kind: 'group', id: uid(), title, children: [], mode: 'manual', enabled: true, collapsed: false, binding: {chat:{ refs:[] },character:{ refs:[] },match:{pattern: ''} }}
}

/**
 * Deep-clones an item or group as a fresh, independent copy — every node
 * (the node itself, and every child if it's a group) gets its own new id,
 * and binding refs are copied by value so editing the clone's bindings can
 * never mutate the original's. Used for the "duplicate" button so it's a
 * true starting-point copy, not a shared reference.
 */
export function cloneNode(node) {
    if (!node) return node;
    if (node.kind === 'group') {
        return {
            kind: 'group',
            id: uid(),
            title: node.title,
            mode: node.mode,
            enabled: node.enabled,
            children: (node.children ?? []).map(cloneNode),
            binding: cloneBinding(node.binding),
            collapsed: !!node.collapsed,
        };
    }
    return {
        kind: 'item',
        id: uid(),
        title: node.title,
        content: node.content,
        mode: node.mode,
        enabled: node.enabled,
        binding: cloneBinding(node.binding),
    };
}

function cloneBinding(b) {
    //if (!b) return { mode: 'manual', enabled: true };
    if (!b){ //bad binding, return a clean empty one
        return {chat: { refs:[] },character:{ refs:[] },match:{pattern: ''}};
    }
    //if (b.mode === 'character' || b.mode === 'chat') {
    //    return { mode: b.mode, refs: (b.refs ?? []).map((r) => ({ ...r })) };
    //}
    return  {chat: structuredClone(b.chat) ?? {refs:[]}, character: structuredClone(b.character) ?? {refs:[]}, match: structuredClone(b.match) ?? {pattern: ''}}

    //return { ...b };
}

export function defaultVariants() {
    return {
        wrapper: { enabled: false, template: '<system>{{PROMPT}}</system>' },
        joiner: '\n\n',
        nodes: [],
    };
}

/**
 * Normalizes whatever's in storage against the current shape — handles
 * settings from before a field existed, missing arrays, etc., so the rest of
 * the code never has to defensively optional-chain everything.
 */
export function normalizeVariants(raw) {
    const base = defaultVariants();
    if (!raw || typeof raw !== 'object') return base;
    return {
        wrapper: { enabled: !!raw.wrapper?.enabled, template: raw.wrapper?.template ?? base.wrapper.template },
        joiner: typeof raw.joiner === 'string' ? raw.joiner : base.joiner,
        nodes: Array.isArray(raw.nodes) ? raw.nodes.map(normalizeNode).filter(Boolean) : [],
    };
}




function normalizeBinding(b) {
    if (!b || typeof b !== 'object') return { character: {refs: []}, chat:{refs:[]}, match:{pattern:''} };
    return {
        character: {refs: Array.isArray(b.character?.refs) ? b.character.refs.filter((r) => r?.uuid) : [] },
        chat: {refs: Array.isArray(b.chat?.refs) ? b.chat.refs.filter((r) => r?.uuid) : [] },
        match: { pattern: (typeof b.match?.pattern === 'string' ? b.match.pattern : '' ) }
    }
}

function normalizeNode(node) {
    if (!node || typeof node !== 'object') return null;

    let n = (node.kind === 'group' ? newGroup(node.title) : newItem(node.title));
    n.id = node.id ?? uid();
    n.content = node.content ?? "";
    n.children = [];
    n.collapsed = node.collapsed;
    n.enabled = false;

    const mode = node.binding?.mode ?? node.mode ?? 'manual';
    switch (mode){
        case 'default': {
            n.enabled = true;
        }
        case 'manual':
            n.mode = 'manual';
            n.enabled = node.enabled || n.enabled;
            break;
        case 'character':
        case 'chat':
            n.mode = 'bound';
            n.binding[mode].refs = structuredClone(node.binding?.refs) ?? [] ;
            break;
        case 'match':
            n.mode = 'bound';
            n.binding.match = {pattern: node.binding?.pattern ?? ""}
            break;
        case 'bound':
            n.mode = 'bound';
            n.binding = structuredClone(node.binding) ?? n.binding;
    }

    if (n.kind === 'group') {
        return {
            kind: 'group',
            id: n.id || uid(),
            title: n.title ?? 'Group',
            mode: n.mode ?? 'manual',
            enabled: n.enabled ?? true,
            children: Array.isArray(node.children) ? node.children.map(normalizeNode).filter((c) => c?.kind === 'item') : [],
            binding: normalizeBinding(n.binding),
            // Purely a display preference (whether this group shows expanded
            // or collapsed in the editor) — never read by isNodeActive or
            // composeVariants, so it has zero effect on generation. Carried
            // through normalize like any other field so it survives a
            // save/reload cycle instead of resetting every time.
            collapsed: !!n.collapsed,
        };
    }
    return {
        kind: 'item',
        id: n.id || uid(),
        title: n.title ?? 'Variant',
        mode: n.mode ?? 'manual',
        enabled: n.enabled ?? false,
        content: n.content ?? '',
        binding: normalizeBinding(n.binding),
    };
}


/**
 * Whether a single node's binding currently matches.
 * ctx: { characterBindingId, chatBindingId, characterDescription }
 */
export function isNodeActive(node, ctx = {}) {
    if (!node){ return false; }
    if (node?.mode === 'manual') {
        return !!node?.enabled;
    }
    const b = node?.binding ?? { chat: { refs: [] }, character: { refs: [] }, match: { pattern: '' } };

    const regex_match = ((b, ctx) => {
        const pattern = (b.match?.pattern ?? '').trim();
        const desc = ctx.characterDescription ?? '';
        if (!pattern || !desc) return false;
        const m = /^\/(.*)\/([a-z]*)$/i.exec(pattern);
        try {
            if (m) return new RegExp(m[1], m[2]).test(desc);
            return desc.toLowerCase().includes(pattern.toLowerCase());
        } catch {
            return false; // malformed regex — fail closed, never throw into a render/generation path
        }
    })(b, ctx);

    return (regex_match || (!!ctx.characterBindingId && (b.character?.refs ?? []).some((r) => r.uuid === ctx.characterBindingId) ||
        (!!ctx.chatBindingId && (b.chat?.refs ?? []).some((r) => r.uuid === ctx.chatBindingId))
    ));
}
    /*
    switch (b.mode) {

    case 'default':
        return true;
    case 'character':
        return !!ctx.characterBindingId && (b.refs ?? []).some((r) => r.uuid === ctx.characterBindingId);
    case 'chat':
        return !!ctx.chatBindingId && (b.refs ?? []).some((r) => r.uuid === ctx.chatBindingId);
    case 'match': {
        const pattern = (b.pattern ?? '').trim();
        const desc = ctx.characterDescription ?? '';
        if (!pattern || !desc) return false;
        const m = /^\/(.*)\/([a-z]*)$/i.exec(pattern);
        try {
            if (m) return new RegExp(m[1], m[2]).test(desc);
            return desc.toLowerCase().includes(pattern.toLowerCase());
        } catch {
            return false; // malformed regex — fail closed, never throw into a render/generation path
        }
    }





    case 'manual':
    default:
        return b.enabled !== false;
}
}

     */

/**
 * Every distinct chat/character binding target referenced anywhere in
 * `nodes` (top-level items/groups AND group children — a child can carry
 * its own independent binding, see the Node shapes note up top), deduped by
 * uuid. Pure and read-only: doesn't care whether any of these targets are
 * the CURRENTLY open chat/character, which is exactly what makes it usable
 * for previewing binding targets that aren't currently open — e.g. a
 * persona with variants bound to several different chats at once.
 *
 * Returns [{ uuid, label }], in first-seen order.
 */
export function collectBindingRefs(nodes, mode) {
    // mode: 'character'|'chat' - buildPreviewView sends mode as constants, not related to mode selector
    const seen = new Map();
    const visit = (n) => {
        if (!n) return;
        if (n.mode === 'bound') {
                for (const r of n.binding?.[mode]?.refs ?? []) {
                    if (r?.uuid && !seen.has(r.uuid)) seen.set(r.uuid, r.label || r.uuid);
                }
        }
        if (n.kind === 'group') {
            for (const child of n.children ?? []) visit(child);
        }
    };
    for (const n of nodes ?? []) visit(n);
    return Array.from(seen, ([uuid, label]) => ({ uuid, label }));
}

/** Flattened list of currently-active leaf items (groups resolved, empties dropped). */
export function activeLeaves(nodes, ctx = {}) {    const out = [];
    for (const n of nodes ?? []) {
        if (n.kind === 'group') {
            if (!isNodeActive(n, ctx)) continue;
            for (const child of n.children ?? []) {
                if (isNodeActive(child, ctx) && (child.content ?? '').trim()) out.push(child);
            }
        } else if (isNodeActive(n, ctx) && (n.content ?? '').trim()) {
            out.push(n);
        }
    }
    return out;
}

/**
 * The actual composition PME describes: base text + every active variant
 * leaf, joined, optionally wrapped. Pure function — callers decide whether
 * the result gets used for real (temporarily, at generation time) or just
 * shown in a preview.
 */
export function composeVariants(baseText, variants, ctx = {}) {
    const v = normalizeVariants(variants);
    const joiner = v.joiner || '\n\n';
    const leaves = activeLeaves(v.nodes, ctx);
    const parts = [(baseText ?? '').trim(), ...leaves.map((n) => n.content.trim())].filter(Boolean);
    let composed = parts.join(joiner);
    if (v.wrapper.enabled && (v.wrapper.template ?? '').includes('{{PROMPT}}')) {
        composed = v.wrapper.template.split('{{PROMPT}}').join(composed);
    }
    return composed;
}
