# Persona Library

A CharacterLibrary-style gallery for your **personas** in SillyTavern. Replaces
the native Persona Management panel with a full-bleed image grid and a proper
detail view — browse, create, edit, and organize your personas the way you'd
browse characters, instead of scrolling a cramped avatar strip.

<img width="1918" height="921" alt="Screenshot 2026-08-17 213102" src="https://github.com/user-attachments/assets/6ce2cb8a-12a1-44c9-a238-ca2110c1bd97" />
<img width="1912" height="917" alt="Screenshot 2026-08-17 211504" src="https://github.com/user-attachments/assets/2afbe466-d84b-4461-bd6c-627d15fc44c2" />
<img width="1918" height="916" alt="Screenshot 2026-08-17 211517" src="https://github.com/user-attachments/assets/5676cd50-f2c3-48f2-9bb8-bd6860e73381" />
<img width="1917" height="917" alt="Screenshot 2026-08-17 211527" src="https://github.com/user-attachments/assets/e41f90d2-fbf8-482a-93ce-549a770c575c" />


## Features

**Gallery**
- Dense, full-bleed photo grid instead of a small avatar strip — full-resolution
  images, not SillyTavern's low-res thumbnail crop
- Search, sort (name / recently used / recently created), and an adjustable
  tile-size slider
- `+ New Persona` right in the toolbar — create one without leaving the gallery

**Detail view** — click any persona to open a large modal with three tabs:
- **Details** — a clean, read-only summary: image, tags, and every part of the
  description laid out as labeled blocks
- **Edit** — rename, replace the image, and write the description. Beyond the
  core description, add any number of **Additional Sections**: either a plain
  freeform block (Outfit, Mood, Scene Details, or your own custom title), or a
  ready-made **character-sheet category** (Appearance, Mentality, Character
  Lore, Social Relationships, and more) with its own labeled fields instead of
  one big paragraph
- **Preview** — shows *exactly* what gets folded into the prompt the AI
  receives, live, as you edit — core description plus every enabled section,
  composed exactly the way SillyTavern will inject it

Prev/next arrows let you flip between personas without closing the modal.
Everything (name, image, description, injection position/depth/role) writes
through SillyTavern's own persona functions, so it stays fully compatible with
the native Persona Management panel, other extensions, and your existing
personas — nothing is stored in a separate, incompatible format.

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

## How the description is built

Each section you add (freeform or a structured category) is really just a
labeled block of text. On save, your core description and every *enabled*
section get joined together and written into SillyTavern's real persona
description field — the same one the native panel uses. Nothing about the
underlying data format changes; sections are purely an editing convenience on
top of it. The **Preview** tab shows you that exact composed result before you
even save, so there's no guessing what the AI will actually receive.

## Notes / limitations

- The section breakdown itself (which parts are "Outfit" vs "Lore", etc.) is
  stored in this extension's own settings, keyed by persona. The *composed*
  result is written into SillyTavern's native description field, so your
  personas work normally even without this extension installed — but the
  section structure specifically won't travel with a plain SillyTavern
  backup/restore unless your extension settings are included too.
- Built and tested against a recent SillyTavern release build. If something
  breaks after a SillyTavern update, please open an issue with what changed.

## Credits

Visual direction inspired by [CharacterLibrary](https://github.com/Sillyanonymous/SillyTavern-CharacterLibrary).
Built independently, for personas rather than characters.

## License

License

Unlicense — public domain dedication. Use it however you'd like.

A note on how this was built

This extension was built through an extended conversation with Claude (Anthropic), directing every design decision, feature, and bug fix — but not hand-writing the code line by line. Sharing that plainly rather than leaving it unstated.
