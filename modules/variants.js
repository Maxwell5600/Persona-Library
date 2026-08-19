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
    return { kind: 'item', id: uid(), title, content: '', binding: { mode: 'manual', enabled: true } };
}

export function newGroup(title = 'New group') {
    return { kind: 'group', id: uid(), title, children: [], binding: { mode: 'manual', enabled: true } };
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
    if (!b || typeof b !== 'object' || !b.mode) return { mode: 'manual', enabled: true };
    if (b.mode === 'character' || b.mode === 'chat') {
        return { mode: b.mode, refs: Array.isArray(b.refs) ? b.refs.filter((r) => r?.uuid) : [] };
    }
    if (b.mode === 'match') return { mode: 'match', pattern: typeof b.pattern === 'string' ? b.pattern : '' };
    if (b.mode === 'default') return { mode: 'default' };
    return { mode: 'manual', enabled: b.enabled !== false };
}

function normalizeNode(n) {
    if (!n || typeof n !== 'object') return null;
    if (n.kind === 'group') {
        return {
            kind: 'group',
            id: n.id || uid(),
            title: n.title ?? 'Group',
            children: Array.isArray(n.children) ? n.children.map(normalizeNode).filter((c) => c?.kind === 'item') : [],
            binding: normalizeBinding(n.binding),
        };
    }
    return {
        kind: 'item',
        id: n.id || uid(),
        title: n.title ?? 'Variant',
        content: n.content ?? '',
        binding: normalizeBinding(n.binding),
    };
}

/**
 * Whether a single node's binding currently matches.
 * ctx: { characterBindingId, chatBindingId, characterDescription }
 */
export function isNodeActive(node, ctx = {}) {
    const b = node?.binding ?? { mode: 'manual', enabled: true };
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
    const seen = new Map();
    const visit = (n) => {
        if (!n) return;
        if (n.binding?.mode === mode) {
            for (const r of n.binding.refs ?? []) {
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
