# Persona Library (SillyTavern extension)

A better gallery for your **personas**. Replaces the cramped avatar strip in
Persona Management with a full-bleed image grid, a detail preview and light
editing. No importers, no downloaders — just the gallery.

Works inside [ProbablyTooManyTabs](https://github.com/IceFog72/SillyTavern-ProbablyTooManyTabs):
because it renders inside ST's own persona panel, it follows that panel into
whatever tab/pane PTMT puts it in, and reflows with the pane width.

## Features

- Full-bleed portrait tiles, name overlay on hover, active persona highlighted
- Click to preview, double-click (or **Use persona**) to switch
- Search across name + description, sort by name / recently used / recently created
- Tag filter chips (uses ST persona tags when present)
- Detail panel: large image, full description, injection position / depth / role,
  lorebook and character connections
- Light editing: rename, edit description and injection settings, replace image,
  duplicate, delete
- Tile-size slider; search / sort / filter / size persist in extension settings

## Install

Copy the folder into:

```
SillyTavern/public/scripts/extensions/third-party/SillyTavern-PersonaLibrary
```

Then reload SillyTavern and open the Persona Management drawer.

## Files

```
manifest.json
index.js                  entry: mount/unmount into the persona panel
persona-library.css       shared stylesheet (also used by the dev preview)
modules/gallery.js        adapter-driven renderer (no ST imports)
modules/st-adapter.js     reads/writes SillyTavern persona state
```

If mounting fails for any reason, ST's native persona list is left visible so
nothing breaks.
