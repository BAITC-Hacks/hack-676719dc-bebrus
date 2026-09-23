// ============================================================
//  HECTRA — Renderer (stable highlight)
// ============================================================

// Configure marked for safe, correct rendering
marked.setOptions({
  breaks: true,       // newlines → <br>
  gfm: true,          // GitHub Flavoured Markdown (tables, strikethrough)
  mangle: false,
  headerIds: false,
});

window.HectraRenderer = {

  // ── User bubble ──────────────────────────────────────────────

  appendUserBubble(container, msg, opts = {}) {
    const time = msg.timestamp.toLocaleTimeString('ru-RU', { hour: '2-digit', minute: '2-digit' });
    const attachments = msg.attachments || [];
    const msgIndex = Number.isInteger(msg.msgIndex) ? msg.msgIndex : '';

    // Split into images and files
    const images = attachments.filter(a => a.kind === 'image');
    const files  = attachments.filter(a => a.kind !== 'image');

    let attachHtml = '';
    if (attachments.length) {
      attachHtml = '<div class="bubble-attachments">';

      for (const f of files) {
        attachHtml += `
          <div class="bubble-attach-file">
            <div class="bubble-attach-file-icon">
              <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
                <path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"/>
                <polyline points="14 2 14 8 20 8"/>
              </svg>
            </div>
            <div class="bubble-attach-file-meta">
              <span class="bubble-attach-file-name">${this._escapeHtml(f.name)}</span>
              ${f.size ? `<span class="bubble-attach-file-size">${this._escapeHtml(f.size)}</span>` : ''}
            </div>
          </div>`;
      }

      for (const img of images) {
        const imageSrc = this._getAttachmentImageSrc(img);
        if (imageSrc) {
          attachHtml += `<button class="bubble-attach-img-btn" type="button" data-image-src="${imageSrc}" data-image-name="${this._escapeHtml(img.name)}" aria-label="Open image ${this._escapeHtml(img.name)}"><img src="${imageSrc}" class="bubble-attach-img" alt="${this._escapeHtml(img.name)}" /></button>`;
        }
      }

      attachHtml += '</div>';
    }

    const el = document.createElement('div');
    el.className = 'msg msg-user';
    if (msgIndex !== '') el.dataset.msgIndex = msgIndex;
    el.innerHTML = `
      <div class="user-bubble">
        <div class="user-actions">
          <button class="user-action-btn" type="button" data-action="edit-user-prompt" data-user-msg="${msgIndex}" title="Revise request" aria-label="Revise request">
            <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round">
              <path d="M17 3a2.828 2.828 0 1 1 4 4L7.5 20.5 2 22l1.5-5.5L17 3z"></path>
            </svg>
          </button>
          <button class="user-action-btn" type="button" data-action="branch-from-message" data-msg-index="${msgIndex}" title="Branch from here" aria-label="Create a branch from this message">
            <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round">
              <line x1="6" y1="3" x2="6" y2="15"></line>
              <circle cx="18" cy="6" r="3"></circle>
              <circle cx="6" cy="18" r="3"></circle>
              <path d="M18 9a9 9 0 0 1-9 9"></path>
            </svg>
          </button>
          <button class="user-action-btn user-action-danger" type="button" data-action="delete-user-prompt" data-user-msg="${msgIndex}" title="Delete prompt and response">
            <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round">
              <polyline points="3 6 5 6 21 6"></polyline>
              <path d="M19 6l-1 14a2 2 0 0 1-2 2H8a2 2 0 0 1-2-2L5 6"></path>
              <path d="M10 11v6"></path>
              <path d="M14 11v6"></path>
              <path d="M9 6V4a1 1 0 0 1 1-1h4a1 1 0 0 1 1 1v2"></path>
            </svg>
          </button>
        </div>
        ${attachHtml}
        ${msg.text ? `<span class="user-text">${this._escapeHtml(msg.text)}</span>` : ''}
        <span class="msg-time">${time}</span>
      </div>`;
    container.appendChild(el);
    this._bindImagePreview(el);
    if (opts.scroll !== false) this._scrollBottom(container.parentElement);
    return el;
  },

  // ── AI message block ─────────────────────────────────────────

  createAIMessageBlock(container, msgIndex) {
    const el = document.createElement('div');
    el.className = 'msg msg-ai';
    el.dataset.msgIndex = msgIndex;
    el.innerHTML = `
      <div class="ai-label">
        <span class="status-pulse"></span>
        <span class="ai-label-name">HECTRA</span>
        <span class="ai-meta-tag">Live document</span>
        <span class="msg-actions">
          <button class="msg-action-btn" type="button" data-action="branch-from-message" data-msg-index="${msgIndex}"
                  title="Branch from here" aria-label="Create a branch from this response">
            <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
              <line x1="6" y1="3" x2="6" y2="15"></line>
              <circle cx="18" cy="6" r="3"></circle>
              <circle cx="6" cy="18" r="3"></circle>
              <path d="M18 9a9 9 0 0 1-9 9"></path>
            </svg>
            Branch
          </button>
        </span>
      </div>
      <div class="ai-response" id="ai-response-${msgIndex}"></div>
      <div class="changelogs-trail" id="changelogs-trail-${msgIndex}"></div>
    `;
    container.appendChild(el);
    this.updateLiveDocumentTag(msgIndex);
    return el;
  },

  /**
   * Render sections into an AI block.
   * sectionsArray = ordered array of { id, title, content }
   * updatedIds    = ids that were added/changed
   * deletedIds    = ids removed (already gone from array)
   * opts          = { oldSnapshot, showDiff }  // coming from previous version
   */
  renderAIContent(msgIndex, sectionsArray, updatedIds = [], deletedIds = [], opts = {}) {
    const responseEl = document.getElementById(`ai-response-${msgIndex}`);
    if (!responseEl) return Promise.resolve();

    const { oldSnapshot, showDiff } = opts;
    const oldMap = oldSnapshot
      ? new Map(oldSnapshot.sections.map(s => [s.id, s]))
      : new Map();

    const contentEl = this._ensureResponseContent(responseEl);
    const existing = {};
    for (const el of contentEl.querySelectorAll('.ai-section')) {
      existing[el.dataset.secId] = el;
    }

    this.renderGlobalVersionBar(msgIndex);

    return this._applyRender(responseEl, contentEl, sectionsArray, existing, updatedIds, oldMap, oldSnapshot, showDiff);
  },

  async _applyRender(responseEl, contentEl, sectionsArray, existing, updatedIds, oldMap, oldSnapshot, showDiff) {
    const frag = document.createDocumentFragment();
    let first = true;

    const renderPlan = this._buildSectionRenderPlan(sectionsArray, oldSnapshot, showDiff);

    for (const item of renderPlan) {
      const sec = item.section;
      let secEl = item.isDeleted ? null : existing[sec.id];

      if (!secEl) {
        secEl = document.createElement('div');
        secEl.className = 'ai-section';
        secEl.dataset.secId = sec.id;
      } else {
        // Clear stale highlight classes from previous renders.
        secEl.classList.remove('sec-modified', 'sec-added', 'sec-flash', 'sec-deleted', 'sec-deleted-static');
      }

      if (item.isDeleted) {
        secEl.classList.add('sec-deleted-static');
      }

      if (!item.isDeleted && showDiff && !oldMap.has(sec.id)) {
        secEl.classList.add('sec-added');
      } else if (!item.isDeleted && showDiff && this._sectionChanged(oldMap.get(sec.id), sec)) {
        secEl.classList.add('sec-modified');
      } else if (!item.isDeleted && !showDiff && updatedIds.includes(sec.id)) {
        void secEl.offsetWidth;
        secEl.classList.add('sec-flash');
      }

      const mathPrepared = this._extractMath(sec.content);
      const bodyHtml = HectraSecurity.sanitizeHtml(marked.parse(mathPrepared.markdown));
      // No per-section chrome: the document stays a document. Section actions
      // appear only when the user selects text (see js/selectionUI.js).
      secEl.innerHTML = `
        <h3 class="sec-title">${this._escapeHtml(sec.title)}</h3>
        <div class="sec-body markdown-body">${bodyHtml}</div>
      `;
      this._renderMathPlaceholders(secEl, mathPrepared.blocks);
      this._renderMath(secEl);
      this._enhanceCodeBlocks(secEl);

      if (!first) frag.appendChild(this._makeDivider());
      first = false;
      frag.appendChild(secEl);
    }

    await this._replaceResponseContent(responseEl, contentEl, frag);
  },

  /**
   * Current sections always follow sectionsArray exactly. Deleted diff rows are
   * inserted next to their former neighbours instead of being appended to the
   * bottom of the document.
   */
  _buildSectionRenderPlan(sectionsArray, oldSnapshot, showDiff) {
    const currentSections = Array.isArray(sectionsArray) ? sectionsArray : [];
    const plan = currentSections.map(section => ({ section, isDeleted: false }));
    if (!showDiff || !oldSnapshot) return plan;

    const oldSections = Array.isArray(oldSnapshot.sections) ? oldSnapshot.sections : [];
    const oldMap = new Map(oldSections.map(section => [section.id, section]));
    const oldOrder = Array.isArray(oldSnapshot.order)
      ? oldSnapshot.order
      : oldSections.map(section => section.id);
    const currentIds = new Set(currentSections.map(section => section.id));
    const plannedIds = new Set(currentIds);

    for (let oldIndex = 0; oldIndex < oldOrder.length; oldIndex++) {
      const id = oldOrder[oldIndex];
      if (currentIds.has(id)) continue;

      const section = oldMap.get(id);
      if (!section) continue;

      const nextAnchor = oldOrder
        .slice(oldIndex + 1)
        .find(candidate => plannedIds.has(candidate));

      if (nextAnchor) {
        const nextIndex = plan.findIndex(item => item.section.id === nextAnchor);
        plan.splice(nextIndex, 0, { section, isDeleted: true });
        plannedIds.add(id);
        continue;
      }

      const previousAnchor = oldOrder
        .slice(0, oldIndex)
        .reverse()
        .find(candidate => plannedIds.has(candidate));
      const previousIndex = previousAnchor
        ? plan.findIndex(item => item.section.id === previousAnchor)
        : -1;
      plan.splice(previousIndex + 1, 0, { section, isDeleted: true });
      plannedIds.add(id);
    }

    return plan;
  },

  /**
   * Renders the global version bar for the given AI message.
   */
  renderGlobalVersionBar(msgIndex) {
    const bar = document.getElementById('global-version-bar');
    if (!bar) return;

    const msg = HectraState.uiMessages[msgIndex];
    const hasVersions = msg && msg.type === 'assistant' && msg.versions && msg.versions.length > 1;

    if (!hasVersions) {
      bar.classList.remove('visible');
      return;
    }

    const current = msg.currentVersionIndex;
    const total = msg.versions.length;

    bar.innerHTML = `
      <button class="version-nav-btn" data-action="prev-version" data-msg="${msgIndex}" title="Switch document to previous version" aria-label="Switch document to previous version" ${current === 0 ? 'disabled' : ''}>
        <svg width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round"><polyline points="15 18 9 12 15 6"></polyline></svg>
      </button>
      <span class="version-info">Version ${current + 1} of ${total}</span>
      <button class="version-nav-btn" data-action="next-version" data-msg="${msgIndex}" title="Switch document to next version" aria-label="Switch document to next version" ${current === total - 1 ? 'disabled' : ''}>
        <svg width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round"><polyline points="9 18 15 12 9 6"></polyline></svg>
      </button>
      <div class="version-actions">
        <button class="version-accept-btn" data-action="accept-version" data-msg="${msgIndex}" title="Remove other snapshots and keep this version only">Keep this version only</button>
        <button class="version-reject-btn" data-action="reject-version" data-msg="${msgIndex}" title="Discard the latest version and restore the previous document" ${current === 0 ? 'disabled' : ''}>Discard latest version</button>
      </div>
    `;

    bar.classList.add('visible');
  },

  // ── Edit button ───────────────────────────────────────────────

  /**
   * Document-level control. The old floating "Edit" button became the document
   * menu next to the Live document label: section-level editing lives on the
   * sections themselves, whole-document actions live here.
   *
   * Keeps its name and the .edit-trigger class so existing callers (and the
   * onboarding anchor) keep working.
   */
  setEditButton(msgIndex, visible, onEditClick) {
    for (const btn of document.querySelectorAll('.edit-trigger')) btn.remove();

    const responseEl = document.getElementById(`ai-response-${msgIndex}`);
    const messageEl = document.querySelector(`.msg-ai[data-msg-index="${msgIndex}"]`);
    const labelEl = messageEl?.querySelector('.ai-label');
    if (!responseEl || !labelEl) return;

    responseEl.classList.toggle('has-edit-btn', visible);
    if (!visible) return;

    const btn = document.createElement('button');
    btn.className = 'edit-trigger';
    btn.type = 'button';
    btn.title = 'Document actions';
    btn.setAttribute('aria-label', 'Document actions');
    btn.setAttribute('aria-haspopup', 'menu');
    btn.innerHTML = `
      <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor"
           stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
        <path d="M17 3a2.828 2.828 0 1 1 4 4L7.5 20.5 2 22l1.5-5.5L17 3z"></path>
      </svg>
      Document ⋯
    `;
    btn.addEventListener('click', () => {
      if (window.HectraBranchUI) HectraBranchUI.openDocumentMenu(msgIndex, btn, onEditClick);
      else onEditClick?.();
    });
    labelEl.appendChild(btn);
  },

  // ── Changelogs ────────────────────────────────────────────────

  appendChangelogs(msgIndex, logs) {
    const trail = document.getElementById(`changelogs-trail-${msgIndex}`);
    if (!trail || !logs.length) return;

    for (const logText of logs) {
      const time = new Date().toLocaleTimeString('ru-RU', { hour: '2-digit', minute: '2-digit' });
      const el = document.createElement('div');
      el.className = 'changelog-entry';
      el.innerHTML = `
        <div class="changelog-icon">
          <svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor"
               stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round">
            <polyline points="23 4 23 10 17 10"></polyline>
            <path d="M20.49 15a9 9 0 1 1-2.12-9.36L23 10"></path>
          </svg>
        </div>
        <div class="changelog-body">
          <span class="changelog-label">Updated</span>
          <span class="changelog-time">${time}</span>
          <div class="changelog-text"></div>
        </div>
      `;
      const textEl = el.querySelector('.changelog-text');
      this._renderInlineMarkdown(textEl, logText);
      trail.appendChild(el);
    }
  },

  setChangelogs(msgIndex, logs = []) {
    const trail = document.getElementById(`changelogs-trail-${msgIndex}`);
    if (!trail) return;
    trail.classList.add('is-hidden');
    setTimeout(() => {
      trail.innerHTML = '';
      this.appendChangelogs(msgIndex, logs);
      requestAnimationFrame(() => trail.classList.remove('is-hidden'));
    }, 80);
  },

  updateLiveDocumentTag(activeMsgIndex) {
    for (const el of document.querySelectorAll('.msg-ai')) {
      el.classList.toggle('is-live', el.dataset.msgIndex === String(activeMsgIndex));
    }
  },

  _bindImagePreview(root) {
    for (const btn of root.querySelectorAll('.bubble-attach-img-btn')) {
      btn.addEventListener('click', () => this._openImagePreview(btn.dataset.imageSrc, btn.dataset.imageName || 'Image'));
    }
  },

  _openImagePreview(src, name) {
    if (!HectraSecurity.isSafeImageDataUrl(src)) return;

    let modal = document.getElementById('image-preview-modal');
    if (!modal) {
      modal = document.createElement('div');
      modal.id = 'image-preview-modal';
      modal.className = 'image-preview-modal';
      modal.innerHTML = `
        <button class="image-preview-close" type="button" aria-label="Close image preview">
          <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round">
            <line x1="18" y1="6" x2="6" y2="18"></line>
            <line x1="6" y1="6" x2="18" y2="18"></line>
          </svg>
        </button>
        <img class="image-preview-img" alt="" />
      `;
      document.body.appendChild(modal);
      modal.addEventListener('click', (e) => {
        if (e.target === modal || e.target.closest('.image-preview-close')) this._closeImagePreview();
      });
      document.addEventListener('keydown', (e) => {
        if (e.key === 'Escape') this._closeImagePreview();
      });
    }

    modal.querySelector('.image-preview-img').src = src;
    modal.querySelector('.image-preview-img').alt = name;
    modal.hidden = false;
    requestAnimationFrame(() => modal.classList.add('is-open'));
  },

  _closeImagePreview() {
    const modal = document.getElementById('image-preview-modal');
    if (!modal || modal.hidden) return;
    modal.classList.remove('is-open');
    setTimeout(() => {
      if (!modal.classList.contains('is-open')) modal.hidden = true;
    }, 180);
  },

  _ensureResponseContent(responseEl) {
    let contentEl = responseEl.querySelector(':scope > .response-content');
    if (contentEl) return contentEl;

    contentEl = document.createElement('div');
    contentEl.className = 'response-content';
    const children = Array.from(responseEl.childNodes).filter(node => {
      return !(node.nodeType === Node.ELEMENT_NODE && node.classList.contains('edit-trigger'));
    });
    for (const node of children) contentEl.appendChild(node);
    responseEl.prepend(contentEl);
    return contentEl;
  },

  // ── Loading ───────────────────────────────────────────────────

  async _replaceResponseContent(responseEl, contentEl, frag) {
    if (!contentEl.childNodes.length) {
      contentEl.appendChild(frag);
      return;
    }

    const oldHeight = responseEl.offsetHeight;
    responseEl.style.height = `${oldHeight}px`;
    responseEl.classList.add('is-resizing');

    contentEl.classList.add('is-hidden');
    await this._sleep(80);

    contentEl.replaceChildren(frag);
    const newHeight = responseEl.scrollHeight;

    await this._nextFrame();
    responseEl.style.height = `${newHeight}px`;
    await this._sleep(140);

    contentEl.classList.remove('is-hidden');
    await this._sleep(110);

    responseEl.classList.remove('is-resizing');
    responseEl.style.height = '';
  },

  _nextFrame() {
    return new Promise(resolve => requestAnimationFrame(resolve));
  },

  _sleep(ms) {
    return new Promise(resolve => setTimeout(resolve, ms));
  },

  showLoadingDots(container, opts = {}) {
    if (document.getElementById('loading-indicator')) return;
    const el = document.createElement('div');
    el.id = 'loading-indicator';
    el.className = 'loading-dots';
    el.innerHTML = '<span></span><span></span><span></span>';
    container.appendChild(el);
    if (opts.scroll !== false) this._scrollBottom(container.parentElement);
  },

  hideLoadingDots() {
    document.getElementById('loading-indicator')?.remove();
  },

  // ── Welcome ───────────────────────────────────────────────────

  hideWelcome() {
    const el = document.getElementById('welcome-screen');
    if (!el) return;
    el.style.opacity = '0';
    el.style.transform = 'translateY(-10px)';
    setTimeout(() => el.remove(), 280);
  },

  showEditOnboarding(editButton, { onClose } = {}) {
    if (!editButton) return null;
    this.dismissEditOnboarding();

    const overlay = document.createElement('div');
    overlay.className = 'edit-onboarding-overlay';
    overlay.innerHTML = `
      <div class="edit-onboarding-backdrop"></div>
      <div class="edit-onboarding-card" role="dialog" aria-modal="true" aria-labelledby="edit-onboarding-title">
        <div class="edit-onboarding-kicker">Changing a document</div>
        <h2 id="edit-onboarding-title">Change the document in place</h2>
        <p>Select text inside a section, then choose <b>Change section</b>. The selected words guide your request; the whole section is the authorized change boundary. Use <b>Explore</b> to continue selected sections as an alternative.</p>
        <div class="edit-onboarding-actions">
          <button type="button" class="edit-onboarding-secondary" data-onboarding-action="close">Got it</button>
        </div>
      </div>
    `;
    document.body.appendChild(overlay);
    editButton.classList.add('edit-trigger-onboarding');

    const close = () => {
      if (typeof overlay._cleanup === 'function') overlay._cleanup();
      editButton.classList.remove('edit-trigger-onboarding');
      overlay.classList.remove('is-open');
      setTimeout(() => overlay.remove(), 180);
      if (typeof onClose === 'function') onClose();
    };

    overlay.addEventListener('click', (e) => {
      const action = e.target.closest('[data-onboarding-action]')?.dataset.onboardingAction;
      if (action === 'close' || e.target.classList.contains('edit-onboarding-backdrop')) {
        close();
      }
    });

    const onKeydown = (e) => {
      if (e.key !== 'Escape') return;
      document.removeEventListener('keydown', onKeydown);
      close();
    };
    document.addEventListener('keydown', onKeydown);

    requestAnimationFrame(() => {
      this._positionEditOnboardingCard(overlay, editButton);
      overlay.classList.add('is-open');
      overlay.querySelector('.edit-onboarding-secondary')?.focus({ preventScroll: true });
    });

    const reposition = () => this._positionEditOnboardingCard(overlay, editButton);
    window.addEventListener('resize', reposition, { passive: true });
    overlay._cleanup = () => {
      window.removeEventListener('resize', reposition);
      document.removeEventListener('keydown', onKeydown);
    };
    return overlay;
  },

  dismissEditOnboarding() {
    const overlay = document.querySelector('.edit-onboarding-overlay');
    if (!overlay) return;
    if (typeof overlay._cleanup === 'function') overlay._cleanup();
    document.querySelector('.edit-trigger-onboarding')?.classList.remove('edit-trigger-onboarding');
    overlay.remove();
  },

  // ── Helpers ───────────────────────────────────────────────────

  _makeDivider() {
    const d = document.createElement('div');
    d.className = 'sec-divider';
    return d;
  },

  _scrollBottom(scrollEl) {
    if (!scrollEl) return;
    requestAnimationFrame(() => scrollEl.scrollTo({ top: scrollEl.scrollHeight, behavior: 'smooth' }));
  },

  _positionEditOnboardingCard(overlay, editButton) {
    const card = overlay.querySelector('.edit-onboarding-card');
    if (!card || !editButton) return;

    const rect = editButton.getBoundingClientRect();
    const gap = 14;
    const margin = 14;
    const width = Math.min(360, window.innerWidth - margin * 2);
    card.style.width = `${width}px`;

    const placeAbove = rect.top > 250;
    let top = placeAbove ? rect.top - card.offsetHeight - gap : rect.bottom + gap;
    let left = Math.min(
      Math.max(rect.right - width, margin),
      window.innerWidth - width - margin
    );

    if (top < margin) top = Math.min(rect.bottom + gap, window.innerHeight - card.offsetHeight - margin);
    if (top + card.offsetHeight > window.innerHeight - margin) {
      top = Math.max(margin, window.innerHeight - card.offsetHeight - margin);
    }

    card.style.left = `${left}px`;
    card.style.top = `${top}px`;
  },

  _enhanceCodeBlocks(root) {
    for (const pre of root.querySelectorAll('pre')) {
      const code = pre.querySelector('code');
      if (!code || pre.closest('.code-block')) continue;

      const rawCode = code.textContent;
      const lang = this._detectCodeLang(code);
      code.innerHTML = this._highlightCode(rawCode, lang);

      const block = document.createElement('div');
      block.className = 'code-block';

      const header = document.createElement('div');
      header.className = 'code-header';

      const langEl = document.createElement('span');
      langEl.className = 'code-lang';
      langEl.textContent = lang || 'text';

      const copyBtn = document.createElement('button');
      copyBtn.className = 'code-copy-btn';
      copyBtn.type = 'button';
      copyBtn.textContent = 'Copy';
      copyBtn.addEventListener('click', async () => {
        try {
          await navigator.clipboard.writeText(rawCode);
          copyBtn.textContent = 'Copied';
          setTimeout(() => { copyBtn.textContent = 'Copy'; }, 1200);
        } catch {
          copyBtn.textContent = 'Failed';
          setTimeout(() => { copyBtn.textContent = 'Copy'; }, 1200);
        }
      });

      header.append(langEl, copyBtn);
      pre.parentNode.insertBefore(block, pre);
      block.append(header, pre);
    }
  },

  _renderMath(root) {
    if (typeof renderMathInElement !== 'function') return;

    renderMathInElement(root, {
      delimiters: [
        { left: '$$', right: '$$', display: true },
        { left: '\\[', right: '\\]', display: true },
        { left: '$', right: '$', display: false },
        { left: '\\(', right: '\\)', display: false },
      ],
      ignoredTags: ['script', 'noscript', 'style', 'textarea', 'pre', 'code'],
      throwOnError: false,
      strict: 'ignore',
    });
  },

  _renderInlineMarkdown(root, markdown) {
    if (!root) return;

    const mathPrepared = this._extractMath(markdown);
    const parser = typeof marked !== 'undefined' && marked.parseInline
      ? marked.parseInline.bind(marked)
      : null;
    const html = parser
      ? parser(mathPrepared.markdown)
      : this._escapeHtml(mathPrepared.markdown);

    root.innerHTML = HectraSecurity.sanitizeHtml(html);
    this._renderMathPlaceholders(root, mathPrepared.blocks);
    this._renderMath(root);
  },

  _extractMath(markdown) {
    const blocks = [];
    let prepared = String(markdown);

    const stash = (formula, display) => {
      const token = `HECTRAMATHBLOCK${blocks.length}END`;
      blocks.push({ token, formula: formula.trim(), display });
      return display ? `\n\n${token}\n\n` : token;
    };

    prepared = prepared.replace(/(^|\n)[ \t]*\$\$[ \t]*\n([\s\S]*?)\n[ \t]*\$\$[ \t]*(?=\n|$)/g, (_, prefix, formula) => {
      return prefix + stash(formula, true);
    });

    prepared = prepared.replace(/(^|\n)[ \t]*\\\[[ \t]*\n([\s\S]*?)\n[ \t]*\\\][ \t]*(?=\n|$)/g, (_, prefix, formula) => {
      return prefix + stash(formula, true);
    });

    prepared = prepared.replace(/\$\$([\s\S]*?)\$\$/g, (_, formula) => stash(formula, true));
    prepared = prepared.replace(/\\\[([\s\S]*?)\\\]/g, (_, formula) => stash(formula, true));
    prepared = prepared.replace(/\\\(([\s\S]*?)\\\)/g, (_, formula) => stash(formula, false));
    prepared = prepared.replace(/(^|[^\\$])\$([^\n$]+?)\$(?!\$)/g, (_, prefix, formula) => {
      return prefix + stash(formula, false);
    });

    return { markdown: prepared, blocks };
  },

  _renderMathPlaceholders(root, blocks) {
    if (!blocks.length) return;

    const byToken = new Map(blocks.map(block => [block.token, block]));
    const tokens = [...byToken.keys()];
    const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
    const textNodes = [];

    while (walker.nextNode()) {
      const node = walker.currentNode;
      if (tokens.some(token => node.nodeValue.includes(token))) {
        textNodes.push(node);
      }
    }

    for (const node of textNodes) {
      const parent = node.parentNode;
      if (!parent) continue;

      const frag = document.createDocumentFragment();
      let remaining = node.nodeValue;

      while (remaining) {
        let nextToken = null;
        let nextIndex = -1;

        for (const token of tokens) {
          const index = remaining.indexOf(token);
          if (index !== -1 && (nextIndex === -1 || index < nextIndex)) {
            nextToken = token;
            nextIndex = index;
          }
        }

        if (!nextToken) {
          frag.appendChild(document.createTextNode(remaining));
          break;
        }

        if (nextIndex > 0) {
          frag.appendChild(document.createTextNode(remaining.slice(0, nextIndex)));
        }

        const block = byToken.get(nextToken);
        const mathEl = document.createElement('span');
        mathEl.className = block.display ? 'math-display' : 'math-inline';
        if (typeof katex !== 'undefined') {
          try {
            katex.render(block.formula, mathEl, {
              displayMode: block.display,
              throwOnError: false,
              strict: 'ignore',
            });
          } catch {
            mathEl.textContent = block.formula;
          }
        } else {
          mathEl.textContent = block.formula;
        }
        frag.appendChild(mathEl);

        remaining = remaining.slice(nextIndex + nextToken.length);
      }

      parent.replaceChild(frag, node);
    }
  },

  _sectionChanged(before, after) {
    if (!before || !after) return false;
    return before.title !== after.title || this._normalizeSectionText(before.content) !== this._normalizeSectionText(after.content);
  },

  _normalizeSectionText(value) {
    return String(value || '').replace(/\r\n/g, '\n').trim();
  },

  _detectCodeLang(codeEl) {
    const className = codeEl.className || '';
    const match = className.match(/language-([a-z0-9_-]+)/i);
    return match ? match[1].toLowerCase() : '';
  },

  _highlightCode(raw, lang) {
    let html = this._escapeHtml(raw);

    html = html.replace(/(&quot;.*?&quot;|&#039;.*?&#039;|`.*?`)/g, '<span class="tok-string">$1</span>');
    html = html.replace(/\b(0x[\da-f]+|\d+(?:\.\d+)?)\b/gi, '<span class="tok-number">$1</span>');
    html = html.replace(/\b(function|return|const|let|var|if|else|for|while|class|new|async|await|try|catch|throw|import|export|from|def|lambda|None|True|False|public|private|static|void|int|string|bool|interface|type|enum|struct|impl|fn|match|use)\b/g, '<span class="tok-keyword">$1</span>');
    html = html.replace(/\b(document|window|console|this|self|super|props|state|request|response|res|req)\b/g, '<span class="tok-symbol">$1</span>');
    html = html.replace(/(^|\n)(\s*)(\/\/.*|#.*)/g, '$1$2<span class="tok-comment">$3</span>');

    if (lang === 'html' || lang === 'xml') {
      html = html.replace(/(&lt;\/?)([\w-]+)/g, '$1<span class="tok-tag">$2</span>');
    }

    return html;
  },

  _escapeHtml(str) {
    return String(str)
      .replace(/&/g, '&amp;').replace(/</g, '&lt;')
      .replace(/>/g, '&gt;').replace(/"/g, '&quot;')
      .replace(/'/g, '&#039;');
  },

  _getAttachmentImageSrc(att) {
    const src = att?.dataUrl || att?.previewDataUrl || '';
    return HectraSecurity.isSafeImageDataUrl(src) ? src : '';
  }
};
