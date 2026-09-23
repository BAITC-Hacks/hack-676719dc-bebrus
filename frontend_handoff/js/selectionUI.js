// ============================================================
//  HECTRA — Selection toolbar (section actions on demand)
// ============================================================

/**
 * The document carries no permanent controls. Selecting text inside the live
 * document is what reveals actions, and the selection is resolved to real
 * section ids through the DOM — the selected string is only a contextual hint,
 * never the identity of the target.
 *
 * Presentation only: every operation is handed to HectraBranchUI, which goes
 * through HectraState.
 */
window.HectraSelectionUI = {

  /** View state only. */
  targetSectionIds: [],
  selectedText: '',
  _frame: null,
  _rect: null,

  TOOLBAR_GAP: 8,

  init() {
    const onChange = () => this._schedule();
    document.addEventListener('selectionchange', onChange);
    document.addEventListener('mouseup', onChange);
    document.addEventListener('keyup', (event) => {
      if (event.shiftKey || event.key.startsWith('Arrow') || event.key === 'a' || event.key === 'End' || event.key === 'Home') onChange();
    });

    // Starting a new selection (or clicking anywhere else) closes the toolbar;
    // pressing inside it must not, or the selection would be lost on click.
    document.addEventListener('mousedown', (event) => {
      const toolbar = this._el();
      if (toolbar && !toolbar.hidden && toolbar.contains(event.target)) { event.preventDefault(); return; }
      this.hide();
    }, true);

    document.addEventListener('keydown', (event) => {
      if (this.isVisible() && event.key === 'Escape') { event.stopPropagation(); this.hide(); return; }
      // Keyboard parity: Tab moves into the toolbar the selection just opened.
      if (this.isVisible() && event.key === 'Tab' && !event.shiftKey && !this._el().contains(document.activeElement)) {
        event.preventDefault();
        this._el().querySelector('.sel-btn')?.focus();
      }
    });

    this._el()?.addEventListener('click', (event) => {
      const button = event.target.closest('[data-sel-action]');
      if (button) this._run(button.dataset.selAction);
    });

    // A scrolled-away selection must not leave the toolbar floating over
    // unrelated content.
    document.getElementById('chat-scroll')?.addEventListener('scroll', () => this._reposition(), { passive: true });
    window.addEventListener('resize', () => this.hide(), { passive: true });
  },

  isVisible() {
    const toolbar = this._el();
    return !!toolbar && !toolbar.hidden;
  },

  hide() {
    const toolbar = this._el();
    this.targetSectionIds = [];
    this.selectedText = '';
    this._rect = null;
    if (!toolbar || toolbar.hidden) return;
    toolbar.classList.remove('is-open');
    toolbar.hidden = true;
  },

  // ── Detection ───────────────────────────────────────────────

  _el() { return document.getElementById('selection-toolbar'); },

  _schedule() {
    if (this._frame) cancelAnimationFrame(this._frame);
    this._frame = requestAnimationFrame(() => { this._frame = null; this.evaluate(); });
  },

  /**
   * Decides whether the current selection deserves a toolbar and which sections
   * it targets.
   */
  evaluate() {
    const toolbar = this._el();
    if (!toolbar) return;

    const selection = window.getSelection();
    if (!selection || selection.isCollapsed || !selection.rangeCount) return this.hide();

    const text = selection.toString();
    if (!text.trim()) return this.hide();                      // whitespace-only

    const host = this._host();
    if (!host) return this.hide();                             // no live document

    const range = selection.getRangeAt(0);
    if (!host.contains(range.commonAncestorContainer)
      && !(range.commonAncestorContainer.contains && range.commonAncestorContainer.contains(host))) {
      return this.hide();                                      // composer, sidebar, history, map
    }

    const ids = this._sectionsInRange(range, host);
    if (!ids.length) return this.hide();

    this.targetSectionIds = ids;
    this.selectedText = text.trim();
    this._render(ids);
    this._rect = this._selectionRect(range);
    this._place();
  },

  /** The live document — earlier responses are read-only history. */
  _host() {
    if (window.HectraMapUI?.isVisible?.()) return null;
    if (window.HectraHistoryUI?.preview) return null;          // viewing an old state
    const live = document.querySelector('.msg-ai.is-live .ai-response');
    return live || null;
  },

  /**
   * Every section element the range really overlaps, in document order.
   * A range that merely touches a boundary (or covers whitespace between two
   * sections) does not count as selecting that section.
   */
  _sectionsInRange(range, host) {
    const ids = [];

    for (const element of host.querySelectorAll('.ai-section')) {
      if (element.classList.contains('sec-deleted-static')) continue;   // diff ghost row
      const id = element.dataset.secId;
      if (!id || ids.includes(id)) continue;
      if (typeof HectraState !== 'undefined' && !HectraState.documentSections.has(id)) continue;

      const sectionRange = document.createRange();
      sectionRange.selectNodeContents(element);

      // No overlap at all.
      if (range.compareBoundaryPoints(Range.END_TO_START, sectionRange) >= 0) continue;
      if (range.compareBoundaryPoints(Range.START_TO_END, sectionRange) <= 0) continue;

      // Clamp the selection to this section and require real text inside it.
      const clamped = range.cloneRange();
      if (clamped.compareBoundaryPoints(Range.START_TO_START, sectionRange) < 0) {
        clamped.setStart(sectionRange.startContainer, sectionRange.startOffset);
      }
      if (clamped.compareBoundaryPoints(Range.END_TO_END, sectionRange) > 0) {
        clamped.setEnd(sectionRange.endContainer, sectionRange.endOffset);
      }
      if (!clamped.toString().trim()) continue;

      ids.push(id);
    }

    return ids;
  },

  _selectionRect(range) {
    const rects = range.getClientRects();
    const rect = range.getBoundingClientRect();
    if (rect && (rect.width || rect.height)) return rect;
    return rects.length ? rects[rects.length - 1] : null;
  },

  // ── Toolbar ─────────────────────────────────────────────────

  _render(ids) {
    const toolbar = this._el();
    const multiple = ids.length > 1;
    const titles = ids.map(id => this._title(id));
    const hint = HectraUI.esc(titles.join(' · '));

    toolbar.innerHTML = `
      <button class="sel-btn" type="button" data-sel-action="edit" title="${multiple ? `Change ${ids.length} sections` : `Change section ${hint}`}"
              aria-label="${multiple ? `Change ${ids.length} selected sections` : `Change section ${hint}`}">
        ${multiple ? 'Change sections' : 'Change section'}
      </button>
      <span class="sel-sep" aria-hidden="true"></span>
      <button class="sel-btn" type="button" data-sel-action="explore" title="Continue ${hint} in a new branch"
              aria-label="${multiple ? `Explore ${ids.length} selected sections in a branch` : `Explore section ${hint} in a branch`}">
        ${multiple ? 'Explore sections' : 'Explore'}
      </button>
      ${multiple ? `<span class="sel-count" title="${hint}">${ids.length}</span>` : ''}`;
  },

  _title(sectionId) {
    const section = typeof HectraState !== 'undefined' ? HectraState.documentSections.get(sectionId) : null;
    return section && section.title ? section.title : sectionId;
  },

  _place() {
    const toolbar = this._el();
    if (!toolbar || !this._rect) return;

    toolbar.hidden = false;
    toolbar.style.left = '0px';
    toolbar.style.top = '0px';

    const width = toolbar.offsetWidth;
    const height = toolbar.offsetHeight;
    const margin = 10;
    const rect = this._rect;

    let left = rect.left + rect.width / 2 - width / 2;
    left = Math.min(Math.max(left, margin), Math.max(margin, window.innerWidth - width - margin));

    // Above the selection, unless there is no room up there.
    let top = rect.top - height - this.TOOLBAR_GAP;
    if (top < margin) top = Math.min(rect.bottom + this.TOOLBAR_GAP, window.innerHeight - height - margin);

    toolbar.style.left = `${Math.round(left)}px`;
    toolbar.style.top = `${Math.round(top)}px`;
    requestAnimationFrame(() => toolbar.classList.add('is-open'));
  },

  /** Scrolling keeps the toolbar on its selection, or drops it when it leaves. */
  _reposition() {
    if (!this.isVisible()) return;

    const selection = window.getSelection();
    if (!selection || selection.isCollapsed || !selection.rangeCount) return this.hide();

    const rect = this._selectionRect(selection.getRangeAt(0));
    const scroll = document.getElementById('chat-scroll');
    const bounds = scroll ? scroll.getBoundingClientRect() : { top: 0, bottom: window.innerHeight };
    if (!rect || rect.bottom < bounds.top || rect.top > bounds.bottom) return this.hide();

    this._rect = rect;
    this._place();
  },

  // ── Actions ─────────────────────────────────────────────────

  _run(action) {
    const ids = [...this.targetSectionIds];
    const selectedText = this.selectedText;
    this.hide();
    window.getSelection()?.removeAllRanges();
    if (!ids.length || !window.HectraBranchUI) return;

    if (action === 'edit') HectraBranchUI.focusSections(ids, 'edit', { selectedText });
    else if (action === 'explore') HectraBranchUI.exploreSections(ids, { selectedText });
  },
};
