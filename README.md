[README.md](https://github.com/user-attachments/files/31247037/README.md)
# Persona Library

A CharacterLibrary-style gallery for your **personas** in SillyTavern. Replaces
the native Persona Management panel with a full-bleed image grid and a proper
detail view — browse, create, edit, and organize your personas the way you'd
browse characters, instead of scrolling a cramped avatar strip.

<img width="1918" height="916" alt="Screenshot 2026-08-18 211532" src="https://github.com/user-attachments/assets/6c120003-c135-4a70-a6c4-bfa5bfdc4e36" />
<img width="1918" height="917" alt="Screenshot 2026-08-18 211617" src="https://github.com/user-attachments/assets/19363996-13e0-40f0-aed4-825c7939b416" />
<img width="1912" height="917" alt="Screenshot 2026-08-17 211504" src="https://github.com/user-attachments/assets/2afbe466-d84b-4461-bd6c-627d15fc44c2" />
<img width="1918" height="916" alt="Screenshot 2026-08-17 211517" src="https://github.com/user-attachments/assets/5676cd50-f2c3-48f2-9bb8-bd6860e73381" />
<img width="1917" height="917" alt="Screenshot 2026-08-17 211527" src="https://github.com/user-attachments/assets/e41f90d2-fbf8-482a-93ce-549a770c575c" />
<img width="1918" height="922" alt="Screenshot 2026-08-17 220147" src="https://github.com/user-attachments/assets/944c8195-c3b3-49c7-8f0a-a9718fbe52b8" />
<img width="1912" height="925" alt="Screenshot 2026-08-17 215742" src="https://github.com/user-attachments/assets/a3d08c68-bf95-4c6e-ba2b-29434c6d8f12" />
<img width="1918" height="921" alt="Screenshot 2026-08-18 210830" src="https://github.com/user-attachments/assets/16c3671c-9c85-4b02-b1a9-1f82a3091592" />
<img width="1918" height="918" alt="Screenshot 2026-08-18 210911" src="https://github.com/user-attachments/assets/f96fb2ed-cc2c-4807-b9d9-00a73d2bad88" />
<img width="1918" height="922" alt="Screenshot 2026-08-18 210818" src="https://github.com/user-attachments/assets/31cb18da-1d1d-415c-8e6f-88ae8191c535" />
<img width="1918" height="910" alt="Screenshot 2026-08-18 211257" src="https://github.com/user-attachments/assets/5b2cdf4c-6407-4879-b73a-e0d910de4b3c" />

## Features

**Gallery**
- Dense, full-bleed photo grid instead of a small avatar strip — full-resolution
  images, not SillyTavern's low-res thumbnail crop
- Search, sort (name / recently used / recently created), and an adjustable
  tile-size slider
- `+ New Persona` right in the toolbar — create one without leaving the gallery

**Detail view** — click any persona to open a large modal with three tabs:
- **Details** — a clean, read-only summary: image and every part of the
  description laid out as labeled blocks
- **Edit** — rename, replace the image, and write the description. Beyond the
  core description, add any number of **Additional Sections**: either a plain
  freeform block (Outfit, Mood, Scene Details, or your own custom title), or a
  ready-made **character-sheet category** (Appearance, Mentality, Character
  Lore, Social Relationships, and more) with its own labeled fields instead of
  one big paragraph. Drag the grip handle on any section to reorder it —
  sections are folded into the final description in the order shown, so this
  isn't just cosmetic
- **Preview** — shows *exactly* what gets folded into the prompt the AI
  receives, live, as you edit — core description plus every enabled section,
  composed exactly the way SillyTavern will inject it

Prev/next arrows let you flip between personas without closing the modal.
Everything (name, image, description, injection position/depth/role) writes
through SillyTavern's own persona functions, so it stays fully compatible with
the native Persona Management panel, other extensions, and your existing
personas — nothing is stored in a separate, incompatible format.

## Variants — dynamic, character/chat-aware blocks

Sections (above) are permanent: once saved, they're baked into the persona's
actual stored description and stay there. **Variants** are the opposite —
blocks of text that only get added to the description *while a message is
actually generating*, and are automatically reverted the instant generation
ends or is stopped. Nothing lingers if something goes wrong mid-generation;
the original description is always restored.

Each variant can be gated by how it should activate:
- **Manual** — a plain on/off toggle
- **Default** — always active
- **Character** — only active when a specific character (or characters) is
  the one you're chatting with
- **Chat** — only active in a specific chat
- **Match** — active when a pattern (plain text or a `/regex/flags`) matches
  the current character's description

Variants can be grouped one level deep — a group has its own binding gating
the whole group, and each child inside it is still independently evaluated,
so a child can be off even inside an otherwise-active group. An optional
wrapper template (with a `{{PROMPT}}` placeholder) and a custom joiner string
are both available for how the composed result gets assembled.

**Character bindings, and the "Reliable character bindings" setting:** by
default, a variant bound to "this character" is matched by that character's
avatar filename — the same method SillyTavern's own native persona–character
connections use, and nothing about the character card is touched. The
trade-off is that renaming the character's file, or re-importing the card,
can silently break the binding. Turning on **Reliable character bindings**
(Extensions panel → Persona Library) changes this: the first time you bind a
variant to a character, a small identifier gets written into that
character's own card data, using SillyTavern's standard per-character
extension-data field. That identifier travels with the card through renames
and export/re-import, so the binding keeps working. This only happens once,
only for a character you actually bind something to — never proactively.
Chat bindings are unaffected by this setting either way; those live inside
the chat's own metadata already, so they're reliable regardless.

## Installation

**Option A — SillyTavern's built-in installer (recommended)**

1. In SillyTavern, open **Extensions** → **Install Extension**
2. Paste this repo's URL:
   ```
   https://github.com/Maxwell5600/Persona-Library
   ```
3. Confirm the install, then reload the page

**Option B — Manual download**

1. Either:
   - Download this repo as a zip (**Code → Download ZIP** on GitHub), or
   - Grab a packaged release zip from the [Releases](https://github.com/Maxwell5600/Persona-Library/releases) page, if one is available
2. Extract it into your SillyTavern install at:
   ```
   SillyTavern/public/scripts/extensions/third-party/Persona-Library/
   ```
   so the folder directly contains `manifest.json`, `index.js`,
   `persona-library.css`, and a `modules/` folder — not nested inside an extra
   subfolder (rename the extracted folder if GitHub's zip added a `-main`
   suffix)
3. Reload SillyTavern, then enable **Persona Library** in the Extensions panel
   if it isn't already on

## Usage

Open the **Persona's** tab like normal — the gallery replaces the native panel
there automatically. Click a persona to open the detail view; click the
background outside the modal, or the X, to close it.

Variants are configured per-persona alongside Sections in the Edit tab. The
"Reliable character bindings" setting lives separately, under
**Extensions → Persona Library**, since it's an install-wide behavior choice
rather than something per-persona.

## Navigation & passthroughs to native SillyTavern UI

A few small additions aimed at not getting in your way when you need
something this extension May Not cover itself:

- **Back to Grid** — a button in the detail view's header (top-left, next to
  the Use/Replace-image/Duplicate/Delete icons) that returns you to the
  persona grid without leaving the tab. This is distinct from the X in the
  same header, which closes the whole panel — Back to Grid is for "I'm done
  with this persona, show me the others," X is for "I'm done with the tab
  entirely."
- **Worlds/Lorebooks** (book icon, top toolbar) — jumps straight to
  SillyTavern's native World Info / Lorebook panel, since managing lorebooks
  isn't something Persona Library reimplements.
- **Open native Persona menu** (button above the gallery, always visible) —
  Persona Library works by hiding SillyTavern's original Persona Management
  UI and mounting its own gallery in the same spot. Some native
  functionality doesn't have a Persona Library equivalent yet, so this
  button temporarily reverses that: it hides the gallery and reveals the
  real, original panel underneath. Click it again (now labeled **Back to
  Persona Library**) to swap back. Nothing about your data changes either
  way — it's purely a display toggle.

The Worlds/Lorebooks button works by finding and clicking SillyTavern's own
native World Info control, so if it doesn't do anything on your particular
SillyTavern build/fork, the underlying element ID may differ from what's
expected — please open an issue with what you see (or don't see) in the
browser console. The native Persona menu toggle doesn't have this issue,
since it's just flipping a display state Persona Library already controls
rather than searching for anything.

## How the description is built

Two layers, composed in order:

1. **Sections** (permanent) — your core description plus every *enabled*
   section get joined together and written into SillyTavern's real persona
   description field on save — the same one the native panel uses. Nothing
   about the underlying data format changes; sections are purely an editing
   convenience on top of it.
2. **Variants** (temporary) — at the moment generation starts, whichever
   variants currently match their binding get appended to that same field,
   and the original is restored the instant generation ends.

The **Preview** tab shows you the Sections-only composed result before you
even save — the base text every generation starts from, before any variants
that happen to be active get layered on top of it at that moment.

## Notes / limitations

- The Sections breakdown itself (which parts are "Outfit" vs "Lore", etc.),
  and all Variants data, is stored in this extension's own settings, keyed by
  persona (Variants) or by persona and character/chat (bindings). The
  *composed* Sections result is written into SillyTavern's native description
  field, so your personas work normally even without this extension
  installed — but the Sections/Variants structure specifically won't travel
  with a plain SillyTavern backup/restore unless your extension settings are
  included too.
- Chat-bound variants store their binding id inside that chat's own
  `chat_metadata`, so they travel with the chat itself.
- Built and tested against a recent SillyTavern release build. If something
  breaks after a SillyTavern update, please open an issue with what changed.

## Credits

Visual direction inspired by [CharacterLibrary](https://github.com/Sillyanonymous/SillyTavern-CharacterLibrary).
The Variants concept (dynamic, conditionally-active description blocks) draws
on the same idea as [SillyTavern-Persona-Management-Extended](https://github.com/dmitryplyaskin/SillyTavern-Persona-Management-Extended)'s
"Additional Descriptions," implemented independently here. Built independently
overall, for personas rather than characters.

## A note on how this was built

This extension was built through an extended conversation with Claude (Anthropic),
directing every design decision, feature, and bug fix — but not hand-writing the
code line by line. Sharing that plainly rather than leaving it unstated.

## License

[Unlicense](LICENSE) — public domain dedication. Use it however you'd like.
