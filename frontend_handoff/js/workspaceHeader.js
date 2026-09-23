// ============================================================
//  HECTRA — Workspace header (top bar navigation + status)
// ============================================================

/**
 * Top bar: where am I (workspace / branch), and the entry points to Map and
 * Merge. Reads HectraState only.
 *
 * History has no entry point here on purpose — it is an internal inspection
 * tool, not something the person writing the document is asked to manage.
 */
window.HectraWorkspaceHeader = {

  init() {
    document.getElementById('view-toggle-btn')?.addEventListener('click', () => {
      if (window.HectraMapUI?.isVisible()) HectraMapUI.hide();
      else HectraMapUI?.show();
    });

    document.getElementById('merge-btn')?.addEventListener('click', (event) => {
      const branch = HectraState.getActiveBranch();
      if (!branch || !window.HectraBranchUI) return;
      // Two operations live behind this button, so it opens them rather than
      // guessing which one was meant.
      HectraUI.openMenu(document.getElementById('context-menu'), event.currentTarget,
        HectraBranchUI.mergeMenuItems(branch, event.currentTarget), { align: 'end' });
    });

    this.render();
  },

  render() {
    const branch = HectraState.getActiveBranch();
    const isMain = !branch || branch.id === (window.HectraActionLog ? HectraActionLog.DEFAULT_BRANCH_ID : 'main');

    const workspace = document.getElementById('crumb-workspace');
    if (workspace) {
      const title = HectraState.sessionTitle || (HectraState.uiMessages.length ? 'Untitled workspace' : 'New workspace');
      workspace.textContent = title;
      workspace.title = title;
    }

    const chip = document.getElementById('branch-chip');
    const chipName = document.getElementById('branch-chip-name');
    if (chip && chipName) {
      chipName.textContent = branch ? branch.name : 'main';
      chip.classList.toggle('is-branch', !isMain);
      chip.setAttribute('aria-label', `Current branch: ${branch ? branch.name : 'main'}. Switch branch`);
    }

    // One quiet secondary line: where this branch came from.
    const note = document.getElementById('crumb-note');
    if (note) {
      const text = this._originNote(branch, isMain);
      note.textContent = text;
      note.hidden = !text;
    }

    // Merge appears where a merge is actually possible: on a branch that can
    // meet a sibling, or that can dissolve into the point it left.
    const mergeBtn = document.getElementById('merge-btn');
    if (mergeBtn) {
      const siblings = isMain ? [] : HectraState.getSiblingMergeCandidates(branch.id);
      const collapse = isMain ? null : HectraState.canCollapseIntoParent(branch.id);
      const canCollapse = !!collapse && (collapse.allowed || collapse.code === 'has-siblings');

      mergeBtn.hidden = !siblings.length && !canCollapse;
      mergeBtn.disabled = false;

      if (!mergeBtn.hidden) {
        mergeBtn.textContent = 'Merge';
        mergeBtn.title = siblings.length
          ? `Merge “${branch.name}” with a branch from the same point, or with “${collapse.parentName}”`
          : `Merge “${branch.name}” into “${collapse.parentName}”`;
        mergeBtn.setAttribute('aria-label', mergeBtn.title);
      }
    }

    const viewBtn = document.getElementById('view-toggle-btn');
    if (viewBtn) {
      const mapVisible = !!window.HectraMapUI?.isVisible();
      viewBtn.textContent = mapVisible ? 'Document' : 'Map';
      viewBtn.setAttribute('aria-pressed', mapVisible ? 'true' : 'false');
      viewBtn.setAttribute('aria-label', mapVisible ? 'Back to the document' : 'Show workspace map');
    }
  },

  /** One quiet line, never a banner. */
  _originNote(branch, isMain) {
    if (isMain || !branch) return '';

    const parent = branch.parentBranchId ? HectraState.getBranch(branch.parentBranchId) : null;
    const sectionIds = Array.isArray(branch.forkSectionIds) && branch.forkSectionIds.length
      ? branch.forkSectionIds
      : (branch.forkSectionId ? [branch.forkSectionId] : []);

    if (sectionIds.length > 1) {
      return `Branched from ${sectionIds.length} sections${parent ? ` of ${parent.name}` : ''}`;
    }

    // The branch is usually named after the section it explores; repeating that
    // name adds nothing, so fall back to the parent branch.
    const sectionTitle = sectionIds.length ? this._sectionTitle(sectionIds[0]) : '';
    if (sectionTitle && sectionTitle !== branch.name && !branch.name.startsWith(sectionTitle)) {
      return `Branched from ${sectionTitle}`;
    }
    if (Number.isInteger(branch.forkMessageIndex)) {
      return `Branched from an earlier message${parent ? ` of ${parent.name}` : ''}`;
    }
    return parent ? `Branched from ${parent.name}` : '';
  },

  _sectionTitle(sectionId) {
    const section = HectraState.documentSections.get(sectionId);
    return section && section.title ? section.title : sectionId;
  },
};
