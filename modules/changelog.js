/*
 * Persona Library — Changelog data.
 *
 * Single source of truth for version history, rendered both here (the
 * in-app viewer in Settings, see settings-panel.js) and, kept in sync BY
 * HAND, in CHANGELOG.md at the repo root for anyone reading the repo
 * without launching SillyTavern. If you add an entry here, add the matching
 * one there too — nothing parses one from the other, on purpose, so both
 * stay simple, readable, and independently correct rather than one being a
 * generated artifact of the other.
 *
 * Ordered NEWEST FIRST. Each entry:
 *   { version, added?: string[], fixed?: string[], removed?: string[], note?: string }
 * `note` is free-form prose for anything that doesn't fit neatly into
 * added/fixed/removed (e.g. the image-gallery removal below).
 */
export const CHANGELOG = [
    {
        version: '1.5.8',
        removed: [
            'The native chat-lock indicator/unlock button in the gallery toolbar, added in 1.5.6 and revised in 1.5.7 \u2014 pulled entirely. In real use it reported "Unlocked" on every click but didn\u2019t actually read or change the chat\u2019s real lock state; rather than keep guessing at SillyTavern\u2019s actual internals through trial and error, chat-lock is left to SillyTavern\u2019s own native Persona Management panel ("Open native Persona menu") for now. See the note on st-adapter.js\u2019s subscribe() function if this is ever revisited \u2014 verify the actual read/write behavior against a live chat first, before building UI on top of it again.',
        ],
    },
    {
        version: '1.5.7',
        fixed: [
            'The chat-lock badge (see 1.5.6, since removed in 1.5.8) rendering as a tiny, effectively empty/unclickable dot \u2014 the unlock action was only wired to a small icon nested inside a larger non-interactive pill, and that icon relied solely on the Font Awesome icon font with no fallback. Made the whole badge the click target and added a plain emoji fallback. This turned out not to be the real problem \u2014 see 1.5.8.',
        ],
    },
    {
        version: '1.5.6',
        added: [
            'Duplicate button on variant items and groups \u2014 clones an existing one (with a fresh id on everything, including a group\u2019s children) as a starting point instead of retyping.',
            'A search/filter box inside the Variants editor itself, separate from the persona-grid search \u2014 useful once a single persona has a lot of variants.',
            'Token count estimates: a small badge on every variant item plus a running total at the bottom of the editor (everything configured, active or not \u2014 the ceiling), and a separate live count on the Preview tab for just what\u2019s currently active (the real, current cost). Both use whichever tokenizer is actually configured, with a rough estimate as a fallback.',
            'A toast confirmation on Save ("Saved \u2713"), so it\u2019s never ambiguous whether an edit actually landed.',
            'An unsaved-changes confirmation when leaving the persona detail view (X button, Back to Grid, or clicking the backdrop) with unsaved edits, instead of silently discarding them.',
            'A native chat-lock indicator in the gallery toolbar (\u2014 see 1.5.8, this was removed again shortly after).',
            'Collapsible variant groups, with the collapsed/expanded state itself saved with the persona (persists across reopening the editor or reloading the page) rather than resetting every time.',
            'This changelog, plus the in-app viewer you\u2019re reading it in.',
        ],
        fixed: [
            'Collapsible variant groups themselves went missing across a couple of build/revert cycles while this version was being put together \u2014 re-implemented as originally settled on (persisted `collapsed` field on the group, chevron toggle, item-count badge when collapsed, search results force-expand a matching group so results are never hidden behind a collapsed one).',
            'The persona description silently not reaching the actual Chat Completion request despite being stored correctly \u2014 SillyTavern reads a separate, singular power_user.persona_description field in addition to the per-avatar map; both are now kept in sync on every write.',
            'The detail modal being mounted on document.body, which put every click inside it (Back to Grid, Duplicate, Delete, Save \u2014 all of it) structurally outside SillyTavern\u2019s own drawer wrapper, so ANY click anywhere in the modal was treated as a background click and closed the whole Persona Management tab. Now mounted inside that wrapper instead, fixing it at the source rather than intercepting clicks on individual buttons.',
            'The X button now also closes the native Persona Management tab (via the real drawer-icon toggle), not just this extension\u2019s own view.',
            'The Variants search box initially matched anywhere inside a word \u2014 searching "Ear" also matched "Beard" and "Year" \u2014 switched to word-boundary matching.',
            'Two follow-up bugs in that same word-boundary fix, found by testing it against more than just the one reported word: a query that itself starts with punctuation (e.g. "(test)") never matched anything, since a word-boundary can\u2019t exist immediately before punctuation; and accented/non-Latin letters (\u00e9, \u00fc, \u65e5, etc.) were being misread as "not word characters" by JS\u2019s ASCII-only \\b, which quietly broke the fix again for any non-English variant titles. Both fixed with Unicode-aware matching and a fallback to plain substring matching for punctuation-led queries.',
        ],
        removed: [],
        note: 'A per-persona image gallery (multiple saved pictures per persona, switchable) was built and briefly iterated on internally between 1.5.5 and this release, but was fully reverted before ever shipping \u2014 it\u2019s not present in this version. It initially stored extra pictures inside SillyTavern\u2019s own /User Avatars/ folder, which SillyTavern scans on load and silently registers any loose file it finds there as a brand-new "[Unnamed Persona]" \u2014 every saved gallery picture was quietly minting a phantom persona. A corrected version (built on SillyTavern\u2019s separate /api/images store instead, the same one its native character Gallery extension uses) was built afterward, but by then the feature was scrapped outright rather than reintroduced. If this is ever revisited: do NOT write anything other than a persona\u2019s own single real avatar into /User Avatars/ or via /api/avatars/*.',
    },
    {
        version: '1.4.1',
        fixed: [
            'Variant text duplicating/compounding in generated prompts when GENERATION_STARTED fired more than once before a matching GENERATION_ENDED (retries, overlapping swipes, etc.) \u2014 the description swap was recomposing on top of an already-swapped value instead of a clean baseline each time, and the eventual restore was putting back the compounded value, not the true original.',
        ],
    },
    {
        version: '1.4.0',
        note: 'Baseline: persona gallery grid, the Sections editor (core description + labeled toggleable blocks, baked into the saved description), the Variants system (items and one level of groups, each independently bindable to manual / a specific character / a specific chat / a regex-or-text match against the current character, composed only at generation time and reverted immediately after), character/chat binding ids, and quick avatar replace.',
    },
];
