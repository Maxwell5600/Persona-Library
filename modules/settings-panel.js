/*
 * Persona Library — Extensions-tab settings panel.
 *
 * First thing Persona Library has ever put outside the Persona's tab. Just
 * one setting so far: the opt-in for stamping a binding id into character
 * cards (see st-adapter.js's ensureCharacterBindingId). Kept intentionally
 * separate from the per-persona Variants editor — it's an install-wide
 * behavior choice, not something to bury per-character.
 */
import { getSettings, saveSettings } from './st-adapter.js';

const PANEL_ID = 'persona-library-settings-panel';

export function mountSettingsPanel() {
    if (document.getElementById(PANEL_ID)) return true;
    const host = document.querySelector('#extensions_settings2') ?? document.querySelector('#extensions_settings');
    if (!host) return false;

    const settings = getSettings();

    const drawer = document.createElement('div');
    drawer.id = PANEL_ID;
    drawer.className = 'inline-drawer';
    drawer.innerHTML = `
        <div class="inline-drawer-toggle inline-drawer-header">
            <b>Persona Library</b>
            <div class="inline-drawer-icon fa-solid fa-circle-chevron-down down"></div>
        </div>
        <div class="inline-drawer-content">
            <label class="checkbox_label" for="pl-reliable-character-bindings" style="align-items:flex-start; gap:8px;">
                <input id="pl-reliable-character-bindings" type="checkbox" />
                <span>
                    <b>Reliable character bindings (Variants)</b>
                    <br/>
                    <small>
                        <b>What this setting is:</b> it only affects Persona Library's "Variants" feature
                        (blocks of a persona that only apply when a specific character or chat is active).
                        It does nothing if you don't use Variants.
                        <br/><br/>
                        <b>What it does when OFF (default):</b> a Variant bound to "this character" is matched
                        by that character's avatar file name &mdash; the same method SillyTavern's own native
                        persona&ndash;character connections use. Persona Library never modifies any character
                        card. The trade-off: renaming that character's file, or re-importing the card, can
                        silently break the binding.
                        <br/><br/>
                        <b>What it does when ON:</b> the very first time you bind a Variant to a specific
                        character, Persona Library writes one small identifier into that character's own card
                        data (using SillyTavern's standard per-character extension-data field &mdash; the same
                        mechanism other extensions use to store character-specific settings). That identifier
                        travels with the card through renames and through export/re-import, so the binding
                        keeps working. This only happens once per character, only for a character you actually
                        bind a Variant to &mdash; never proactively, and never touching any other part of the
                        card.
                        <br/><br/>
                        Chat bindings are unaffected by this setting either way &mdash; those are stored inside
                        the chat itself, never the character card, so they're reliable regardless.
                    </small>
                </span>
            </label>
        </div>`;

    const checkbox = drawer.querySelector('#pl-reliable-character-bindings');
    checkbox.checked = !!settings.reliableCharacterBindings;
    checkbox.addEventListener('change', () => {
        saveSettings({ reliableCharacterBindings: checkbox.checked });
    });

    host.appendChild(drawer);
    return true;
}
