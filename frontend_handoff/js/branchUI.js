// ============================================================
//  HECTRA — Branch UI (sidebar, selector, composer context)
// ============================================================

/**
 * Presentation layer for branches. Every branch fact comes from HectraState —
 * this module keeps only view state (which workspace rows are expanded, which
 * sections the composer is pointed at).
 */
window.HectraBranchUI = {

  /** View state only. */
  expandedWorkspaces: new Set(),
  showArchived: false,
  sectionFocus: null,          // { mode: 'edit' | 'explore', sectionIds, titles, selectedText }

  init() {
    const chip = document.getElementById('branch-chip');
    chip?.addEventListener('click', () => this.toggleBranchMenu());

    // Delegated: sidebar rows are re-rendered constantly.
    document.getElementById('chat-history-list')?.addEventListener('click', (event) => {
      const caret = event.target.closest('.ws-caret');
      if (caret) {
        event.stopPropagation();
        this.toggleWorkspace(caret.closest('.ws-item')?.dataset.sessionId);
        return;
      }

      const more = event.target.closest('.branch-more');
      if (more) {
        event.stopPropagation();
        const row = more.closest('.branch-row');
        this.openBranchRowMenu(row?.dataset.branchId, row?.dataset.sessionId, more);
        return;
      }

      const branchRow = event.target.closest('.branch-row');
      if (branchRow) {
        event.stopPropagation();
        this.openWorkspaceBranch(branchRow.dataset.sessionId, branchRow.dataset.branchId);
        return;
      }

      const del = event.target.closest('.ws-delete');
      if (del) {
        event.stopPropagation();
        window.deleteWorkspace?.(del.closest('.ws-item')?.dataset.sessionId);
        return;
      }

      const row = event.target.closest('.ws-row');
      if (row) this.openWorkspaceBranch(row.closest('.ws-item')?.dataset.sessionId, null);
    });

    document.getElementById('composer-context')?.addEventListener('click', (event) => {
      if (event.target.closest('.ctx-chip-clear')) this.clearContext();
    });
  },

  // ── Sidebar: workspaces and branches ────────────────────────

  renderWorkspaces() {
    const list = document.getElementById('chat-history-list');
    if (!list) return;

    const sessions = HectraState.getAllSessionMeta();
    if (!sessions.length) {
      list.innerHTML = '<span class="sidebar-empty">No workspaces yet</span>';
      return;
    }

    list.innerHTML = sessions.map(meta => this._workspaceRow(meta)).join('');
  },

  _workspaceRow(meta) {
    const isActive = meta.id === HectraState.sessionId;
    const branchCount = isActive
      ? HectraState.getVisibleBranches().length
      : (Number.isInteger(meta.branchCount) ? meta.branchCount : 1);
    const hasBranches = branchCount > 1;
    const expanded = this.expandedWorkspaces.has(meta.id) && hasBranches;
    const visible = expanded ? this._branchesOf(meta) : [];

    return `
      <div class="ws-item${isActive ? ' is-active' : ''}${expanded ? ' is-expanded' : ''}" data-session-id="${HectraUI.esc(meta.id)}">
        <div class="ws-row" role="button" tabindex="0" title="${HectraUI.esc(meta.title || 'Workspace')}">
          <button class="ws-caret${hasBranches ? '' : ' is-empty'}" type="button" tabindex="${hasBranches ? '0' : '-1'}"
                  aria-label="${expanded ? 'Collapse' : 'Expand'} branches of ${HectraUI.esc(meta.title || 'workspace')}"
                  aria-expanded="${expanded ? 'true' : 'false'}">
            <svg width="9" height="9" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="3" stroke-linecap="round" aria-hidden="true">
              <polyline points="9 18 15 12 9 6"></polyline>
            </svg>
          </button>
          <span class="ws-title">${HectraUI.esc(meta.title || 'New workspace')}</span>
          ${hasBranches ? `<span class="ws-count">${branchCount}</span>` : ''}
          <button class="ws-delete" type="button" title="Delete workspace" aria-label="Delete workspace ${HectraUI.esc(meta.title || '')}">×</button>
        </div>
        <div class="ws-branches">
          ${visible.map(branch => this._branchRow(branch, meta.id, isActive)).join('')}
        </div>
      </div>`;
  },

  _branchRow(branch, sessionId, sessionIsActive) {
    const isActive = sessionIsActive && branch.id === HectraState.branchId;
    const divergence = sessionIsActive ? HectraState.getBranchDivergence(branch.id) : null;
    const changes = divergence && divergence.changedSectionCount ? String(divergence.changedSectionCount) : '';

    return `
      <div class="branch-row${isActive ? ' is-active' : ''}${branch.status === 'archived' ? ' is-archived' : ''}"
           role="button" tabindex="0"
           data-branch-id="${HectraUI.esc(branch.id)}" data-session-id="${HectraUI.esc(sessionId)}"
           title="${HectraUI.esc(branch.name)}${branch.status === 'archived' ? ' · archived' : ''}">
        <span class="branch-dot" aria-hidden="true" style="${isActive ? '' : 'opacity:.4'}"></span>
        <span class="branch-row-name">${HectraUI.esc(branch.name)}</span>
        ${branch.priority > 0 ? '<span class="branch-star" title="Preferred branch">★</span>' : ''}
        ${changes ? `<span class="branch-row-badge" title="${divergence.changedSectionCount} section${divergence.changedSectionCount > 1 ? 's' : ''} changed on this branch">${changes}</span>` : ''}
        <button class="branch-more" type="button" title="Branch actions" aria-label="Actions for branch ${HectraUI.esc(branch.name)}" aria-haspopup="menu">⋯</button>
      </div>`;
  },

  /** Live branches for the open workspace; the stored ones for the others. */
  _branchesOf(meta) {
    if (meta.id === HectraState.sessionId) return HectraState.getVisibleBranches({ includeArchived: this.showArchived });

    const session = HectraState.getSession(meta.id);
    if (Array.isArray(session?.branches) && window.HectraActionLog) {
      return HectraActionLog.normalizeBranches(session.branches)
        .filter(branch => branch.status !== 'deleted' && (this.showArchived || branch.status !== 'archived'));
    }
    return [{ id: 'main', name: 'main', status: 'open', priority: 0 }];
  },

  toggleWorkspace(sessionId) {
    if (!sessionId) return;
    if (this.expandedWorkspaces.has(sessionId)) this.expandedWorkspaces.delete(sessionId);
    else this.expandedWorkspaces.add(sessionId);
    this.renderWorkspaces();
  },

  /** Opens a workspace and, optionally, one of its branches. */
  async openWorkspaceBranch(sessionId, branchId) {
    if (!sessionId || HectraState.isLoading) return false;
    let guardHandled = false;

    if (sessionId !== HectraState.sessionId) {
      const data = HectraState.getSession(sessionId);
      if (!data) return false;
      const allowed = await window.guardComposerNavigation?.({
        targetLabel: data.title || 'another workspace',
      });
      if (allowed === false) return false;
      guardHandled = true;
      window.HectraSelectionUI?.hide();
      await window.restoreSessionUI?.(data, { skipDraftGuard: true });
    }

    if (branchId && branchId !== HectraState.branchId) {
      const switched = await this.switchTo(branchId, { skipDraftGuard: guardHandled });
      if (!switched) return false;
    }
    else this.refresh();

    window.setSidebarOpen?.(false);
    return true;
  },

  // ── Branch selector ─────────────────────────────────────────

  toggleBranchMenu() {
    const menu = document.getElementById('branch-menu');
    const chip = document.getElementById('branch-chip');
    if (!menu || !chip) return;
    if (HectraUI.isMenuOpen(menu)) { HectraUI.closeMenu(); return; }

    const active = HectraState.branchId;
    const branches = HectraState.getVisibleBranches({ includeArchived: this.showArchived });
    const items = [{ sectionLabel: 'Branches' }];

    for (const branch of branches) {
      const divergence = HectraState.getBranchDivergence(branch.id);
      const notes = [];
      if (divergence && divergence.changedSectionCount) {
        notes.push(`${divergence.changedSectionCount} change${divergence.changedSectionCount > 1 ? 's' : ''}`);
      }
      if (branch.status === 'archived') notes.push('archived');
      if (!HectraState.isBranchLeaf(branch.id)) notes.push('closed');

      items.push({
        label: branch.priority > 0 ? `★ ${branch.name}` : branch.name,
        note: notes.join(' · '),
        dot: branch.id === active,
        active: branch.id === active,
        onSelect: () => this.switchTo(branch.id),
      });
    }

    const canBranch = HectraState.uiMessages.length > 0;
    items.push({ separator: true });
    items.push({
      label: '+ New branch',
      disabled: !canBranch,
      onSelect: () => this.createBranch(),
    });
    if (!canBranch) items.push({ hint: 'Write something first — a branch continues from the current document.' });
    else items.push({ hint: 'Or press Branch on any message to fork from that point.' });

    HectraUI.openMenu(menu, chip, items);
  },

  openBranchRowMenu(branchId, sessionId, anchor) {
    if (!branchId) return;

    // Branch actions need the branch's live track, so open its workspace first.
    if (sessionId && sessionId !== HectraState.sessionId) {
      this.openWorkspaceBranch(sessionId, branchId);
      return;
    }

    const branch = HectraState.getBranch(branchId);
    if (!branch) return;
    HectraUI.openMenu(document.getElementById('context-menu'), anchor, this.branchMenuItems(branch, { anchor }), { align: 'end' });
  },

  /** One menu definition for the sidebar row and the map node. */
  branchMenuItems(branch, options = {}) {
    const isMain = branch.id === (window.HectraActionLog ? HectraActionLog.DEFAULT_BRANCH_ID : 'main');
    const removable = HectraState.canDeleteBranch(branch.id);

    const items = [];
    if (options.withTitle) items.push({ sectionLabel: HectraUI.truncate(branch.name, 26) });

    items.push({ label: 'Open branch', onSelect: () => this.switchTo(branch.id) });
    if (!options.fromMap) items.push({ label: 'View in map', onSelect: () => window.HectraMapUI?.show(branch.id) });
    items.push({ separator: true });
    items.push({ label: 'Rename', onSelect: () => this.renameBranch(branch.id) });
    items.push({
      label: branch.priority > 0 ? 'Preferred branch' : 'Set as preferred',
      disabled: branch.priority > 0,
      onSelect: () => { HectraState.setPreferredBranch(branch.id); HectraState.saveSession(); this.refresh(); window.HectraMapUI?.refreshIfVisible(); },
    });

    if (!isMain) {
      items.push(...this.mergeMenuItems(branch, options.anchor));
      items.push({ separator: true });
      items.push({
        label: branch.status === 'archived' ? 'Archived' : 'Archive',
        disabled: branch.status === 'archived',
        onSelect: () => this.archiveBranch(branch.id),
      });
      items.push({
        label: 'Delete branch',
        disabled: !removable.allowed,
        title: removable.allowed ? '' : removable.reason,
        onSelect: () => this.deleteBranch(branch.id),
      });
      if (!removable.allowed) items.push({ hint: removable.reason });
    }

    return items;
  },

  // ── Merge: two operations, never one ────────────────────────
  //
  // With a sibling, because they grew from the same point and can be compared.
  // With the ancestor, because a branch and the point it left are one run of
  // writing — that one only removes a boundary. Both are offered to leaves, so
  // a tree always resolves from the bottom up.

  mergeMenuItems(branch, anchor) {
    const siblings = HectraState.getSiblingMergeCandidates(branch.id);
    const collapse = HectraState.canCollapseIntoParent(branch.id);
    const blocked = !HectraState.isBranchLeaf(branch.id);

    return [
      {
        label: 'Merge alternatives',
        note: siblings.length > 1 ? `${siblings.length}` : (siblings.length === 1 ? siblings[0].name : ''),
        disabled: !siblings.length,
        title: siblings.length
          ? 'Merge with a branch that split from the same point'
          : (blocked
            ? 'Its own branches have to be merged first'
            : 'Nothing else split from the same point'),
        onSelect: () => this.openSiblingMergeMenu(branch.id, anchor),
      },
      {
        label: 'Continue as one branch',
        note: collapse.code === 'has-siblings' ? `${collapse.abandonedCount} to archive` : '',
        disabled: collapse.code === 'root' || collapse.code === 'no-parent'
          || collapse.code === 'not-open' || collapse.code === 'unknown',
        title: collapse.allowed ? `Continue the parent and this branch as “${collapse.mergedName}”` : collapse.reason,
        onSelect: () => this.collapseBranch(branch.id),
      },
    ];
  },

  /** One sibling merges straight away; several ask which one. */
  openSiblingMergeMenu(branchId, anchor) {
    const candidates = HectraState.getSiblingMergeCandidates(branchId);
    if (!candidates.length) return;
    if (candidates.length === 1) { window.HectraMergeUI?.open(branchId, candidates[0].id); return; }

    HectraUI.openMenu(document.getElementById('context-menu'), anchor || document.getElementById('branch-chip'), [
      { sectionLabel: 'Merge alternatives' },
      ...candidates.map(candidate => ({
        label: candidate.name,
        onSelect: () => window.HectraMergeUI?.open(branchId, candidate.id),
      })),
    ], { align: 'end' });
  },

  /**
   * Merging with the ancestor is not a merge and has nothing to preview: the
   * two are already one run of writing. All it can ask about is what it costs —
   * the branches that split from the same point and would be given up.
   */
  async collapseBranch(branchId) {
    const branch = HectraState.getBranch(branchId);
    const check = HectraState.canCollapseIntoParent(branchId);
    if (!branch || (!check.allowed && check.code !== 'has-siblings')) {
      if (check.reason) window.appendErrorMsg?.(check.reason);
      return;
    }

    const givingUp = check.code === 'has-siblings';
    const count = Number(check.abandonedCount || 0);
    const ok = await HectraUI.confirm({
      title: 'Continue as one branch?',
      body: `This will continue the parent and this branch as one line of work${givingUp ? ` and archive ${count} other alternative${count === 1 ? '' : 's'}` : ''}. The result will be named “${check.mergedName}”.`,
      warning: givingUp ? 'Archived alternatives stay in the action log.' : '',
      confirmLabel: 'Continue as one branch',
    });
    if (!ok) return;

    const result = HectraState.collapseIntoParent(branchId, { adopt: givingUp });
    if (!result) {
      window.appendErrorMsg?.('That merge could not be completed. Nothing was changed.');
      return;
    }

    HectraState.saveSession();
    await window.renderAllMessages?.();
    this.refresh();
    window.HectraMapUI?.refreshIfVisible();
    window.HectraMapUI?.flash(result.branchId, `${result.previousName} + ${result.childName}`);
    window.setStatus?.('ready');
  },

  // ── Branch operations (all through HectraState) ─────────────

  async switchTo(branchId, options = {}) {
    if (HectraState.isLoading) return false;
    if (branchId === HectraState.branchId) return true;
    const target = HectraState.getBranch(branchId);
    if (!options.skipDraftGuard) {
      const allowed = await window.guardComposerNavigation?.({
        targetLabel: target?.name || 'another branch',
      });
      if (allowed === false) return false;
    }

    window.HectraSelectionUI?.hide();
    window.HectraHistoryUI?.exitPreview({ silent: true });
    window.setStatus?.('switching');
    const ok = HectraState.switchBranch(branchId);
    if (!ok) {
      window.setStatus?.('error', 'Branch unavailable');
      window.appendErrorMsg?.('That branch has no stored state and was not opened.');
      return false;
    }

    this.sectionFocus = null;
    HectraState.saveSession();
    await window.renderAllMessages?.();
    window.HectraMapUI?.refreshIfVisible();
    window.HectraHistoryUI?.refreshIfOpen();
    this.refresh();
    window.setStatus?.('ready');
    return true;
  },

  /** Branch creation is one click: auto-named, switched to, renameable later. */
  async createBranch(options = {}) {
    if (HectraState.isLoading) return null;
    if (!HectraState.uiMessages.length) {
      window.appendErrorMsg?.('Start the document before branching.');
      return null;
    }
    if (!options.skipDraftGuard) {
      const allowed = await window.guardComposerNavigation?.({
        targetLabel: options.name || 'a new alternative',
      });
      if (allowed === false) return null;
    }

    window.HectraSelectionUI?.hide();
    window.setStatus?.('branching');
    const branch = HectraState.createBranch(options.name || null, options);
    if (!branch) {
      window.setStatus?.('error', 'Could not create branch');
      window.appendErrorMsg?.('The branch could not be created — nothing was changed.');
      return null;
    }

    this.expandedWorkspaces.add(HectraState.sessionId);
    HectraState.saveSession();
    await window.renderAllMessages?.();
    window.HectraMapUI?.refreshIfVisible();
    window.HectraHistoryUI?.refreshIfOpen();
    this.refresh();
    window.setStatus?.('ready');
    return branch;
  },

  /**
   * "Branch from here" on any message: the fork keeps the conversation and the
   * document state as they were at that message.
   */
  async branchFromMessage(msgIndex) {
    const index = Number(msgIndex);
    const message = HectraState.uiMessages[index];
    if (!message) return null;

    const label = message.type === 'user'
      ? HectraUI.truncate(message.text || 'Request', 32)
      : `From response ${Math.floor(index / 2) + 1}`;

    const branch = await this.createBranch({ fromMessageIndex: index, name: label });
    if (!branch) return null;

    document.getElementById('user-input')?.focus();
    return branch;
  },

  renameBranch(branchId) {
    const branch = HectraState.getBranch(branchId);
    if (!branch) return;
    const next = window.prompt('Branch name', branch.name);
    if (next === null) return;
    if (!next.trim()) return;
    HectraState.renameBranch(branchId, next);
    HectraState.saveSession();
    this.refresh();
    window.HectraMapUI?.refreshIfVisible();
    window.HectraHistoryUI?.refreshIfOpen();
  },

  async archiveBranch(branchId) {
    const branch = HectraState.getBranch(branchId);
    if (!branch) return;
    const wasActive = branchId === HectraState.branchId;
    if (!HectraState.archiveBranch(branchId)) return;

    HectraState.saveSession();
    if (wasActive) await window.renderAllMessages?.();
    this.refresh();
    window.HectraMapUI?.refreshIfVisible();
    window.HectraHistoryUI?.refreshIfOpen();
  },

  /**
   * Deleting is a soft delete and only ever offered for a leaf branch — the
   * state layer refuses anything that would orphan a descendant.
   */
  async deleteBranch(branchId) {
    const branch = HectraState.getBranch(branchId);
    if (!branch) return;

    const check = HectraState.canDeleteBranch(branchId);
    if (!check.allowed) {
      window.appendErrorMsg?.(check.reason);
      return;
    }

    const warning = check.hasUnmergedChanges
      ? 'This branch contains unmerged changes.'
      : '';
    const confirmed = await HectraUI.confirm({
      title: `Delete “${branch.name}”?`,
      body: 'This removes the branch from the active workspace view. Its historical actions remain for state integrity.',
      warning,
      confirmLabel: 'Delete branch',
    });
    if (!confirmed) return;

    const wasActive = branchId === HectraState.branchId;
    if (!HectraState.deleteBranch(branchId)) {
      window.appendErrorMsg?.('That branch could not be deleted — nothing was changed.');
      return;
    }

    HectraState.saveSession();
    if (wasActive) await window.renderAllMessages?.();
    this.refresh();
    window.HectraMapUI?.refreshIfVisible();
    window.HectraHistoryUI?.refreshIfOpen();
  },

  // ── Section-scoped actions (from the selection toolbar) ─────

  /**
   * Points the composer at one or more sections. targetSectionIds — not the
   * selected string — is what the instruction is scoped to.
   */
  focusSections(sectionIds, mode, options = {}) {
    const ids = (Array.isArray(sectionIds) ? sectionIds : [sectionIds])
      .filter(id => HectraState.documentSections.has(id));
    if (!ids.length) return;

    this.sectionFocus = {
      mode,
      sectionIds: ids,
      titles: ids.map(id => HectraState.documentSections.get(id).title || id),
      selectedText: typeof options.selectedText === 'string' ? options.selectedText : '',
    };

    if (mode === 'edit') window.enterEditMode?.(HectraState.lastAIIndex);
    this.renderComposerContext();
    document.getElementById('user-input')?.focus();
  },

  /** Explore: a branch that continues exactly the selected sections. */
  async exploreSections(sectionIds, options = {}) {
    const ids = (Array.isArray(sectionIds) ? sectionIds : [sectionIds])
      .filter(id => HectraState.documentSections.has(id));
    if (!ids.length) return null;

    const titles = ids.map(id => HectraState.documentSections.get(id).title || id);
    const name = titles.length === 1 ? `${titles[0]} exploration` : `${titles[0]} +${titles.length - 1} exploration`;

    const branch = await this.createBranch({ fromSectionIds: ids, fromSectionId: ids[0], name });
    if (!branch) return null;

    this.sectionFocus = {
      mode: 'explore',
      sectionIds: ids,
      titles,
      selectedText: typeof options.selectedText === 'string' ? options.selectedText : '',
    };
    this.renderComposerContext();
    document.getElementById('user-input')?.focus();
    return branch;
  },

  /** Single-section helpers kept for callers that already have one id. */
  focusSection(sectionId, mode) { return this.focusSections([sectionId], mode); },
  exploreSection(sectionId) { return this.exploreSections([sectionId]); },

  /** Document-level menu (anchored next to the Live document label). */
  openDocumentMenu(msgIndex, anchor, onEditWholeDocument) {
    const message = HectraState.uiMessages[msgIndex];
    const versions = (message && message.versions) || [];

    // Branching lives on messages and selections; merging is a branch-level
    // action in the top bar. Neither belongs to the document menu.
    HectraUI.openMenu(document.getElementById('context-menu'), anchor, [
      { sectionLabel: 'Live document' },
      { label: 'Change whole document', onSelect: () => { this.clearContext(); onEditWholeDocument?.(); } },
      { label: 'Reorder, add or remove sections', onSelect: () => window.enterStructureMode?.() },
      {
        label: 'Compare versions',
        note: versions.length > 1 ? `${versions.length}` : '',
        disabled: versions.length <= 1,
        onSelect: () => {
          HectraRenderer.renderGlobalVersionBar(msgIndex);
          document.getElementById('global-version-bar')?.scrollIntoView({ block: 'nearest' });
        },
      },
    ], { align: 'end' });
  },

  // ── Composer context chip ───────────────────────────────────

  /**
   * Answers one question: where does my next instruction go?
   */
  renderComposerContext() {
    const host = document.getElementById('composer-context');
    if (!host) return;

    const chips = [];
    const branch = HectraState.getActiveBranch();
    const isMain = !branch || branch.id === (window.HectraActionLog ? HectraActionLog.DEFAULT_BRANCH_ID : 'main');
    const focus = this.sectionFocus;
    const promptEditing = !!window.isPromptEditing?.();

    const exploring = focus && focus.mode === 'explore';
    const target = focus ? this._focusLabel(focus) : '';

    if (focus && focus.mode === 'edit') {
      if (focus.titles.length === 1) {
        chips.push(this._chip('Changing section', target, { clear: true, edit: true, title: focus.titles[0] }));
        chips.push(this._helper('Selected text guides the request. The whole section may be changed.'));
      } else {
        chips.push(this._chip(`Changing ${focus.titles.length} sections`, '', { clear: true, edit: true, title: focus.titles.join(' · ') }));
        chips.push(this._helper('Selected text guides the request. Changes are limited to these sections.'));
      }
    } else if (HectraState.isEditMode) {
      chips.push(this._chip('Changing whole document', '', { clear: true, edit: true }));
    } else if (promptEditing) {
      chips.push(this._chip('Revising request', '', { clear: true, edit: true }));
    } else if (exploring) {
      // Sections and branch in one chip: "Exploring: Success Metrics · Sensor Strategy"
      const suffix = !isMain && branch.name !== target ? ` · ${branch.name}` : '';
      chips.push(this._chip('Exploring', target + suffix, { clear: true, title: focus.titles.join(' · ') }));
    }

    if (!isMain && !exploring) {
      const divergence = HectraState.getBranchDivergence(branch.id);
      const note = divergence && divergence.changedSectionCount
        ? `${divergence.changedSectionCount} change${divergence.changedSectionCount > 1 ? 's' : ''}`
        : '';
      chips.push(this._chip('Branch', branch.name + (note ? ` · ${note}` : ''), {}));
    }

    // Said once, in full: this point is closed, and what happens instead.
    const write = HectraState.canWriteToBranch();
    if (!write.allowed) chips.push(this._frozenNotice(write));

    host.innerHTML = chips.join('');
    host.hidden = !chips.length;
    document.getElementById('input-box')?.classList.toggle('branch-mode', !write.allowed);
    this._syncPlaceholder(focus, isMain, branch, write);
  },

  /**
   * The one place the rule is stated to the user. Not a warning — nothing is
   * being refused, the message simply lands somewhere else.
   */
  _frozenNotice(write) {
    const count = write.children.length;
    return `
      <span class="ctx-notice" title="${HectraUI.esc(write.reason)}">
        <span class="ctx-notice-title">This branch already has alternatives.</span>
        <span class="ctx-notice-text">Sending will continue in a new branch.${count === 1
          ? ` “${HectraUI.esc(HectraUI.truncate(write.children[0].name, 26))}” already continues from here.`
          : ` ${count} alternatives already continue from here.`}</span>
      </span>`;
  },

  _focusLabel(focus) {
    if (!focus || !focus.titles.length) return '';
    if (focus.titles.length === 1) return HectraUI.truncate(focus.titles[0], 34);
    return `${focus.titles.length} sections`;
  },

  _chip(label, value, { clear = false, edit = false, title = '' } = {}) {
    return `
      <span class="ctx-chip${edit ? ' is-edit' : ''}"${title ? ` title="${HectraUI.esc(title)}"` : ''}>
        <span class="ctx-chip-label">${HectraUI.esc(label)}${value ? ':' : ''}</span>
        ${value ? `<span class="ctx-chip-value">${HectraUI.esc(value)}</span>` : ''}
        ${clear ? '<button class="ctx-chip-clear" type="button" title="Clear context" aria-label="Clear composer context">×</button>' : ''}
      </span>`;
  },

  _helper(text) {
    return `<span class="ctx-helper">${HectraUI.esc(text)}</span>`;
  },

  _syncPlaceholder(focus, isMain, branch, write) {
    const input = document.getElementById('user-input');
    if (!input) return;

    if (write && !write.allowed) {
      input.placeholder = 'Type to start a new branch from here...';
      return;
    }

    if (focus && focus.mode === 'edit') {
      input.placeholder = focus.titles.length === 1
        ? `Describe the change to “${HectraUI.truncate(focus.titles[0], 30)}”...`
        : `Describe the change to ${focus.titles.length} selected sections...`;
    }
    else if (HectraState.isEditMode) input.placeholder = 'Describe the change: expand a section, add a point, delete a section...';
    else if (focus && focus.mode === 'explore') input.placeholder = 'Ask about the selected part...';
    else input.placeholder = 'Tell Hectra what to write or change…';
  },

  clearContext() {
    this.sectionFocus = null;
    window.cancelInputMode?.();
    this.renderComposerContext();
  },

  /** Repaint everything branch-related. */
  refresh() {
    this.renderWorkspaces();
    window.HectraWorkspaceHeader?.render();
    this.renderComposerContext();
  },
};
