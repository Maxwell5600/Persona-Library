/*
 * Persona Library — tiny word-level text diff, used by the comparison window.
 *
 * Pure and dependency-free. Words are compared as whole whitespace-separated
 * tokens; whitespace is carried along so the original text round-trips
 * exactly, and a run of changed words highlights as one continuous span.
 *
 * Uses Myers' O(ND) algorithm, so two long descriptions that are mostly the
 * same (the usual "compare two versions" case) are cheap. If the texts are so
 * different that the edit distance blows past MAX_D, it degrades to
 * "everything between the shared start and end is changed" instead of
 * burning memory.
 */

const MAX_D = 1500;

function tokenize(text) {
    return (text ?? '').match(/\s+|\S+/g) ?? [];
}

/** Marks which words of a / b are NOT part of the common subsequence. */
function changedWords(a, b) {
    const aChanged = new Uint8Array(a.length);
    const bChanged = new Uint8Array(b.length);

    // Trim the shared head and tail first — most real diffs are small.
    let head = 0;
    while (head < a.length && head < b.length && a[head] === b[head]) head++;
    let tail = 0;
    while (tail < a.length - head && tail < b.length - head && a[a.length - 1 - tail] === b[b.length - 1 - tail]) tail++;
    const am = a.slice(head, a.length - tail);
    const bm = b.slice(head, b.length - tail);

    const markAll = () => {
        for (let i = 0; i < am.length; i++) aChanged[head + i] = 1;
        for (let j = 0; j < bm.length; j++) bChanged[head + j] = 1;
    };

    const n = am.length;
    const m = bm.length;
    if (!n || !m) { markAll(); return { aChanged, bChanged }; }

    const max = n + m;
    const off = max;
    const v = new Int32Array(2 * max + 3);
    const trace = [];
    let found = -1;
    const limit = Math.min(max, MAX_D);
    for (let d = 0; d <= limit && found < 0; d++) {
        // Snapshot of the diagonals reachable at this depth, taken BEFORE
        // this round's updates — that's what backtracking needs to read.
        trace.push(v.slice(off - d, off + d + 1));
        for (let k = -d; k <= d; k += 2) {
            let x;
            if (k === -d || (k !== d && v[off + k - 1] < v[off + k + 1])) x = v[off + k + 1];
            else x = v[off + k - 1] + 1;
            let y = x - k;
            while (x < n && y < m && am[x] === bm[y]) { x++; y++; }
            v[off + k] = x;
            if (x >= n && y >= m) { found = d; break; }
        }
    }
    if (found < 0) { markAll(); return { aChanged, bChanged }; }

    let x = n;
    let y = m;
    for (let d = found; d > 0; d--) {
        const vs = trace[d];
        const k = x - y;
        const prevK = (k === -d || (k !== d && vs[k - 1 + d] < vs[k + 1 + d])) ? k + 1 : k - 1;
        const prevX = vs[prevK + d];
        const prevY = prevX - prevK;
        while (x > prevX && y > prevY) { x--; y--; }
        if (x === prevX) { y--; bChanged[head + y] = 1; } // insertion: a word only in b
        else { x--; aChanged[head + x] = 1; }              // deletion: a word only in a
    }
    return { aChanged, bChanged };
}

/** Turns a token list + per-word changed flags into merged {text, changed} segments. */
function toSegments(tokens, changedFlags) {
    const isWord = tokens.map((t) => !/^\s/.test(t));
    const wordIdx = [];
    isWord.forEach((w, i) => { if (w) wordIdx.push(i); });
    const flag = new Array(tokens.length).fill(false);
    wordIdx.forEach((ti, wi) => { flag[ti] = !!changedFlags[wi]; });
    // Whitespace between two changed words belongs to the highlight too.
    for (let i = 0; i < tokens.length; i++) {
        if (!isWord[i]) flag[i] = !!(flag[i - 1] && isWord[i - 1] && flag[i + 1] && isWord[i + 1]);
    }
    const out = [];
    tokens.forEach((t, i) => {
        const last = out[out.length - 1];
        if (last && last.changed === flag[i]) last.text += t;
        else out.push({ text: t, changed: flag[i] });
    });
    return out;
}

/**
 * @param {string} aText
 * @param {string} bText
 * @returns {{ a: {text: string, changed: boolean}[], b: {text: string, changed: boolean}[], identical: boolean }}
 */
export function diffText(aText, bText) {
    const ta = tokenize(aText);
    const tb = tokenize(bText);
    const wa = ta.filter((t) => !/^\s/.test(t));
    const wb = tb.filter((t) => !/^\s/.test(t));
    const { aChanged, bChanged } = changedWords(wa, wb);
    let identical = true;
    for (const f of aChanged) if (f) { identical = false; break; }
    if (identical) for (const f of bChanged) if (f) { identical = false; break; }
    return { a: toSegments(ta, aChanged), b: toSegments(tb, bChanged), identical };
}
