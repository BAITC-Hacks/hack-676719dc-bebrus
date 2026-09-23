// ============================================================
//  HECTRA — History UI (internal inspection panel)
// ============================================================

/**
 * INTERNAL TOOL — not part of the product surface.
 *
 * The workspace has no visible way in: no top-bar button, no menu entry. It is
 * how we read the action log while working on Hectra, not something the person
 * writing a document is asked to reason about. Two ways in, both ours:
 *
 *   Ctrl + Alt + Shift + H     toggles the panel
 *   HectraHistoryUI.open()     from the console, optionally { branchId } / { sectionId }
 *
 * What it shows is content history only — what was written, removed or
 * rewritten (HectraActionLog.CONTENT_ACTION_TYPES). Branch switches, questions,
 * responses and merge bookkeeping stay in the log and out of this panel.
 *
 * Nothing here mutates history. "Restore this state" goes through the existing
 * HectraState.restoreVersion, which appends a new action — the log stays
 * append-only.
 */
window.HectraHistoryUI = {

  /** View state only. */
  open_: false,
  filter: {},              // { branchId } | { sectionId }
  expanded: new Set(),     // actionSeq values
  preview: null,           // { msgIndex, versionIndex, actionSeq }

  init() {
    const panel = document.getElementById('history-panel');
    panel?.addEventListener('click', (event) => {
      if (event.target.closest('.panel-close')) { this.close(); return; }
      if (event.target.closest('[data-history-reset]')) { this.filter = {}; this.render(); return; }

      const sectionBtn = event.target.closest('[data-history-section]');
      if (sectionBtn) {
        event.stopPropagation();
        this.filter = { sectionId: sectionBtn.dataset.historySection };
        this.render();
        return;
      }

      const actionBtn = event.target.closest('[data-history-action]');
      if (actionBtn) {
        event.stopPropagation();
        const seq = Number(actionBtn.dataset.seq);
        if (actionBtn.dataset.historyAction === 'state') this.previewState(seq);
        else if (actionBtn.dataset.historyAction === 'restore') this.restoreState(seq);
        return;
      }

      const item = event.target.closest('.hist-item');
      if (item) this.toggleItem(Number(item.dataset.seq));
    });

    document.getElementById('history-banner')?.addEventListener('click', (event) => {
      if (event.target.closest('[data-banner="return"]')) this.exitPreview();
      else if (event.target.closest('[data-banner="restore"]')) this.restoreState(this.preview?.actionSeq);
    });

    // The only entry point. Deliberately a chord nobody reaches by accident.
    document.addEventListener('keydown', (event) => {
      if (!event.ctrlKey || !event.altKey || !event.shiftKey) return;
      if ((event.key || '').toLowerCase() !== 'h') return;
      event.preventDefault();
      this.toggle();
    });
  },

  isOpen() { return this.open_; },

  open(filter = {}) {
    this.filter = filter || {};
    this.open_ = true;
    const panel = document.getElementById('history-panel');
    if (panel) panel.hidden = false;
    this.render();
    window.HectraWorkspaceHeader?.render();
  },

  close() {
    this.open_ = false;
    const panel = document.getElementById('history-panel');
    if (panel) panel.hidden = true;
    window.HectraWorkspaceHeader?.render();
  },

  toggle() { this.open_ ? this.close() : this.open(); },

  refreshIfOpen() { if (this.open_) this.render(); },

  toggleItem(seq) {
    if (!Number.isInteger(seq)) return;
    if (this.expanded.has(seq)) this.expanded.delete(seq);
    else this.expanded.add(seq);
    this.render();
  },

  // ── Rendering ───────────────────────────────────────────────

  render() {
    const panel = document.getElementById('history-panel');
    if (!panel || !this.open_) return;

    const actions = this._visibleActions();
    panel.innerHTML = `
      <div class="panel-head">
        <span class="panel-title">History</span>
        <button class="panel-close" type="button" title="Close history" aria-label="Close history">×</button>
      </div>
      <div class="panel-body">
        ${this._scopeLine()}
        ${actions.length
          ? actions.slice().reverse().map(action => this._item(action)).join('')
          : HectraUI.emptyState('No changes yet.', 'Writing, editing and removing content appears here.')}
      </div>`;
  },

  _scopeLine() {
    const filtered = this.filter.branchId || this.filter.sectionId;
    if (!filtered) return '';

    let label = '';
    if (this.filter.branchId) {
      const branch = HectraState.getBranch(this.filter.branchId);
      label = `Branch “${branch ? branch.name : this.filter.branchId}”`;
    } else {
      const section = HectraState.documentSections.get(this.filter.sectionId);
      label = `Section “${section ? section.title : this.filter.sectionId}”`;
    }

    return `
      <div class="panel-scope">
        ${HectraUI.esc(label)}
        <button class="hist-action-btn" type="button" data-history-reset style="margin-left:8px">Show all</button>
      </div>`;
  },

  /**
   * Canonical order (actionSeq), narrowed to content changes.
   *
   * The action log answers "what happened in this workspace?"; history answers
   * the smaller question "what was written, removed or rewritten?". Everything
   * else — questions, responses, branch switches, the start and bookkeeping
   * halves of a merge — stays in the log and out of here.
   */
  _visibleActions() {
    let actions = this.filter.sectionId
      ? HectraState.getSectionHistory(this.filter.sectionId)
      : HectraState.getActions();

    if (this.filter.branchId) actions = actions.filter(action => action.branchId === this.filter.branchId);

    return actions.filter(action => HectraActionLog.isContentAction(action));
  },

  _item(action) {
    const expanded = this.expanded.has(action.actionSeq);
    const delta = action.payload && action.payload.delta;
    const summary = HectraUI.deltaSummary(delta);
    const branch = HectraState.getBranch(action.branchId);
    const showBranch = HectraState.getBranches().length > 1;

    return `
      <div class="hist-item${expanded ? ' is-open' : ''}" data-seq="${action.actionSeq}" role="button" tabindex="0"
           title="${HectraUI.esc(new Date(action.createdAtMs).toLocaleString())}">
        <div class="hist-head">
          <span class="hist-time">${HectraUI.time(action.createdAtMs)}</span>
          <span class="hist-label">${HectraUI.esc(HectraUI.actionLabel(action))}</span>
          ${showBranch ? `<span class="hist-branch">${HectraUI.esc(branch ? branch.name : action.branchId)}</span>` : ''}
        </div>
        ${summary ? `<div class="hist-sub">${HectraUI.esc(summary)}</div>` : ''}
        ${expanded ? this._detail(action, delta) : ''}
      </div>`;
  },

  _detail(action, delta) {
    const rows = [];
    // Each row is a way into that section's own history.
    const row = (id, className, text) =>
      `<button class="hist-change ${className}" type="button" data-history-section="${HectraUI.esc(id)}"
               title="Show everything that happened to this section">${text}</button>`;

    for (const item of (delta && delta.insertedSections) || []) {
      rows.push(row(item.id, 'hist-change-add', `+ added “${HectraUI.esc(HectraUI.truncate(item.after.title, 34))}”`));
    }
    for (const item of (delta && delta.deletedSections) || []) {
      rows.push(row(item.id, 'hist-change-del', `− removed “${HectraUI.esc(HectraUI.truncate(item.before.title, 34))}”`));
    }
    for (const item of (delta && delta.changedSections) || []) {
      const renamed = item.before.title !== item.after.title;
      rows.push(row(item.id, 'hist-change-mod', `~ ${renamed
        ? `renamed to “${HectraUI.esc(HectraUI.truncate(item.after.title, 26))}”`
        : `rewrote “${HectraUI.esc(HectraUI.truncate(item.after.title, 30))}”`}`));
    }
    for (const item of (delta && delta.movedSections) || []) {
      rows.push(row(item.id, 'hist-change-mod', `↕ moved “${HectraUI.esc(HectraUI.truncate(this._sectionTitle(item.id), 30))}”`));
    }

    const text = action.payload && typeof action.payload.text === 'string' ? action.payload.text : '';
    if (!rows.length && text) rows.push(`<div class="hist-change">“${HectraUI.esc(HectraUI.truncate(text, 120))}”</div>`);

    const snapshot = this._resolveSnapshot(action);
    const actions = [];
    if (snapshot) {
      actions.push(`<button class="hist-action-btn" type="button" data-history-action="state" data-seq="${action.actionSeq}">View state</button>`);
      actions.push(`<button class="hist-action-btn" type="button" data-history-action="restore" data-seq="${action.actionSeq}">Restore this state</button>`);
    }

    if (!rows.length && !actions.length) return '';
    return `
      <div class="hist-detail">
        ${rows.join('') || '<div class="hist-change">No document change.</div>'}
        ${actions.length ? `<div class="hist-detail-actions">${actions.join('')}</div>` : ''}
      </div>`;
  },

  _sectionTitle(sectionId) {
    const section = HectraState.documentSections.get(sectionId);
    return section && section.title ? section.title : sectionId;
  },

  /**
   * Maps an action to a version snapshot that still exists in the active
   * branch's track. Returns null when the state cannot be shown — the UI then
   * simply does not offer it.
   */
  _resolveSnapshot(action) {
    if (!action || action.branchId !== HectraState.branchId) return null;

    const payload = action.payload || {};
    const msgIndex = Number.isInteger(payload.messageIndex) ? payload.messageIndex : payload.targetMessageIndex;
    const versionIndex = [payload.versionIndex, payload.newVersionIndex, payload.toVersionIndex,
      payload.restoredVersionIndex, payload.acceptedVersionIndex, payload.resultVersionIndex].find(Number.isInteger);

    if (!Number.isInteger(msgIndex) || !Number.isInteger(versionIndex)) return null;

    const message = HectraState.uiMessages[msgIndex];
    const snapshot = message && message.versions && message.versions[versionIndex];
    if (!snapshot || !Array.isArray(snapshot.sections)) return null;
    return { msgIndex, versionIndex, snapshot };
  },

  // ── Historical state preview ────────────────────────────────

  /** Read-only: previewing never changes the active state. */
  async previewState(actionSeq) {
    const action = HectraState.getAction(actionSeq);
    const resolved = this._resolveSnapshot(action);
    if (!resolved) return;

    this.preview = { ...resolved, actionSeq };
    await HectraRenderer.renderAIContent(resolved.msgIndex, resolved.snapshot.sections, [], [], {});
    this._renderBanner(action);
  },

  _renderBanner(action) {
    const banner = document.getElementById('history-banner');
    if (!banner) return;

    banner.innerHTML = `
      <span class="history-banner-text">Viewing history · <b>${HectraUI.esc(HectraUI.time(action.createdAtMs))}</b> · ${HectraUI.esc(HectraUI.actionLabel(action))}</span>
      <button class="hist-action-btn" type="button" data-banner="return">Return to current</button>
      <button class="hist-action-btn" type="button" data-banner="restore">Restore this state</button>`;
    banner.hidden = false;
  },

  async exitPreview(options = {}) {
    const wasPreviewing = !!this.preview;
    this.preview = null;
    const banner = document.getElementById('history-banner');
    if (banner) { banner.hidden = true; banner.innerHTML = ''; }
    if (wasPreviewing && !options.silent) await window.renderAllMessages?.();
  },

  /** The only path that changes state — through the existing restore mechanism. */
  async restoreState(actionSeq) {
    const action = HectraState.getAction(actionSeq);
    const resolved = this._resolveSnapshot(action);
    if (!resolved) return;

    this.preview = null;
    const banner = document.getElementById('history-banner');
    if (banner) { banner.hidden = true; banner.innerHTML = ''; }

    const ok = HectraState.restoreVersion(resolved.msgIndex, resolved.versionIndex);
    if (!ok) {
      window.appendErrorMsg?.('That state could not be restored. Nothing was changed.');
      await window.renderAllMessages?.();
      return;
    }

    HectraState.saveSession();
    await window.renderAllMessages?.();
    this.refreshIfOpen();
  },
};
