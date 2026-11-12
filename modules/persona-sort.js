/*
 * Persona Library — shared sorting + token-count helpers.
 *
 * Used by BOTH the main gallery (gallery.js) and the Quick Switcher
 * (quick-switcher.js) so the two can never drift apart: one comparator, one
 * async token-count cache, instead of a copy in each file.
 *
 * Pure apart from the adapter.getTokenCount() calls inside createTokenCounter().
 */

const byName = (a, b) => (a.name ?? '').toLowerCase().localeCompare((b.name ?? '').toLowerCase());

/**
 * Async token counts for a list of personas, cached per persona id.
 *
 * The cache stores the exact description text each count was computed from,
 * so an edited persona is recounted automatically. A run-id guard stops a
 * stale batch (fast popup close + reopen, or a sort switch mid-flight) from
 * overwriting a newer one.
 */
export function createTokenCounter() {
    let cache = new Map();
    let runId = 0;
    return {
        /** Drop every cached count (the Quick Switcher does this on each open). */
        clear() { cache = new Map(); },
        /** Cached count for `p`, or -1 when it hasn't been resolved yet. */
        get(p) { return cache.get(p.id)?.count ?? -1; },
        /**
         * Resolves counts for whichever personas don't have a fresh one yet,
         * then calls `onSettled` once. Does nothing (and never calls
         * `onSettled`) when everything is already cached, so re-rendering from
         * inside `onSettled` can't loop.
         */
        ensure(list, adapter, onSettled) {
            if (typeof adapter.getTokenCount !== 'function') return;
            const myRun = ++runId;
            const pending = list.filter((p) => cache.get(p.id)?.desc !== (p.description ?? ''));
            if (!pending.length) return;
            Promise.all(pending.map((p) => adapter.getTokenCount(p.description ?? '')
                .then((count) => { cache.set(p.id, { desc: p.description ?? '', count }); })
                .catch(() => { cache.set(p.id, { desc: p.description ?? '', count: 0 }); })))
                .then(() => { if (myRun === runId) onSettled(); });
        },
    };
}

export const isTokenSort = (key) => key === 'tokens-asc' || key === 'tokens-desc' || key === 'tokens';

/**
 * @param {Array} list personas
 * @param {string} key  sort key
 * @param {{ activeId?: string|null, favorites?: Set<string>, tokensOf?: (p) => number }} [ctx]
 * @returns {Array} a new, sorted array
 */
export function sortPersonas(list, key, { activeId = null, favorites = new Set(), tokensOf = () => -1 } = {}) {
    const arr = list.slice();
    switch (key) {
        case 'name-desc': return arr.sort((a, b) => byName(b, a));
        case 'created': return arr.sort((a, b) => (b.created ?? 0) - (a.created ?? 0));
        case 'modified':
            return arr.sort((a, b) => ((b.modified ?? b.created ?? 0) - (a.modified ?? a.created ?? 0)) || byName(a, b));
        // Most recently used first, in order: the active persona (it IS the
        // most recent use), then the one used before it, and so on.
        case 'recent':
            return arr.sort((a, b) => {
                if (a.id === activeId) return b.id === activeId ? 0 : -1;
                if (b.id === activeId) return 1;
                return ((b.lastUsed ?? 0) - (a.lastUsed ?? 0)) || byName(a, b);
            });
        case 'favorites':
            return arr.sort((a, b) => (Number(favorites.has(b.id)) - Number(favorites.has(a.id))) || byName(a, b));
        case 'tokens-asc': return arr.sort((a, b) => tokensOf(a) - tokensOf(b));
        // Legacy 'tokens' (pre-dating the asc/desc split) = highest first.
        case 'tokens-desc':
        case 'tokens': return arr.sort((a, b) => tokensOf(b) - tokensOf(a));
        case 'name':
        default: return arr.sort(byName);
    }
}
