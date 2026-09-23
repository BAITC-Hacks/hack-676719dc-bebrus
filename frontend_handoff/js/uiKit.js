// ============================================================
//  HECTRA — UI kit (shared presentation primitives)
// ============================================================

/**
 * Small helpers the branch / history / map / merge modules share: popover
 * menus, escaping, time formatting and human labels for internal action types.
 *
 * Presentation only. Nothing here holds workspace state — every fact comes from
 * HectraState.
 */
window.HectraUI = {

  _openMenu: null,

  esc(value) {
    return String(value ?? '')
      .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;').replace(/'/g, '&#039;');
  },

  /** 10:43 — what the user reads instead of an actionSeq. */
  time(ms) {
    if (!Number.isFinite(ms)) return '--:--';
    const date = new Date(ms);
    return `${String(date.getHours()).padStart(2, '0')}:${String(date.getMinutes()).padStart(2, '0')}`;
  },

  truncate(value, max = 48) {
    const text = String(value ?? '').replace(/\s+/g, ' ').trim();
    return text.length > max ? `${text.slice(0, max - 1)}…` : text;
  },

  /**
   * Internal action types never reach the user. This is the only place that
   * translates them into readable labels.
   */
  actionLabel(action) {
    const types = window.HectraActionLog ? HectraActionLog.ACTION_TYPES : {};
    const payload = (action && action.payload) || {};

    switch (action && action.type) {
      case types.USER_MESSAGE:                return `Asked: “${this.truncate(payload.text, 52)}”`;
      case types.USER_MESSAGE_EDITED:         return `Reworded a request`;
      case types.AI_MESSAGE:                  return payload.origin === 'regenerate' ? 'Regenerated the response' : 'Hectra responded';
      case types.DOCUMENT_CREATED:            return `Wrote the document · ${payload.sectionCount || 0} sections`;
      case types.DOCUMENT_EDIT_PROPOSED:      return 'Proposed a change';
      case types.DOCUMENT_EDIT_APPLIED:       return this._editLabel(payload);
      case types.VERSION_ACCEPTED:            return 'Accepted version';
      case types.VERSION_REJECTED:            return 'Reverted the change';
      case types.VERSION_RESTORED:            return 'Restored an earlier state';
      case types.MESSAGE_PAIR_DELETED:        return 'Deleted a request and its response';
      case types.ASSISTANT_MESSAGE_DISCARDED: return 'Discarded a response';
      case types.BRANCH_CREATED:              return `Created branch “${payload.name || payload.branchId}”`;
      case types.BRANCH_SWITCHED:             return `Switched to “${this.branchName(payload.toBranchId)}”`;
      case types.BRANCH_RENAMED:              return `Renamed branch to “${payload.name}”`;
      case types.BRANCH_DISCARDED:            return `Archived branch “${payload.name || payload.branchId}”`;
      case types.BRANCH_DELETED:              return `Deleted branch “${payload.name || payload.branchId}”`;
      case types.MERGE_STARTED:               return `Started merging “${this.branchName(payload.sourceBranchId)}”`;
      case types.MERGE_CONFLICT:              return this._conflictLabel(payload);
      case types.MERGE_COMPLETED:             return `Merged “${payload.sourceName || this.branchName(payload.sourceBranchId)}” into ${payload.targetName || this.branchName(payload.targetBranchId)}`;
      case types.BRANCH_MERGED:               return `Branch “${payload.name || payload.branchId}” marked as merged`;
      default:                                return 'Workspace updated';
    }
  },

  /**
   * Branch ids never reach the user — always the name they gave it.
   * HectraState is a top-level const, so it is reachable by name but not as a
   * window property.
   */
  branchName(branchId) {
    const branch = typeof HectraState !== 'undefined' ? HectraState.getBranch(branchId) : null;
    return branch ? branch.name : String(branchId ?? '');
  },

  _conflictLabel(payload) {
    const resolutions = Array.isArray(payload.resolutions) ? payload.resolutions : [];
    if (resolutions.length === 1) return `Resolved merge conflict in “${this.truncate(resolutions[0].title || resolutions[0].sectionId, 34)}”`;
    return `Resolved ${resolutions.length || (payload.sectionIds || []).length} merge conflicts`;
  },

  _editLabel(payload) {
    const delta = payload.delta || {};
    const titles = [
      ...(delta.changedSections || []).map(item => item.after && item.after.title),
      ...(delta.insertedSections || []).map(item => item.after && item.after.title),
      ...(delta.deletedSections || []).map(item => item.before && item.before.title),
    ].filter(Boolean);

    if (!titles.length) return 'Edited the document';
    if (titles.length === 1) return `Edited “${this.truncate(titles[0], 40)}”`;
    return `Edited “${this.truncate(titles[0], 28)}” +${titles.length - 1} more`;
  },

  /** One-line summary of a delta, e.g. "2 sections changed · 1 added". */
  deltaSummary(delta) {
    if (!delta) return '';
    const parts = [];
    const changed = (delta.changedSections || []).length;
    const added = (delta.insertedSections || []).length;
    const removed = (delta.deletedSections || []).length;
    const moved = (delta.movedSections || []).length;

    if (changed) parts.push(`${changed} section${changed > 1 ? 's' : ''} changed`);
    if (added) parts.push(`${added} added`);
    if (removed) parts.push(`${removed} removed`);
    if (!changed && !added && !removed && moved) parts.push('reordered');
    return parts.join(' · ');
  },

  // ── Popover menus ───────────────────────────────────────────

  /**
   * Opens a menu next to an anchor element.
   * items: [{ label, note, onSelect, disabled, active, dot }] or { separator: true }
   *        or { hint: 'text' } or { sectionLabel: 'BRANCHES' }
   */
  openMenu(menuEl, anchorEl, items, options = {}) {
    if (!menuEl) return;
    this.closeMenu();

    menuEl.innerHTML = items.map((item, index) => {
      if (item.separator) return '<div class="menu-sep"></div>';
      if (item.sectionLabel) return `<div class="menu-label">${this.esc(item.sectionLabel)}</div>`;
      if (item.hint) return `<div class="menu-hint">${this.esc(item.hint)}</div>`;
      return `
        <button class="menu-item${item.active ? ' is-active' : ''}" type="button" role="menuitem"
                data-menu-index="${index}"${item.disabled ? ' disabled' : ''}
                ${item.title ? `title="${this.esc(item.title)}"` : ''}>
          ${item.dot === undefined ? '' : `<span class="menu-item-dot${item.dot ? '' : ' is-empty'}"></span>`}
          <span class="menu-item-label">${this.esc(item.label)}</span>
          ${item.note ? `<span class="menu-item-note">${this.esc(item.note)}</span>` : ''}
        </button>`;
    }).join('');

    menuEl.hidden = false;
    this._positionMenu(menuEl, anchorEl, options.align || 'start');
    requestAnimationFrame(() => menuEl.classList.add('is-open'));

    const onClick = (event) => {
      const button = event.target.closest('.menu-item');
      if (!button || button.disabled) return;
      const item = items[Number(button.dataset.menuIndex)];
      this.closeMenu();
      if (item && typeof item.onSelect === 'function') item.onSelect();
    };

    const onKeydown = (event) => {
      const focusables = Array.from(menuEl.querySelectorAll('.menu-item:not(:disabled)'));
      if (event.key === 'Escape') { event.stopPropagation(); this.closeMenu(); anchorEl?.focus?.(); return; }
      if (event.key !== 'ArrowDown' && event.key !== 'ArrowUp') return;
      event.preventDefault();
      const current = focusables.indexOf(document.activeElement);
      const next = event.key === 'ArrowDown'
        ? (current + 1) % focusables.length
        : (current <= 0 ? focusables.length - 1 : current - 1);
      focusables[next]?.focus();
    };

    const onOutside = (event) => {
      if (menuEl.contains(event.target) || (anchorEl && anchorEl.contains(event.target))) return;
      this.closeMenu();
    };

    menuEl.addEventListener('click', onClick);
    menuEl.addEventListener('keydown', onKeydown);
    document.addEventListener('mousedown', onOutside, true);
    window.addEventListener('resize', this._boundClose = () => this.closeMenu(), { passive: true });

    if (anchorEl && anchorEl.setAttribute) anchorEl.setAttribute('aria-expanded', 'true');

    this._openMenu = {
      menuEl,
      anchorEl,
      cleanup: () => {
        menuEl.removeEventListener('click', onClick);
        menuEl.removeEventListener('keydown', onKeydown);
        document.removeEventListener('mousedown', onOutside, true);
        window.removeEventListener('resize', this._boundClose);
      },
    };

    menuEl.querySelector('.menu-item:not(:disabled)')?.focus({ preventScroll: true });
  },

  closeMenu() {
    const open = this._openMenu;
    if (!open) return;
    this._openMenu = null;
    open.cleanup();
    open.menuEl.classList.remove('is-open');
    if (open.anchorEl && open.anchorEl.setAttribute) open.anchorEl.setAttribute('aria-expanded', 'false');
    setTimeout(() => {
      if (!open.menuEl.classList.contains('is-open')) open.menuEl.hidden = true;
    }, 140);
  },

  isMenuOpen(menuEl) {
    return !!this._openMenu && (!menuEl || this._openMenu.menuEl === menuEl);
  },

  _positionMenu(menuEl, anchorEl, align) {
    const margin = 10;
    const rect = anchorEl && anchorEl.getBoundingClientRect
      ? anchorEl.getBoundingClientRect()
      : { left: margin, right: margin, top: margin, bottom: margin };

    menuEl.style.left = '0px';
    menuEl.style.top = '0px';
    const width = menuEl.offsetWidth;
    const height = menuEl.offsetHeight;

    let left = align === 'end' ? rect.right - width : rect.left;
    left = Math.min(Math.max(left, margin), Math.max(margin, window.innerWidth - width - margin));

    let top = rect.bottom + 6;
    if (top + height > window.innerHeight - margin) {
      top = Math.max(margin, rect.top - height - 6);
    }

    menuEl.style.left = `${Math.round(left)}px`;
    menuEl.style.top = `${Math.round(top)}px`;
  },

  emptyState(title, subtext) {
    return `
      <div class="ui-empty">
        <div class="ui-empty-title">${this.esc(title)}</div>
        ${subtext ? `<div class="ui-empty-sub">${this.esc(subtext)}</div>` : ''}
      </div>`;
  },

  /**
   * Small confirmation for one destructive step. Deliberately not a big danger
   * modal — it states what happens and what survives. Resolves false when the
   * dialog is unavailable, so a caller can never proceed by accident.
   */
  confirm(options = {}) {
    return new Promise((resolve) => {
      const modal = document.getElementById('confirm-modal');
      if (!modal) { resolve(false); return; }

      modal.innerHTML = `
        <div class="confirm-panel" role="alertdialog" aria-modal="true" aria-labelledby="confirm-title">
          <div class="confirm-title" id="confirm-title">${this.esc(options.title || 'Are you sure?')}</div>
          ${options.body ? `<div class="confirm-body">${this.esc(options.body)}</div>` : ''}
          ${options.warning ? `<div class="confirm-warning">${this.esc(options.warning)}</div>` : ''}
          <div class="confirm-actions">
            <button class="ui-btn" type="button" data-confirm="cancel">${this.esc(options.cancelLabel || 'Cancel')}</button>
            <button class="ui-btn is-danger" type="button" data-confirm="ok">${this.esc(options.confirmLabel || 'Confirm')}</button>
          </div>
        </div>`;

      modal.hidden = false;
      requestAnimationFrame(() => modal.classList.add('is-open'));

      const finish = (value) => {
        modal.removeEventListener('click', onClick);
        document.removeEventListener('keydown', onKeydown, true);
        modal.classList.remove('is-open');
        setTimeout(() => { if (!modal.classList.contains('is-open')) { modal.hidden = true; modal.innerHTML = ''; } }, 140);
        resolve(value);
      };

      const onClick = (event) => {
        if (event.target === modal || event.target.closest('[data-confirm="cancel"]')) finish(false);
        else if (event.target.closest('[data-confirm="ok"]')) finish(true);
      };

      const onKeydown = (event) => {
        if (event.key === 'Escape') { event.stopPropagation(); finish(false); }
      };

      modal.addEventListener('click', onClick);
      document.addEventListener('keydown', onKeydown, true);
      modal.querySelector('[data-confirm="cancel"]')?.focus({ preventScroll: true });
    });
  },
};

document.addEventListener('keydown', (event) => {
  if (event.key === 'Escape') HectraUI.closeMenu();
});
