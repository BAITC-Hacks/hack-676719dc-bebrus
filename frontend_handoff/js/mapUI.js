// ============================================================
//  HECTRA — Workspace map (branch overview)
// ============================================================

/**
 * Branch-level overview: one node per branch, never one per message.
 * Replaces the document view only — sidebar, top bar and composer stay.
 *
 * The map is a space rather than a panel: a mesh recedes behind the branches at
 * two parallax rates, cards drift slightly out of phase with each other, and the
 * viewport is dragged rather than scrolled — inside limits, so the graph can
 * never be thrown off screen.
 *
 * Topology comes from HectraState.getBranchTree(); the map holds no branch data
 * of its own, only view state (pan offset).
 */
window.HectraMapUI = {

  NODE_W: 168,
  NODE_H: 78,
  GAP_X: 34,
  GAP_Y: 82,

  /** How far past the content edge the viewport may travel. */
  PAN_SLACK: 150,
  /**
   * Parallax rates: the mesh moves slower than the branches.
   * Kept low on purpose — the mesh is a depth cue behind the cards, and a
   * background that travels fast makes the cards in front of it hard to read.
   */
  MESH_FAR: 0.04,
  MESH_NEAR: 0.1,

  /**
   * How a shadow answers the light. SPREAD is the lean a card has because of
   * where it sits in the graph — measured across the graph, so a wide tree does
   * not push every outer card straight into the limit. SHIFT is what moving the
   * space adds on top, and it is what has to stay in range for the shadows to
   * keep answering a drag.
   */
  SHADOW_SPREAD_X: 4,
  SHADOW_SPREAD_Y: 2.5,
  SHADOW_SHIFT_X: 0.04,
  SHADOW_SHIFT_Y: 0.025,

  /** How long a merge stays visible on the surviving node. */
  FLASH_MS: 5000,

  /** View state only. */
  pan: { x: 0, y: 0 },
  _content: { width: 0, height: 0 },
  _drag: null,
  _suppressClick: false,
  _flashTimer: null,
  selectedBranchId: null,
  sourcePickMode: false,
  /** One clock for every card's drift — see _floatStyle. */
  _floatEpoch: 0,

  init() {
    const view = document.getElementById('map-view');
    if (!view) return;

    this._floatEpoch = performance.now();

    view.addEventListener('click', (event) => {
      // A drag that ended over a node must not also open it.
      if (this._suppressClick) { this._suppressClick = false; return; }

      // If a capture retargeted the click to the space, ask the page what is
      // actually under the pointer.
      const hit = event.target === view
        ? (document.elementFromPoint(event.clientX, event.clientY) || event.target)
        : event.target;

      const temporaryAction = hit.closest('[data-temporary-chat-action]');
      if (temporaryAction) {
        const action = temporaryAction.dataset.temporaryChatAction;
        if (action === 'open') this.openTemporaryChat();
        else if (action === 'close') this.destroyTemporaryChat();
        else if (action === 'reset') this.destroyTemporaryChat();
        else if (action === 'send') this._sendTemporaryQuestion();
        else if (action === 'retry') this._retryTemporaryQuestion();
        return;
      }

      const openSelected = hit.closest('[data-map-action="open-selected"]');
      if (openSelected) {
        this._openBranch(this.selectedBranchId, { toDocument: true });
        return;
      }

      const toggle = hit.closest('[data-map-action="toggle-archived"]');
      if (toggle && window.HectraBranchUI) {
        HectraBranchUI.showArchived = !HectraBranchUI.showArchived;
        this.render();
        HectraBranchUI.refresh();
        return;
      }

      if (hit.closest('[data-map-action="recenter"]')) { this.centre(); return; }

      const more = hit.closest('.map-node-more');
      if (more) {
        event.stopPropagation();
        this._openNodeMenu(more.closest('.map-node')?.dataset.branchId, more);
        return;
      }

      const node = hit.closest('.map-node');
      if (node) this._selectNode(node.dataset.branchId);
    });

    view.addEventListener('dblclick', (event) => {
      if (event.target.closest('.temporary-chat-drawer')) return;
      const node = event.target.closest('.map-node');
      if (node) this._openBranch(node.dataset.branchId, { toDocument: true });
      else this.centre();
    });

    view.addEventListener('contextmenu', (event) => {
      const node = event.target.closest('.map-node');
      if (!node) return;
      event.preventDefault();
      this._openNodeMenu(node.dataset.branchId, node);
    });

    // Nodes are reachable and operable from the keyboard; arrows move the space.
    view.addEventListener('keydown', (event) => {
      if (event.target.closest('.temporary-chat-drawer')) return;
      const node = event.target.closest('.map-node');
      if (node && !event.target.closest('.map-node-more') && (event.key === 'Enter' || event.key === ' ')) {
        event.preventDefault();
        this._selectNode(node.dataset.branchId);
        return;
      }

      const step = event.shiftKey ? 160 : 70;
      const moves = {
        ArrowLeft: [step, 0], ArrowRight: [-step, 0],
        ArrowUp: [0, step], ArrowDown: [0, -step],
      };
      if (!moves[event.key]) return;
      event.preventDefault();
      this._setPan(this.pan.x + moves[event.key][0], this.pan.y + moves[event.key][1]);
    });

    // ── Drag to move through the space ──────────────────────────
    view.addEventListener('pointerdown', (event) => {
      if (event.button !== 0 || event.target.closest('.map-node-more, .map-bar, .temporary-chat-drawer')) return;
      // A drag does not always produce a click to consume the flag, so clear it
      // here: otherwise the next genuine click on a card would be swallowed.
      this._suppressClick = false;
      this._drag = {
        id: event.pointerId,
        startX: event.clientX,
        startY: event.clientY,
        panX: this.pan.x,
        panY: this.pan.y,
        moved: false,
      };
      // Capture is taken only once a real drag starts (see pointermove):
      // capturing on press would retarget the following click to the view and
      // a plain click on a card would stop opening its branch.
    });

    view.addEventListener('pointermove', (event) => {
      const drag = this._drag;
      if (!drag || drag.id !== event.pointerId) return;

      const dx = event.clientX - drag.startX;
      const dy = event.clientY - drag.startY;
      if (!drag.moved && Math.abs(dx) + Math.abs(dy) < 4) return;   // still a click

      if (!drag.moved) {
        drag.moved = true;
        view.classList.add('is-panning');
        try { view.setPointerCapture(event.pointerId); } catch { /* pointer already gone */ }
      }
      this._setPan(drag.panX + dx, drag.panY + dy);
    });

    const endDrag = (event) => {
      const drag = this._drag;
      if (!drag || drag.id !== event.pointerId) return;
      this._drag = null;
      this._suppressClick = drag.moved;
      view.classList.remove('is-panning');
      if (view.hasPointerCapture?.(event.pointerId)) view.releasePointerCapture(event.pointerId);
    };
    view.addEventListener('pointerup', endDrag);
    view.addEventListener('pointercancel', endDrag);

    view.addEventListener('wheel', (event) => {
      if (view.hidden) return;
      if (event.target.closest('.temporary-chat-drawer')) return;
      event.preventDefault();
      this._setPan(this.pan.x - event.deltaX, this.pan.y - event.deltaY);
    }, { passive: false });

    window.addEventListener('resize', () => { if (this.isVisible()) this._setPan(this.pan.x, this.pan.y); }, { passive: true });

    view.addEventListener('keydown', event => {
      if (!event.target.matches('#temporary-chat-input')) return;
      if (event.key === 'Enter' && !event.shiftKey) {
        event.preventDefault();
        this._sendTemporaryQuestion();
      }
    });
  },

  isVisible() {
    const view = document.getElementById('map-view');
    return !!view && !view.hidden;
  },

  show(focusBranchId) {
    const view = document.getElementById('map-view');
    const scroll = document.getElementById('chat-scroll');
    if (!view || !scroll) return;

    window.HectraHistoryUI?.exitPreview({ silent: true });
    window.HectraSelectionUI?.hide();
    scroll.hidden = true;
    view.hidden = false;
    if (focusBranchId && !window.HectraTemporaryChat?.getSession()) this.selectedBranchId = focusBranchId;
    this.render(focusBranchId);
    this.centre(focusBranchId);
    window.HectraWorkspaceHeader?.render();
  },

  hide() {
    const view = document.getElementById('map-view');
    const scroll = document.getElementById('chat-scroll');
    if (!view || !scroll) return;

    this.destroyTemporaryChat({ render: false });
    view.hidden = true;
    scroll.hidden = false;
    window.HectraWorkspaceHeader?.render();
  },

  refreshIfVisible() { if (this.isVisible()) this.render(); },

  // ── Layout ──────────────────────────────────────────────────

  render(focusBranchId) {
    const view = document.getElementById('map-view');
    const stage = document.getElementById('map-stage');
    if (!view || !stage) return;

    const roots = HectraState.getBranchTree();
    const visible = this._pruneHidden(roots);
    const branchCount = HectraState.getVisibleBranches({ includeArchived: this._showArchived() }).length;
    const archivedCount = HectraState.getBranches()
      .filter(branch => branch.status === 'archived' || branch.status === 'deleted').length;

    const temporarySession = window.HectraTemporaryChat?.getSession();
    const sourceCandidates = this._temporaryCandidateIds(visible);
    let selectedBranch = this.selectedBranchId ? HectraState.getBranch(this.selectedBranchId) : null;
    if (selectedBranch && ['deleted', 'merged'].includes(selectedBranch.status)) {
      this.selectedBranchId = null;
      selectedBranch = null;
    }
    const selectedBlock = selectedBranch
      ? HectraState.getBranchLastContentBlock(selectedBranch.id)
      : null;
    const selectedIsActive = selectedBranch?.id === HectraState.branchId;
    const sourceMessage = selectedBranch
      ? `Selected branch: ${selectedBranch.name}`
      : 'Select a highlighted branch to open its document or ask about its snapshot.';
    const noSnapshot = selectedBranch && !selectedBlock;
    const bar = `
      <div class="map-bar">
        <div class="map-source-picker${selectedBranch ? ' has-source' : ' is-picking'}" role="status" aria-live="polite">
          <span class="map-source-picker-dot" aria-hidden="true"></span>
          <span>${HectraUI.esc(sourceMessage)}</span>
        </div>
        <div class="map-context-actions">
          <button class="topbar-btn map-open-branch is-primary" type="button" data-map-action="open-selected"
                  ${!selectedBranch || selectedIsActive ? 'disabled' : ''}
                  title="${selectedIsActive ? 'This branch document is currently open' : 'Open the selected branch document'}">
            ${selectedIsActive ? 'Currently open' : 'Open branch'}
          </button>
          <button class="topbar-btn map-temporary-open" type="button" data-temporary-chat-action="open"
                  ${!selectedBlock || temporarySession ? 'disabled' : ''}
                  title="${noSnapshot ? 'No document snapshot available' : temporarySession ? 'Close or reset the current temporary chat before choosing another source' : 'Ask a read-only question about the frozen last document block'}">
            Ask about snapshot
          </button>
          ${noSnapshot ? '<span class="map-context-note">No document snapshot available</span>' : ''}
        </div>
        ${archivedCount ? `<button class="topbar-btn" type="button" data-map-action="toggle-archived" aria-pressed="${this._showArchived() ? 'true' : 'false'}">
          ${this._showArchived() ? 'Hide' : 'Show'} archived (${archivedCount})
        </button>` : ''}
      </div>`;

    // Leaves take the next column; every parent centres over its own children.
    const placed = [];
    let column = 0;
    const layout = (node, depth) => {
      const childCentres = node.children.map(child => layout(child, depth + 1));
      const x = childCentres.length
        ? (childCentres[0] + childCentres[childCentres.length - 1]) / 2
        : (column++ * (this.NODE_W + this.GAP_X));
      placed.push({ node, depth, x, y: depth * (this.NODE_H + this.GAP_Y) });
      return x;
    };
    visible.forEach(root => layout(root, 0));

    const minX = Math.min(...placed.map(item => item.x));
    const width = Math.max(...placed.map(item => item.x - minX)) + this.NODE_W;
    const height = Math.max(...placed.map(item => item.y)) + this.NODE_H;
    const byId = new Map(placed.map(item => [item.node.branch.id, item]));

    // Curved edges, anchored slightly inside the cards so a drifting node never
    // pulls away from its line.
    const edges = placed
      .filter(item => item.node.branch.parentBranchId && byId.has(item.node.branch.parentBranchId))
      .map(item => {
        const parent = byId.get(item.node.branch.parentBranchId);
        const x1 = parent.x - minX + this.NODE_W / 2;
        const y1 = parent.y + this.NODE_H - 8;
        const x2 = item.x - minX + this.NODE_W / 2;
        const y2 = item.y + 8;
        const bend = Math.max(24, (y2 - y1) * 0.55);
        return `<path d="M ${x1} ${y1} C ${x1} ${y1 + bend}, ${x2} ${y2 - bend}, ${x2} ${y2}"></path>`;
      }).join('');

    this._content = { width, height };

    stage.innerHTML = `
      ${this._backdrop()}
      <div class="map-canvas map-world" style="width:${width}px;height:${height}px">
        <svg class="map-edges" width="${width}" height="${height}" aria-hidden="true">${edges}</svg>
        ${placed.map(item => this._node(item, minX, focusBranchId, sourceCandidates, !selectedBranch)).join('')}
      </div>
      <div class="map-vignette"></div>
      ${bar}
      <div class="map-hint">Single-click selects · use Open branch · double-click is a shortcut · drag to move</div>`;

    this._applyPan();
    this._renderTemporaryDrawer();
  },

  _backdrop() {
    return `
      <div class="map-mesh is-far" aria-hidden="true"></div>
      <div class="map-mesh is-near" aria-hidden="true"></div>`;
  },

  _showArchived() { return !!window.HectraBranchUI?.showArchived; },

  _temporaryCandidateIds(nodes) {
    const ids = new Set();
    const visit = node => {
      if (!node.hidden && HectraState.getBranchLastContentBlock(node.branch.id)) ids.add(node.branch.id);
      node.children.forEach(visit);
    };
    nodes.forEach(visit);
    return ids;
  },

  /**
   * Merged, deleted and archived branches leave the map — unless a visible
   * descendant still hangs off them, in which case the node stays as a dimmed
   * link so the chain to the root never breaks.
   *
   * A merged branch is gone for a different reason than a deleted one: it was
   * absorbed. There is no node left to mark, which is why nothing here draws a
   * badge for it.
   */
  _pruneHidden(nodes) {
    const showArchived = this._showArchived();
    const walk = (node) => {
      const children = node.children.map(walk).filter(Boolean);
      const status = node.branch.status;
      const hidden = status === 'deleted' || status === 'merged' || (status === 'archived' && !showArchived);
      if (hidden && !children.length) return null;
      return { ...node, children, hidden };
    };
    return nodes.map(walk).filter(Boolean);
  },

  _node(item, minX, focusBranchId, sourceCandidates = new Set(), selectionNeeded = false) {
    const branch = item.node.branch;
    const x = item.x - minX;
    const isActive = branch.id === HectraState.branchId;
    const divergence = HectraState.getBranchDivergence(branch.id);
    const actionCount = HectraState.getActionsByBranch(branch.id).length;

    const children = HectraState.getChildBranches(branch.id);

    const meta = [];
    if (branch.status === 'archived') meta.push('archived');
    if (branch.status === 'deleted') meta.push('deleted');
    if (divergence && divergence.changedSectionCount) {
      meta.push(`${divergence.changedSectionCount} change${divergence.changedSectionCount > 1 ? 's' : ''}`);
    }
    // A node that something branched off is closed to writing — that is worth
    // saying on the card, since it decides where the next message goes.
    if (children.length) meta.push('closed');
    meta.push(`${actionCount} action${actionCount === 1 ? '' : 's'}`);

    const flag = divergence && this._hasConflict(branch)
      ? '<span class="map-node-flag is-conflict" title="Overlapping changes with a branch from the same point">!</span>'
      : '';

    const isSelected = branch.id === this.selectedBranchId;
    const isTemporarySource = branch.id === window.HectraTemporaryChat?.getSession()?.sourceBranchId;
    const isSourceOption = this.sourcePickMode && sourceCandidates.has(branch.id);
    const isSourceUnavailable = this.sourcePickMode && !sourceCandidates.has(branch.id);

    return `
      <div class="map-node${isActive ? ' is-active' : ''}${isSelected ? ' is-selected' : ''}${isTemporarySource ? ' is-temp-source' : ''}${isSourceOption ? ' is-source-option' : ''}${isSourceUnavailable ? ' is-source-unavailable' : ''}${selectionNeeded && !item.node.hidden ? ' is-selection-option' : ''}${children.length ? ' is-closed' : ''}${item.node.hidden || branch.status === 'archived' ? ' is-archived' : ''}"
           role="button" tabindex="0" data-branch-id="${HectraUI.esc(branch.id)}"
           style="left:${x}px;top:${item.y}px;${this._shadowStyle(x, item.y)}${this._floatStyle(branch.id, item.depth, isActive)}"
           aria-label="Branch ${HectraUI.esc(branch.name)}${isActive ? ' (current)' : ''}${isSelected ? ' (selected)' : ''}${isTemporarySource ? ' (question source)' : ''}"
           aria-current="${isActive ? 'true' : 'false'}">
        <div class="map-node-head">
          <span class="branch-dot" aria-hidden="true" style="${isActive ? '' : 'opacity:.4'}"></span>
          <span class="map-node-name">${HectraUI.esc(branch.name)}</span>
          ${branch.priority > 0 ? '<span class="branch-star" title="Preferred branch">★</span>' : ''}
          ${flag}
          <button class="map-node-more" type="button" title="Branch actions"
                  aria-label="Actions for branch ${HectraUI.esc(branch.name)}" aria-haspopup="menu">⋯</button>
        </div>
        <div class="map-node-roles">
          ${isActive ? '<span class="map-node-role is-current">CURRENT</span>' : ''}
          ${isSelected ? '<span class="map-node-role is-selected">SELECTED</span>' : ''}
          ${isTemporarySource ? '<span class="map-node-role is-question-source">QUESTION SOURCE</span>' : ''}
        </div>
        <div class="map-node-meta">${HectraUI.esc(meta.join(' · '))}</div>
      </div>`;
  },

  /**
   * Drift parameters derived from the branch id: the same card always breathes
   * on the same clock, and its own offset keeps it out of step with the others.
   *
   * A card's animation restarts whenever the map re-renders, because the element
   * itself is new. So the delay is measured from one epoch shared by the whole
   * map rather than from the element: a card recreated mid-drift resumes exactly
   * where the old one was instead of jumping back to the start.
   */
  _floatStyle(branchId, depth, isActive) {
    let hash = 0;
    for (let i = 0; i < branchId.length; i++) hash = (hash * 31 + branchId.charCodeAt(i)) >>> 0;

    const duration = 5.8 + (hash % 26) / 10;          // 5.8s … 8.3s
    const offset = ((hash >> 4) % 61) / 10;           // 0s … 6s — where this card sits in the cycle
    const elapsed = (performance.now() - this._floatEpoch) / 1000;
    const delay = -((offset + elapsed) % duration);
    const driftX = ((hash >> 7) % 7) - 3;             // −3px … 3px
    const driftY = -(5 + ((hash >> 11) % 5));         // −5px … −9px

    const scale = Math.max(0.9, 1 - depth * 0.035);
    const opacity = isActive ? 1 : Math.max(0.74, 1 - depth * 0.08);

    return `--float-duration:${duration.toFixed(1)}s;--float-delay:${delay.toFixed(2)}s;` +
      `--float-x:${driftX}px;--float-y:${driftY}px;--depth-scale:${scale.toFixed(3)};--depth-opacity:${opacity.toFixed(2)};`;
  },

  /**
   * The light stays with the viewport, not with the graph: a card away from the
   * middle of the tree casts its shadow away from the middle. Measured as a
   * fraction of the graph rather than in pixels, so the lean of an outer card
   * is the same whether the tree is two branches wide or twenty.
   *
   * This half belongs to the card and never changes; _applyPan supplies the
   * half that moves with the space.
   */
  _shadowStyle(x, y) {
    const halfWidth = Math.max(this._content.width, this.NODE_W) / 2;
    const halfHeight = Math.max(this._content.height, this.NODE_H) / 2;
    const fromCentreX = (x + this.NODE_W / 2 - halfWidth) / halfWidth;    // −1 … 1
    const fromCentreY = (y + this.NODE_H / 2 - halfHeight) / halfHeight;

    return `--shadow-base-x:${(fromCentreX * this.SHADOW_SPREAD_X).toFixed(1)}px;` +
      `--shadow-base-y:${(fromCentreY * this.SHADOW_SPREAD_Y).toFixed(1)}px;`;
  },

  /**
   * The only overlap that can exist is with a branch from the same fork point.
   * A branch can never disagree with its ancestor: the ancestor stopped moving
   * the moment this one left it.
   */
  _hasConflict(branch) {
    for (const sibling of HectraState.getSiblingMergeCandidates(branch.id)) {
      const analysis = HectraState.analyzeMerge(branch.id, sibling.id);
      if (analysis && analysis.overlapping.length) return true;
    }
    return false;
  },

  // ── Moving through the space ────────────────────────────────

  /**
   * The part of the map the user can actually see: the composer floats over the
   * bottom of the view, so that strip does not count as space.
   */
  _viewport() {
    const view = document.getElementById('map-stage');
    if (!view) return { width: 0, height: 0 };

    const rect = view.getBoundingClientRect();
    const composer = document.querySelector('.input-area');
    const overlap = composer
      ? Math.max(0, rect.bottom - composer.getBoundingClientRect().top)
      : 0;

    return { width: rect.width, height: Math.max(160, rect.height - overlap) };
  },

  /** Clamps the offset so the graph can never be dragged out of reach. */
  _clamp(x, y) {
    const view = document.getElementById('map-view');
    if (!view) return { x, y };

    const rect = this._viewport();
    const axis = (offset, viewSize, contentSize) => {
      if (!contentSize) return 0;
      const slack = this.PAN_SLACK;
      if (contentSize + slack * 2 <= viewSize) {
        // It fits: stay around the centre, with a little room to move.
        const centre = (viewSize - contentSize) / 2;
        return Math.min(Math.max(offset, centre - slack), centre + slack);
      }
      return Math.min(Math.max(offset, viewSize - contentSize - slack), slack);
    };

    return {
      x: axis(x, rect.width, this._content.width),
      y: axis(y, rect.height, this._content.height),
    };
  },

  _setPan(x, y) {
    this.pan = this._clamp(x, y);
    this._applyPan();
  },

  _applyPan() {
    const view = document.getElementById('map-view');
    const stage = document.getElementById('map-stage');
    if (!view || !stage) return;

    // Everything measured first, written after: no layout in between.
    const rect = this._viewport();
    const world = stage.querySelector('.map-world');
    const far = stage.querySelector('.map-mesh.is-far');
    const near = stage.querySelector('.map-mesh.is-near');

    if (world) world.style.transform = `translate3d(${Math.round(this.pan.x)}px, ${Math.round(this.pan.y)}px, 0)`;
    if (far) far.style.transform = `translate3d(${(this.pan.x * this.MESH_FAR).toFixed(1)}px, ${(this.pan.y * this.MESH_FAR).toFixed(1)}px, 0)`;
    if (near) near.style.transform = `translate3d(${(this.pan.x * this.MESH_NEAR).toFixed(1)}px, ${(this.pan.y * this.MESH_NEAR).toFixed(1)}px, 0)`;

    // Moving the space moves every card past the light, so the shadows lean
    // with it. Measured from where the graph rests, so a map nobody has dragged
    // yet shows only the lean the cards have of their own accord. One variable
    // for the whole map; the per-card half is inline.
    const restX = (rect.width - this._content.width) / 2;
    const restY = (rect.height - this._content.height) / 2;
    stage.style.setProperty('--shadow-pan-x', `${((this.pan.x - restX) * this.SHADOW_SHIFT_X).toFixed(1)}px`);
    stage.style.setProperty('--shadow-pan-y', `${((this.pan.y - restY) * this.SHADOW_SHIFT_Y).toFixed(1)}px`);
  },

  /** Puts the graph — or one branch — back in the middle of the viewport. */
  centre(focusBranchId) {
    const view = document.getElementById('map-stage');
    if (!view || !this._content.width) return;

    const rect = this._viewport();
    let x = (rect.width - this._content.width) / 2;
    // Sit a little above the middle: a tree grows downwards, so the room it
    // needs is below it.
    let y = Math.max(28, (rect.height - this._content.height) * 0.42);

    const node = focusBranchId ? view.querySelector(`.map-node[data-branch-id="${CSS.escape(focusBranchId)}"]`) : null;
    if (node) {
      x = rect.width / 2 - (node.offsetLeft + this.NODE_W / 2);
      y = rect.height / 2 - (node.offsetTop + this.NODE_H / 2);
    }

    this._setPan(x, y);
  },

  // ── Interaction ─────────────────────────────────────────────

  _selectNode(branchId) {
    if (!branchId) return false;
    const branch = HectraState.getBranch(branchId);
    if (!branch || branch.status === 'deleted' || branch.status === 'merged') return false;
    this.selectedBranchId = branchId;
    this.sourcePickMode = false;
    this.render();
    return true;
  },

  openTemporaryChat() {
    if (window.HectraTemporaryChat?.getSession()) return false;
    const branch = HectraState.getBranch(this.selectedBranchId);
    const sourceBlock = branch ? HectraState.getBranchLastContentBlock(branch.id) : null;
    if (!branch || !sourceBlock) {
      this.sourcePickMode = true;
      this.render();
      return false;
    }

    const opened = HectraTemporaryChat.open({
      sourceBranchId: branch.id,
      sourceBranchName: branch.name,
      sourceBlock,
    });
    if (!opened.ok) return false;
    this.selectedBranchId = branch.id;
    this.sourcePickMode = false;
    this.render();
    this.centre(branch.id);
    setTimeout(() => document.getElementById('temporary-chat-input')?.focus(), 0);
    return true;
  },

  destroyTemporaryChat(options = {}) {
    window.HectraTemporaryChat?.close();
    this.selectedBranchId = null;
    this.sourcePickMode = false;
    const view = document.getElementById('map-view');
    const drawer = document.getElementById('temporary-chat-drawer');
    view?.classList.remove('is-drawer-open');
    if (drawer) {
      drawer.hidden = true;
      drawer.innerHTML = '';
    }
    if (options.render !== false && this.isVisible()) this.render();
  },

  _renderTemporaryDrawer() {
    const view = document.getElementById('map-view');
    const drawer = document.getElementById('temporary-chat-drawer');
    if (!view || !drawer) return;
    const session = window.HectraTemporaryChat?.getSession();
    if (!session) {
      view.classList.remove('is-drawer-open');
      drawer.hidden = true;
      drawer.innerHTML = '';
      return;
    }

    view.classList.add('is-drawer-open');
    drawer.hidden = false;
    const messages = session.messages.map(message => {
      if (message.role === 'assistant') {
        const html = HectraSecurity.sanitizeHtml(marked.parse(message.text || ''));
        return `<div class="temporary-message is-assistant markdown-body">${html}</div>`;
      }
      return `<div class="temporary-message is-user${message.status === 'error' ? ' is-error' : ''}">
        ${HectraUI.esc(message.text)}
        ${message.status === 'error' ? '<small>Not answered</small>' : ''}
      </div>`;
    }).join('');
    const loading = session.status === 'loading';
    const failed = session.status === 'error';

    drawer.innerHTML = `
      <div class="temporary-chat-head">
        <div>
          <strong>${HectraUI.esc(session.sourceBranchName)}</strong>
          <span>Temporary chat · last block only</span>
          <small>Frozen snapshot from ${new Date(session.capturedAtMs).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}</small>
        </div>
        <button type="button" data-temporary-chat-action="reset">Reset</button>
        <button type="button" data-temporary-chat-action="close" aria-label="Close temporary chat">Close</button>
      </div>
      <div class="temporary-chat-messages">
        ${messages || '<div class="temporary-chat-empty">Ask about this frozen branch block. Other branch history and notes are not included.</div>'}
        ${loading ? '<div class="temporary-chat-thinking"><span></span><span></span><span></span></div>' : ''}
        ${failed ? `<div class="temporary-chat-error">${HectraUI.esc(session.error)} <button type="button" data-temporary-chat-action="retry">Retry</button></div>` : ''}
      </div>
      <div class="temporary-chat-compose">
        <textarea id="temporary-chat-input" rows="2" placeholder="Ask about this block…" ${loading ? 'disabled' : ''}></textarea>
        <button type="button" data-temporary-chat-action="send" ${loading ? 'disabled' : ''} aria-label="Send temporary question">Send</button>
      </div>`;
    const messagesEl = drawer.querySelector('.temporary-chat-messages');
    if (messagesEl) messagesEl.scrollTop = messagesEl.scrollHeight;
  },

  async _sendTemporaryQuestion() {
    const input = document.getElementById('temporary-chat-input');
    const started = window.HectraTemporaryChat?.beginQuestion(input?.value || '', 5);
    if (!started?.ok) return false;
    const sessionId = HectraTemporaryChat.getSession()?.sessionId;
    this._renderTemporaryDrawer();
    await this._runTemporaryRequest(started.requestMessages, sessionId);
    return true;
  },

  async _retryTemporaryQuestion() {
    const retried = window.HectraTemporaryChat?.retry(5);
    if (!retried?.ok) return false;
    const sessionId = HectraTemporaryChat.getSession()?.sessionId;
    this._renderTemporaryDrawer();
    await this._runTemporaryRequest(retried.requestMessages, sessionId);
    return true;
  },

  async _runTemporaryRequest(messages, sessionId) {
    try {
      const answer = await window.requestTemporaryChatAnswer?.(messages, sessionId);
      // A late response after Close/Reset is ignored and cannot recreate a
      // destroyed session.
      if (HectraTemporaryChat.getSession()?.sessionId !== sessionId) return;
      HectraTemporaryChat.resolve(answer || 'No answer was returned.');
    } catch (error) {
      if (HectraTemporaryChat.getSession()?.sessionId !== sessionId) return;
      HectraTemporaryChat.fail(error);
    }
    this._renderTemporaryDrawer();
  },

  async _openBranch(branchId, options = {}) {
    if (!branchId) return false;
    let opened = true;
    if (branchId !== HectraState.branchId) opened = await window.HectraBranchUI?.switchTo(branchId);
    if (opened === false) return false;
    if (options.toDocument) this.hide();
    else this._syncActive();
    return true;
  },

  /**
   * Says what just happened, on the node it happened to, and then stops saying
   * it. A merge used to leave a badge behind for good — but once the merged
   * branch is gone from the map, a permanent mark has nothing left to mark.
   */
  flash(branchId, text = '') {
    const view = document.getElementById('map-view');
    const node = branchId && view
      ? view.querySelector(`.map-node[data-branch-id="${CSS.escape(branchId)}"]`)
      : null;
    if (!node) return;

    node.querySelector('.map-node-flash')?.remove();
    node.classList.remove('is-flashing');
    void node.offsetWidth;                       // restart the animation on a repeat merge
    node.classList.add('is-flashing');
    if (text) node.insertAdjacentHTML('beforeend', `<span class="map-node-flash">${HectraUI.esc(text)}</span>`);

    clearTimeout(this._flashTimer);
    this._flashTimer = setTimeout(() => {
      node.classList.remove('is-flashing');
      node.querySelector('.map-node-flash')?.remove();
    }, this.FLASH_MS);
  },

  /**
   * Which card is current, updated in place. Selecting a branch is not a change
   * of the graph, so it must not go through render(): rebuilding the nodes would
   * interrupt what they are doing for something only two of them care about.
   */
  _syncActive() {
    const view = document.getElementById('map-view');
    if (!view) return;

    for (const node of view.querySelectorAll('.map-node')) {
      const isActive = node.dataset.branchId === HectraState.branchId;
      node.classList.toggle('is-active', isActive);
      node.setAttribute('aria-current', isActive ? 'true' : 'false');
      const dot = node.querySelector('.branch-dot');
      if (dot) dot.style.opacity = isActive ? '' : '.4';
    }
  },

  _openNodeMenu(branchId, anchor) {
    const branch = HectraState.getBranch(branchId);
    if (!branch || !window.HectraBranchUI) return;

    // One menu definition for the sidebar row and the map node.
    const items = HectraBranchUI.branchMenuItems(branch, { withTitle: true, fromMap: true });
    HectraUI.openMenu(document.getElementById('context-menu'), anchor, items, { align: 'end' });
  },
};
