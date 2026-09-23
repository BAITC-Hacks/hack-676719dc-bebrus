// ============================================================
//  HECTRA — Merge UI
// ============================================================

/**
 * Merge entry point, preview, conflict resolution and review timeline.
 *
 * Everything shown here is real: the classification comes from
 * HectraState.planMerge() (a three-way comparison against the branch's fork
 * point), the conflict view shows both actual versions, and "Apply merge" calls
 * HectraState.applyMerge(), which writes a new state of the target branch and
 * records the merge in the action log.
 *
 * Two honest boundaries:
 *   • only "Combine" calls the model, and its result is a proposal until the
 *     user accepts it;
 *   • branch discussion (context) is NOT merged — see the review screen.
 */
window.HectraMergeUI = {

  /** View state. The merge plan itself lives in this.plan and holds the decisions. */
  screen: 'choice',        // 'choice' | 'preview' | 'review' | 'conflict'
  plan: null,
  sourceBranchId: null,
  conflictSectionId: null,
  proposal: null,          // { sectionId, status: 'loading'|'ready'|'error', title, content, error }
  error: '',

  init() {
    const modal = document.getElementById('merge-modal');
    modal?.addEventListener('click', (event) => {
      if (event.target === modal || event.target.closest('[data-merge="close"]')) { this.close(); return; }

      const go = event.target.closest('[data-merge-screen]');
      if (go) { this.screen = go.dataset.mergeScreen; this.error = ''; this.render(); return; }

      const conflict = event.target.closest('[data-merge-conflict]');
      if (conflict) { this.openConflict(conflict.dataset.mergeConflict); return; }

      const resolve = event.target.closest('[data-merge-resolve]');
      if (resolve) { this.resolve(resolve.dataset.mergeResolve); return; }

      const proposal = event.target.closest('[data-merge-proposal]');
      if (proposal) {
        const action = proposal.dataset.mergeProposal;
        if (action === 'request') this.combine();
        else if (action === 'accept') this.acceptCombination();
        else if (action === 'reject') { this.proposal = null; this.render(); }
        return;
      }

      if (event.target.closest('[data-merge="apply"]')) this.apply();
    });

    document.addEventListener('keydown', (event) => {
      if (event.key === 'Escape' && this.isOpen()) this.close();
    });
  },

  isOpen() {
    const modal = document.getElementById('merge-modal');
    return !!modal && !modal.hidden;
  },

  /** Always between siblings now: the target is named, never guessed. */
  open(sourceBranchId, targetBranchId) {
    const plan = HectraState.planMerge(sourceBranchId, targetBranchId);
    if (!plan) return;

    this.plan = plan;
    this.sourceBranchId = plan.sourceBranchId;
    this.screen = 'choice';
    this.conflictSectionId = null;
    this.proposal = null;
    this.error = '';

    const modal = document.getElementById('merge-modal');
    if (!modal) return;
    modal.hidden = false;
    requestAnimationFrame(() => modal.classList.add('is-open'));
    this.render();
  },

  close() {
    const modal = document.getElementById('merge-modal');
    if (!modal || modal.hidden) return;
    this.plan = null;
    this.proposal = null;
    modal.classList.remove('is-open');
    setTimeout(() => { if (!modal.classList.contains('is-open')) { modal.hidden = true; modal.innerHTML = ''; } }, 150);
  },

  // ── Decisions ───────────────────────────────────────────────

  openConflict(sectionId) {
    this.conflictSectionId = sectionId;
    this.proposal = null;
    this.screen = 'conflict';
    this.render();
  },

  resolve(resolution) {
    const engine = window.HectraMergeEngine;
    if (!this.plan || !engine || !this.conflictSectionId) return;

    engine.resolve(this.plan, this.conflictSectionId, resolution);
    this.proposal = null;
    this.screen = 'preview';
    this.render();
  },

  /** The only model call in the merge flow. */
  async combine() {
    const item = this._item(this.conflictSectionId);
    if (!item || !window.requestMergeCombination) return;

    this.proposal = { sectionId: item.id, status: 'loading', title: item.title, content: '' };
    this.render();

    try {
      const combined = await window.requestMergeCombination({
        sectionId: item.id,
        title: item.title,
        base: item.base,
        current: item.target,
        branch: item.source,
        targetName: this.plan.targetName,
        sourceName: this.plan.sourceName,
      });
      if (!this.plan || this.conflictSectionId !== item.id) return;   // user moved on
      this.proposal = { sectionId: item.id, status: 'ready', title: combined.title || item.title, content: combined.content };
    } catch (error) {
      this.proposal = { sectionId: item.id, status: 'error', title: item.title, content: '', error: error.message || 'The model could not be reached.' };
    }
    this.render();
  },

  acceptCombination() {
    const engine = window.HectraMergeEngine;
    if (!engine || !this.plan || !this.proposal || this.proposal.status !== 'ready') return;

    engine.resolve(this.plan, this.proposal.sectionId, engine.RESOLUTIONS.COMBINED, {
      combined: { title: this.proposal.title, content: this.proposal.content },
    });
    this.proposal = null;
    this.screen = 'preview';
    this.render();
  },

  /** Applies the merge and leaves the user on the target branch. */
  async apply() {
    if (!this.plan || !this.plan.canApply || HectraState.isLoading) return;

    window.setStatus?.('merging');
    const outcome = HectraState.applyMerge(this.plan);

    if (!outcome.ok) {
      this.error = this._failureText(outcome.reason);
      window.setStatus?.('error', 'Merge failed');
      this.render();
      return;
    }

    HectraState.saveSession();
    this.close();

    await window.renderAllMessages?.();
    await window.showDocumentDiff?.(outcome.messageIndex, outcome.appliedSectionIds, outcome.removedSectionIds);
    window.HectraMapUI?.refreshIfVisible();
    window.HectraHistoryUI?.refreshIfOpen();
    window.HectraBranchUI?.refresh();
    // The source has left the map; the survivor says so for a moment.
    const count = outcome.appliedSectionIds.length;
    window.HectraMapUI?.flash(outcome.targetBranchId, `${count} change${count === 1 ? '' : 's'} taken in`);
    window.setStatus?.('ready');
  },

  _failureText(reason) {
    const map = {
      unresolved: 'Some conflicts are still undecided.',
      'empty-result': 'That combination would leave the document empty; nothing was merged.',
      'invalid-result': 'The merged document was not valid; nothing was merged.',
      'target-unavailable': 'The target branch could not be opened; nothing was merged.',
      'no-document': 'The target branch has no document to merge into; nothing was merged.',
      'unknown-branch': 'That branch no longer exists; nothing was merged.',
      'source-has-branches': 'This branch has branches of its own. They have to be merged first — otherwise they lose the point they grew out of.',
    };
    return map[reason] || 'The merge could not be applied; nothing was changed.';
  },

  // ── Rendering ───────────────────────────────────────────────

  _item(sectionId) {
    const engine = window.HectraMergeEngine;
    return this.plan && engine ? engine.findItem(this.plan, sectionId) : null;
  },

  render() {
    const modal = document.getElementById('merge-modal');
    if (!modal || modal.hidden) return;
    if (!this.plan) { this.close(); return; }

    const body = this.screen === 'preview' ? this._previewScreen()
      : this.screen === 'review' ? this._reviewScreen()
      : this.screen === 'conflict' ? this._conflictScreen()
      : this._choiceScreen();

    modal.innerHTML = `
      <div class="merge-panel" role="dialog" aria-modal="true" aria-labelledby="merge-title">
        <div class="merge-head">
          <span class="merge-title" id="merge-title">Merge “${HectraUI.esc(this.plan.sourceName)}” into ${HectraUI.esc(this.plan.targetName)}</span>
          <button class="panel-close" type="button" data-merge="close" title="Close" aria-label="Close merge">×</button>
        </div>
        ${body}
      </div>`;
    modal.querySelector('.merge-choice, .merge-btn, .panel-close')?.focus({ preventScroll: true });
  },

  _choiceScreen() {
    if (!this.plan.hasChanges) {
      const merged = this.plan.alreadyMerged;
      return `
        <div class="merge-body">
          ${HectraUI.emptyState(
            merged ? 'Already merged.' : 'No changes to merge.',
            merged
              ? `Everything “${this.plan.sourceName}” changed is already in ${this.plan.targetName}.`
              : `“${this.plan.sourceName}” has not changed the document since it branched off.`)}
        </div>
        <div class="merge-foot">
          <span class="merge-foot-note"></span>
          <button class="merge-btn merge-btn-quiet" type="button" data-merge="close">Close</button>
        </div>`;
    }

    const conflicts = this.plan.conflicts.length;
    return `
      <div class="merge-body">
        <button class="merge-choice" type="button" data-merge-screen="preview">
          <span class="merge-choice-title">Quick merge</span>
          <span class="merge-choice-sub">Review the compatible changes, then apply them.${conflicts ? ` ${conflicts} overlapping section${conflicts > 1 ? 's need' : ' needs'} a decision.` : ''}</span>
        </button>
        <button class="merge-choice" type="button" data-merge-screen="review">
          <span class="merge-choice-title">Review merge</span>
          <span class="merge-choice-sub">Walk the branch history in order before merging.</span>
        </button>
      </div>
      <div class="merge-foot">
        <span class="merge-foot-note"></span>
        <button class="merge-btn merge-btn-quiet" type="button" data-merge="close">Cancel</button>
      </div>`;
  },

  _previewScreen() {
    const engine = window.HectraMergeEngine;
    const compatible = this.plan.items.filter(item => item.status === engine.ITEM_STATUS.COMPATIBLE);
    const conflicts = this.plan.items.filter(item => item.status === engine.ITEM_STATUS.CONFLICT);
    const rows = [...compatible, ...conflicts].map(item => this._row(item)).join('');

    return `
      <div class="merge-body">
        <div class="merge-summary">
          ${compatible.length} compatible change${compatible.length === 1 ? '' : 's'} ·
          ${conflicts.length} overlapping section${conflicts.length === 1 ? '' : 's'}
        </div>
        ${rows || HectraUI.emptyState('Nothing to merge.', 'This branch has no section changes.')}
      </div>
      ${this._foot()}`;
  },

  _row(item) {
    const engine = window.HectraMergeEngine;
    const isConflict = item.status === engine.ITEM_STATUS.CONFLICT;
    const decided = isConflict && !!item.resolution;

    const mark = decided ? '✓' : isConflict ? '!' : '✓';
    const markClass = decided ? 'is-ok' : isConflict ? 'is-conflict' : 'is-ok';

    return `
      <div class="merge-row${isConflict ? ' is-clickable' : ''}"${isConflict
        ? ` role="button" tabindex="0" data-merge-conflict="${HectraUI.esc(item.id)}" title="Compare both versions"`
        : ''}>
        <span class="merge-row-mark ${markClass}">${mark}</span>
        <span>
          <span class="merge-row-title">${HectraUI.esc(item.title)}</span>
          <span class="merge-row-sub">${HectraUI.esc(this._rowSub(item))}</span>
        </span>
        ${isConflict && !decided ? '<span class="merge-row-cta">Resolve</span>' : ''}
      </div>`;
  },

  _rowSub(item) {
    const engine = window.HectraMergeEngine;
    if (item.status === engine.ITEM_STATUS.CONFLICT) {
      if (item.resolution === engine.RESOLUTIONS.COMBINED) return 'Resolved · combined version';
      if (item.resolution === engine.RESOLUTIONS.SOURCE) return `Resolved · using “${this.plan.sourceName}”`;
      if (item.resolution === engine.RESOLUTIONS.TARGET) return `Resolved · keeping ${this.plan.targetName}`;
      return this._conflictText(item);
    }

    if (item.kind === engine.CHANGE_KINDS.ORDER) return 'Compatible · section order changed on this branch';
    if (item.reason === engine.REASONS.IDENTICAL) return 'Compatible · both sides made the same change';
    const change = item.kind === engine.CHANGE_KINDS.ADDED ? 'New section on this branch'
      : item.kind === engine.CHANGE_KINDS.REMOVED ? 'Removed on this branch'
      : 'Rewritten on this branch';
    return `Compatible · ${change}`;
  },

  _conflictText(item) {
    const engine = window.HectraMergeEngine;
    switch (item.reason) {
      case engine.REASONS.DELETED_BY_SOURCE: return `This branch removed the section, but ${this.plan.targetName} modified it`;
      case engine.REASONS.DELETED_BY_TARGET: return `${this.plan.targetName} removed the section, but this branch modified it`;
      case engine.REASONS.BOTH_ADDED:        return 'Both sides added a different section with this id';
      case engine.REASONS.ORDER:             return 'Both sides reordered the document differently';
      default:                               return 'Both branches changed this section';
    }
  },

  _conflictScreen() {
    const engine = window.HectraMergeEngine;
    const item = this._item(this.conflictSectionId)
      || this.plan.items.find(entry => entry.status === engine.ITEM_STATUS.CONFLICT);
    if (!item) { this.screen = 'preview'; return this._previewScreen(); }
    this.conflictSectionId = item.id;

    const compare = item.kind === engine.CHANGE_KINDS.ORDER
      ? this._orderCompare()
      : `
        <div class="merge-compare">
          <div>
            <div class="merge-side-label">Current (${HectraUI.esc(this.plan.targetName)})</div>
            <div class="merge-side-text">${HectraUI.esc(item.target ? item.target.content : '— removed —')}</div>
          </div>
          <div>
            <div class="merge-side-label">Branch (${HectraUI.esc(this.plan.sourceName)})</div>
            <div class="merge-side-text">${HectraUI.esc(item.source ? item.source.content : '— removed —')}</div>
          </div>
        </div>
        ${item.base ? `<details class="merge-base"><summary>Original, before the branch</summary><div class="merge-side-text">${HectraUI.esc(item.base.content)}</div></details>` : ''}`;

    return `
      <div class="merge-body">
        <div class="merge-summary">${HectraUI.esc(item.title)} — ${HectraUI.esc(this._conflictText(item).toLowerCase())}.</div>
        ${compare}
        ${this._proposalBlock(item)}
      </div>
      <div class="merge-foot">
        <span class="merge-foot-note">${item.resolution ? 'Decision recorded — it applies when you merge.' : 'Pick one version to continue.'}</span>
        <button class="merge-btn merge-btn-quiet" type="button" data-merge-screen="preview">Back</button>
        ${this._conflictActions(item)}
      </div>`;
  },

  _orderCompare() {
    const analysis = this.plan.order;
    const titles = ids => ids.map(id => {
      const item = this.plan.items.find(entry => entry.id === id);
      const section = HectraState.documentSections.get(id);
      return HectraUI.truncate((item && item.title) || (section && section.title) || id, 22);
    }).join(' → ');

    return `
      <div class="merge-compare">
        <div>
          <div class="merge-side-label">Current (${HectraUI.esc(this.plan.targetName)})</div>
          <div class="merge-side-text">${HectraUI.esc(titles(analysis.targetSeq))}</div>
        </div>
        <div>
          <div class="merge-side-label">Branch (${HectraUI.esc(this.plan.sourceName)})</div>
          <div class="merge-side-text">${HectraUI.esc(titles(analysis.sourceSeq))}</div>
        </div>
      </div>`;
  },

  _conflictActions(item) {
    const engine = window.HectraMergeEngine;
    const keep = item.reason === engine.REASONS.DELETED_BY_TARGET ? 'Keep deletion'
      : item.kind === engine.CHANGE_KINDS.ORDER ? 'Keep current order'
      : 'Keep current';
    const use = item.reason === engine.REASONS.DELETED_BY_SOURCE ? 'Delete section'
      : item.reason === engine.REASONS.DELETED_BY_TARGET ? 'Restore from branch'
      : item.kind === engine.CHANGE_KINDS.ORDER ? 'Use branch order'
      : 'Use branch';

    // Combining two texts only makes sense when there are two texts.
    const canCombine = !!item.target && !!item.source && item.kind !== engine.CHANGE_KINDS.ORDER;
    const busy = this.proposal && this.proposal.sectionId === item.id && this.proposal.status === 'loading';

    return `
      <button class="merge-btn${item.resolution === engine.RESOLUTIONS.TARGET ? ' is-chosen' : ''}" type="button"
              data-merge-resolve="${engine.RESOLUTIONS.TARGET}">${keep}</button>
      <button class="merge-btn${item.resolution === engine.RESOLUTIONS.SOURCE ? ' is-chosen' : ''}" type="button"
              data-merge-resolve="${engine.RESOLUTIONS.SOURCE}">${use}</button>
      ${canCombine ? `<button class="merge-btn" type="button" data-merge-proposal="request"${busy ? ' disabled' : ''}>${busy ? 'Combining…' : 'Combine'}</button>` : ''}`;
  },

  /** An AI combination is a proposal until it is explicitly accepted. */
  _proposalBlock(item) {
    const proposal = this.proposal && this.proposal.sectionId === item.id ? this.proposal : null;
    if (!proposal) {
      return item.resolution === window.HectraMergeEngine.RESOLUTIONS.COMBINED && item.combined
        ? `<div class="merge-proposal">
             <div class="merge-side-label">Combined text selected for merge</div>
             <div class="merge-side-text">${HectraUI.esc(item.combined.content)}</div>
           </div>`
        : '';
    }

    if (proposal.status === 'loading') {
      return '<div class="merge-proposal is-loading">Asking the model to combine both versions…</div>';
    }
    if (proposal.status === 'error') {
      return `<div class="merge-proposal is-error">${HectraUI.esc(proposal.error)}</div>`;
    }

    return `
      <div class="merge-proposal">
        <div class="merge-side-label">AI combination</div>
        <div class="merge-side-text">${HectraUI.esc(proposal.content)}</div>
        <div class="merge-proposal-actions">
          <button class="merge-btn merge-btn-quiet" type="button" data-merge-proposal="reject">Discard combination</button>
          <button class="merge-btn is-primary" type="button" data-merge-proposal="accept">Use combined text</button>
        </div>
      </div>`;
  },

  /**
   * Review timeline: real actions in canonical actionSeq order, with human
   * timestamps. It is a reading view — merging document state does not move the
   * branch conversation into the target.
   */
  _reviewScreen() {
    const branch = HectraState.getBranch(this.plan.sourceBranchId);
    const forkSeq = branch && Number.isInteger(branch.forkActionSeq) ? branch.forkActionSeq : 0;
    const types = HectraActionLog.ACTION_TYPES;
    const noise = new Set([types.DOCUMENT_EDIT_PROPOSED, types.BRANCH_SWITCHED]);

    const actions = HectraState.getActionsAfter(Math.max(0, forkSeq - 1))
      .filter(action => action.branchId === this.plan.sourceBranchId || action.actionSeq === forkSeq)
      .filter(action => !noise.has(action.type));

    const items = actions.map(action => `
      <div class="merge-timeline-item">
        <span class="merge-timeline-time">${HectraUI.time(action.createdAtMs)}</span>
        <span class="merge-timeline-body">
          <span class="merge-timeline-label">${HectraUI.esc(HectraUI.actionLabel(action))}</span>
          <span class="merge-timeline-branch">${HectraUI.esc(HectraUI.branchName(action.branchId))}</span>
        </span>
      </div>`).join('');

    return `
      <div class="merge-body">
        <div class="merge-summary">Branch history in workspace order · ${actions.length} step${actions.length === 1 ? '' : 's'}</div>
        ${items || HectraUI.emptyState('Nothing recorded on this branch yet.')}
        <div class="merge-note">Merging carries the document state. This discussion stays on the branch — Hectra does not move branch messages into ${HectraUI.esc(this.plan.targetName)}.</div>
      </div>
      ${this._foot()}`;
  },

  _foot() {
    const left = this.plan.unresolved.length;
    const note = this.error
      ? this.error
      : left
        ? `${left} conflict${left > 1 ? 's' : ''} left to resolve`
        : this.plan.hasChanges ? `Ready · creates a new state of ${this.plan.targetName}` : '';

    return `
      <div class="merge-foot">
        <span class="merge-foot-note${this.error ? ' is-error' : ''}">${HectraUI.esc(note)}</span>
        <button class="merge-btn merge-btn-quiet" type="button" data-merge-screen="choice">Back</button>
        <button class="merge-btn is-primary" type="button" data-merge="apply"${this.plan.canApply ? '' : ' disabled'}
                title="${HectraUI.esc(this.plan.canApply ? `Apply into ${this.plan.targetName}` : note)}">Apply merge</button>
      </div>`;
  },
};
