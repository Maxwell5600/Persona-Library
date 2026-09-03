# Changelog

All notable changes to Persona Library are documented here, newest first.

This file is the human-readable counterpart to `modules/changelog.js`, which
drives the in-app **"What's New / Changelog"** viewer in Settings (under the
"Reliable character bindings" toggle). The two are kept in sync by hand —
nothing parses one from the other on purpose, so both stay simple and
independently correct. If you add an entry to one, add the matching one to
the other.

## v1.6.3

### Added
- Native SillyTavern persona locks (Default / Character / Chat) wired
  directly into the persona detail view — three lock buttons showing live
  state and toggling the real thing via ST's own lock functions.
- Locks only work on the currently active persona, same as native — shown
  greyed-out with a tooltip on any other persona's card.

### Fixed
- Lock icon rendering blank, and the lock button's highlight not updating
  until the modal was reopened.
- Header buttons (Save, Close, etc.) getting clipped off-screen on
  narrower widths.
- Nav arrows floating in the wrong spot, then overlapping the photo —
  moved to a slim bar below the image instead of an overlay.
- Large empty gap next to the photo on narrow/stacked screens.
- Scrolling past the bottom of the modal bleeding into the gallery grid
  behind it.
- Hardened section field rows so their X/expand buttons can't get pushed off-screen.
- "Back to Grid" is now a small icon-only button — a composite grid +
  back-arrow icon (not a bare grid, not an X) so it's unambiguous at a
  glance — instead of a full-width label, and no longer drifts into an
  isolated gap on wide screens — moved next to the action icons with a
  small fixed buffer, not glued to them or floating alone.
- Replace Image reordered to sit right after "Use this persona."
- New/edited/renamed/duplicated/deleted personas now show up immediately
  in the native Persona Management list (including its list-view
  description preview) instead of needing a full page reload.
- The hero image and header staying permanently pinned at the top on
  narrow/short screens with no way to scroll past them — the Edit/Preview/
  Details tab content had its own independent scroll that silently
  absorbed all the overflow before the outer modal's scroll ever got a
  chance to activate.
- Deleting the currently-ACTIVE persona leaving a blank "ghost" persona
  behind after a SillyTavern refresh — the active-persona pointer wasn't
  being updated on delete, so SillyTavern's own self-healing logic
  silently recreated it at the same id on next load. Also now clears a
  matching default-persona lock or chat-persona lock, and no longer
  aborts cleanup if the avatar file was already gone.

## v1.6.2

## v1.6.2

### Fixed
- The real root cause of the "saved changes don't show up until you switch
  personas and back" bug — the 1.6.1 fix addressed a genuine, confirmed
  part of this (the `persona_description` singular field never being
  written), but a saved edit still didn't appear in the native
  `#persona_description` textarea or the live prompt without a persona
  switch. Turns out `ctx()?.setPersonaDescription` — called after every
  write, meant to refresh the native panel — has **never actually
  existed**: confirmed directly against SillyTavern's own `st-context.js`
  source, `setPersonaDescription` is exported from `personas.js` but never
  re-exported through the public `getContext()` object this extension was
  calling it through. Every one of those calls, in every version,
  including the ones that already fixed the underlying data, was a silent
  no-op. The data was correct after 1.6.1 (which is why the AI backend
  eventually received the right text once a generation happened to run
  past the native panel's stale display) — the visible native panel itself
  just never got told to re-read it, so it sat stale until a persona
  switch triggered SillyTavern's own internal call to the real function.
  Fixed by importing the real, actually-exported `setPersonaDescription`
  directly from `personas.js` instead of going through the broken proxy —
  the same pattern already used elsewhere in this file for `initPersona`.
  This should be the actual, complete fix for the reported behavior, not
  just a partial one.

## v1.6.1

### Fixed
- A saved edit to a persona's description (via the Edit tab's Sections, or
  a rename/position/depth/role change) not showing up in SillyTavern's own
  native description textarea, and not reaching the actual prompt on the
  next generation — until switching to a different persona and back. Root
  cause: SillyTavern reads the description from **two** places —
  `persona_descriptions[id].description` (the per-persona storage entry
  this extension was correctly writing) and `persona_description` (a
  separate, singular "active" field that both the native textarea and the
  prompt builder actually read from, which was never being written by the
  Sections/rename save path). Switching personas "fixed" it because
  SillyTavern's own persona-switch logic happens to copy the storage entry
  into that singular field — masking the bug rather than avoiding it. This
  is the exact same class of bug already fixed for the Variants
  generation-time patch a few versions back (see 1.5.6's note on this);
  that fix just never got carried over to the separate Sections/
  `updatePersona` save path. Both are now kept in sync on every write,
  consistently, everywhere a description gets saved.

## v1.6.0

### Added
- A variant can now be bound to a character **and** a chat at the same
  time, instead of being locked to only one binding type. The old separate
  Character / Chat / Match modes are merged into a single "Automatic
  Bindings" section with both "+ Bind current character" and "+ Bind
  current chat" buttons together, plus the match-pattern field — bind as
  many of the three as you want on one item or group.
- **Important semantics to know:** combining a character binding and a chat
  binding on the same node is **OR**, not AND — it activates when *either*
  matches, not only when both do at once (e.g. "chat X" alone, or
  "character Y" alone, both trigger it; it does not require chat X
  specifically with character Y). This was a deliberate design decision
  made when adding this, not an accidental side effect.

Existing variants keep working with no manual re-configuring: old
character-only, chat-only, match-only, and legacy default-mode data are all
automatically converted to the new combined binding shape the next time
they're loaded.

On that note — the migration code contains a switch statement where the old
`'default'` (always-active) mode intentionally falls through into the
`'manual'` case with no `break;`, so it becomes `mode: 'manual', enabled:
true` on load. That *looks* like a classic missing-break bug on a cold read
(it's exactly the pattern most linters flag), but it isn't — it's the
intended migration path, confirmed by whoever wrote it. Flagging this here
so nobody "fixes" it later by adding a break and silently breaks the
migration instead.

## v1.5.8

### Removed
- The native chat-lock indicator/unlock button in the gallery toolbar,
  added in 1.5.6 and revised in 1.5.7 — pulled entirely. In real use it
  reported "Unlocked" on every click but didn't actually read or change the
  chat's real lock state; rather than keep guessing at SillyTavern's actual
  internals through trial and error, chat-lock is left to SillyTavern's own
  native Persona Management panel ("Open native Persona menu") for now. See
  the note next to `subscribe()` in `st-adapter.js` if this is ever
  revisited — verify the actual read/write behavior against a live chat
  first, before building UI on top of it again.

## v1.5.7

### Fixed
- The chat-lock badge (see 1.5.6, since removed in 1.5.8) rendering as a
  tiny, effectively empty/unclickable dot — the unlock action was only
  wired to a small icon nested inside a larger non-interactive pill, and
  that icon relied solely on the Font Awesome icon font with no fallback.
  Made the whole badge the click target and added a plain emoji fallback.
  This turned out not to be the real problem — see 1.5.8.

## v1.5.6

### Added
- Duplicate button on variant items and groups — clones an existing one
  (with a fresh id on everything, including a group's children) as a
  starting point instead of retyping.
- A search/filter box inside the Variants editor itself, separate from the
  persona-grid search — useful once a single persona has a lot of variants.
- Token count estimates: a small badge on every variant item plus a running
  total at the bottom of the editor (everything configured, active or not —
  the ceiling), and a separate live count on the Preview tab for just what's
  currently active (the real, current cost). Both use whichever tokenizer is
  actually configured, with a rough estimate as a fallback.
- A toast confirmation on Save ("Saved ✓"), so it's never ambiguous whether
  an edit actually landed.
- An unsaved-changes confirmation when leaving the persona detail view (X
  button, Back to Grid, or clicking the backdrop) with unsaved edits,
  instead of silently discarding them.
- A native chat-lock indicator in the gallery toolbar (— see v1.5.8, this
  was removed again shortly after).
- Collapsible variant groups, with the collapsed/expanded state itself saved
  with the persona (persists across reopening the editor or reloading the
  page) rather than resetting every time.
- This changelog, plus the in-app viewer.

### Fixed
- Collapsible variant groups themselves went missing across a couple of
  build/revert cycles while this version was being put together —
  re-implemented as originally settled on (persisted `collapsed` field on
  the group, chevron toggle, item-count badge when collapsed, search
  results force-expand a matching group so results are never hidden behind
  a collapsed one).
- The persona description silently not reaching the actual Chat Completion
  request despite being stored correctly — SillyTavern reads a separate,
  singular `power_user.persona_description` field in addition to the
  per-avatar map; both are now kept in sync on every write.
- The detail modal being mounted on `document.body`, which put every click
  inside it (Back to Grid, Duplicate, Delete, Save — all of it) structurally
  outside SillyTavern's own drawer wrapper, so *any* click anywhere in the
  modal was treated as a background click and closed the whole Persona
  Management tab. Now mounted inside that wrapper instead, fixing it at the
  source rather than intercepting clicks on individual buttons.
- The X button now also closes the native Persona Management tab (via the
  real drawer-icon toggle), not just this extension's own view.
- The Variants search box initially matched anywhere inside a word —
  searching "Ear" also matched "Beard" and "Year" — switched to
  word-boundary matching.
- Two follow-up bugs in that same word-boundary fix, found by testing it
  against more than just the one reported word: a query that itself starts
  with punctuation (e.g. `(test)`) never matched anything, since a
  word-boundary can't exist immediately before punctuation; and
  accented/non-Latin letters (é, ü, 日, etc.) were being misread as "not word
  characters" by JS's ASCII-only `\b`, which quietly broke the fix again for
  any non-English variant titles. Both fixed with Unicode-aware matching and
  a fallback to plain substring matching for punctuation-led queries.

### Removed
- A per-persona image gallery (multiple saved pictures per persona,
  switchable) was built and briefly iterated on internally between 1.5.5 and
  this release, but was fully reverted before ever shipping — it's **not**
  present in this version. It initially stored extra pictures inside
  SillyTavern's own `/User Avatars/` folder, which SillyTavern scans on load
  and silently registers any loose file it finds there as a brand-new
  "[Unnamed Persona]" — every saved gallery picture was quietly minting a
  phantom persona. A corrected version (built on SillyTavern's separate
  `/api/images` store instead, the same one its native character Gallery
  extension uses) was built afterward, but by then the feature was scrapped
  outright rather than reintroduced.
  **If this is ever revisited: do NOT write anything other than a persona's
  own single real avatar into `/User Avatars/` or via `/api/avatars/*`.**

## v1.4.1

### Fixed
- Variant text duplicating/compounding in generated prompts when
  `GENERATION_STARTED` fired more than once before a matching
  `GENERATION_ENDED` (retries, overlapping swipes, etc.) — the description
  swap was recomposing on top of an already-swapped value instead of a clean
  baseline each time, and the eventual restore was putting back the
  compounded value, not the true original.

## v1.4.0

Baseline: persona gallery grid, the Sections editor (core description +
labeled toggleable blocks, baked into the saved description), the Variants
system (items and one level of groups, each independently bindable to
manual / a specific character / a specific chat / a regex-or-text match
against the current character, composed only at generation time and
reverted immediately after), character/chat binding ids, and quick avatar
replace.
