// ============================================================
//  HECTRA — App (fixed)
// ============================================================

const chatContainer = document.getElementById('chat-container');
const chatScroll    = document.getElementById('chat-scroll');
const userInput     = document.getElementById('user-input');
const sendBtn       = document.getElementById('send-btn');
const cancelEditBtn = document.getElementById('cancel-edit-btn');
const newChatBtn    = document.getElementById('new-chat-btn');
const statusDot     = document.getElementById('status-dot');
const statusText    = document.getElementById('status-text');
const inputBox      = document.getElementById('input-box');
const attachBtn     = document.getElementById('attach-btn');
const fileInput     = document.getElementById('file-input');
const attachPreview = document.getElementById('attach-preview');
const sidebar        = document.getElementById('sidebar');
const sidebarToggle  = document.getElementById('sidebar-toggle-btn');
const sidebarBackdrop = document.getElementById('sidebar-backdrop');
const settingsBtn    = document.getElementById('settings-btn');
const settingsModal  = document.getElementById('settings-modal');
const settingsCloseBtn = document.getElementById('settings-close-btn');
const saveSettingsBtn = document.getElementById('save-settings-btn');

// Pending file attachments for current message
let pendingAttachments = [];
let promptEditIndex = null;
let promptEditAttachments = [];
const browserTokenTotals = {
  input: 0,
  output: 0,
  reasoning: 0,
  total: 0,
  imageInput: 0,
  cachedInput: 0,
  requests: 0,
  title: {
    input: 0,
    output: 0,
    reasoning: 0,
    total: 0,
    requests: 0,
  },
};

const SETTINGS_KEYS = {
  theme: 'hectra_theme',
  apiMode: 'hectra_api_mode',
  editOnboardingSeen: 'hectra_edit_onboarding_seen',
};
const SETTINGS_ANIMATION_MS = 180;

// ── Init ──────────────────────────────────────────────────────

initSettings();
HectraState.init();
resetEditOnboardingWhenChatsAreEmpty();
chatContainer.innerHTML = buildWelcomeHTML();

// Branch / history / map / merge layers. Each one reads HectraState; none of
// them keeps workspace state of its own.
HectraUI && HectraBranchUI.init();
HectraSelectionUI.init();
HectraHistoryUI.init();
HectraMapUI.init();
HectraMergeUI.init();
HectraEditReviewUI.init();
HectraWorkspaceHeader.init();

renderSidebarSessions();
HectraBranchUI.renderComposerContext();
setStatus('ready');

// ── Input ─────────────────────────────────────────────────────

userInput.addEventListener('input', () => {
  userInput.style.height = 'auto';
  userInput.style.height = Math.min(userInput.scrollHeight, 150) + 'px';
});
userInput.addEventListener('keydown', e => {
  if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); handleSend(); }
});
sendBtn.addEventListener('click', handleSend);
cancelEditBtn.addEventListener('click', cancelInputMode);

// ── Responsive sidebar ───────────────────────────────────────

function setSidebarOpen(open) {
  document.body.classList.toggle('sidebar-open', open);
  if (sidebarToggle) sidebarToggle.setAttribute('aria-expanded', open ? 'true' : 'false');
  if (sidebarBackdrop) sidebarBackdrop.hidden = !open;
}

sidebarToggle?.addEventListener('click', () => {
  setSidebarOpen(!document.body.classList.contains('sidebar-open'));
});

sidebarBackdrop?.addEventListener('click', () => setSidebarOpen(false));

document.addEventListener('keydown', (e) => {
  if (e.key === 'Escape') setSidebarOpen(false);
});

window.matchMedia('(min-width: 1025px)').addEventListener('change', (e) => {
  if (e.matches) setSidebarOpen(false);
});

// ── Settings ─────────────────────────────────────────────────

function initSettings() {
  const theme = localStorage.getItem(SETTINGS_KEYS.theme) || 'dark';
  const apiMode = sessionStorage.getItem(SETTINGS_KEYS.apiMode) || 'direct';

  applyTheme(theme);
  setSegmentedValue('theme', theme);
  setSegmentedValue('api-mode', apiMode);
}

function applyTheme(theme) {
  document.body.classList.toggle('theme-light', theme === 'light');
}

function openSettings() {
  initSettings();
  if (settingsModal) {
    settingsModal.hidden = false;
    requestAnimationFrame(() => settingsModal.classList.add('is-open'));
  }
  setSidebarOpen(false);
  setTimeout(() => settingsModal?.querySelector('.segmented-control button.active')?.focus(), 0);
}

function closeSettings() {
  if (!settingsModal || settingsModal.hidden) return;
  settingsModal.classList.remove('is-open');
  setTimeout(() => {
    if (!settingsModal.classList.contains('is-open')) settingsModal.hidden = true;
  }, SETTINGS_ANIMATION_MS);
}

settingsBtn?.addEventListener('click', openSettings);
settingsCloseBtn?.addEventListener('click', closeSettings);
settingsModal?.addEventListener('click', (e) => {
  if (e.target === settingsModal) closeSettings();
});

settingsModal?.addEventListener('click', (e) => {
  const option = e.target.closest('.segmented-control button');
  if (!option) return;
  const group = option.closest('.segmented-control');
  const setting = group?.dataset.setting;
  if (!setting) return;
  setSegmentedValue(setting, option.dataset.value);
  if (setting === 'theme') applyTheme(option.dataset.value);
});

saveSettingsBtn?.addEventListener('click', () => {
  const theme = getSegmentedValue('theme') || 'dark';
  const apiMode = getSegmentedValue('api-mode') || 'direct';

  localStorage.setItem(SETTINGS_KEYS.theme, theme);
  sessionStorage.setItem(SETTINGS_KEYS.apiMode, apiMode);
  applyTheme(theme);
  closeSettings();
});

function setSegmentedValue(setting, value) {
  const group = document.querySelector(`.segmented-control[data-setting="${setting}"]`);
  if (!group) return;
  for (const btn of group.querySelectorAll('button')) {
    btn.classList.toggle('active', btn.dataset.value === value);
  }
}

function getSegmentedValue(setting) {
  return document.querySelector(`.segmented-control[data-setting="${setting}"] button.active`)?.dataset.value;
}

document.addEventListener('keydown', (e) => {
  if (e.key === 'Escape') closeSettings();
});

// ── File attachments ──────────────────────────────────────────

attachBtn.addEventListener('click', () => fileInput.click());

fileInput.addEventListener('change', async (e) => {
  for (const file of e.target.files) await processAttachment(file);
  renderAttachPreviews();
  e.target.value = '';
});

document.addEventListener('paste', async (e) => {
  if (HectraState.isLoading || !e.clipboardData) return;

  const files = getPastedImageFiles(e.clipboardData);
  if (!files.length) return;

  e.preventDefault();
  for (const file of files) await processAttachment(file);
  renderAttachPreviews();
  userInput.focus();
});

function getPastedImageFiles(clipboardData) {
  const files = [];
  for (const item of clipboardData.items || []) {
    if (item.kind !== 'file' || !item.type.startsWith('image/')) continue;
    const file = item.getAsFile();
    if (!file) continue;
    const extension = (file.type.split('/')[1] || 'png').replace('jpeg', 'jpg');
    const name = file.name || `pasted-image-${Date.now()}.${extension}`;
    files.push(new File([file], name, { type: file.type, lastModified: file.lastModified }));
  }
  return files;
}

function formatFileSize(bytes) {
  if (bytes < 1024) return bytes + ' B';
  if (bytes < 1024 * 1024) return (bytes / 1024).toFixed(1) + ' KB';
  return (bytes / (1024 * 1024)).toFixed(1) + ' MB';
}

async function processAttachment(file) {
  const imageTypes = ['image/jpeg', 'image/png', 'image/gif', 'image/webp'];
  const size = formatFileSize(file.size);
  if (imageTypes.includes(file.type)) {
    if (file.size > HectraSecurity.MAX_IMAGE_ATTACHMENT_BYTES) {
      appendErrorMsg(`File is too large: ${file.name}`);
      return;
    }
    const dataUrl = await fileToDataUrl(file);
    if (!HectraSecurity.isSafeImageDataUrl(dataUrl)) {
      appendErrorMsg(`Unsupported image: ${file.name}`);
      return;
    }
    const previewDataUrl = await createImagePreviewDataUrl(file, dataUrl);
    pendingAttachments.push({ name: file.name, kind: 'image', mimeType: file.type, dataUrl, previewDataUrl, size });
  } else if (isPdfFile(file)) {
    if (file.size > HectraSecurity.MAX_PDF_ATTACHMENT_BYTES) {
      appendErrorMsg(`PDF file is too large: ${file.name}`);
      return;
    }
    try {
      const text = await extractPdfText(file);
      if (!text.trim()) {
        appendErrorMsg(`No extractable text found in PDF: ${file.name}`);
        return;
      }
      if (new Blob([text]).size > HectraSecurity.MAX_TEXT_ATTACHMENT_BYTES) {
        appendErrorMsg(`Extracted PDF text is too large: ${file.name}`);
        return;
      }
      pendingAttachments.push({ name: file.name, kind: 'text', mimeType: file.type, text, size });
    } catch (err) {
      console.error('[Hectra] PDF extraction failed:', err);
      appendErrorMsg(`Could not read PDF text: ${file.name}`);
    }
  } else {
    if (file.size > HectraSecurity.MAX_TEXT_ATTACHMENT_BYTES) {
      appendErrorMsg(`Text file is too large: ${file.name}`);
      return;
    }
    try {
      const text = await file.text();
      pendingAttachments.push({ name: file.name, kind: 'text', text, size });
    } catch {
      appendErrorMsg(`Could not read file: ${file.name}`);
    }
  }
}

function fileToDataUrl(file) {
  return new Promise(resolve => {
    const r = new FileReader();
    r.onload = e => resolve(e.target.result);
    r.readAsDataURL(file);
  });
}

function createImagePreviewDataUrl(file, fallbackDataUrl) {
  return new Promise(resolve => {
    const img = new Image();
    const objectUrl = URL.createObjectURL(file);

    img.onload = () => {
      URL.revokeObjectURL(objectUrl);

      const maxSide = 720;
      const scale = Math.min(1, maxSide / Math.max(img.naturalWidth || 1, img.naturalHeight || 1));
      const width = Math.max(1, Math.round((img.naturalWidth || 1) * scale));
      const height = Math.max(1, Math.round((img.naturalHeight || 1) * scale));

      try {
        const canvas = document.createElement('canvas');
        canvas.width = width;
        canvas.height = height;
        const ctx = canvas.getContext('2d');
        ctx.drawImage(img, 0, 0, width, height);
        const preview = canvas.toDataURL('image/jpeg', 0.78);
        resolve(HectraSecurity.isSafeImageDataUrl(preview) ? preview : fallbackDataUrl);
      } catch {
        resolve(fallbackDataUrl);
      }
    };

    img.onerror = () => {
      URL.revokeObjectURL(objectUrl);
      resolve(fallbackDataUrl);
    };

    img.src = objectUrl;
  });
}

function isPdfFile(file) {
  return file.type === 'application/pdf' || /\.pdf$/i.test(file.name);
}

async function extractPdfText(file) {
  if (!window.pdfjsLib) throw new Error('PDF.js is not loaded');

  pdfjsLib.GlobalWorkerOptions.workerSrc =
    'https://cdn.jsdelivr.net/npm/pdfjs-dist@3.11.174/build/pdf.worker.min.js';

  const data = await file.arrayBuffer();
  const pdf = await pdfjsLib.getDocument({ data }).promise;
  const pages = [];

  for (let pageNumber = 1; pageNumber <= pdf.numPages; pageNumber++) {
    const page = await pdf.getPage(pageNumber);
    const content = await page.getTextContent();
    const text = content.items
      .map(item => item.str)
      .join(' ')
      .replace(/\s+/g, ' ')
      .trim();

    if (text) pages.push(`--- Page ${pageNumber} ---\n${text}`);
  }

  return pages.join('\n\n');
}

function renderAttachPreviews() {
  if (!attachPreview) return;
  attachPreview.innerHTML = '';
  if (!pendingAttachments.length) { attachPreview.style.display = 'none'; return; }
  attachPreview.style.display = 'flex';

  pendingAttachments.forEach((att, i) => {
    const card = document.createElement('div');
    card.className = 'attach-card';

    const previewSrc = getAttachmentImageSrc(att);
    const iconHtml = att.kind === 'image'
      ? `<div class="attach-card-icon"><img src="${previewSrc}" alt="" /></div>`
      : `<div class="attach-card-icon">
           <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round">
             <path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"/>
             <polyline points="14 2 14 8 20 8"/>
           </svg>
         </div>`;

    card.innerHTML = `
      ${iconHtml}
      <div class="attach-card-meta">
        <span class="attach-card-name">${_esc(att.name)}</span>
        <span class="attach-card-size">${att.size || ''}</span>
      </div>
      <button class="attach-card-rm" title="Remove">
        <svg width="8" height="8" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="3" stroke-linecap="round">
          <line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/>
        </svg>
      </button>
    `;

    card.querySelector('.attach-card-rm').addEventListener('click', () => {
      pendingAttachments.splice(i, 1);
      renderAttachPreviews();
    });

    attachPreview.appendChild(card);
  });
}

function getAttachmentImageSrc(att) {
  const src = att?.dataUrl || att?.previewDataUrl || '';
  return HectraSecurity.isSafeImageDataUrl(src) ? src : '';
}

function _esc(str) {
  return String(str).replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;');
}

function buildUserContent(text, attachments) {
  if (!attachments.length) return text;
  const parts = [];
  for (const att of attachments) {
    if (att.kind === 'image') {
      parts.push({ type: 'image_url', image_url: { url: att.dataUrl, detail: 'high' } });
    } else {
      parts.push({ type: 'text', text: `[File: ${att.name}]\n\`\`\`\n${att.text}\n\`\`\`` });
    }
  }
  parts.push({ type: 'text', text });
  return parts;
}
newChatBtn.addEventListener('click', async () => {
  if (HectraState.isLoading) return;
  const allowed = await guardComposerNavigation({ kind: 'new' });
  if (!allowed) return;
  HectraHistoryUI.exitPreview({ silent: true });
  HectraMapUI.hide();
  HectraState.reset();
  chatContainer.innerHTML = buildWelcomeHTML();
  exitEditMode();
  pendingAttachments = [];
  renderAttachPreviews();
  setStatus('ready');
  HectraBranchUI.refresh();
  HectraHistoryUI.refreshIfOpen();
  const versionBar = document.getElementById('global-version-bar');
  if (versionBar) versionBar.classList.remove('visible');
  setSidebarOpen(false);
});

// ── Version control event delegation ──────────────────────────

document.addEventListener('click', async (e) => {
  const btn = e.target.closest('button');
  if (!btn) return;

  if (btn.dataset.action === 'edit-user-prompt') {
    const msgIndex = parseInt(btn.dataset.userMsg, 10);
    if (!isNaN(msgIndex)) enterPromptEditMode(msgIndex);
    return;
  }

  if (btn.dataset.action === 'delete-user-prompt') {
    const msgIndex = parseInt(btn.dataset.userMsg, 10);
    if (!isNaN(msgIndex)) await deletePromptPair(msgIndex);
    return;
  }

  // Branch from any message — user request or response alike.
  if (btn.dataset.action === 'branch-from-message') {
    const msgIndex = parseInt(btn.dataset.msgIndex, 10);
    if (!isNaN(msgIndex)) await HectraBranchUI.branchFromMessage(msgIndex);
    return;
  }

  const action = btn.dataset.action;
  const msgIndex = parseInt(btn.dataset.msg, 10);
  if (isNaN(msgIndex)) return;

  const msg = HectraState.uiMessages[msgIndex];
  if (!msg || msg.type !== 'assistant') return;

  if (action === 'prev-version') {
    if (msg.currentVersionIndex > 0) {
      HectraState.restoreVersion(msgIndex, msg.currentVersionIndex - 1);
      const sections = HectraState.getDocumentSectionsArray();
      const prevSnap = HectraState.getPreviousSnapshot(msgIndex);
      await withPreservedViewport(async () => {
        await HectraRenderer.renderAIContent(msgIndex, sections, [], [], {
          oldSnapshot: prevSnap,
          showDiff: !!prevSnap,
        });
        HectraRenderer.setChangelogs(msgIndex, msg.changelogs || []);
      });
    }
  } else if (action === 'next-version') {
    if (msg.currentVersionIndex < msg.versions.length - 1) {
      HectraState.restoreVersion(msgIndex, msg.currentVersionIndex + 1);
      const sections = HectraState.getDocumentSectionsArray();
      const prevSnap = HectraState.getPreviousSnapshot(msgIndex);
      await withPreservedViewport(async () => {
        await HectraRenderer.renderAIContent(msgIndex, sections, [], [], {
          oldSnapshot: prevSnap,
          showDiff: !!prevSnap,
        });
        HectraRenderer.setChangelogs(msgIndex, msg.changelogs || []);
      });
    }
  } else if (action === 'accept-version') {
    HectraState.acceptVersion(msgIndex);
    // After accepting - redraw without the diff and recreate the Edit button
    const sections = HectraState.getDocumentSectionsArray();
    await withPreservedViewport(async () => {
      await HectraRenderer.renderAIContent(msgIndex, sections, [], [], {});
      HectraRenderer.setChangelogs(msgIndex, msg.changelogs || []);
      // The Edit button has to stay
      HectraRenderer.setEditButton(msgIndex, true, () => enterEditMode(msgIndex));
    });
  } else if (action === 'reject-version') {
    const rejected = HectraState.rejectVersion(msgIndex);
    if (rejected) {
      const sections = HectraState.getDocumentSectionsArray();
      const prevSnap = HectraState.getPreviousSnapshot(msgIndex);
      await withPreservedViewport(async () => {
        await HectraRenderer.renderAIContent(msgIndex, sections, [], [], {
          oldSnapshot: prevSnap,
          showDiff: !!prevSnap,
        });
        HectraRenderer.setChangelogs(msgIndex, msg.changelogs || []);
        // The Edit button is recreated
        HectraRenderer.setEditButton(msgIndex, true, () => enterEditMode(msgIndex));
      });
    }
  }
});

// ── Send ──────────────────────────────────────────────────────

async function handleSend() {
  const raw = userInput.value.trim();
  if (!raw && !pendingAttachments.length || HectraState.isLoading) return;

  // A point something branched off no longer takes writing directly — its
  // document is the base those branches measured themselves against. The
  // instruction is not refused: it opens a branch of its own. Checked before
  // the input is cleared, so nothing is lost if the branch cannot be made.
  if (!HectraState.canWriteToBranch().allowed && !(await continueInNewBranch())) return;

  const attachments = [...pendingAttachments];
  pendingAttachments = [];
  renderAttachPreviews();
  clearInput();

  const frozenEditContext = HectraState.isEditMode
    ? createFrozenEditContext()
    : null;
  const text = scopeInstructionToSection(raw, frozenEditContext);
  if (promptEditIndex !== null) await regeneratePrompt(promptEditIndex, raw, attachments);
  else if (HectraState.isEditMode) await doEdit(withMergeContext(text), attachments, frozenEditContext);
  else await doChat(withMergeContext(text), attachments);
}

function createFrozenEditContext() {
  const focus = HectraBranchUI.sectionFocus;
  const targetSectionIds = focus?.mode === 'edit'
    ? [...(focus.sectionIds || [])]
    : [...HectraState.sectionOrder];
  return HectraState.createEditRequestContext({
    targetSectionIds,
    selectedText: focus?.mode === 'edit' ? String(focus.selectedText || '') : '',
  });
}

/** Where the instruction goes when the current point is closed to writing. */
async function continueInNewBranch() {
  const from = promptEditIndex !== null ? { fromMessageIndex: promptEditIndex } : {};
  const branch = await HectraBranchUI.createBranch({ ...from, skipDraftGuard: true });
  if (!branch) {
    appendErrorMsg('A branch could not be created here, so nothing was sent.');
    return false;
  }
  showTransientNotice('Continued in a new branch');
  return true;
}

/**
 * A merge leaves the document saying something this conversation never asked
 * for. One line of context — once, on the next instruction — is what stops the
 * model from quietly restoring what it remembers writing.
 */
function withMergeContext(text) {
  const notes = HectraState.takeBranchNotes();
  if (!notes.length || !text) return text;
  return `${text}\n\nContext: ${notes.join(' ')}`;
}

/**
 * When the composer points at sections, name them in the instruction so the
 * model edits the right ones. Section ids are the target; the selected text is
 * only extra context. The system prompts are untouched.
 */
function scopeInstructionToSection(text, frozenContext = null) {
  const focus = HectraBranchUI.sectionFocus;
  if ((!focus && !frozenContext) || !text) return text;

  const frozenSections = new Map((frozenContext?.baseSnapshot?.sections || []).map(section => [section.id, section]));
  const ids = (frozenContext?.targetSectionIds || focus?.sectionIds || [])
    .filter(id => frozenSections.has(id) || HectraState.documentSections.has(id));
  if (!ids.length) return text;

  const named = ids
    .map(id => {
      const section = frozenSections.get(id) || HectraState.documentSections.get(id);
      return `[#${id}] "${section?.title || id}"`;
    })
    .join(', ');
  const scoped = ids.length === 1 ? `Section ${named}: ${text}` : `Sections ${named}: ${text}`;

  const fragment = String(frozenContext?.selectedText ?? focus?.selectedText ?? '').trim();
  if (!fragment) return scoped;
  return `${scoped}\n\nSelected fragment for context: "${fragment.slice(0, 240)}${fragment.length > 240 ? '…' : ''}"`;
}

async function deletePromptPair(msgIndex) {
  if (HectraState.isLoading) return;
  const removed = HectraState.removePromptPair(msgIndex);
  if (!removed) return;

  if (promptEditIndex !== null && promptEditIndex >= msgIndex) exitPromptEditMode();
  exitEditMode();
  if (!HectraState.uiMessages.length) {
    const emptySessionId = HectraState.sessionId;
    HectraState.deleteSession(emptySessionId);
    HectraState.reset();
  }
  await renderAllMessages();
  HectraState.saveSession();
  renderSidebarSessions();
  setStatus('ready');
}

async function regeneratePrompt(msgIndex, text, newAttachments = []) {
  const existing = HectraState.uiMessages[msgIndex];
  if (!existing || existing.type !== 'user') {
    exitPromptEditMode();
    return;
  }

  const attachments = newAttachments.length ? newAttachments : promptEditAttachments;
  const content = buildUserContent(text, attachments);
  HectraState.updateUserMessage(msgIndex, text, null, attachments);
  HectraState.removeAssistantAfterUser(msgIndex);
  exitPromptEditMode();
  await renderAllMessages();

  setLoadingState(true);
  setStatus('thinking');

  try {
    const hasPriorAssistant = HectraState.uiMessages
      .slice(0, msgIndex)
      .some(m => m.type === 'assistant');

    if (!hasPriorAssistant) HectraState.switchToCreatorMode();
    else HectraState.switchToChatMode();

    const historyForApi = HectraState.chatHistory
      .slice(0, msgIndex + 2)
      .map((msg, i, arr) => i === arr.length - 1 ? { role: 'user', content } : msg);

    const raw = await callAPI(historyForApi, !hasPriorAssistant, hasPriorAssistant ? 'regenerate' : 'create');
    console.log('[Hectra] Regenerated response:\n', raw);

    const { sections, deletedIds } = parseMdResponse(raw);
    console.log('[Hectra] Regenerated sections:', sections.map(s => s.id), '| deleted:', deletedIds);

    HectraState.switchToChatMode();

    const logs = sections.length
      ? [`Document created: ${sections.map(s => s.title).join(', ')}`]
      : ['Response received'];

    HectraState.insertAIMessageAfterUser(msgIndex, raw, sections, logs);
    await renderAllMessages();

    HectraState.saveSession();
    renderSidebarSessions();
    if (msgIndex === 0) generateTitle(text);
    setStatus('ready');
  } catch (err) {
    console.error('[Hectra] Regenerate error:', err);
    if (err.name === 'AbortError') err = new Error('API request timed out. Try a shorter prompt.');
    appendErrorMsg(err.message || 'API error');
    setStatus('error');
    HectraState.switchToChatMode();
  } finally {
    setLoadingState(false);
    HectraRenderer.hideLoadingDots();
  }
}

// ── Chat (new message) ────────────────────────────────────────

async function doChat(text, attachments = []) {
  HectraRenderer.setEditButton(-1, false, null);

  const content = buildUserContent(text, attachments);
  // Store only plain text in chatHistory — images stay out of accumulated history
  const msg = HectraState.addUserMessage(text, null, attachments);
  HectraRenderer.hideWelcome();
  HectraRenderer.appendUserBubble(chatContainer, msg);

  setLoadingState(true);
  setStatus('thinking');

  try {
    if (!HectraState.hasDocument) {
      HectraState.switchToCreatorMode();
    }

    const isEditMode = !HectraState.hasDocument;
    // Inject full multipart content only for this one request
    const historyForApi = [
      ...HectraState.chatHistory.slice(0, -1),
      { role: 'user', content }
    ];
    const raw = await callAPI(historyForApi, isEditMode, isEditMode ? 'create' : 'chat');
    console.log('[Hectra] Chat response:\n', raw);

    const { sections, deletedIds } = parseMdResponse(raw);
    console.log('[Hectra] Parsed sections:', sections.map(s => s.id), '| deleted:', deletedIds);

    HectraState.switchToChatMode();

    const logs = sections.length
      ? [`Document created: ${sections.map(s => s.title).join(', ')}`]
      : ['Response received'];

    const aiMsg = HectraState.addAIMessage(raw, sections, logs);
    const orderedSections = HectraState.getDocumentSectionsArray();

    HectraRenderer.createAIMessageBlock(chatContainer, aiMsg.msgIndex);
    await HectraRenderer.renderAIContent(aiMsg.msgIndex, orderedSections, orderedSections.map(s => s.id));
    HectraRenderer.setEditButton(aiMsg.msgIndex, true, () => enterEditMode(aiMsg.msgIndex));

    // Save session and generate title after first exchange
    HectraState.saveSession();
    renderSidebarSessions();
    const isFirstExchange = HectraState.uiMessages.filter(m => m.type === 'user').length === 1;
    if (isFirstExchange) generateTitle(text);
    if (isFirstExchange) scheduleEditOnboarding(aiMsg.msgIndex);

    setStatus('ready');

  } catch (err) {
    console.error('[Hectra] Chat error:', err);
    if (err.name === 'AbortError') err = new Error('API request timed out. Try a shorter prompt.');
    appendErrorMsg(err.message || 'API error');
    setStatus('error');
    HectraState.switchToChatMode();
  } finally {
    setLoadingState(false);
    HectraRenderer.hideLoadingDots();
  }
}

// ── Edit (patch) ──────────────────────────────────────────────

async function doEdit(editText, attachments = [], frozenContext = null) {
  const preEditAnchor = captureScrollAnchor();
  setLoadingState(true, { scroll: false });
  setStatus('editing');

  HectraState.switchToEditMode();

  const content = buildUserContent(editText, attachments);
  const tempHistory = [
    ...keepLastConversationPairs(HectraState.chatHistory, 5),
    { role: 'user', content }
  ];

  try {
    const raw = await callAPI(tempHistory, true, 'edit');
    console.log('[Hectra] Edit response:\n', raw);

    const parsed = parseMdResponse(raw);
    const { sections, deletedIds } = parsed;
    console.log('[Hectra] Patch sections:', sections.map(s => s.id), '| deleted:', deletedIds);

    const logs = [];
    if (sections.length) logs.push(`Updated: ${sections.map(s => s.title).join(', ')}`);
    if (deletedIds.length) logs.push(`Deleted: ${deletedIds.join(', ')}`);
    if (!logs.length) logs.push('Document updated');

    const context = frozenContext || createFrozenEditContext();
    const proposal = HectraState.createEditProposal(parsed, context, logs);
    if (!proposal) throw new Error('No active AI message to edit');
    HectraState.saveWorkspace();

    if (HectraEditEngine.canAutoApply(proposal)) {
      const accepted = proposal.operations.map(operation => operation.operationId);
      const result = HectraState.commitEditProposal(proposal, accepted, { auto: true });
      if (!result.ok) throw new Error(result.error || 'The scoped edit could not be applied.');
      if (result.committed) {
        await renderCommittedEdit(result);
        HectraEditReviewUI.showUndoToast(result, undoCommittedEdit);
      }
    } else {
      openEditProposalReview(proposal);
    }
    setStatus('ready');

  } catch (err) {
    console.error('[Hectra] Edit error:', err);
    if (err.name === 'AbortError') err = new Error('API request timed out. Try a shorter edit instruction.');
    appendErrorMsg(err.message || 'Editing failed');
    setStatus('error');
  } finally {
    setLoadingState(false);
    HectraRenderer.hideLoadingDots();
    restoreScrollAnchor(preEditAnchor);
  }
}

function openEditProposalReview(proposal) {
  HectraEditReviewUI.openProposal(proposal, {
    onDecision: (operationId, decision) => HectraState.setEditProposalDecision(operationId, decision),
    onDiscard: () => {
      HectraState.discardEditProposal(proposal);
      HectraState.saveWorkspace();
      setStatus('ready');
      return { ok: true };
    },
    onCommit: async (_proposal, acceptedIds) => {
      const result = HectraState.commitEditProposal(proposal, acceptedIds);
      if (!result.ok) return result;
      if (result.committed) await renderCommittedEdit(result);
      else HectraState.saveWorkspace();
      return result;
    },
  });
}

async function renderCommittedEdit(result) {
  const updatedMsg = result.updatedMsg;
  if (!updatedMsg) return;
  const updatedIds = result.delta?.touchedSectionIds || [];
  const deletedIds = result.delta?.deletedSections?.map(item => item.id) || [];
  const orderedSections = HectraState.getDocumentSectionsArray();
  const prevSnap = HectraState.getPreviousSnapshot(updatedMsg.msgIndex);
  await withPreservedViewport(async () => {
    await HectraRenderer.renderAIContent(updatedMsg.msgIndex, orderedSections, updatedIds, deletedIds, {
      oldSnapshot: prevSnap,
      showDiff: !!prevSnap,
    });
    HectraRenderer.setChangelogs(updatedMsg.msgIndex, updatedMsg.changelogs || []);
    HectraRenderer.setEditButton(updatedMsg.msgIndex, true, () => enterEditMode(updatedMsg.msgIndex));
    document.querySelector(`[data-msg-index="${updatedMsg.msgIndex}"]`)?.classList.add('editing');
  });
  HectraState.saveSession();
  renderSidebarSessions();
}

async function undoCommittedEdit(commit) {
  const result = HectraState.undoLastEdit(commit?.requestId);
  if (!result.ok) return result;
  if (result.committed) await renderCommittedEdit(result);
  return result;
}

/**
 * Model assistance for one section inside the unsaved structure draft. The
 * response is only a suggestion: editReviewUI requires Use in draft, then
 * the regular structure Save performs the sole live commit.
 */
async function requestStructureSectionSuggestion({ sectionId, instruction, snapshot }) {
  const prepared = HectraStructureAssistant.buildRequest({
    sectionId,
    instruction,
    snapshot,
    systemPrompt: HectraConfig.STRUCTURE_SECTION_SYSTEM_PROMPT,
  });
  if (!prepared.ok) return prepared;

  try {
    const requestId = `structure-agent:${Date.now()}:${Math.random().toString(36).slice(2, 8)}`;
    const raw = await callAPI(prepared.messages, true, 'edit', { conversationId: requestId });
    return HectraStructureAssistant.parseSuggestion(parseMdResponse(raw), sectionId);
  } catch (error) {
    return { ok: false, error: error?.message || 'The section agent request failed.' };
  }
}

window.requestStructureSectionSuggestion = requestStructureSectionSuggestion;

function enterStructureMode() {
  if (HectraState.isLoading || HectraState.lastAIIndex < 0) return;
  const context = HectraState.createEditRequestContext({
    requestId: `structure_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`,
    targetSectionIds: [...HectraState.sectionOrder],
  });
  HectraEditReviewUI.openStructureEditor(context.baseSnapshot, {
    onAskAgent: request => window.requestStructureSectionSuggestion(request),
    onSave: async candidateSnapshot => {
      const proposal = HectraState.createManualStructureProposal(candidateSnapshot, {
        context,
        logs: ['Document structure or section content updated'],
      });
      const invalid = proposal.operations.find(operation => operation.authorization === HectraEditEngine.AUTHORIZATION.INVALID);
      if (invalid) return { ok: false, error: invalid.reason };
      const accepted = proposal.operations.map(operation => operation.operationId);
      const result = HectraState.commitEditProposal(proposal, accepted);
      if (!result.ok) return result;
      if (result.committed) await renderCommittedEdit(result);
      return result;
    },
    onError: message => appendErrorMsg(message),
  });
}

window.enterStructureMode = enterStructureMode;

/**
 * Re-renders a message against its previous version. An edit and a merge both
 * land as a new version, so both show the same diff, version bar and changelog.
 */
async function showDocumentDiff(msgIndex, updatedIds = [], deletedIds = []) {
  const message = HectraState.uiMessages[msgIndex];
  if (!message || message.type !== 'assistant') return;

  const sections = HectraState.getDocumentSectionsArray();
  const prevSnap = HectraState.getPreviousSnapshot(msgIndex);
  await withPreservedViewport(async () => {
    await HectraRenderer.renderAIContent(msgIndex, sections, updatedIds, deletedIds, {
      oldSnapshot: prevSnap,
      showDiff: !!prevSnap,
    });
    HectraRenderer.setChangelogs(msgIndex, message.changelogs || []);
    HectraRenderer.setEditButton(msgIndex, true, () => enterEditMode(msgIndex));
  });
}

/**
 * The one model call in the merge flow: combine two versions of a section.
 * Returns a proposal — the merge UI only uses it if the user accepts it.
 */
async function requestMergeCombination({ sectionId, title, base, current, branch, targetName, sourceName }) {
  const parts = [
    `Section id: ${sectionId}`,
    `Section title: ${title}`,
    base ? `ORIGINAL (before the branch):\n${base.content}` : 'ORIGINAL: this section did not exist before the branch.',
    current ? `CURRENT (${targetName}):\n${current.content}` : `CURRENT (${targetName}): the section was removed.`,
    branch ? `BRANCH (${sourceName}):\n${branch.content}` : `BRANCH (${sourceName}): the section was removed.`,
  ];

  const history = [
    { role: 'system', content: HectraConfig.MERGE_COMBINE_SYSTEM_PROMPT },
    {
      role: 'user',
      content: `${parts.join('\n\n')}\n\nОбъедини обе версии в одну секцию. Ответ — ровно одна секция:\n## ${title} [#${sectionId}]\n<содержимое>`,
    },
  ];

  const raw = await callAPI(history, true, 'edit');
  const { sections } = parseMdResponse(raw);
  const combined = sections.find(section => section.id === sectionId) || sections[0];
  if (!combined || !String(combined.content || '').trim()) {
    throw new Error('The model returned no usable combination. Nothing was changed.');
  }
  return { title: combined.title || title, content: combined.content.trim() };
}

// ── Edit mode ─────────────────────────────────────────────────

function enterEditMode(msgIndex) {
  exitPromptEditMode();
  HectraState.isEditMode = true;
  HectraState.switchToEditMode();
  inputBox.classList.add('edit-mode');
  cancelEditBtn.style.display = 'flex';
  userInput.focus();
  document.querySelectorAll('.msg-ai.editing').forEach(el => el.classList.remove('editing'));
  document.querySelector(`[data-msg-index="${msgIndex}"]`)?.classList.add('editing');
  HectraBranchUI.renderComposerContext();
}

function exitEditMode() {
  HectraState.isEditMode = false;
  HectraState.switchToChatMode();
  HectraBranchUI.sectionFocus = null;
  inputBox.classList.remove('edit-mode');
  cancelEditBtn.style.display = 'none';
  document.querySelectorAll('.msg-ai.editing').forEach(el => el.classList.remove('editing'));

  if (HectraState.lastAIIndex >= 0) {
    const msg = HectraState.uiMessages[HectraState.lastAIIndex];
    if (msg && msg.type === 'assistant') {
      HectraRenderer.setEditButton(msg.msgIndex, true, () => enterEditMode(msg.msgIndex));
    }
  }
  HectraBranchUI.renderComposerContext();
}

function enterPromptEditMode(msgIndex) {
  if (HectraState.isLoading) return;
  const msg = HectraState.uiMessages[msgIndex];
  if (!msg || msg.type !== 'user') return;

  exitEditMode();
  promptEditIndex = msgIndex;
  promptEditAttachments = msg.attachments || [];
  inputBox.classList.add('edit-mode');
  cancelEditBtn.style.display = 'flex';
  userInput.value = msg.text || '';
  userInput.dispatchEvent(new Event('input'));
  userInput.focus();

  document.querySelectorAll('.msg-user.prompt-editing').forEach(el => el.classList.remove('prompt-editing'));
  document.querySelector(`.msg-user[data-msg-index="${msgIndex}"]`)?.classList.add('prompt-editing');
  HectraBranchUI.renderComposerContext();
}

function exitPromptEditMode() {
  promptEditIndex = null;
  promptEditAttachments = [];
  document.querySelectorAll('.msg-user.prompt-editing').forEach(el => el.classList.remove('prompt-editing'));
  if (!HectraState.isEditMode) {
    inputBox.classList.remove('edit-mode');
    cancelEditBtn.style.display = 'none';
  }
  HectraBranchUI.renderComposerContext();
}

/** Read by the composer context chip. */
function isPromptEditing() {
  return promptEditIndex !== null;
}

function cancelInputMode() {
  exitPromptEditMode();
  exitEditMode();
  clearInput();
  HectraBranchUI.sectionFocus = null;
  HectraBranchUI.renderComposerContext();
}

// ── API ───────────────────────────────────────────────────────

/**
 * Strip base64 image_url from every history entry except the last.
 * Prevents massive payloads on follow-up messages.
 */
function sanitizeHistory(history) {
  return history.map((msg, i) => {
    if (i === history.length - 1 || !Array.isArray(msg.content)) return msg;
    const cleaned = msg.content.map(p =>
      p.type === 'image_url' ? { type: 'text', text: '[image]' } : p
    );
    const single = cleaned.length === 1 && cleaned[0].type === 'text';
    return { ...msg, content: single ? cleaned[0].text : cleaned };
  });
}

function sanitizeHistoryForApi(history) {
  return history.map((msg, i) => {
    const base = { ...msg };
    delete base.reasoning_content;
    delete base.reasoning;

    if (!Array.isArray(base.content)) {
      return { ...base, content: stripReasoning(base.content) };
    }

    if (i === history.length - 1) {
      return {
        ...base,
        content: base.content.map(p =>
          p.type === 'text' ? { ...p, text: stripReasoning(p.text) } : p
        )
      };
    }

    const cleaned = base.content.map(p =>
      p.type === 'image_url' ? { type: 'text', text: '[image omitted from previous turn]' } :
        p.type === 'text' ? { ...p, text: stripReasoning(p.text) } : p
    );
    const single = cleaned.length === 1 && cleaned[0].type === 'text';
    return { ...base, content: single ? cleaned[0].text : cleaned };
  });
}

function keepLastConversationPairs(history, maxPairs = 10) {
  if (!Array.isArray(history) || history.length <= 1) return history;

  const systemMessage = history[0];
  const conversation = history.slice(1);
  const maxMessages = maxPairs * 2;

  if (conversation.length <= maxMessages) return history;
  return [systemMessage, ...conversation.slice(-maxMessages)];
}

function stripReasoning(value) {
  if (typeof value !== 'string') return value;
  return value
    .replace(/<think\b[^>]*>[\s\S]*?<\/think>/gi, '')
    .replace(/<\/?think>/gi, '')
    .replace(/\n?---[ \t]*\nИСТОРИЯ ИЗМЕНЕНИЙ:[\s\S]*$/i, '')
    .replace(/\n?ИСТОРИЯ ИЗМЕНЕНИЙ:[\s\S]*$/i, '')
    .trim();
}

async function callAPI(history, isEdit = false, requestType = 'chat', options = {}) {
  const apiMode = sessionStorage.getItem(SETTINGS_KEYS.apiMode) || 'direct';
  const useDirect = apiMode === 'direct';
  const url = useDirect ? HectraConfig.DIRECT_API_URL : HectraConfig.API_URL;
  const headers = { 'Content-Type': 'application/json' };
  const conversationId = typeof options.conversationId === 'string'
    ? options.conversationId
    : getConversationId();
  const model = getModelForRequest(requestType, isEdit);
  const reasoningEffort = getReasoningEffortForRequest(model, requestType, isEdit);

  if (useDirect) {
    const token = HectraConfig.API_KEY;
    if (!token) throw new Error('Direct API mode is selected, but the token is empty');
    headers.Authorization = `Bearer ${token}`;
    if (conversationId) headers['x-grok-conv-id'] = conversationId;
  }

  const requestBody = {
    model,
    messages: sanitizeHistoryForApi(history),
    temperature: isEdit ? 0.3 : 0.7,
    top_p: 0.9,
  };
  if (reasoningEffort) requestBody.reasoning_effort = reasoningEffort;
  if (!useDirect) {
    requestBody.request_type = requestType;
    requestBody.conversation_id = conversationId;
  }

  const res = await fetch(url, {
    method: 'POST',
    headers,
    body: JSON.stringify(requestBody)
  });
  if (!res.ok) {
    const details = await readApiError(res);
    throw new Error(`API Error ${res.status}${details ? `: ${details}` : ''}`);
  }
  const data = await res.json();
  logTokenTotals(data, useDirect, requestType);
  const message = data.choices?.[0]?.message || {};
  return stripReasoning(extractAssistantText(message.content));
}

/** Separate read-only model path used only by the Map drawer. */
async function requestTemporaryChatAnswer(messages, sessionId) {
  return callAPI(messages, false, 'temporary-chat', { conversationId: sessionId || '' });
}

window.requestTemporaryChatAnswer = requestTemporaryChatAnswer;

function getModelForRequest(requestType, isEdit) {
  if (requestType === 'title') return HectraConfig.MODELS?.TITLE || 'grok-4-1-fast-non-reasoning';
  if (isEdit || requestType === 'edit' || requestType === 'regenerate') {
    return HectraConfig.MODELS?.EDIT || HectraConfig.MODEL || 'grok-4.3';
  }
  return HectraConfig.MODELS?.DEFAULT || HectraConfig.MODEL || 'grok-4.3';
}

function getReasoningEffortForRequest(model, requestType, isEdit) {
  if (model !== 'grok-4.3') return '';
  if (requestType === 'edit') return 'none';
  return 'low';
}

function getConversationId() {
  const id = String(HectraState.sessionId || '').trim();
  return /^[A-Za-z0-9._:-]{1,128}$/.test(id) ? id : '';
}

function logTokenTotals(data, useDirect, requestType = 'chat') {
  const totals = data?.hectra_token_totals || (useDirect ? updateBrowserTokenTotals(data?.usage, requestType) : null);
  if (!totals) return;
  const logType = totals.request_type || requestType;

  console.log(
    `[tokens][${logType}] sum: input=${totals.input}, output=${totals.output}, requests=${totals.requests}`
  );
  console.log(formatTokenReport(logType, totals.last_request, totals));
}

function updateBrowserTokenTotals(usage, requestType = 'chat') {
  if (!usage || typeof usage !== 'object') return null;

  const requestUsage = normalizeUsage(usage);
  const input = requestUsage.input;
  const output = requestUsage.output;

  browserTokenTotals.input += input;
  browserTokenTotals.output += output;
  browserTokenTotals.reasoning += requestUsage.reasoning;
  browserTokenTotals.total += requestUsage.total;
  browserTokenTotals.imageInput += requestUsage.imageInput;
  browserTokenTotals.cachedInput += requestUsage.cachedInput;
  browserTokenTotals.requests += 1;
  if (requestType === 'title') {
    browserTokenTotals.title.input += input;
    browserTokenTotals.title.output += output;
    browserTokenTotals.title.reasoning += requestUsage.reasoning;
    browserTokenTotals.title.total += requestUsage.total;
    browserTokenTotals.title.requests += 1;
  }
  browserTokenTotals.request_type = requestType;
  browserTokenTotals.last_request = requestUsage;

  return browserTokenTotals;
}

function numberOrZero(value) {
  if (typeof value === 'number' && Number.isFinite(value)) return value;
  if (typeof value === 'string' && value.trim() && Number.isFinite(Number(value))) return Number(value);
  return 0;
}

function extractInputTokens(usage) {
  return numberOrZero(
    usage.prompt_tokens ??
    usage.input_tokens ??
    usage.inputTokens ??
    usage.promptTokens
  );
}

function extractOutputTokens(usage) {
  return numberOrZero(
    usage.completion_tokens ??
    usage.output_tokens ??
    usage.completionTokens ??
    usage.outputTokens
  );
}

function normalizeUsage(usage) {
  const input = extractInputTokens(usage);
  const output = extractOutputTokens(usage);
  const totalFromApi = numberOrZero(usage.total_tokens ?? usage.totalTokens);
  const details = getUsageDetails(usage);
  const reasoning = numberOrZero(
    details.output.reasoning_tokens ??
    details.output.reasoningTokens ??
    usage.reasoning_tokens ??
    usage.reasoningTokens
  );
  const imageInput = numberOrZero(
    details.input.image_tokens ??
    details.input.imageTokens ??
    usage.prompt_image_tokens ??
    usage.promptImageTokens ??
    usage.input_image_tokens ??
    usage.inputImageTokens
  );
  const cachedInput = numberOrZero(
    details.input.cached_tokens ??
    details.input.cachedTokens ??
    usage.cached_prompt_text_tokens ??
    usage.cachedPromptTextTokens
  );
  const textInput = numberOrZero(details.input.text_tokens ?? details.input.textTokens);
  const audioInput = numberOrZero(details.input.audio_tokens ?? details.input.audioTokens);
  const audioOutput = numberOrZero(details.output.audio_tokens ?? details.output.audioTokens);
  const total = totalFromApi || input + output + reasoning;

  return {
    input,
    output,
    reasoning,
    outputBillable: output + reasoning,
    total,
    imageInput,
    cachedInput,
    textInput,
    audioInput,
    audioOutput,
    costUsdTicks: numberOrZero(usage.cost_in_usd_ticks ?? usage.costUsdTicks),
  };
}

function getUsageDetails(usage) {
  return {
    input: usage.prompt_tokens_details ?? usage.input_tokens_details ?? usage.promptTokensDetails ?? usage.inputTokensDetails ?? {},
    output: usage.completion_tokens_details ?? usage.output_tokens_details ?? usage.completionTokensDetails ?? usage.outputTokensDetails ?? {},
  };
}

function formatTokenReport(requestType, requestUsage, totals) {
  const last = requestUsage || {};
  const title = totals.title || {};
  const lines = [
    '##################',
    `TOKEN USAGE REPORT | type=${requestType}`,
    '------------------ REQUEST ------------------',
    tokenLine('input', last.input),
    tokenLine('output_visible', last.output),
    tokenLine('output_reasoning', last.reasoning),
    tokenLine('output_billable', last.outputBillable),
    tokenLine('total', last.total),
    '--------------- CACHE / MEDIA ---------------',
    tokenLine('image_input', last.imageInput),
    tokenLine('cached_input', last.cachedInput),
    tokenLine('text_input_detail', last.textInput),
    tokenLine('audio_input_detail', last.audioInput),
    tokenLine('audio_output_detail', last.audioOutput),
    '------------------ SESSION ------------------',
    tokenLine('input', totals.input),
    tokenLine('output_visible', totals.output),
    tokenLine('output_reasoning', totals.reasoning),
    tokenLine('output_billable', numberOrZero(totals.output) + numberOrZero(totals.reasoning)),
    tokenLine('total', totals.total),
    tokenLine('requests', totals.requests),
    '------------------- TITLE -------------------',
    tokenLine('input', title.input),
    tokenLine('generated_output', title.output),
    tokenLine('reasoning', title.reasoning),
    tokenLine('total', title.total),
    tokenLine('requests', title.requests),
  ];
  if (numberOrZero(last.costUsdTicks)) lines.push('-------------------- COST --------------------', tokenLine('cost_in_usd_ticks', last.costUsdTicks));
  lines.push('##################');
  return lines.join('\n');
}

function tokenLine(label, value) {
  return `${label.padEnd(22, ' ')} ${String(numberOrZero(value)).padStart(12, ' ')}`;
}

function extractAssistantText(content) {
  if (typeof content === 'string') return content;
  if (!Array.isArray(content)) return '';

  return content
    .map(part => {
      if (typeof part === 'string') return part;
      if (!part || typeof part !== 'object') return '';
      if (typeof part.text === 'string') return part.text;
      if (typeof part.content === 'string') return part.content;
      return '';
    })
    .filter(Boolean)
    .join('\n');
}

async function readApiError(res) {
  try {
    const text = await res.text();
    if (!text) return '';

    try {
      const data = JSON.parse(text);
      return data?.error?.message || data?.message || data?.error || text.slice(0, 240);
    } catch {
      return text.slice(0, 240);
    }
  } catch {
    return '';
  }
}

// ── UI helpers ────────────────────────────────────────────────

function setLoadingState(on, opts = {}) {
  HectraState.isLoading = on;
  userInput.disabled = on;
  sendBtn.disabled   = on;
  if (on) {
    sendBtn.innerHTML = '<div class="btn-spinner"></div>';
    HectraRenderer.showLoadingDots(chatContainer, { scroll: opts.scroll !== false });
  } else {
    sendBtn.innerHTML = `<svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round">
      <line x1="22" y1="2" x2="11" y2="13"></line><polygon points="22 2 15 22 11 13 2 9 22 2"></polygon>
    </svg>`;
  }
}

function captureScrollAnchor() {
  if (!chatScroll) return null;
  const scrollRect = chatScroll.getBoundingClientRect();
  const selectors = '.ai-section, .msg-ai, .msg-user, .changelogs-trail';
  const candidates = Array.from(chatContainer.querySelectorAll(selectors));
  const anchorEl = candidates.find(el => {
    const rect = el.getBoundingClientRect();
    return rect.bottom > scrollRect.top + 8 && rect.top < scrollRect.bottom - 8;
  });

  return {
    scrollTop: chatScroll.scrollTop,
    scrollHeight: chatScroll.scrollHeight,
    anchorEl,
    offsetTop: anchorEl ? anchorEl.getBoundingClientRect().top - scrollRect.top : 0,
  };
}

function restoreScrollAnchor(anchor) {
  if (!anchor || !chatScroll) return;

  requestAnimationFrame(() => {
    if (anchor.anchorEl && document.contains(anchor.anchorEl)) {
      const scrollRect = chatScroll.getBoundingClientRect();
      const nextOffset = anchor.anchorEl.getBoundingClientRect().top - scrollRect.top;
      chatScroll.scrollTop += nextOffset - anchor.offsetTop;
      return;
    }

    chatScroll.scrollTop = Math.min(anchor.scrollTop, chatScroll.scrollHeight - chatScroll.clientHeight);
  });
}

async function withPreservedViewport(task) {
  const anchor = captureScrollAnchor();
  const result = await task();
  restoreScrollAnchor(anchor);
  await new Promise(resolve => requestAnimationFrame(resolve));
  restoreScrollAnchor(anchor);
  return result;
}

function scheduleEditOnboarding(msgIndex) {
  const storage = getEditOnboardingStorage();
  if (storage.getItem(SETTINGS_KEYS.editOnboardingSeen) === '1') return;

  const btn = document.querySelector(`.msg-ai[data-msg-index="${msgIndex}"] .edit-trigger`);
  if (!btn) return;

  btn.scrollIntoView({ behavior: 'smooth', block: 'center', inline: 'nearest' });
  window.setTimeout(() => {
    if (!document.contains(btn)) return;
    HectraRenderer.showEditOnboarding(btn, {
      onClose: () => storage.setItem(SETTINGS_KEYS.editOnboardingSeen, '1'),
    });
  }, 520);
}

function getEditOnboardingStorage() {
  return HectraSecurity.storage();
}

function resetEditOnboardingWhenChatsAreEmpty() {
  const storage = getEditOnboardingStorage();
  if (HectraState.getAllSessionMeta().length > 0) return;

  storage.removeItem(SETTINGS_KEYS.editOnboardingSeen);
  localStorage.removeItem(SETTINGS_KEYS.editOnboardingSeen);
  sessionStorage.removeItem(SETTINGS_KEYS.editOnboardingSeen);
}

/**
 * Status is transient: a calm workspace says nothing at all. Only real activity
 * (and failures) get announced.
 */
function setStatus(state, detail) {
  const map = {
    thinking:      { color: '#f59e0b', label: 'Generating…' },
    editing:       { color: '#f59e0b', label: 'Applying edit…' },
    branching:     { color: '#3b82f6', label: 'Creating branch…' },
    switching:     { color: '#3b82f6', label: 'Switching branch…' },
    reconstructing:{ color: '#3b82f6', label: 'Reconstructing…' },
    merging:       { color: '#3b82f6', label: 'Merging…' },
    offline:       { color: '#707070', label: 'Offline' },
    error:         { color: '#ef4444', label: 'Error' },
  };

  const badge = document.getElementById('status-badge');
  const s = map[state];

  if (!s) {                        // 'ready' and anything unknown: say nothing
    if (badge) badge.hidden = true;
    if (statusText) statusText.textContent = '';
    return;
  }

  if (statusDot) statusDot.style.backgroundColor = s.color;
  if (statusText) statusText.textContent = detail || s.label;
  if (badge) badge.hidden = false;
}

function clearInput() {
  userInput.value = '';
  userInput.style.height = 'auto';
}

function isComposerDirty() {
  return !!userInput.value.trim() || pendingAttachments.length > 0;
}

function discardComposerDraft() {
  pendingAttachments = [];
  renderAttachPreviews();
  cancelInputMode();
}

async function guardComposerNavigation({ targetLabel = 'another branch', kind = 'switch' } = {}) {
  if (!isComposerDirty()) return true;
  const current = HectraState.getActiveBranch?.();
  const currentLabel = current?.name || HectraState.sessionTitle || 'this workspace';
  const startingNew = kind === 'new';
  const confirmed = await HectraUI.confirm({
    title: 'Discard this draft?',
    body: startingNew
      ? `This draft belongs to “${currentLabel}”. Starting a new workspace will discard it.`
      : `This draft belongs to “${currentLabel}”. Switching to “${targetLabel}” will discard it.`,
    cancelLabel: 'Stay here',
    confirmLabel: startingNew ? 'Start new and discard' : 'Switch and discard',
  });
  if (!confirmed) return false;
  discardComposerDraft();
  return true;
}

function showTransientNotice(message) {
  document.querySelector('.navigation-toast')?.remove();
  const toast = document.createElement('div');
  toast.className = 'edit-undo-toast navigation-toast';
  toast.setAttribute('role', 'status');
  toast.textContent = String(message || '');
  document.body.appendChild(toast);
  requestAnimationFrame(() => toast.classList.add('is-open'));
  window.setTimeout(() => {
    toast.classList.remove('is-open');
    window.setTimeout(() => toast.remove(), 160);
  }, 3000);
}

function appendErrorMsg(text) {
  const el = document.createElement('div');
  el.className = 'error-msg';
  el.textContent = '⚠ ' + text;
  chatContainer.appendChild(el);
}

// ── Title agent ───────────────────────────────────────────────

async function generateTitle(firstUserText) {
  try {
    const titleHistory = [
      { role: 'system', content: HectraConfig.TITLE_SYSTEM_PROMPT },
      { role: 'user', content: firstUserText },
    ];
    const title = (await callAPI(titleHistory, false, 'title')).trim().replace(/^["«]|["»]$/g, '').slice(0, 60);
    HectraState.sessionTitle = title;
    HectraState.saveSession();
    renderSidebarSessions();   // also refreshes the workspace name in the top bar
  } catch(e) { console.warn('[Hectra] Title generation failed:', e); }
}

// ── Session sidebar ───────────────────────────────────────────

/**
 * Repaints everything that reflects workspace/branch state. Kept under its old
 * name so every existing call site stays correct.
 */
function renderSidebarSessions() {
  HectraBranchUI.refresh();
  HectraHistoryUI.refreshIfOpen();
  HectraMapUI.refreshIfVisible();
}

function deleteWorkspace(sessionId) {
  if (!sessionId || HectraState.isLoading) return;
  HectraState.deleteSession(sessionId);
  HectraBranchUI.expandedWorkspaces.delete(sessionId);

  if (sessionId === HectraState.sessionId) {
    HectraState.reset();
    chatContainer.innerHTML = buildWelcomeHTML();
    exitEditMode();
    HectraMapUI.hide();
    HectraHistoryUI.exitPreview({ silent: true });
  }
  HectraBranchUI.refresh();
}

async function restoreSessionUI(sessionData, options = {}) {
  if (HectraState.isLoading) return false;
  if (!options.skipDraftGuard) {
    const allowed = await guardComposerNavigation({ targetLabel: sessionData?.title || 'another workspace' });
    if (!allowed) return false;
  }
  HectraHistoryUI.exitPreview({ silent: true });
  HectraMapUI.destroyTemporaryChat?.();
  HectraState.loadSession(sessionData);
  await renderAllMessages();
  HectraHistoryUI.refreshIfOpen();
  HectraMapUI.refreshIfVisible();
  return true;
}

async function renderAllMessages() {
  chatContainer.innerHTML = '';
  HectraSelectionUI.hide();
  exitEditMode();
  exitPromptEditMode();
  const versionBar = document.getElementById('global-version-bar');
  if (versionBar) versionBar.classList.remove('visible');

  if (!HectraState.uiMessages.length) {
    chatContainer.innerHTML = buildWelcomeHTML();
    HectraBranchUI.refresh();
    setStatus('ready');
    return;
  }

  for (const msg of HectraState.uiMessages) {
    if (msg.type === 'user') {
      HectraRenderer.appendUserBubble(chatContainer, {
        msgIndex: msg.msgIndex,
        text: msg.text,
        attachments: msg.attachments || [],
        timestamp: new Date(msg.timestamp),
      });
    } else if (msg.type === 'assistant') {
      const currentVersion = msg.versions?.[msg.currentVersionIndex ?? 0];
      const sections = currentVersion?.sections || msg.displaySections || HectraState.getDocumentSectionsArray();
      HectraRenderer.createAIMessageBlock(chatContainer, msg.msgIndex);
      await HectraRenderer.renderAIContent(msg.msgIndex, sections, [], [], {});
      HectraRenderer.setChangelogs(msg.msgIndex, msg.changelogs || []);
      if (msg.msgIndex === HectraState.lastAIIndex) {
        HectraRenderer.setEditButton(msg.msgIndex, true, () => enterEditMode(msg.msgIndex));
      }
    }
  }
  HectraBranchUI.refresh();
  setStatus('ready');
}

function buildWelcomeHTML() {
  return `
    <div id="welcome-screen" class="welcome-screen">
      <img src="logo.png" class="welcome-logo-img" alt="Hectra" />
      <h2 class="welcome-title">Hectra Workspace</h2>
      <p class="welcome-sub">Create a live document, then select text inside any section to change that section.<br>Your selection guides the request; the whole section is the authorized change boundary.</p>
      <div class="welcome-chips">
        <button class="hint-chip" type="button">Explain quantum computers</button>
        <button class="hint-chip" type="button">Write an ML project plan</button>
        <button class="hint-chip" type="button">Explain the SOLID principles</button>
      </div>
    </div>
  `;
}

document.addEventListener('click', (e) => {
  const hint = e.target.closest('.hint-chip');
  if (!hint) return;
  fillHint(hint);
});

// ── Internal history viewer ───────────────────────────────────
// Console-only on purpose: the action log is data architecture, the chat UI
// stays exactly as heavy as it was. Run HectraDebug.history() in DevTools.

window.HectraDebug = {
  history(limit = 50) {
    const text = HectraState.formatActionLog(limit);
    console.log(
      `[Hectra] workspace ${HectraState.workspaceId} · branch ${HectraState.branchId} · ` +
      `lastActionSeq ${HectraState.lastActionSeq} · ${HectraState.actions.length} action(s) in memory`
    );
    console.log(text || '(no actions yet)');
    return HectraState.lastActionSeq;
  },
  actions()          { return HectraState.getActions(); },
  action(seq)        { return HectraState.getAction(seq); },
  branch(branchId)   { return HectraState.getActionsByBranch(branchId); },
  session(sessionId) { return HectraState.getActionsBySession(sessionId || HectraState.sessionId); },
  issues()           { return HectraState.getActionLogIssues(); },
};

function fillHint(el) {
  userInput.value = el.textContent;
  userInput.focus();
  userInput.dispatchEvent(new Event('input'));
}
