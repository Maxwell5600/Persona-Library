/*
 * Persona Library — shared persona context menu.
 *
 * One menu, two homes: right-clicking a tile in the gallery and
 * right-clicking a persona in the chat-bar Quick Switcher. Both build their
 * items with personaMenuItems() and render them with createContextMenu(), so
 * the two can never drift apart — the caller only supplies what each action
 * actually does in its own context. An action that isn't supplied simply
 * doesn't appear.
 */

const el = (tag, props = {}, children = []) => {
    const node = document.createElement(tag);
    for (const [k, v] of Object.entries(props)) {
        if (k === 'class') node.className = v;
        else if (k === 'text') node.textContent = v;
        else if (k.startsWith('on')) node.addEventListener(k.slice(2), v);
        else if (v !== undefined && v !== null && v !== false) node.setAttribute(k, v === true ? '' : String(v));
    }
    for (const c of [].concat(children)) if (c) node.append(c);
    return node;
};

/**
 * Builds the item list.
 * @param {{id:string,name:string}} p
 * @param {object} o
 * @param {boolean} o.isActive
 * @param {boolean} o.isFav
 * @param {boolean} [o.canCompare]
 * @param {{activeKey:string, list:{key:string,name:string,active:boolean,isOriginal:boolean}[]}|null} [o.incarnations]
 * @param {object} o.actions  use, edit, duplicate, gallery, toggleFavorite, compare, remove, switchIncarnation, manageIncarnations
 */
export function personaMenuItems(p, { isActive, isFav, canCompare = true, incarnations = null, actions = {} }) {
    const a = actions;
    const items = [
        { title: p.name },
        a.use && { icon: 'fa-check', label: isActive ? 'Currently active' : 'Set as active', disabled: isActive, onClick: () => a.use(p) },
        a.edit && { icon: 'fa-pen', label: 'Edit', onClick: () => a.edit(p) },
        a.duplicate && { icon: 'fa-clone', label: 'Duplicate', onClick: () => a.duplicate(p) },
        a.gallery && { icon: 'fa-images', label: 'Open image gallery', onClick: () => a.gallery(p) },
        'sep',
        a.toggleFavorite && { icon: 'fa-star', label: isFav ? 'Remove from favorites' : 'Add to favorites', keepOpen: true, onClick: () => a.toggleFavorite(p) },
        a.compare && canCompare && { icon: 'fa-code-compare', label: 'Compare with\u2026', onClick: () => a.compare(p) },
    ];
    // Incarnations: only persona entries that actually have some get a list;
    // everyone else just gets the "add one" shortcut (if the host offers it).
    if (a.switchIncarnation && incarnations?.list?.length > 1) {
        items.push('sep', { heading: 'Incarnations' });
        for (const inc of incarnations.list) {
            items.push({
                icon: inc.active ? 'fa-circle-dot' : 'fa-circle',
                label: inc.isOriginal ? `${inc.name} (original)` : inc.name,
                disabled: inc.active,
                keepOpen: true,
                onClick: () => a.switchIncarnation(p, inc.key),
            });
        }
    }
    if (a.manageIncarnations) {
        items.push({ icon: 'fa-layer-group', label: incarnations ? 'Manage incarnations\u2026' : 'Add incarnation\u2026', onClick: () => a.manageIncarnations(p) });
    }
    if (a.remove) items.push('sep', { icon: 'fa-trash', label: 'Delete', danger: true, onClick: () => a.remove(p) });
    return items.filter(Boolean);
}

/**
 * @param {HTMLElement} mountOn  element the menu is appended to
 * @param {{ onDismissAnchor?: () => void }} [opts]
 */
export function createContextMenu(mountOn) {
    const menu = el('div', { class: 'pl-ctx-menu pl-root', role: 'menu', hidden: true });
    menu.addEventListener('contextmenu', (e) => e.preventDefault());
    mountOn.appendChild(menu);
    let teardown = null;
    const close = () => teardown?.();

    /**
     * @param {{ x:number, y:number, items:any[], anchorRect?:DOMRect, onClose?:()=>void, afterAction?:(item:any)=>void, extraDismissTargets?:EventTarget[] }} o
     */
    function open({ x, y, items, anchorRect, onClose, afterAction, extraDismissTargets = [] }) {
        close();
        const nodes = items.map((it) => {
            if (it === 'sep') return el('div', { class: 'pl-ctx-sep' });
            if (it.title) return el('div', { class: 'pl-ctx-title', text: it.title });
            if (it.heading) return el('div', { class: 'pl-ctx-heading', text: it.heading });
            // `iconNode` lets a caller supply its own icon element (the lock
            // dropdown uses hand-drawn glyphs); `checked` (true/false, not
            // undefined) appends an on/off tick at the row's right edge.
            return el('button', {
                class: `pl-ctx-item${it.danger ? ' pl-ctx-danger' : ''}${it.checked ? ' pl-ctx-on' : ''}`, type: 'button', role: 'menuitem', disabled: !!it.disabled,
                onclick: () => { close(); it.onClick?.(); afterAction?.(it); },
            }, [
                it.iconNode ? it.iconNode() : el('i', { class: `fa-solid ${it.icon}` }),
                el('span', { text: it.label }),
                it.checked !== undefined ? el('i', { class: `fa-solid fa-check pl-ctx-tick${it.checked ? '' : ' pl-ctx-tick-off'}` }) : null,
            ]);
        });
        menu.replaceChildren(...nodes);
        menu.hidden = false;

        // Keyboard-invoked context menus report 0,0 — anchor those to the element.
        let px = x;
        let py = y;
        if (!px && !py && anchorRect) {
            px = anchorRect.left + anchorRect.width / 2;
            py = anchorRect.top + anchorRect.height / 2;
        }
        // `px`/`py` are screen coordinates, but `position: fixed` is only relative
        // to the screen when no ancestor traps it. SillyTavern's drawer (with a
        // blur / transform, depending on the theme) does exactly that for menus
        // mounted inside it, which is deliberate (see gallery.js), so measure
        // where this menu's real containing block is with a throwaway invisible
        // probe, then place and clamp inside THAT, not the window.
        const probe = el('div');
        probe.style.cssText = 'position:fixed;inset:0;visibility:hidden;pointer-events:none;';
        mountOn.appendChild(probe);
        const cb = probe.getBoundingClientRect();
        probe.remove();
        const minX = Math.max(cb.left, 0) + 4;
        const minY = Math.max(cb.top, 0) + 4;
        const maxX = Math.min(cb.right, window.innerWidth) - menu.offsetWidth - 4;
        const maxY = Math.min(cb.bottom, window.innerHeight) - menu.offsetHeight - 4;
        menu.style.left = `${Math.max(minX, Math.min(px, maxX)) - cb.left}px`;
        menu.style.top = `${Math.max(minY, Math.min(py, maxY)) - cb.top}px`;

        const onDown = (ev) => { if (!menu.contains(ev.target)) close(); };
        const onKey = (ev) => {
            if (ev.key === 'Escape') { ev.stopPropagation(); close(); return; }
            if (ev.key !== 'ArrowDown' && ev.key !== 'ArrowUp') return;
            ev.preventDefault();
            const els = [...menu.querySelectorAll('.pl-ctx-item:not([disabled])')];
            if (!els.length) return;
            const at = els.indexOf(document.activeElement);
            const next = ev.key === 'ArrowDown' ? (at + 1) % els.length : (at - 1 + els.length) % els.length;
            els[next].focus();
        };
        document.addEventListener('pointerdown', onDown, true);
        document.addEventListener('keydown', onKey, true);
        window.addEventListener('blur', close);
        window.addEventListener('resize', close);
        for (const t of extraDismissTargets) t.addEventListener('scroll', close, { passive: true });
        teardown = () => {
            document.removeEventListener('pointerdown', onDown, true);
            document.removeEventListener('keydown', onKey, true);
            window.removeEventListener('blur', close);
            window.removeEventListener('resize', close);
            for (const t of extraDismissTargets) t.removeEventListener('scroll', close);
            menu.hidden = true;
            menu.replaceChildren();
            teardown = null;
            onClose?.();
        };
        menu.querySelector('.pl-ctx-item:not([disabled])')?.focus();
    }

    return {
        open,
        close,
        contains: (node) => menu.contains(node),
        destroy() { close(); menu.remove(); },
    };
}
