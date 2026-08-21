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
import { CHANGELOG } from './changelog.js';

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

    drawer.querySelector('.inline-drawer-content').appendChild(buildChangelogSection(settings));

    host.appendChild(drawer);
    return true;
}

function escapeHtml(s) {
    return String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

/**
 * "What's New" viewer, right under the setting above — this extension
 * replaces SillyTavern's own Persona Management panel wholesale, so there's
 * nowhere else a person would naturally see what changed between installs.
 * Deliberately plain <details>/<summary> rather than SillyTavern's own
 * .inline-drawer markup: that relies on ST's own click wiring, which isn't
 * guaranteed to pick up elements added to the DOM after page load the same
 * way; <details> works with zero JS and can't silently fail to expand.
 *
 * Also tracks whether there's anything unseen (a simple "have you opened
 * this since a newer version landed" flag in settings) and shows a small
 * badge on the toggle when so — marked seen the moment it's opened.
 */
function buildChangelogSection(settings) {
    const currentVersion = CHANGELOG[0]?.version ?? '';
    const hasUnseen = !!currentVersion && settings.lastSeenChangelogVersion !== currentVersion;

    const wrap = document.createElement('div');
    wrap.id = 'pl-changelog';
    wrap.style.marginTop = '10px';
    wrap.style.paddingTop = '8px';
    wrap.style.borderTop = '1px solid var(--SmartThemeBorderColor, rgba(255,255,255,.15))';

    const details = document.createElement('details');
    const summary = document.createElement('summary');
    summary.style.cursor = 'pointer';
    summary.innerHTML = `<b>What's New / Changelog</b>${hasUnseen ? ' <span style="background:var(--SmartThemeQuoteColor,#5a8); color:#111; border-radius:999px; padding:1px 8px; font-size:0.75em; margin-left:6px;">NEW</span>' : ''}`;
    details.appendChild(summary);

    const body = document.createElement('div');
    body.style.marginTop = '8px';
    body.style.display = 'flex';
    body.style.flexDirection = 'column';
    body.style.gap = '14px';

    CHANGELOG.forEach((entry, i) => {
        const block = document.createElement('div');
        const listHtml = (title, items) => (items && items.length
            ? `<b>${escapeHtml(title)}</b><ul style="margin:2px 0 6px 18px; padding:0;">${items.map((it) => `<li style="margin-bottom:3px;">${escapeHtml(it)}</li>`).join('')}</ul>`
            : '');
        block.innerHTML = `
            <div>
                <b style="font-size:1.05em;">v${escapeHtml(entry.version)}</b>
                ${i === 0 ? '<small style="opacity:0.6;"> (current)</small>' : ''}
            </div>
            ${listHtml('Added', entry.added)}
            ${listHtml('Fixed', entry.fixed)}
            ${listHtml('Removed', entry.removed)}
            ${entry.note ? `<small style="opacity:0.75; display:block;">${escapeHtml(entry.note)}</small>` : ''}
        `;
        body.appendChild(block);
    });

    details.appendChild(body);
    details.addEventListener('toggle', () => {
        if (details.open && currentVersion) saveSettings({ lastSeenChangelogVersion: currentVersion });
    });
    wrap.appendChild(details);
    return wrap;
}
