/* One menu for everything you can do to an item: opened by a ⋮ button or a right-click.
   Also the 10-second UNDO toast used by every delete, and a small yes/no dialog. */
(() => {
  const esc = s => String(s ?? '').replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
  let open = null; // {menu, anchor, cleanup}

  function close(restoreFocus = true) {
    if (!open) return;
    const {menu, anchor, cleanup} = open; open = null;
    cleanup(); menu.remove();
    anchor?.setAttribute?.('aria-expanded', 'false');
    if (restoreFocus && anchor?.isConnected) anchor.focus({preventScroll: true});
  }

  /* items: [{id, label, run, hint, danger, disabled, why, checked}] or '-' for a divider.
     at: a MouseEvent (right-click) or an element (the ⋮ button) to place the menu by. */
  function show(at, items, {title = '', anchor = null, label = 'Actions'} = {}) {
    close(false);
    const menu = document.createElement('div');
    menu.className = 'im-menu'; menu.setAttribute('role', 'menu'); menu.setAttribute('aria-label', title ? label + ' for ' + title : label);
    const list = items.filter((item, i, all) => item !== '-' || (i > 0 && all[i - 1] !== '-' && i < all.length - 1));
    menu.innerHTML = (title ? `<div class="im-title" aria-hidden="true">${esc(title)}</div>` : '') + list.map((item, i) => item === '-'
      ? '<div class="im-sep" role="separator"></div>'
      : `<button type="button" role="${item.checked == null ? 'menuitem' : 'menuitemcheckbox'}" data-im="${i}" ${item.id ? `data-action="${esc(item.id)}"` : ''} class="${item.danger ? 'im-danger' : ''}" ${item.checked != null ? `aria-checked="${!!item.checked}"` : ''} ${item.disabled ? 'aria-disabled="true"' : ''} ${item.disabled && item.why ? `title="${esc(item.why)}"` : ''}><span>${esc(item.label)}</span>${item.hint ? `<kbd>${esc(item.hint)}</kbd>` : ''}</button>`).join('');
    document.body.append(menu);
    // Place it: under the button, or at the pointer; always fully on screen.
    const box = menu.getBoundingClientRect();
    let x, y;
    if (at && 'clientX' in at && !(at instanceof Element)) { x = at.clientX; y = at.clientY; }
    else { const r = (at || anchor).getBoundingClientRect(); x = r.right - box.width; y = r.bottom + 4; if (y + box.height > innerHeight - 8) y = r.top - box.height - 4; }
    menu.style.left = Math.max(8, Math.min(x, innerWidth - box.width - 8)) + 'px';
    menu.style.top = Math.max(8, Math.min(y, innerHeight - box.height - 8)) + 'px';
    const buttons = [...menu.querySelectorAll('button')];
    const focus = i => buttons[(i + buttons.length) % buttons.length]?.focus();
    menu.onclick = e => {
      const b = e.target.closest('[data-im]'); if (!b) return;
      const item = list[+b.dataset.im];
      if (item.disabled) { if (item.why) window.ScrewShop?.notify(item.why); return; }
      close(); Promise.resolve().then(() => item.run()).catch(err => window.ScrewShop?.notify(err.message));
    };
    menu.onkeydown = e => {
      const i = buttons.indexOf(document.activeElement);
      if (e.key === 'ArrowDown') { e.preventDefault(); focus(i + 1); }
      else if (e.key === 'ArrowUp') { e.preventDefault(); focus(i - 1); }
      else if (e.key === 'Home') { e.preventDefault(); focus(0); }
      else if (e.key === 'End') { e.preventDefault(); focus(-1); }
      else if (e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); close(); }
      else if (e.key === 'Tab') close(false);
    };
    menu.oncontextmenu = e => e.preventDefault();
    const outside = e => { if (!menu.contains(e.target) && !(anchor && anchor.contains(e.target))) close(false); };
    // Scrolling the page closes the menu, but not the scroll-into-view that the opening click itself causes.
    const opened = performance.now();
    const away = e => { if (!menu.contains(e.target) && performance.now() - opened > 250) close(false); };
    const blur = () => close(false);
    setTimeout(() => { if (open?.menu === menu) document.addEventListener('pointerdown', outside, true); });
    document.addEventListener('scroll', away, true); addEventListener('resize', blur); addEventListener('blur', blur);
    open = {menu, anchor, cleanup: () => { document.removeEventListener('pointerdown', outside, true); document.removeEventListener('scroll', away, true); removeEventListener('resize', blur); removeEventListener('blur', blur); }};
    anchor?.setAttribute?.('aria-expanded', 'true');
    focus(0);
    return menu;
  }
  // A ⋮ button toggles its own menu.
  function toggle(button, items, options = {}) {
    if (open && open.anchor === button) { close(); return; }
    show(button, items, {...options, anchor: button});
  }

  /* ---------- Delete with UNDO ---------- */
  const pending = new Map(); // id -> {body, finish}
  let tray;
  function trayEl() {
    if (tray?.isConnected) return tray;
    tray = document.createElement('div'); tray.className = 'im-toasts'; tray.setAttribute('aria-live', 'polite'); document.body.append(tray); return tray;
  }
  async function commit(body) {
    const response = await fetch('/api/trash', {method: 'POST', headers: {'X-ScrewShop': '1', 'Content-Type': 'application/json'}, body: JSON.stringify(body)});
    const result = await response.json().catch(() => ({}));
    if (!response.ok || result.error) throw Error(result.error?.message || 'The computer could not delete it.');
    return result.data;
  }
  /* label: what the person sees. items: what the server removes ({table,id,with_stems} or {note}).
     hide(): take it off screen now. restore(): put it back (UNDO, or the delete failed).
     after(result): refresh lists once it's really gone. */
  function remove({label, items, hide, restore, after, seconds = 10}) {
    const id = Math.random().toString(36).slice(2);
    try { hide?.(); } catch (e) { console.error(e); }
    const toast = document.createElement('div');
    toast.className = 'im-toast'; toast.setAttribute('role', 'status');
    toast.innerHTML = `<span>Deleted <b>${esc(label)}</b></span><button type="button" class="im-undo">UNDO <small>${seconds}</small></button><button type="button" class="im-dismiss" aria-label="Close">×</button>`;
    trayEl().append(toast);
    const body = {items, label};
    let left = seconds, done = false;
    const tick = setInterval(() => { left--; const s = toast.querySelector('small'); if (s) s.textContent = Math.max(0, left); if (left <= 0) finish(); }, 1000);
    const end = text => { clearInterval(tick); pending.delete(id); toast.querySelector('.im-undo')?.remove(); toast.querySelector('span').innerHTML = text; setTimeout(() => toast.remove(), 6000); };
    const finish = async () => {
      if (done) return; done = true; clearInterval(tick);
      toast.querySelector('.im-undo').disabled = true;
      try {
        const result = await commit(body);
        end(result.kept?.length
          ? `Deleted <b>${esc(label)}</b>. Its audio is still used elsewhere (Studio, a pad or another copy), so the file stays until that's removed too.`
          : result.folder ? `Deleted <b>${esc(label)}</b>. Moved to <b>Deleted Files</b> › ${esc(result.folder)}.` : `Deleted <b>${esc(label)}</b>.`);
        await after?.(result);
      } catch (error) {
        try { restore?.(); } catch (_) {}
        end(`Not deleted: ${esc(error.message)}`); toast.classList.add('im-error');
      }
    };
    pending.set(id, {body, finish});
    toast.querySelector('.im-undo').onclick = () => {
      if (done) return; done = true; clearInterval(tick); pending.delete(id);
      try { restore?.(); } catch (e) { console.error(e); }
      toast.querySelector('span').innerHTML = `Restored <b>${esc(label)}</b>.`; toast.querySelector('.im-undo').remove();
      setTimeout(() => toast.remove(), 2500);
    };
    toast.querySelector('.im-dismiss').onclick = () => { finish(); toast.remove(); };
    return {finish};
  }
  // Closing or reloading the page inside the UNDO window still finishes the delete.
  addEventListener('pagehide', () => {
    for (const {body} of pending.values()) {
      try { fetch('/api/trash', {method: 'POST', keepalive: true, headers: {'X-ScrewShop': '1', 'Content-Type': 'application/json'}, body: JSON.stringify(body)}); } catch (_) {}
    }
    pending.clear();
  });

  // A plain "done, UNDO?" toast for changes that are undone in the page itself (a Studio clip, a pad).
  function undoable(text, undo, seconds = 10) {
    const toast = document.createElement('div');
    toast.className = 'im-toast'; toast.setAttribute('role', 'status');
    toast.innerHTML = `<span>${esc(text)}</span><button type="button" class="im-undo">UNDO <small>${seconds}</small></button><button type="button" class="im-dismiss" aria-label="Close">×</button>`;
    trayEl().append(toast);
    let left = seconds;
    const tick = setInterval(() => { left--; const s = toast.querySelector('small'); if (s) s.textContent = Math.max(0, left); if (left <= 0) gone(); }, 1000);
    const gone = () => { clearInterval(tick); toast.remove(); };
    toast.querySelector('.im-undo').onclick = () => { gone(); undo(); };
    toast.querySelector('.im-dismiss').onclick = gone;
  }

  /* ---------- A small question dialog ---------- */
  function ask({title, text = '', check = null, ok = 'OK', cancel = 'Cancel', danger = false}) {
    return new Promise(resolve => {
      const dialog = document.createElement('dialog'); dialog.className = 'im-ask';
      dialog.innerHTML = `<form method="dialog"><h3>${esc(title)}</h3>${text ? `<p>${esc(text)}</p>` : ''}${check ? `<label><input type="checkbox" data-check> ${esc(check)}</label>` : ''}<div><button value="cancel">${esc(cancel)}</button><button value="ok" class="${danger ? 'im-danger' : 'ss-primary'}">${esc(ok)}</button></div></form>`;
      document.body.append(dialog);
      dialog.onclose = () => { const value = dialog.returnValue === 'ok' ? {ok: true, checked: !!dialog.querySelector('[data-check]')?.checked} : {ok: false}; dialog.remove(); resolve(value); };
      dialog.showModal(); dialog.querySelector('button[value=ok]').focus();
    });
  }

  /* ---------- A small floating window (pad sound editor) ---------- */
  function panel({title, className = '', onClose}) {
    const dialog = document.createElement('dialog'); dialog.className = 'im-panel ' + className;
    dialog.innerHTML = `<header><h3>${esc(title)}</h3><button type="button" data-close aria-label="Close">×</button></header><div class="im-panel-body"></div>`;
    document.body.append(dialog);
    dialog.querySelector('[data-close]').onclick = () => dialog.close();
    dialog.addEventListener('close', () => { onClose?.(); dialog.remove(); });
    dialog.addEventListener('click', e => { if (e.target === dialog) dialog.close(); }); // click the backdrop to close
    dialog.showModal();
    return dialog;
  }

  window.ItemMenu = {show, toggle, close, remove, undoable, ask, panel, isOpen: () => !!open};
})();
