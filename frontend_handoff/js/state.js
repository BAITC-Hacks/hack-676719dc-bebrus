// ============================================================
//  HECTRA — State (updated with versioning + dual agents)
// ============================================================

const HectraState = {
  chatHistory:      [],
  uiMessages:       [],
  lastAIIndex:      -1,
  documentSections: new Map(),
  sectionOrder:     [],
  isLoading:        false,
  isEditMode:       false,
  sessionId:        null,
  sessionTitle:     null,
  sessionCreatedAt: null,

  // ── Workspace-level append-only history ──
  // actionSeq belongs to the workspace, never to a session, a branch or a
  // document. Sessions and branches are metadata on top of one chronology.
  workspaceId:      null,
  branchId:         'main',
  branches:         [],
  branchTracks:     {},   // saved conversation+document of INACTIVE branches
  branchBases:      {},   // fork-point document per branch — the merge base
  branchNotes:      {},   // one-shot context per branch: what a merge brought in
  actions:          [],
  lastActionSeq:    0,
  actionLogIssues:  [],
  pendingEditProposal: null, // in-memory only; never serialized with a workspace
  editUndo:          null,   // one recoverable committed edit, also in-memory only

  _SESSIONS_KEY: 'hectra_sessions',
  _SESSION_SCHEMA_VERSION: 2,
  _ACTIVE_WORKSPACE_KEY: 'hectra_workspace_id',
  _WORKSPACE_KEY_PREFIX: 'hectra_workspace_',
  _WORKSPACE_ID_RE: /^ws_\d+$/,
  _MAX_WORKSPACE_BYTES: 2 * 1024 * 1024,
  _MAX_ACTION_LOG_ISSUES: 50,

  init() {
    this.chatHistory      = [{ role: 'system', content: HectraConfig.CHAT_SYSTEM_PROMPT }];
    this.uiMessages       = [];
    this.documentSections = new Map();
    this.sectionOrder     = [];
    this.lastAIIndex      = -1;
    this.isLoading        = false;
    this.isEditMode       = false;
    this.pendingEditProposal = null;
    this.editUndo         = null;
    this.sessionId        = 'sess_' + Date.now();
    this.sessionTitle     = null;
    this.sessionCreatedAt = Date.now();

    // A new session (including "New chat") never resets the action log:
    // the workspace sequence continues where it left off. Branches, however,
    // belong to the session the user sees as a workspace, so they start fresh.
    this._initWorkspace();
    this._resetBranchState();
  },

  reset() { this.init(); },

  // System prompt switching
  switchToChatMode() {
    this.chatHistory[0].content = HectraConfig.CHAT_SYSTEM_PROMPT;
  },
  switchToCreatorMode() {
    this.chatHistory[0].content = HectraConfig.CREATOR_SYSTEM_PROMPT;
  },
  switchToEditMode() {
    this.chatHistory[0].content = HectraConfig.EDIT_SYSTEM_PROMPT;
  },

  addUserMessage(text, content = null, attachments = []) {
    const msg = { type: 'user', msgIndex: this.uiMessages.length, text, attachments, timestamp: new Date() };
    this.uiMessages.push(msg);
    this.chatHistory.push({ role: 'user', content: content || text });
    this._recordAction(this._types().USER_MESSAGE, {
      messageIndex: msg.msgIndex,
      text: typeof text === 'string' ? text : '',
      attachmentCount: Array.isArray(attachments) ? attachments.length : 0,
    });
    return msg;
  },

  updateUserMessage(msgIndex, text, content = null, attachments = null) {
    const msg = this.uiMessages[msgIndex];
    if (!msg || msg.type !== 'user') return null;

    const previousText = typeof msg.text === 'string' ? msg.text : '';
    msg.text = text;
    if (attachments) msg.attachments = attachments;
    this.chatHistory[msgIndex + 1] = { role: 'user', content: content || text };
    this._recordAction(this._types().USER_MESSAGE_EDITED, {
      messageIndex: msgIndex,
      text: typeof text === 'string' ? text : '',
      previousText,
    });
    return msg;
  },

  removePromptPair(msgIndex) {
    const msg = this.uiMessages[msgIndex];
    if (!msg || msg.type !== 'user') return false;

    const count = this.uiMessages[msgIndex + 1]?.type === 'assistant' ? 2 : 1;
    this.uiMessages.splice(msgIndex, count);
    this.chatHistory.splice(msgIndex + 1, count);
    this._reindexMessages();
    this._rebuildActiveDocumentFromLastAssistant();
    this._recordAction(this._types().MESSAGE_PAIR_DELETED, {
      messageIndex: msgIndex,
      removedCount: count,
    });
    return true;
  },

  removeAssistantAfterUser(msgIndex) {
    if (this.uiMessages[msgIndex]?.type !== 'user') return false;
    if (this.uiMessages[msgIndex + 1]?.type !== 'assistant') return false;

    this.uiMessages.splice(msgIndex + 1, 1);
    this.chatHistory.splice(msgIndex + 2, 1);
    this._reindexMessages();
    this._rebuildActiveDocumentFromLastAssistant();
    this._recordAction(this._types().ASSISTANT_MESSAGE_DISCARDED, {
      userMessageIndex: msgIndex,
      removedMessageIndex: msgIndex + 1,
    });
    return true;
  },

  /**
   * Returns sections in sectionOrder as an array.
   */
  getDocumentSectionsArray() {
    return this.sectionOrder
      .filter(id => this.documentSections.has(id))
      .map(id => this.documentSections.get(id));
  },

  /**
   * Add a full AI message (creation / new chat turn).
   * sections = array from parseMdResponse (ordered).
   */
  addAIMessage(rawText, sections, logs) {
    // Full document: reset
    this.documentSections = new Map();
    this.sectionOrder     = [];
    for (const sec of sections) {
      this.documentSections.set(sec.id, sec);
      this.sectionOrder.push(sec.id);
    }

    const msg = {
      type:       'assistant',
      msgIndex:   this.uiMessages.length,
      rawText,
      changelogs: [],
      modelChangelogs: [...logs],
      timestamp:  new Date(),
      displaySections: this.getDocumentSectionsArray().map(s => ({...s})),
      versions:   [ this._snapshot([]) ],
      currentVersionIndex: 0,
    };
    this.uiMessages.push(msg);
    this.chatHistory.push({ role: 'assistant', content: this._buildMdSnapshot() });
    this.lastAIIndex = msg.msgIndex;
    this._recordAIMessage(msg, 'chat');
    return msg;
  },

  insertAIMessageAfterUser(userMsgIndex, rawText, sections, logs) {
    const insertIndex = userMsgIndex + 1;

    this.documentSections = new Map();
    this.sectionOrder     = [];
    for (const sec of sections) {
      this.documentSections.set(sec.id, sec);
      this.sectionOrder.push(sec.id);
    }

    const msg = {
      type:       'assistant',
      msgIndex:   insertIndex,
      rawText,
      changelogs: [],
      modelChangelogs: [...logs],
      timestamp:  new Date(),
      displaySections: this.getDocumentSectionsArray().map(s => ({...s})),
      versions:   [ this._snapshot([]) ],
      currentVersionIndex: 0,
    };

    this.uiMessages.splice(insertIndex, 0, msg);
    this.chatHistory.splice(insertIndex + 1, 0, { role: 'assistant', content: this._buildMdSnapshot() });
    this._reindexMessages();
    this._rebuildActiveDocumentFromLastAssistant();
    this._recordAIMessage(this.uiMessages[insertIndex], 'regenerate');
    return this.uiMessages[insertIndex];
  },

  /** Freeze write scope and the exact document seen when an edit is sent. */
  createEditRequestContext(options = {}) {
    const engine = this._requireEditEngine();
    return engine.createRequestContext({
      requestId: options.requestId || `edit_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`,
      branchId: this._resolveBranchId(),
      targetMessageIndex: this.lastAIIndex,
      targetSectionIds: Array.isArray(options.targetSectionIds)
        ? [...options.targetSectionIds]
        : [...this.sectionOrder],
      selectedText: typeof options.selectedText === 'string' ? options.selectedText : '',
      baseSnapshot: this._snapshot(this.uiMessages[this.lastAIIndex]?.changelogs || []),
      capturedAtMs: Date.now(),
    });
  },

  /**
   * Parse output has already been produced by mdParser. This method only builds
   * and stores a proposal; it never changes the live document, history or
   * versions. DOCUMENT_EDIT_PROPOSED therefore no longer implies an apply.
   */
  createEditProposal(parsed, frozenContext, logs = []) {
    if (!frozenContext) return null;
    const engine = this._requireEditEngine();
    const proposal = engine.createProposal(parsed, frozenContext, {
      origin: 'model',
      logs,
      computeDelta: this._computeDelta.bind(this),
    });

    const proposedAction = this._recordAction(this._types().DOCUMENT_EDIT_PROPOSED, {
      requestId: proposal.requestId,
      targetMessageIndex: frozenContext.targetMessageIndex,
      initialScope: [...proposal.initialScope],
      proposedSectionIds: proposal.operations
        .filter(operation => !operation.kinds.includes(engine.KINDS.DELETE))
        .map(operation => operation.sectionId),
      proposedDeletedSectionIds: proposal.operations
        .filter(operation => operation.kinds.includes(engine.KINDS.DELETE))
        .map(operation => operation.sectionId),
      operations: proposal.operations.map(operation => ({
        operationId: operation.operationId,
        sectionId: operation.sectionId,
        kinds: [...operation.kinds],
        authorization: operation.authorization,
        reason: operation.reason,
      })),
      source: 'model',
    }, { branchId: frozenContext.branchId });
    proposal.proposedActionSeq = proposedAction?.actionSeq ?? null;
    this.pendingEditProposal = proposal;
    return proposal;
  },

  /** Build a local structural batch through the same normalized engine. */
  createManualStructureProposal(candidateSnapshot, options = {}) {
    const engine = this._requireEditEngine();
    const context = options.context || this.createEditRequestContext({
      requestId: options.requestId || `structure_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`,
      targetSectionIds: [...this.sectionOrder],
    });
    const proposal = engine.createProposalFromCandidate(candidateSnapshot, context, {
      origin: options.origin || 'manual-structure',
      logs: options.logs || ['Document structure updated'],
      computeDelta: this._computeDelta.bind(this),
    });
    this.pendingEditProposal = proposal;
    return proposal;
  },

  checkEditProposalFreshness(proposal = this.pendingEditProposal) {
    if (!proposal) return { fresh: false, reason: 'The edit proposal is no longer available.' };
    if (proposal.branchId !== this._resolveBranchId()) {
      return { fresh: false, reason: 'The active branch changed after this request was sent.' };
    }
    const current = this._snapshot(this.uiMessages[this.lastAIIndex]?.changelogs || []);
    const delta = this._computeDelta(proposal.baseSnapshot, current);
    if (!delta || delta.hasChanges) {
      return { fresh: false, reason: 'The document changed after this request was sent.' };
    }
    return { fresh: true, reason: '' };
  },

  setEditProposalDecision(operationId, decision) {
    const proposal = this.pendingEditProposal;
    const operation = proposal?.operations?.find(item => item.operationId === operationId);
    if (!operation) return false;
    const engine = this._requireEditEngine();
    if (operation.authorization === engine.AUTHORIZATION.INVALID && decision === engine.DECISIONS.ACCEPTED) {
      return false;
    }
    if (!Object.values(engine.DECISIONS).includes(decision)) return false;
    operation.decision = decision;
    return true;
  },

  /**
   * The sole model/manual edit write boundary. It validates freshness and the
   * complete accepted combination before one atomic document/version mutation.
   */
  commitEditProposal(proposal = this.pendingEditProposal, acceptedOperationIds = [], options = {}) {
    const engine = this._requireEditEngine();
    if (!proposal || proposal.status !== 'pending') {
      return { ok: false, error: 'The edit proposal is no longer pending.' };
    }

    const freshness = this.checkEditProposalFreshness(proposal);
    if (!freshness.fresh) {
      proposal.status = 'stale';
      proposal.staleReason = freshness.reason;
      return { ok: false, stale: true, error: `${freshness.reason} Repeat the request to use the latest document.` };
    }
    if (options.auto === true && !engine.canAutoApply(proposal)) {
      return { ok: false, error: 'This proposal contains changes that cannot be auto-applied.' };
    }

    const accepted = [...new Set(Array.isArray(acceptedOperationIds) ? acceptedOperationIds : [])];
    if (!accepted.length) {
      this.discardEditProposal(proposal);
      return { ok: true, committed: false, rejected: true };
    }

    const materialized = engine.materializeProposal(proposal, accepted, {
      explicitApproval: options.auto !== true,
      computeDelta: this._computeDelta.bind(this),
    });
    if (!materialized.ok) return { ok: false, error: materialized.error || 'The accepted changes are not structurally valid.' };
    if (!materialized.delta?.hasChanges) {
      this.discardEditProposal(proposal);
      return { ok: true, committed: false, noChanges: true };
    }

    const msg = this.uiMessages[this.lastAIIndex];
    if (!msg || msg.type !== 'assistant') return { ok: false, error: 'No active document is available.' };
    if (!msg.versions || !msg.versions.length) {
      msg.versions = [this._snapshot(msg.changelogs || [])];
      msg.currentVersionIndex = 0;
    }

    const beforeSnapshot = this._snapshot(msg.changelogs || []);
    const previousVersionIndex = msg.currentVersionIndex ?? (msg.versions.length - 1);
    const afterSnapshot = engine.clone(materialized.snapshot);
    afterSnapshot.changelogs = [...(beforeSnapshot.changelogs || []), ...(proposal.logs || [])];

    // Everything above is read-only. The complete candidate and invariants are
    // known valid before this single mutation block begins.
    this.documentSections = new Map(afterSnapshot.sections.map(section => [section.id, { ...section, position: null }]));
    this.sectionOrder = [...afterSnapshot.order];
    msg.changelogs = [...afterSnapshot.changelogs];
    msg.versions.push(engine.clone(afterSnapshot));
    msg.currentVersionIndex = msg.versions.length - 1;
    msg.displaySections = this.getDocumentSectionsArray().map(section => ({ ...section }));
    this._syncAssistantHistory();

    const acceptedSet = new Set(accepted);
    for (const operation of proposal.operations) {
      operation.decision = acceptedSet.has(operation.operationId)
        ? engine.DECISIONS.ACCEPTED
        : engine.DECISIONS.REJECTED;
    }
    proposal.status = 'committed';
    this.pendingEditProposal = null;

    const appliedAction = this._recordAction(this._types().DOCUMENT_EDIT_APPLIED, {
      requestId: proposal.requestId,
      targetMessageIndex: msg.msgIndex,
      previousVersionIndex,
      newVersionIndex: msg.currentVersionIndex,
      initialScope: [...proposal.initialScope],
      origin: proposal.origin || 'model',
      decisions: proposal.operations.map(operation => ({
        operationId: operation.operationId,
        sectionId: operation.sectionId,
        kinds: [...operation.kinds],
        authorization: operation.authorization,
        decision: operation.decision,
      })),
      updatedSectionIds: proposal.operations
        .filter(operation => acceptedSet.has(operation.operationId) && !operation.kinds.includes(engine.KINDS.DELETE))
        .map(operation => operation.sectionId),
      deletedSectionIds: proposal.operations
        .filter(operation => acceptedSet.has(operation.operationId) && operation.kinds.includes(engine.KINDS.DELETE))
        .map(operation => operation.sectionId),
      delta: this._computeDelta(beforeSnapshot, afterSnapshot),
    }, proposal.proposedActionSeq ? { parentActionSeq: proposal.proposedActionSeq } : {});

    if (options.recordUndo !== false) {
      this.editUndo = {
        requestId: proposal.requestId,
        branchId: proposal.branchId,
        initialScope: [...proposal.initialScope],
        beforeSnapshot: engine.clone(beforeSnapshot),
        afterSnapshot: engine.clone(afterSnapshot),
        appliedActionSeq: appliedAction?.actionSeq ?? null,
      };
    }

    return {
      ok: true,
      committed: true,
      requestId: proposal.requestId,
      updatedMsg: msg,
      versionIndex: msg.currentVersionIndex,
      beforeSnapshot,
      afterSnapshot,
      delta: this._computeDelta(beforeSnapshot, afterSnapshot),
      acceptedOperationIds: [...accepted],
    };
  },

  discardEditProposal(proposal = this.pendingEditProposal) {
    if (!proposal) return false;
    if (proposal.status === 'pending') proposal.status = 'discarded';
    if (this.pendingEditProposal === proposal) this.pendingEditProposal = null;
    return true;
  },

  /** Undo is another validated edit/version, never a destructive version prune. */
  undoLastEdit(requestId = null) {
    const undo = this.editUndo;
    const engine = this._requireEditEngine();
    if (!undo || (requestId && undo.requestId !== requestId)) {
      return { ok: false, error: 'That edit can no longer be undone.' };
    }
    if (undo.branchId !== this._resolveBranchId()
        || !engine.snapshotEquals(this._snapshot(), undo.afterSnapshot, this._computeDelta.bind(this))) {
      return { ok: false, stale: true, error: 'The document changed after that edit, so Undo is no longer safe.' };
    }

    const context = this.createEditRequestContext({
      requestId: `undo_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`,
      targetSectionIds: undo.initialScope,
    });
    const proposal = engine.createProposalFromCandidate(undo.beforeSnapshot, context, {
      origin: 'undo',
      logs: ['Previous document snapshot restored'],
      computeDelta: this._computeDelta.bind(this),
    });
    this.pendingEditProposal = proposal;
    const accepted = proposal.operations
      .filter(operation => operation.authorization !== engine.AUTHORIZATION.INVALID)
      .map(operation => operation.operationId);
    const result = this.commitEditProposal(proposal, accepted, { recordUndo: false });
    if (result.ok) this.editUndo = null;
    return result;
  },

  /**
   * Compatibility helper for older internal callers and tests. It still goes
   * through proposal + validation + one explicit commit; the product's model
   * pipeline never calls it directly.
   */
  applyEdit(sections, deletedIds, newLogs) {
    const context = this.createEditRequestContext({ targetSectionIds: [...this.sectionOrder] });
    const proposal = this.createEditProposal({ sections: sections || [], deletedIds: deletedIds || [] }, context, newLogs || []);
    if (!proposal) return null;
    const engine = this._requireEditEngine();
    const accepted = proposal.operations
      .filter(operation => operation.authorization !== engine.AUTHORIZATION.INVALID)
      .map(operation => operation.operationId);
    const result = this.commitEditProposal(proposal, accepted);
    if (!result.ok || !result.committed) return null;
    return {
      updatedMsg: result.updatedMsg,
      updatedIds: proposal.operations
        .filter(operation => accepted.includes(operation.operationId) && !operation.kinds.includes(engine.KINDS.DELETE))
        .map(operation => operation.sectionId),
      deletedIds: proposal.operations
        .filter(operation => accepted.includes(operation.operationId) && operation.kinds.includes(engine.KINDS.DELETE))
        .map(operation => operation.sectionId),
    };
  },

  /**
   * Restore document state to a specific version of the given AI message.
   *
   * Restoring never removes history: it appends a VERSION_RESTORED action that
   * says "state was restored". Pass { log: false } for internal restores that
   * are a step of a larger action.
   */
  restoreVersion(msgIndex, versionIndex, options = {}) {
    const msg = this.uiMessages[msgIndex];
    if (!msg || !msg.versions || versionIndex < 0 || versionIndex >= msg.versions.length) return false;

    const fromVersionIndex = msg.currentVersionIndex ?? 0;
    const beforeSnapshot = this._snapshot(msg.changelogs || []);

    const snap = msg.versions[versionIndex];
    this.documentSections = new Map(snap.sections.map(s => [s.id, s]));
    this.sectionOrder = [...snap.order];
    msg.changelogs = [...(snap.changelogs || [])];
    msg.currentVersionIndex = versionIndex;
    this._syncAssistantHistory();

    if (options.log !== false) {
      this._recordAction(this._types().VERSION_RESTORED, {
        messageIndex: msgIndex,
        fromVersionIndex,
        toVersionIndex: versionIndex,
        delta: this._computeDelta(beforeSnapshot, this._snapshot(msg.changelogs)),
      });
    }
    return true;
  },

  /**
   * Accept the current version: delete all other versions, make current the only one.
   */
  acceptVersion(msgIndex) {
    const msg = this.uiMessages[msgIndex];
    if (!msg) return;
    const acceptedVersionIndex = msg.currentVersionIndex;
    const previousVersionCount = msg.versions?.length ?? 0;
    const current = msg.versions[msg.currentVersionIndex];
    msg.versions = [current];
    msg.currentVersionIndex = 0;
    msg.changelogs = [...(current.changelogs || [])];
    this._syncAssistantHistory();
    this._recordAction(this._types().VERSION_ACCEPTED, {
      messageIndex: msgIndex,
      acceptedVersionIndex,
      discardedVersionCount: Math.max(0, previousVersionCount - 1),
    });
  },

  /**
   * Reject the current version (if there is a previous one): go back to previous version.
   * The rejected version disappears from the snapshot list, but the log keeps
   * both the action that created it and the rejection itself.
   */
  rejectVersion(msgIndex) {
    const msg = this.uiMessages[msgIndex];
    if (!msg || msg.versions.length <= 1) return false;

    const rejectedVersionIndex = msg.versions.length - 1;
    const beforeSnapshot = this._snapshot(msg.changelogs || []);

    // Remove last version and restore previous
    msg.versions.pop();
    const prevIndex = msg.versions.length - 1;
    const restored = this.restoreVersion(msgIndex, prevIndex, { log: false });
    if (!restored) return false;

    this._recordAction(this._types().VERSION_REJECTED, {
      messageIndex: msgIndex,
      rejectedVersionIndex,
      restoredVersionIndex: prevIndex,
      delta: this._computeDelta(beforeSnapshot, this._snapshot(msg.changelogs)),
    });
    return true;
  },

  /**
   * Get the previous version snapshot of the given AI message (for diff).
   * Returns null if none.
   */
  getPreviousSnapshot(msgIndex) {
    const msg = this.uiMessages[msgIndex];
    if (!msg || msg.currentVersionIndex <= 0 || !msg.versions) return null;
    return msg.versions[msg.currentVersionIndex - 1];
  },

  // ── Action log (append-only) ─────────────────────────────────

  /**
   * The only place in Hectra that allocates an actionSeq. No other code may
   * touch lastActionSeq.
   *
   * options:
   *   branchId        — defaults to the active branch ("main")
   *   parentActionSeq — explicit causal parent; null means root.
   *                     Defaults to the last action on the same branch and is
   *                     never derived as actionSeq - 1.
   *   sessionId       — defaults to the active session
   *   createdAtMs     — defaults to Date.now()
   *
   * Throws on an exhausted sequence or an invalid record; callers inside
   * HectraState go through _recordAction, which keeps a logging failure from
   * touching document state.
   */
  appendAction(type, payload = {}, options = {}) {
    const log = this._requireActionLog();
    if (!this.workspaceId) this._initWorkspace();

    const nextActionSeq = this.lastActionSeq + 1;
    if (!Number.isInteger(nextActionSeq) || nextActionSeq < log.MIN_ACTION_SEQ || nextActionSeq > log.MAX_ACTION_SEQ) {
      throw new Error(
        `[Hectra] action sequence exhausted for workspace ${this.workspaceId}: ` +
        `${log.MAX_ACTION_SEQ} is the last usable actionSeq (no wraparound)`
      );
    }

    const branchId = this._resolveBranchId(options.branchId);
    const record = log.createAction({
      actionSeq:       nextActionSeq,
      workspaceId:     this.workspaceId,
      type,
      createdAtMs:     Number.isFinite(options.createdAtMs) ? options.createdAtMs : Date.now(),
      parentActionSeq: this._resolveParentActionSeq(options, branchId),
      branchId,
      sessionId:       options.sessionId !== undefined ? options.sessionId : (this.sessionId || null),
      payload,
      schemaVersion:   log.ACTION_SCHEMA_VERSION,
    });

    this._ensureBranch(branchId);
    this.actions.push(record);
    this.lastActionSeq = record.actionSeq;
    return record;
  },

  getAction(seq) {
    if (!Number.isInteger(seq)) return null;
    return this.actions.find(action => action.actionSeq === seq) || null;
  },

  /** Canonical actionSeq ASC order. */
  getActions() {
    const log = this._optionalActionLog();
    return log ? log.sortActions(this.actions) : [...this.actions];
  },

  getActionsAfter(seq) {
    const from = Number.isInteger(seq) ? seq : 0;
    return this.getActions().filter(action => action.actionSeq > from);
  },

  /** Inclusive on both ends. */
  getActionsBetween(fromSeq, toSeq) {
    const from = Number.isInteger(fromSeq) ? fromSeq : 0;
    const to   = Number.isInteger(toSeq) ? toSeq : this.lastActionSeq;
    return this.getActions().filter(action => action.actionSeq >= from && action.actionSeq <= to);
  },

  getLatestAction() {
    const actions = this.getActions();
    return actions.length ? actions[actions.length - 1] : null;
  },

  getActionsByBranch(branchId) {
    const id = typeof branchId === 'string' ? branchId.trim() : '';
    if (!id) return [];
    return this.getActions().filter(action => action.branchId === id);
  },

  getActionsBySession(sessionId) {
    const id = typeof sessionId === 'string' ? sessionId.trim() : '';
    if (!id) return [];
    return this.getActions().filter(action => action.sessionId === id);
  },

  /** Default causal parent for the next action on a branch. */
  getLatestActionOnBranch(branchId) {
    const id = this._resolveBranchId(branchId);
    for (let i = this.actions.length - 1; i >= 0; i--) {
      if (this.actions[i].branchId === id) return this.actions[i];
    }
    return null;
  },

  getActionLogIssues() {
    return [...this.actionLogIssues];
  },

  /** Plain-text dump for the internal history viewer (see HectraDebug). */
  formatActionLog(limit = 50) {
    const log = this._optionalActionLog();
    if (!log) return '';
    const actions = this.getActions();
    const slice = Number.isInteger(limit) && limit > 0 ? actions.slice(-limit) : actions;
    return log.formatActions(slice);
  },

  // ── Branches ─────────────────────────────────────────────────
  //
  // A branch owns a *track*: its own conversation and document. The active
  // branch's track IS the live state (chatHistory / uiMessages /
  // documentSections / sectionOrder), so every existing consumer — renderer,
  // applyEdit, versions, diff — keeps working with no branch awareness at all.
  // Switching a branch swaps the live state; inactive tracks wait in
  // branchTracks. branchBases keeps each branch's fork-point document, which is
  // the merge base.

  getBranches() {
    return this.branches.map(branch => ({ ...branch }));
  },

  getBranch(branchId) {
    const id = typeof branchId === 'string' ? branchId.trim() : '';
    const branch = this.branches.find(item => item.id === id);
    return branch ? { ...branch } : null;
  },

  getActiveBranch() {
    return this.getBranch(this._resolveBranchId());
  },

  /**
   * Read the last visible assistant/document block from one branch without
   * switching branches or creating missing track state. The returned block is
   * detached from both the live state and branchTracks.
   */
  getBranchLastContentBlock(branchId) {
    const id = typeof branchId === 'string' ? branchId.trim() : '';
    const branch = this.branches.find(item => item.id === id);
    const statuses = this._branchStatuses();
    if (!branch || branch.status === statuses.DELETED || branch.status === statuses.MERGED) return null;

    const track = id === this._resolveBranchId()
      ? { uiMessages: this.uiMessages }
      : this.branchTracks[id];
    if (!track || !Array.isArray(track.uiMessages)) return null;

    for (let index = track.uiMessages.length - 1; index >= 0; index--) {
      const message = track.uiMessages[index];
      if (!message || message.type !== 'assistant') continue;

      const versions = Array.isArray(message.versions) ? message.versions : [];
      const versionIndex = Number.isInteger(message.currentVersionIndex) ? message.currentVersionIndex : 0;
      const version = versions[versionIndex];
      const visibleSections = Array.isArray(version?.sections)
        ? version.sections
        : (Array.isArray(message.displaySections) ? message.displaySections : []);
      if (!visibleSections.length) continue;

      const byId = new Map(visibleSections.map(section => [section.id, section]));
      const order = Array.isArray(version?.order)
        ? version.order.filter(sectionId => byId.has(sectionId))
        : visibleSections.map(section => section.id);
      const sections = order.map(sectionId => byId.get(sectionId)).filter(Boolean);
      const meaningful = sections.some(section => String(section.title || '').trim() || String(section.content || '').trim());
      if (!meaningful) continue;

      return JSON.parse(JSON.stringify({
        type: 'assistant-document-block',
        messageIndex: Number.isInteger(message.msgIndex) ? message.msgIndex : index,
        sections: sections.map(section => ({
          id: section.id,
          title: String(section.title || section.id || ''),
          content: String(section.content || ''),
        })),
        order: [...order],
        markdown: sections.map(section => `## ${section.title || section.id} [#${section.id}]\n${section.content || ''}`).join('\n\n'),
      }));
    }
    return null;
  },

  /** Branch tree for the map: [{ branch, children: [...] }] rooted at main. */
  getBranchTree() {
    const nodes = new Map(this.branches.map(branch => [branch.id, { branch: { ...branch }, children: [] }]));
    const roots = [];

    for (const node of nodes.values()) {
      const parent = node.branch.parentBranchId ? nodes.get(node.branch.parentBranchId) : null;
      if (parent) parent.children.push(node); else roots.push(node);
    }

    const byCreation = (a, b) => (a.branch.createdAtMs || 0) - (b.branch.createdAtMs || 0);
    const sortTree = node => { node.children.sort(byCreation); node.children.forEach(sortTree); };
    roots.sort(byCreation);
    roots.forEach(sortTree);
    return roots;
  },

  /**
   * Branches the user should see. Deleted ones never; archived ones on request;
   * merged ones never — a merge collapses two nodes into one, so the source has
   * no node left to stand on. It survives only in the log.
   */
  getVisibleBranches(options = {}) {
    const statuses = this._branchStatuses();
    return this.getBranches().filter(branch => {
      if (branch.status === statuses.DELETED) return false;
      if (branch.status === statuses.MERGED) return false;
      if (branch.status === statuses.ARCHIVED && !options.includeArchived) return false;
      return true;
    });
  },

  // ── Structure: where writing is allowed ──────────────────────
  //
  // A node is one continuous run of writing. The moment a branch grows out of
  // it, it stops being the place work happens: its document is the base every
  // child measured itself against, and writing into it after the fork would
  // move that base under them — every child would inherit conflicts nobody
  // caused. So only leaves are writable, and a node becomes a leaf again as
  // soon as its branches have collapsed back into it.

  /** Branches still hanging off this one. Merged, archived and deleted do not count. */
  getChildBranches(branchId) {
    const statuses = this._branchStatuses();
    const id = this._resolveBranchId(branchId);
    return this.branches
      .filter(branch => branch.parentBranchId === id && branch.status === statuses.OPEN)
      .map(branch => ({ ...branch }));
  },

  isBranchLeaf(branchId) {
    return this.getChildBranches(branchId).length === 0;
  },

  /**
   * Whether the next instruction may be written here.
   *
   * A frozen node does not refuse the instruction — the composer turns it into
   * a branch instead — so this reports why rather than a bare false.
   */
  canWriteToBranch(branchId) {
    const id = this._resolveBranchId(branchId);
    const branch = this.branches.find(item => item.id === id);
    if (!branch) return { allowed: false, code: 'unknown', children: [], reason: 'That branch no longer exists.' };

    const children = this.getChildBranches(id);
    if (!children.length) return { allowed: true, code: 'leaf', children: [], reason: '' };

    return {
      allowed: false,
      code: 'has-branches',
      children,
      reason: children.length === 1
        ? `“${branch.name}” is where “${children[0].name}” branched off, so it is no longer written to directly.`
        : `“${branch.name}” is where ${children.length} branches split off, so it is no longer written to directly.`,
    };
  },

  /** Every branch in this subtree, the branch itself included. */
  getSubtreeBranchIds(branchId) {
    const id = this._resolveBranchId(branchId);
    const collected = [];
    const walk = (currentId) => {
      collected.push(currentId);
      for (const child of this.branches.filter(branch => branch.parentBranchId === currentId)) {
        walk(child.id);
      }
    };
    walk(id);
    return collected;
  },

  /**
   * Creates a branch and switches to it. Returns the branch record, or null when
   * it cannot be created — never a half-created branch.
   *
   * options:
   *   fromMessageIndex — fork from the state at that message instead of the head
   *   fromSectionId / fromSectionIds — what the branch is meant to explore
   */
  createBranch(name, options = {}) {
    const log = this._optionalActionLog();
    if (!log) return null;

    const parentBranchId = this._resolveBranchId();
    const parentBranch = this.branches.find(branch => branch.id === parentBranchId);
    if (!parentBranch) return null;

    const fork = this._resolveFork(options);
    if (!fork) return null;

    const sectionIds = Array.isArray(options.fromSectionIds) ? options.fromSectionIds.filter(Boolean) : [];
    const branch = log.createBranch(this._nextBranchId(), {
      name: this._uniqueBranchName(name || this._suggestBranchName(options)),
      parentBranchId,
      forkActionSeq: fork.actionSeq,
      forkSectionId: options.fromSectionId || sectionIds[0] || null,
      forkSectionIds: sectionIds,
      forkMessageIndex: fork.messageIndex,
      createdAtMs: Date.now(),
    });

    // The branch continues from the forked state — the head, or an earlier message.
    this.branchTracks[branch.id] = fork.track;
    this.branchBases[branch.id] = fork.snapshot;
    this.branches.push(branch);

    this._recordAction(this._types().BRANCH_CREATED, {
      branchId: branch.id,
      name: branch.name,
      parentBranchId,
      forkSectionId: branch.forkSectionId,
      forkSectionIds: branch.forkSectionIds,
      forkMessageIndex: branch.forkMessageIndex,
      sectionCount: (fork.snapshot.order || []).length,
    }, { branchId: branch.id, parentActionSeq: branch.forkActionSeq });

    // The switch is part of creating the branch, so it is not a separate event.
    this.switchBranch(branch.id, { log: false });
    return { ...branch };
  },

  switchBranch(branchId, options = {}) {
    const id = typeof branchId === 'string' ? branchId.trim() : '';
    const branch = this.branches.find(item => item.id === id);
    if (!branch) return false;
    if (branch.status === this._branchStatuses().DELETED) return false;

    const from = this._resolveBranchId();
    if (id === from) return true;

    const track = this.branchTracks[id];
    if (!track) return false;  // no stored state for that branch — never invent one

    this.branchTracks[from] = this._captureTrack();
    this._applyTrack(track);
    delete this.branchTracks[id];
    this.branchId = id;

    if (options.log !== false) {
      this._recordAction(this._types().BRANCH_SWITCHED, { fromBranchId: from, toBranchId: id });
    }
    return true;
  },

  renameBranch(branchId, name) {
    const branch = this.branches.find(item => item.id === this._resolveBranchId(branchId));
    if (!branch || typeof name !== 'string' || !name.trim()) return null;

    const previousName = branch.name;
    branch.name = this._uniqueBranchName(name, branch.id);
    if (branch.name === previousName) return { ...branch };

    this._recordAction(this._types().BRANCH_RENAMED, {
      branchId: branch.id,
      name: branch.name,
      previousName,
    }, { branchId: branch.id });
    return { ...branch };
  },

  /**
   * Whether a branch may be deleted. Deletion must never orphan a graph node, so
   * the policy is deliberately conservative: root never, leaves yes, anything
   * with living descendants no (there is no explicit safe reparenting).
   */
  canDeleteBranch(branchId) {
    const log = this._optionalActionLog();
    const statuses = this._branchStatuses();
    const id = this._resolveBranchId(branchId);
    const branch = this.branches.find(item => item.id === id);

    if (!branch) return { allowed: false, code: 'unknown', reason: 'That branch no longer exists.' };
    if (id === (log ? log.DEFAULT_BRANCH_ID : 'main') || !branch.parentBranchId) {
      return { allowed: false, code: 'root', reason: 'The main branch is the root of the workspace and cannot be deleted.' };
    }
    if (branch.status === statuses.DELETED) {
      return { allowed: false, code: 'already-deleted', reason: 'That branch is already deleted.' };
    }

    const children = this.branches.filter(item => item.parentBranchId === id && item.status !== statuses.DELETED);
    if (children.length) {
      return {
        allowed: false,
        code: 'has-children',
        childCount: children.length,
        reason: `“${branch.name}” has ${children.length} child branch${children.length > 1 ? 'es' : ''} and cannot be deleted. Delete the child branches first.`,
      };
    }

    return {
      allowed: true,
      code: 'leaf',
      reason: '',
      hasUnmergedChanges: this.hasUnmergedChanges(id),
      isMerged: branch.status === statuses.MERGED,
    };
  },

  /** Does this branch hold document work that has not been merged? */
  hasUnmergedChanges(branchId) {
    const divergence = this.getBranchDivergence(branchId);
    return !!divergence && divergence.changedSectionCount > 0;
  },

  /**
   * Soft delete: the branch leaves the normal UI, its actions and its stored
   * state stay so provenance and older references keep resolving.
   */
  deleteBranch(branchId) {
    const statuses = this._branchStatuses();
    const id = this._resolveBranchId(branchId);
    const check = this.canDeleteBranch(id);
    if (!check.allowed) return null;

    const branch = this.branches.find(item => item.id === id);
    if (id === this._resolveBranchId()) {
      const parent = this.branches.find(item => item.id === branch.parentBranchId && item.status !== statuses.DELETED);
      const fallback = parent ? parent.id : (this._optionalActionLog() || {}).DEFAULT_BRANCH_ID || 'main';
      if (!this.switchBranch(fallback)) return null;   // never leave the UI on a deleted branch
    }

    branch.status = statuses.DELETED;
    branch.deletedAtMs = Date.now();

    this._recordAction(this._types().BRANCH_DELETED, {
      branchId: branch.id,
      name: branch.name,
      parentBranchId: branch.parentBranchId,
      hadUnmergedChanges: !!check.hasUnmergedChanges,
    }, { branchId: branch.id });

    return { ...branch };
  },

  /** Archiving hides a branch from the default lists; its history stays. */
  archiveBranch(branchId) {
    const log = this._optionalActionLog();
    const branch = this.branches.find(item => item.id === this._resolveBranchId(branchId));
    if (!branch || !log || branch.id === log.DEFAULT_BRANCH_ID) return null;
    if (branch.status === log.BRANCH_STATUSES.ARCHIVED) return { ...branch };

    if (branch.id === this.branchId) this.switchBranch(branch.parentBranchId || log.DEFAULT_BRANCH_ID);
    branch.status = log.BRANCH_STATUSES.ARCHIVED;
    this._recordAction(this._types().BRANCH_DISCARDED, { branchId: branch.id, name: branch.name }, { branchId: branch.id });
    return { ...branch };
  },

  /**
   * "Set as preferred" in the UI. Presentation / merge-policy metadata only:
   * it never changes an actionSeq and never reorders the log.
   */
  setBranchPriority(branchId, priority) {
    const branch = this.branches.find(item => item.id === this._resolveBranchId(branchId));
    if (!branch || !Number.isFinite(priority)) return null;
    branch.priority = priority;
    return { ...branch };
  },

  setPreferredBranch(branchId) {
    const target = this.branches.find(item => item.id === this._resolveBranchId(branchId));
    if (!target) return null;
    for (const branch of this.branches) branch.priority = branch === target ? 1 : 0;
    return { ...target };
  },

  getPreferredBranch() {
    const preferred = this.branches.filter(branch => branch.priority > 0)
      .sort((a, b) => b.priority - a.priority)[0];
    return preferred ? { ...preferred } : null;
  },

  /** { sections, order } for any branch — live state for the active one. */
  getBranchDocument(branchId) {
    const id = this._resolveBranchId(branchId);
    if (id === this._resolveBranchId()) {
      return { sections: this.getDocumentSectionsArray().map(s => ({ ...s })), order: [...this.sectionOrder] };
    }
    const track = this.branchTracks[id];
    if (!track) return null;
    return {
      sections: (track.documentSections || []).map(entry => ({ ...entry[1] })),
      order: [...(track.sectionOrder || [])],
    };
  },

  /**
   * What this branch has changed since it forked — the "N changes" the UI shows.
   *
   * Measured against the branch's own fork point, not against the parent's
   * current state, so later work on the parent is never counted as this
   * branch's doing. That keeps this number consistent with analyzeMerge().
   * Returns null for a branch without a fork point (main).
   */
  getBranchDivergence(branchId) {
    const log = this._optionalActionLog();
    if (!log) return null;

    const id = this._resolveBranchId(branchId);
    const branch = this.branches.find(item => item.id === id);
    if (!branch) return null;

    const base = this.branchBases[id];
    const document = this.getBranchDocument(id);
    if (!base || !document) return null;

    const delta = log.computeDocumentDelta(base, document);
    return {
      branchId: id,
      parentBranchId: branch.parentBranchId,
      changedSectionCount: delta.touchedSectionIds.length,
      delta,
    };
  },

  // ── Merge ────────────────────────────────────────────────────
  //
  // Two operations, and they are not variants of each other.
  //
  //   With a sibling — a real three-way merge. Both branches grew out of the
  //   same frozen parent, so they share one base and comparing them means
  //   something. This is the only place a conflict can exist at all.
  //
  //   With the ancestor — not a merge. A branch is its parent's track
  //   continued, and the parent has not moved since the fork, so the two are
  //   one run of writing with a boundary drawn through it. Collapsing removes
  //   the boundary: nothing to compare, nothing to resolve.
  //
  // Both are offered to leaves only, which is what makes a tree resolve from
  // the bottom up: children collapse into their parent first, and siblings then
  // meet each other as equals.

  /**
   * Siblings this branch may merge with.
   *
   * Both sides must be leaves. A node with branches of its own is somebody's
   * base — dissolving it, or writing a merge result into it, would move that
   * base under its children.
   */
  getSiblingMergeCandidates(branchId) {
    const statuses = this._branchStatuses();
    const id = this._resolveBranchId(branchId);
    const branch = this.branches.find(item => item.id === id);
    if (!branch || !branch.parentBranchId) return [];
    if (branch.status !== statuses.OPEN || !this.isBranchLeaf(id)) return [];

    return this.branches
      .filter(item => item.id !== id
        && item.parentBranchId === branch.parentBranchId
        && item.status === statuses.OPEN
        && this.isBranchLeaf(item.id))
      .map(item => ({ ...item }));
  },

  /**
   * Whether this branch can be dissolved into its ancestor, and what stands in
   * the way.
   *
   * Only siblings ever do: they measured themselves against the parent as it
   * was, and collapsing moves it. They can be given up explicitly (adopt) —
   * never silently, and never destroyed: giving up means archived.
   */
  canCollapseIntoParent(branchId) {
    const statuses = this._branchStatuses();
    const id = this._resolveBranchId(branchId);
    const branch = this.branches.find(item => item.id === id);

    if (!branch) return { allowed: false, code: 'unknown', siblings: [], reason: 'That branch no longer exists.' };
    if (!branch.parentBranchId) {
      return { allowed: false, code: 'root', siblings: [], reason: 'The root of the workspace has no ancestor to merge into.' };
    }
    if (branch.status !== statuses.OPEN) {
      return { allowed: false, code: 'not-open', siblings: [], reason: 'That branch is no longer active.' };
    }

    const parent = this.branches.find(item => item.id === branch.parentBranchId);
    if (!parent) return { allowed: false, code: 'no-parent', siblings: [], reason: 'Its ancestor is no longer available.' };

    const mergedName = `${parent.name} & ${branch.name}`;
    const siblings = this.getChildBranches(parent.id).filter(item => item.id !== id);
    const abandoned = siblings.flatMap(sibling => this.getSubtreeBranchIds(sibling.id));

    if (siblings.length) {
      return {
        allowed: false,
        code: 'has-siblings',
        parentName: parent.name,
        mergedName,
        siblings,
        abandonedCount: abandoned.length,
        reason: `“${parent.name}” is the point ${siblings.length + 1} branches split from. Merging “${branch.name}” into it closes that point, and the other ${abandoned.length} branch${abandoned.length > 1 ? 'es' : ''} would be given up.`,
      };
    }

    return {
      allowed: true,
      code: 'only-child',
      parentName: parent.name,
      mergedName,
      siblings: [],
      abandonedCount: 0,
      reason: '',
    };
  },

  /**
   * Dissolves a branch into its ancestor: one node, one conversation, one name.
   *
   * Nothing is compared and nothing can conflict — the branch's track already
   * begins with the parent's, so the surviving node simply takes it whole.
   * Branches taken off this one move up to the survivor; the messages they
   * forked from are inside that same track, so their fork points stay valid.
   *
   * options.adopt gives up the sibling subtrees (archived, never destroyed).
   */
  collapseIntoParent(branchId, options = {}) {
    const statuses = this._branchStatuses();
    const id = this._resolveBranchId(branchId);
    const check = this.canCollapseIntoParent(id);
    if (!check.allowed && !(check.code === 'has-siblings' && options.adopt)) return null;

    const child = this.branches.find(item => item.id === id);
    const parent = this.branches.find(item => item.id === child.parentBranchId);

    // The branch's run of writing, wherever it is being kept right now.
    const wasActive = id === this._resolveBranchId();
    const track = wasActive ? this._captureTrack() : this.branchTracks[id];
    if (!track) return null;

    const abandoned = [];
    for (const sibling of check.siblings) {
      for (const abandonedId of this.getSubtreeBranchIds(sibling.id)) {
        const branch = this.branches.find(item => item.id === abandonedId);
        if (!branch || branch.status !== statuses.OPEN) continue;
        branch.status = statuses.ARCHIVED;
        abandoned.push({ branchId: branch.id, name: branch.name });
      }
    }

    const previousName = parent.name;
    parent.name = this._uniqueBranchName(check.mergedName, parent.id);

    for (const branch of this.branches) {
      if (branch.parentBranchId === id) branch.parentBranchId = parent.id;
    }

    // Handing the track over. The parent's own copy is dropped rather than
    // merged: every message in it is already the start of the branch's.
    if (wasActive) {
      delete this.branchTracks[parent.id];
      this.branchId = parent.id;                      // the live state is already the right one
    } else if (parent.id === this._resolveBranchId()) {
      this._applyTrack(track);
      delete this.branchTracks[id];
    } else {
      this.branchTracks[parent.id] = track;
      delete this.branchTracks[id];
    }

    if (this.branchNotes[id]) {
      this.branchNotes[parent.id] = [...(this.branchNotes[parent.id] || []), ...this.branchNotes[id]];
      delete this.branchNotes[id];
    }

    child.status = statuses.MERGED;
    child.mergedIntoBranchId = parent.id;
    child.mergedAtMs = Date.now();

    // Nobody is left standing on a branch that was just given up.
    if (abandoned.some(entry => entry.branchId === this._resolveBranchId())) {
      this.switchBranch(parent.id, { log: false });
    }

    this._recordAction(this._types().BRANCH_COLLAPSED, {
      branchId: child.id,
      childName: child.name,
      intoBranchId: parent.id,
      name: parent.name,
      previousName,
      adoptedAway: abandoned,
    }, { branchId: parent.id });

    return {
      branchId: parent.id,
      name: parent.name,
      previousName,
      childName: child.name,
      abandoned,
    };
  },

  /**
   * What a merge brought into a branch, held until the next instruction is sent
   * from it. The document is authoritative, but the conversation still reads as
   * if those sections had never changed — one line of context is what keeps the
   * model from quietly restoring what it remembers promising.
   */
  takeBranchNotes(branchId) {
    const id = this._resolveBranchId(branchId);
    const notes = this.branchNotes[id] || [];
    delete this.branchNotes[id];
    return [...notes];
  },

  _addBranchNote(branchId, note) {
    if (!note) return;
    const id = this._resolveBranchId(branchId);
    this.branchNotes[id] = [...(this.branchNotes[id] || []), note];
  },

  /**
   * Three-way merge plan for a branch: BASE is the document the branch forked
   * from, TARGET the branch it merges into (its parent unless told otherwise),
   * SOURCE the branch itself.
   *
   * Returns a live plan object: resolving a conflict on it and calling
   * applyMerge() is the whole merge flow.
   */
  planMerge(sourceBranchId, targetBranchId) {
    const log = this._optionalActionLog();
    const engine = this._optionalMergeEngine();
    if (!log || !engine) return null;

    const sourceId = this._resolveBranchId(sourceBranchId);
    const source = this.branches.find(branch => branch.id === sourceId);
    if (!source) return null;

    const targetId = this._resolveBranchId(targetBranchId || source.parentBranchId || log.DEFAULT_BRANCH_ID);
    const target = this.branches.find(branch => branch.id === targetId);
    if (!target || sourceId === targetId) return null;

    const base = this.branchBases[sourceId];
    const sourceDocument = this.getBranchDocument(sourceId);
    const targetDocument = this.getBranchDocument(targetId);
    if (!base || !sourceDocument || !targetDocument) return null;

    const plan = engine.planMerge({
      base,
      target: targetDocument,
      source: sourceDocument,
      sourceName: source.name,
      targetName: target.name,
    });

    plan.sourceBranchId = sourceId;
    plan.targetBranchId = targetId;
    plan.alreadyMerged = source.status === this._branchStatuses().MERGED && !plan.hasChanges;
    return plan;
  },

  /**
   * Flat summary of a merge for the places that only need counts and titles
   * (branch map flag, merge button tooltip). Built from the same plan the merge
   * itself uses, so preview and result can never disagree.
   */
  analyzeMerge(sourceBranchId, targetBranchId) {
    const engine = this._optionalMergeEngine();
    const plan = this.planMerge(sourceBranchId, targetBranchId);
    if (!plan || !engine) return null;

    const describe = item => ({
      id: item.id,
      title: item.title,
      change: item.kind,
      reason: item.reason,
      sourceContent: item.source ? item.source.content : null,
      targetContent: item.target ? item.target.content : null,
      baseContent: item.base ? item.base.content : null,
    });

    return {
      sourceBranchId: plan.sourceBranchId,
      targetBranchId: plan.targetBranchId,
      sourceName: plan.sourceName,
      targetName: plan.targetName,
      compatible: plan.items.filter(item => item.status === engine.ITEM_STATUS.COMPATIBLE).map(describe),
      overlapping: plan.items.filter(item => item.status === engine.ITEM_STATUS.CONFLICT).map(describe),
      hasChanges: plan.hasChanges,
      canApply: plan.canApply,
      alreadyMerged: plan.alreadyMerged,
    };
  },

  /**
   * Applies a resolved merge plan.
   *
   * The result is a NEW state of the target branch — an extra version on its
   * live document, exactly like an edit — never a retroactive rewrite of the
   * target's history and never a blind copy of the branch snapshot. The source
   * branch keeps all of its own actions and state.
   *
   * Returns { ok, reason?, ... }.
   */
  applyMerge(plan) {
    const log = this._optionalActionLog();
    const engine = this._optionalMergeEngine();
    if (!log || !engine) return { ok: false, reason: 'unavailable' };
    if (!plan || !plan.canApply) return { ok: false, reason: 'unresolved' };

    const sourceId = plan.sourceBranchId;
    const targetId = plan.targetBranchId;
    const source = this.branches.find(branch => branch.id === sourceId);
    const target = this.branches.find(branch => branch.id === targetId);
    if (!source || !target) return { ok: false, reason: 'unknown-branch' };

    // A merged branch leaves the map, so it must not be holding anyone up: its
    // own branches forked from its document and would lose the node they grew
    // out of. They collapse first — that is the bottom-up order.
    if (!this.isBranchLeaf(sourceId)) return { ok: false, reason: 'source-has-branches' };

    const result = engine.buildResult(plan);
    if (!result || !result.order.length) return { ok: false, reason: 'empty-result' };
    if (result.sections.some(section => !section || !section.id)) return { ok: false, reason: 'invalid-result' };

    const sourceHead = this.getLatestActionOnBranch(sourceId);
    const targetHeadBefore = this.getLatestActionOnBranch(targetId);
    const previousBranchId = this._resolveBranchId();

    // The merge happens on the target branch, so the UI can never be left on a
    // branch holding a stale pointer to a state that moved on.
    if (previousBranchId !== targetId && !this.switchBranch(targetId, { log: false })) {
      return { ok: false, reason: 'target-unavailable' };
    }

    const holder = this.uiMessages[this.lastAIIndex];
    if (!holder || holder.type !== 'assistant') {
      if (previousBranchId !== targetId) this.switchBranch(previousBranchId, { log: false });
      return { ok: false, reason: 'no-document' };
    }

    const conflicts = plan.items.filter(item => item.status === engine.ITEM_STATUS.CONFLICT);
    const started = this._recordAction(this._types().MERGE_STARTED, {
      sourceBranchId: sourceId,
      targetBranchId: targetId,
      baseForkActionSeq: source.forkActionSeq ?? null,
      sourceHeadActionSeq: sourceHead ? sourceHead.actionSeq : null,
      targetHeadActionSeqBefore: targetHeadBefore ? targetHeadBefore.actionSeq : null,
      changeCount: plan.items.length,
      conflictCount: conflicts.length,
    }, {
      branchId: targetId,
      parentActionSeq: targetHeadBefore ? targetHeadBefore.actionSeq : null,
    });

    if (conflicts.length) {
      this._recordAction(this._types().MERGE_CONFLICT, {
        sourceBranchId: sourceId,
        targetBranchId: targetId,
        sectionIds: conflicts.map(item => item.id),
        resolutions: conflicts.map(item => ({
          sectionId: item.id,
          title: item.title,
          reason: item.reason,
          resolution: item.resolution,
        })),
      }, { branchId: targetId, parentActionSeq: started ? started.actionSeq : undefined });
    }

    const label = `Merged “${source.name}”: ${result.appliedSectionIds.length} change${result.appliedSectionIds.length === 1 ? '' : 's'}`;
    const applied = this._applyMergedDocument(result, [label]);
    if (!applied) {
      if (previousBranchId !== targetId) this.switchBranch(previousBranchId, { log: false });
      return { ok: false, reason: 'no-document' };
    }

    const completed = this._recordAction(this._types().MERGE_COMPLETED, {
      sourceBranchId: sourceId,
      targetBranchId: targetId,
      sourceName: source.name,
      targetName: target.name,
      baseForkActionSeq: source.forkActionSeq ?? null,
      sourceHeadActionSeq: sourceHead ? sourceHead.actionSeq : null,
      targetHeadActionSeqBefore: targetHeadBefore ? targetHeadBefore.actionSeq : null,
      targetMessageIndex: applied.messageIndex,
      resultVersionIndex: applied.versionIndex,
      appliedSectionIds: [...result.appliedSectionIds],
      removedSectionIds: [...result.removedSectionIds],
      resolvedConflicts: conflicts.map(item => ({ sectionId: item.id, resolution: item.resolution })),
      // Document state is merged; branch discussion is not. See planMerge docs.
      contextMerge: 'not-applied',
      delta: this._computeDelta(applied.before, applied.after),
    }, { branchId: targetId, parentActionSeq: started ? started.actionSeq : undefined });

    this._recordAction(this._types().BRANCH_MERGED, {
      branchId: sourceId,
      name: source.name,
      intoBranchId: targetId,
      mergeActionSeq: completed ? completed.actionSeq : null,
    }, { branchId: sourceId, parentActionSeq: sourceHead ? sourceHead.actionSeq : null });

    source.status = this._branchStatuses().MERGED;
    source.mergedIntoBranchId = targetId;
    source.mergedAtMs = Date.now();

    // The branch leaves the map, but its bookkeeping stays honest: everything it
    // held reached the target, so from here it diverges from that state by
    // nothing at all.
    const sourceDocument = this.getBranchDocument(sourceId);
    if (sourceDocument) {
      this.branchBases[sourceId] = { sections: sourceDocument.sections.map(s => ({ ...s })), order: [...sourceDocument.order] };
    }

    // The document now says something the surviving conversation never asked
    // for. One line of context, carried to the next instruction, is what keeps
    // the model from restoring what it remembers promising.
    if (result.appliedSectionIds.length) {
      const titles = result.appliedSectionIds
        .map(id => {
          const item = plan.items.find(entry => entry.id === id);
          return item && item.title ? `“${item.title}”` : `[#${id}]`;
        })
        .slice(0, 6);
      this._addBranchNote(targetId,
        `${titles.join(', ')}${result.appliedSectionIds.length > titles.length ? ' and others' : ''} came from the branch “${source.name}” and replaced what was here.`);
    }

    return {
      ok: true,
      sourceBranchId: sourceId,
      targetBranchId: targetId,
      messageIndex: applied.messageIndex,
      versionIndex: applied.versionIndex,
      appliedSectionIds: [...result.appliedSectionIds],
      removedSectionIds: [...result.removedSectionIds],
      conflictCount: conflicts.length,
      mergeActionSeq: completed ? completed.actionSeq : null,
    };
  },

  /**
   * Writes a merged document onto the active branch's live message as a new
   * version — the same mechanism an edit uses, so the version bar, diff,
   * changelog and restore keep working on a merge result.
   */
  _applyMergedDocument(result, logs = []) {
    const msg = this.uiMessages[this.lastAIIndex];
    if (!msg || msg.type !== 'assistant') return null;

    if (!msg.versions || !msg.versions.length) {
      msg.versions = [this._snapshot(msg.changelogs || [])];
      msg.currentVersionIndex = 0;
    }
    if (msg.currentVersionIndex !== msg.versions.length - 1) {
      this.restoreVersion(this.lastAIIndex, msg.versions.length - 1, { log: false });
    }

    const before = this._snapshot(msg.changelogs || []);
    msg.versions.push(before);
    msg.currentVersionIndex = msg.versions.length - 1;

    this.documentSections = new Map(result.sections.map(section => [section.id, { ...section }]));
    this.sectionOrder = [...result.order];
    msg.changelogs.push(...logs);
    this._syncAssistantHistory();

    const after = this._snapshot(msg.changelogs);
    msg.versions[msg.currentVersionIndex] = after;
    msg.displaySections = this.getDocumentSectionsArray().map(section => ({ ...section }));

    return { before, after, versionIndex: msg.currentVersionIndex, messageIndex: msg.msgIndex };
  },

  /**
   * Where a section came from, read straight out of the action log.
   * Returns actions that created, changed or removed the section.
   */
  getSectionHistory(sectionId) {
    const id = typeof sectionId === 'string' ? sectionId.trim() : '';
    if (!id) return [];

    return this.getActions().filter(action => {
      const payload = action.payload || {};
      if (Array.isArray(payload.sectionIds) && payload.sectionIds.includes(id)) return true;
      const touched = payload.delta && payload.delta.touchedSectionIds;
      return Array.isArray(touched) && touched.includes(id);
    });
  },

  // ── Private helpers ──────────────────────────────────────────

  _snapshot(changelogs = []) {
    return {
      sections: this.getDocumentSectionsArray().map(s => ({ ...s })),
      order: [...this.sectionOrder],
      changelogs: [...changelogs],
    };
  },

  // ── Action log internals ─────────────────────────────────────

  _optionalActionLog() {
    return typeof HectraActionLog !== 'undefined' && HectraActionLog ? HectraActionLog : null;
  },

  _optionalMergeEngine() {
    return typeof HectraMergeEngine !== 'undefined' && HectraMergeEngine ? HectraMergeEngine : null;
  },

  _optionalEditEngine() {
    return typeof HectraEditEngine !== 'undefined' && HectraEditEngine ? HectraEditEngine : null;
  },

  _requireEditEngine() {
    const engine = this._optionalEditEngine();
    if (!engine) throw new Error('[Hectra] HectraEditEngine is unavailable; js/editEngine.js must load before js/state.js');
    return engine;
  },

  _branchStatuses() {
    const log = this._optionalActionLog();
    return log ? log.BRANCH_STATUSES : { OPEN: 'open', MERGED: 'merged', ARCHIVED: 'archived', DELETED: 'deleted' };
  },

  _requireActionLog() {
    const log = this._optionalActionLog();
    if (!log) {
      throw new Error('[Hectra] HectraActionLog is unavailable; js/actionLog.js must load before js/state.js');
    }
    return log;
  },

  _types() {
    const log = this._optionalActionLog();
    return log ? log.ACTION_TYPES : {};
  },

  /**
   * Safe append used by every state mutation. A broken action log must never
   * damage the document, so failures are isolated and reported instead of
   * thrown.
   */
  _recordAction(type, payload, options = {}) {
    try {
      return this.appendAction(type, payload, options);
    } catch (error) {
      this._pushActionLogIssue({ code: 'append_failed', actionSeq: null, message: `${type}: ${error.message}` });
      console.warn('[Hectra] action log append failed; document state is unaffected:', error.message);
      return null;
    }
  },

  _recordAIMessage(msg, origin) {
    if (!msg) return null;
    const aiAction = this._recordAction(this._types().AI_MESSAGE, {
      messageIndex: msg.msgIndex,
      documentVersionIndex: msg.currentVersionIndex ?? 0,
      sectionCount: this.sectionOrder.length,
      origin,
    });

    // A response that carries sections replaces the whole document.
    if (this.sectionOrder.length) {
      this._recordAction(this._types().DOCUMENT_CREATED, {
        messageIndex: msg.msgIndex,
        versionIndex: msg.currentVersionIndex ?? 0,
        sectionIds: [...this.sectionOrder],
        sectionCount: this.sectionOrder.length,
      }, aiAction ? { parentActionSeq: aiAction.actionSeq } : {});
    }
    return aiAction;
  },

  _computeDelta(before, after) {
    const log = this._optionalActionLog();
    return log ? log.computeDocumentDelta(before, after) : null;
  },

  _resolveBranchId(branchId) {
    if (typeof branchId === 'string' && branchId.trim()) return branchId.trim();
    if (typeof this.branchId === 'string' && this.branchId.trim()) return this.branchId.trim();
    const log = this._optionalActionLog();
    return log ? log.DEFAULT_BRANCH_ID : 'main';
  },

  /**
   * parentActionSeq is stored explicitly, never derived as actionSeq - 1:
   * actionSeq is chronology, parentActionSeq is causality. The two diverge as
   * soon as branches exist.
   */
  _resolveParentActionSeq(options, branchId) {
    if (options.parentActionSeq !== undefined) return options.parentActionSeq;
    const latest = this.getLatestActionOnBranch(branchId);
    return latest ? latest.actionSeq : null;
  },

  _ensureBranch(branchId, options = {}) {
    const log = this._optionalActionLog();
    const id = this._resolveBranchId(branchId);
    if (!Array.isArray(this.branches)) this.branches = [];

    const existing = this.branches.find(branch => branch.id === id);
    if (existing) return existing;

    const branch = log ? log.createBranch(id, options) : { id, name: id, priority: 0, status: 'open' };
    this.branches.push(branch);
    return branch;
  },

  // ── Branch tracks ────────────────────────────────────────────

  _resetBranchState() {
    const log = this._optionalActionLog();
    this.branchId = log ? log.DEFAULT_BRANCH_ID : 'main';
    this.branches = [];
    this.branchTracks = {};
    this.branchBases = {};
    this.branchNotes = {};
    this._ensureBranch(this.branchId, { name: this.branchId, createdAtMs: Date.now() });
  },

  /**
   * Where a new branch starts: the current head, or the state at a chosen
   * message. Returns null for an impossible fork so createBranch can refuse
   * instead of inventing a state.
   */
  _resolveFork(options = {}) {
    const head = this.getLatestActionOnBranch(this._resolveBranchId());
    const headSeq = head ? head.actionSeq : null;

    if (!Number.isInteger(options.fromMessageIndex)) {
      return {
        messageIndex: null,
        actionSeq: headSeq,
        track: this._cloneTrack(this._captureTrack()),
        snapshot: this._snapshot(),
      };
    }

    const index = options.fromMessageIndex;
    if (index < 0 || index >= this.uiMessages.length) return null;

    const built = this._trackAtMessage(index);
    if (!built) return null;

    // Causality: the branch grows out of the action that produced that message.
    const messageAction = this._findMessageAction(index);
    return {
      messageIndex: index,
      actionSeq: messageAction ? messageAction.actionSeq : headSeq,
      track: built.track,
      snapshot: built.snapshot,
    };
  },

  /**
   * Conversation and document as they stood at a given message. The document
   * comes from that message's own version snapshot — history is read, never
   * recomputed.
   */
  _trackAtMessage(index) {
    const messages = this.uiMessages.slice(0, index + 1).map(msg => ({ ...msg }));
    if (!messages.length) return null;

    let assistant = null;
    for (let i = messages.length - 1; i >= 0; i--) {
      if (messages[i].type === 'assistant') { assistant = messages[i]; break; }
    }

    let snapshot = { sections: [], order: [], changelogs: [] };
    if (assistant) {
      const versions = Array.isArray(assistant.versions) ? assistant.versions : [];
      const version = versions[assistant.currentVersionIndex ?? 0]
        || (Array.isArray(assistant.displaySections)
          ? { sections: assistant.displaySections, order: assistant.displaySections.map(s => s.id), changelogs: assistant.changelogs || [] }
          : null);

      if (version) {
        const sections = (version.sections || []).map(section => ({ ...section }));
        snapshot = {
          sections,
          order: [...(version.order || sections.map(section => section.id))],
          changelogs: [...(version.changelogs || [])],
        };
      }

      // The fork starts with that state as its only version: the branch inherits
      // the document, not the parent's later version stack.
      assistant.versions = [{
        sections: snapshot.sections.map(section => ({ ...section })),
        order: [...snapshot.order],
        changelogs: [...snapshot.changelogs],
      }];
      assistant.currentVersionIndex = 0;
      assistant.changelogs = [...snapshot.changelogs];
      assistant.displaySections = snapshot.sections.map(section => ({ ...section }));
    }

    const track = this._cloneTrack({
      chatHistory: this.chatHistory.slice(0, index + 2),
      uiMessages: messages,
      documentSections: snapshot.sections.map(section => [section.id, section]),
      sectionOrder: [...snapshot.order],
      lastAIIndex: assistant ? assistant.msgIndex : -1,
    });

    return { track, snapshot };
  },

  /** The action that produced a message on the active branch, if it is still stored. */
  _findMessageAction(messageIndex) {
    const types = this._types();
    const wanted = new Set([types.USER_MESSAGE, types.AI_MESSAGE]);
    const onBranch = this.getActionsByBranch(this._resolveBranchId());

    for (let i = onBranch.length - 1; i >= 0; i--) {
      const action = onBranch[i];
      if (wanted.has(action.type) && action.payload && action.payload.messageIndex === messageIndex) return action;
    }
    return null;
  },

  _nextBranchId() {
    let candidate = 'br_' + Date.now();
    let suffix = 2;
    while (this.branches.some(branch => branch.id === candidate)) candidate = `br_${Date.now()}_${suffix++}`;
    return candidate;
  },

  _suggestBranchName(options = {}) {
    const ids = Array.isArray(options.fromSectionIds) && options.fromSectionIds.length
      ? options.fromSectionIds
      : (typeof options.fromSectionId === 'string' ? [options.fromSectionId] : []);

    const titles = ids
      .map(id => this.documentSections.get(id))
      .filter(Boolean)
      .map(section => section.title)
      .filter(Boolean);

    if (titles.length === 1) return titles[0];
    if (titles.length > 1) return `${titles[0]} +${titles.length - 1}`;
    return `Branch ${this.branches.length}`;
  },

  _uniqueBranchName(name, ownBranchId = null) {
    const base = String(name || 'Branch').trim().slice(0, 60) || 'Branch';
    const taken = id => this.branches.some(branch => branch.id !== ownBranchId && branch.name === id);
    if (!taken(base)) return base;

    let suffix = 2;
    while (taken(`${base} ${suffix}`)) suffix++;
    return `${base} ${suffix}`;
  },

  /** The live state as a storable track. Timestamps stay Date objects here. */
  _captureTrack() {
    return {
      chatHistory:      this.chatHistory,
      uiMessages:       this.uiMessages,
      documentSections: [...this.documentSections.entries()],
      sectionOrder:     [...this.sectionOrder],
      lastAIIndex:      this.lastAIIndex,
    };
  },

  _applyTrack(track) {
    if (!track) return false;
    this.chatHistory = Array.isArray(track.chatHistory) && track.chatHistory.length
      ? track.chatHistory
      : [{ role: 'system', content: HectraConfig.CHAT_SYSTEM_PROMPT }];
    this.uiMessages = (track.uiMessages || []).map(msg => ({
      ...msg,
      timestamp: msg.timestamp instanceof Date ? msg.timestamp : new Date(msg.timestamp || Date.now()),
    }));
    this.documentSections = new Map(track.documentSections || []);
    this.sectionOrder = [...(track.sectionOrder || [])];
    this._reindexMessages();
    return true;
  },

  /** Deep copy for forking. Dates become numbers; _applyTrack restores them. */
  _cloneTrack(track) {
    return JSON.parse(JSON.stringify({
      chatHistory:      track.chatHistory,
      uiMessages:       (track.uiMessages || []).map(msg => ({
        ...msg,
        timestamp: msg.timestamp instanceof Date ? msg.timestamp.getTime() : msg.timestamp,
      })),
      documentSections: track.documentSections,
      sectionOrder:     track.sectionOrder,
      lastAIIndex:      track.lastAIIndex,
    }));
  },

  _serializeBranchTracks() {
    const serialized = {};
    for (const [id, track] of Object.entries(this.branchTracks || {})) {
      serialized[id] = this._cloneTrack(track);
    }
    return serialized;
  },

  _pushActionLogIssue(issue) {
    if (!Array.isArray(this.actionLogIssues)) this.actionLogIssues = [];
    this.actionLogIssues.push(issue);
    if (this.actionLogIssues.length > this._MAX_ACTION_LOG_ISSUES) {
      this.actionLogIssues = this.actionLogIssues.slice(-this._MAX_ACTION_LOG_ISSUES);
    }
  },

  _reindexMessages() {
    this.uiMessages.forEach((msg, index) => {
      msg.msgIndex = index;
    });
    const lastAI = [...this.uiMessages].reverse().find(m => m.type === 'assistant');
    this.lastAIIndex = lastAI ? lastAI.msgIndex : -1;
  },

  _rebuildActiveDocumentFromLastAssistant() {
    const lastAI = [...this.uiMessages].reverse().find(m => m.type === 'assistant');
    if (!lastAI) {
      this.documentSections = new Map();
      this.sectionOrder = [];
      this.lastAIIndex = -1;
      return;
    }

    const currentVersion = lastAI.versions?.[lastAI.currentVersionIndex ?? 0];
    const sections = currentVersion?.sections || lastAI.displaySections || [];
    const order = currentVersion?.order || sections.map(s => s.id);
    this.documentSections = new Map(sections.map(s => [s.id, { ...s }]));
    this.sectionOrder = [...order];
    this.lastAIIndex = lastAI.msgIndex;
  },

  _syncAssistantHistory() {
    const lastAssIdx = [...this.chatHistory].map(m => m.role).lastIndexOf('assistant');
    if (lastAssIdx !== -1) {
      this.chatHistory[lastAssIdx].content = this._buildMdSnapshot();
    }
  },

  _insertInOrder(id, position) {
    if (!position || position.type === 'end') {
      this.sectionOrder.push(id);
      return;
    }
    if (position.type === 'start') {
      this.sectionOrder.unshift(id);
      return;
    }
    const refIdx = this.sectionOrder.indexOf(position.ref);
    if (refIdx === -1) {
      this.sectionOrder.push(id);
      return;
    }
    if (position.type === 'after') {
      this.sectionOrder.splice(refIdx + 1, 0, id);
    } else if (position.type === 'before') {
      this.sectionOrder.splice(refIdx, 0, id);
    }
  },

  /**
   * Reconstruct full Markdown document snapshot for chatHistory.
   * Changelogs stay in UI state only; sending them back to the model can leak
   * service text into the visible answer.
   */
  _buildMdSnapshot() {
    return this.getDocumentSectionsArray()
      .map(s => `## ${s.title} [#${s.id}]\n${s.content}`)
      .join('\n\n');
  },

  _normalizeChatHistoryForModel(history) {
    if (!Array.isArray(history)) {
      return [{ role: 'system', content: HectraConfig.CHAT_SYSTEM_PROMPT }];
    }

    return history.map(msg => {
      if (!msg || msg.role !== 'assistant' || typeof msg.content !== 'string') return msg;
      return { ...msg, content: this._stripChangelogBlock(msg.content) };
    });
  },

  _stripChangelogBlock(content) {
    if (typeof content !== 'string') return content;
    return content
      .replace(/\n?---[ \t]*\nИСТОРИЯ ИЗМЕНЕНИЙ:[\s\S]*$/i, '')
      .replace(/\n?ИСТОРИЯ ИЗМЕНЕНИЙ:[\s\S]*$/i, '')
      .trim();
  },

  // ── Workspace persistence ────────────────────────────────────
  //
  // The workspace record is the authority for the action log: it outlives every
  // session, so the sequence survives "New chat", session switching and reload.
  // Session records only reference their workspace.

  _storage() {
    try {
      const storage = typeof HectraSecurity !== 'undefined' && HectraSecurity ? HectraSecurity.storage() : null;
      if (storage && typeof storage.getItem === 'function' && typeof storage.setItem === 'function') return storage;
    } catch { /* storage unavailable (private mode, sandboxed context) */ }
    return this._memoryStorage();
  },

  _memoryStorage() {
    if (!this.__memoryStorage) {
      const map = new Map();
      this.__memoryStorage = {
        getItem:    key => (map.has(key) ? map.get(key) : null),
        setItem:    (key, value) => { map.set(key, String(value)); },
        removeItem: key => { map.delete(key); },
      };
    }
    return this.__memoryStorage;
  },

  _isValidWorkspaceId(id) {
    return typeof id === 'string' && this._WORKSPACE_ID_RE.test(id);
  },

  _initWorkspace() {
    const workspaceId = this._resolveActiveWorkspaceId();

    // Same workspace (e.g. "New chat"): the in-memory log is already the
    // authority, keep it and keep counting.
    if (this.workspaceId === workspaceId) {
      this._ensureBranch(this.branchId);
      return workspaceId;
    }

    this.workspaceId = workspaceId;
    this._loadWorkspaceLog(workspaceId);
    this._ensureBranch(this.branchId);
    return workspaceId;
  },

  _resolveActiveWorkspaceId() {
    const storage = this._storage();
    try {
      const stored = storage.getItem(this._ACTIVE_WORKSPACE_KEY);
      if (this._isValidWorkspaceId(stored)) return stored;
    } catch { /* fall through to a fresh workspace */ }

    const created = 'ws_' + Date.now();
    this._writeActiveWorkspaceId(created);
    return created;
  },

  _writeActiveWorkspaceId(workspaceId) {
    try { this._storage().setItem(this._ACTIVE_WORKSPACE_KEY, workspaceId); }
    catch (e) { console.warn('[Hectra] active workspace id could not be stored:', e); }
  },

  /**
   * Loads and validates the persisted log. A corrupted log is isolated, not
   * repaired and not deleted: the document keeps opening either way.
   */
  _loadWorkspaceLog(workspaceId) {
    const log = this._optionalActionLog();

    // Reset before reading: the read itself reports unreadable storage.
    this.actionLogIssues = [];
    const record = this._readWorkspaceRecord(workspaceId);
    this._truncatedBeforeSeq = Number.isInteger(record?.truncatedBeforeSeq) ? record.truncatedBeforeSeq : null;

    if (!log) {
      this.actions = [];
      this.lastActionSeq = Number.isInteger(record?.lastActionSeq) ? record.lastActionSeq : 0;
      this.branches = [];
      return;
    }

    const normalized = log.normalizeLog(record && record.actions, {
      workspaceId,
      storedLastActionSeq: record ? record.lastActionSeq : null,
    });

    this.actions       = [...normalized.actions];
    this.lastActionSeq = normalized.lastActionSeq;

    // Branch topology is owned by the session (see _restoreBranchesFromSession).
    // The workspace record only registers which branch ids the log references.

    for (const issue of normalized.issues) this._pushActionLogIssue(issue);
    if (normalized.issues.length) {
      console.warn(
        `[Hectra] action log for ${workspaceId} loaded with ${normalized.issues.length} issue(s); ` +
        `${normalized.rejected.length} record(s) isolated. Document state is unaffected.`,
        normalized.issues
      );
    }
  },

  _readWorkspaceRecord(workspaceId) {
    if (!this._isValidWorkspaceId(workspaceId)) return null;
    try {
      const raw = this._storage().getItem(this._WORKSPACE_KEY_PREFIX + workspaceId);
      if (!raw) return null;
      const parsed = JSON.parse(raw);
      return parsed && typeof parsed === 'object' ? parsed : null;
    } catch (error) {
      this._pushActionLogIssue({ code: 'workspace_unreadable', actionSeq: null, message: String(error?.message || error) });
      console.warn('[Hectra] workspace history could not be read; continuing with an empty log:', error);
      return null;
    }
  },

  _buildWorkspaceRecord(actions, truncatedBeforeSeq) {
    const log = this._optionalActionLog();
    return {
      schemaVersion:  log ? log.ACTION_SCHEMA_VERSION : 1,
      workspaceId:    this.workspaceId,
      updatedAt:      Date.now(),
      lastActionSeq:  this.lastActionSeq,
      activeBranchId: this._resolveBranchId(),
      // Registry of branch ids the log references — the branch records
      // themselves belong to the session.
      branchIds:      this.branches.map(branch => branch.id),
      truncatedBeforeSeq: truncatedBeforeSeq ?? null,
      actions,
    };
  },

  saveWorkspace() {
    if (!this.workspaceId) return false;

    let actions = this.getActions();
    let truncatedBeforeSeq = this._truncatedBeforeSeq ?? null;
    let serialized = JSON.stringify(this._buildWorkspaceRecord(actions, truncatedBeforeSeq));

    // Storage is finite. Oldest actions may drop out of *storage*, but
    // lastActionSeq is always preserved, so a sequence number is never reused.
    while (serialized.length > this._MAX_WORKSPACE_BYTES && actions.length > 1) {
      actions = actions.slice(Math.max(1, Math.floor(actions.length / 4)));
      truncatedBeforeSeq = actions[0].actionSeq;
      serialized = JSON.stringify(this._buildWorkspaceRecord(actions, truncatedBeforeSeq));
    }

    if (truncatedBeforeSeq !== (this._truncatedBeforeSeq ?? null)) {
      this._truncatedBeforeSeq = truncatedBeforeSeq;
      console.warn(
        `[Hectra] stored workspace history trimmed before actionSeq ${truncatedBeforeSeq}; ` +
        `lastActionSeq stays ${this.lastActionSeq}`
      );
    }

    try {
      this._storage().setItem(this._WORKSPACE_KEY_PREFIX + this.workspaceId, serialized);
      return true;
    } catch (e) {
      console.warn('[Hectra] workspace history save failed:', e);
      return false;
    }
  },

  getWorkspaceRecord(workspaceId = this.workspaceId) {
    return this._readWorkspaceRecord(workspaceId);
  },

  // ── Session persistence ──────────────────────────────────────

  saveSession() {
    // The action log belongs to the workspace, so it is persisted even when the
    // session itself is empty (e.g. the last prompt pair was just deleted).
    this.saveWorkspace();

    if (!this.uiMessages.length) return;
    const session = {
      id:          this.sessionId,
      workspaceId: this.workspaceId,
      // Branches belong to the session the user sees as a workspace. The active
      // branch's document/messages stay in the top-level fields below; only the
      // inactive tracks are stored separately.
      branchId:    this._resolveBranchId(),
      branches:    this.branches,
      branchTracks: this._serializeBranchTracks(),
      branchBases: this.branchBases,
      branchNotes: this.branchNotes,
      schemaVersion: this._SESSION_SCHEMA_VERSION,
      title:       this.sessionTitle || 'New chat',
      createdAt:   this.sessionCreatedAt,
      updatedAt:   Date.now(),
      chatHistory: this.chatHistory,
      documentSections: [...this.documentSections.entries()],
      sectionOrder:     [...this.sectionOrder],
      uiMessages: this.uiMessages.map(m => ({
        type:       m.type,
        text:       m.text || null,
        timestamp:  m.timestamp ? m.timestamp.getTime() : Date.now(),
        msgIndex:   m.msgIndex,
        changelogs: m.changelogs || [],
        modelChangelogs: m.modelChangelogs || [],
        rawText:    m.rawText   || null,
        attachments: (m.attachments || []).map(a => a.kind === 'image'
          ? {
              name: a.name,
              kind: a.kind,
              mimeType: a.mimeType,
              size: a.size,
              previewDataUrl: HectraSecurity.isSafeImageDataUrl(a.previewDataUrl || a.dataUrl)
                ? (a.previewDataUrl || a.dataUrl)
                : null,
            }
          : a),
        displaySections: m.displaySections || null,
        versions:   m.versions || null,
        currentVersionIndex: m.currentVersionIndex ?? 0,
      })),
    };
    try {
      const serialized = JSON.stringify(session);
      if (serialized.length > HectraSecurity.MAX_SESSION_BYTES) {
        throw new Error('session payload too large');
      }
      const storage = this._storage();
      storage.setItem(`hectra_session_${this.sessionId}`, serialized);
      const index = this.getAllSessionMeta();
      const i = index.findIndex(s => s.id === this.sessionId);
      // branchCount lets the sidebar show a workspace as expandable without
      // reading the whole session record.
      const meta = {
        id: this.sessionId,
        title: session.title,
        updatedAt: session.updatedAt,
        branchCount: this.branches.length,
      };
      if (i >= 0) index[i] = meta; else index.unshift(meta);
      storage.setItem(this._SESSIONS_KEY, JSON.stringify(index));
    } catch(e) { console.warn('[Hectra] session save failed:', e); }
  },

  getAllSessionMeta() {
    try {
      const parsed = JSON.parse(this._storage().getItem(this._SESSIONS_KEY) || '[]');
      return Array.isArray(parsed) ? parsed.filter(s => s && /^sess_\d+$/.test(String(s.id))) : [];
    }
    catch { return []; }
  },

  getSession(id) {
    if (!/^sess_\d+$/.test(String(id))) return null;
    try { return JSON.parse(this._storage().getItem(`hectra_session_${id}`)); }
    catch { return null; }
  },

  deleteSession(id) {
    if (!/^sess_\d+$/.test(String(id))) return;
    const storage = this._storage();
    storage.removeItem(`hectra_session_${id}`);
    const index = this.getAllSessionMeta().filter(s => s.id !== id);
    storage.setItem(this._SESSIONS_KEY, JSON.stringify(index));
  },

  loadSession(sessionData) {
    this.pendingEditProposal = null;
    this.editUndo = null;
    this._adoptWorkspaceFromSession(sessionData);
    this.chatHistory      = this._normalizeChatHistoryForModel(sessionData.chatHistory);
    this.documentSections = new Map(sessionData.documentSections);
    this.sectionOrder     = sessionData.sectionOrder;
    this.sessionId        = sessionData.id;
    this.sessionTitle     = sessionData.title;
    this.sessionCreatedAt = sessionData.createdAt;
    this.isLoading        = false;
    this.isEditMode       = false;
    this.uiMessages = sessionData.uiMessages.map(m => ({
      ...m,
      timestamp: new Date(m.timestamp),
    }));
    const lastAI = [...this.uiMessages].reverse().find(m => m.type === 'assistant');
    this.lastAIIndex = lastAI ? lastAI.msgIndex : -1;
  },

  /**
   * Sessions saved before the action log existed carry no workspaceId: they
   * simply join the active workspace and continue its sequence. Historical
   * actions are never reconstructed for them.
   */
  _adoptWorkspaceFromSession(sessionData) {
    const workspaceId = this._isValidWorkspaceId(sessionData?.workspaceId) ? sessionData.workspaceId : null;

    if (workspaceId && workspaceId !== this.workspaceId) {
      this.workspaceId = workspaceId;
      this._writeActiveWorkspaceId(workspaceId);
      this._loadWorkspaceLog(workspaceId);
    } else if (!this.workspaceId) {
      this._initWorkspace();
    }

    this._restoreBranchesFromSession(sessionData);
  },

  /**
   * Branch state of the restored session. Sessions saved before branches
   * existed simply come back as a single "main" branch.
   */
  _restoreBranchesFromSession(sessionData) {
    const log = this._optionalActionLog();
    this.branchTracks = {};
    this.branchBases = {};
    this.branchNotes = {};
    this.branches = log
      ? log.normalizeBranches(sessionData?.branches)
      : [{ id: 'main', name: 'main', priority: 0, status: 'open' }];

    const tracks = sessionData?.branchTracks;
    if (tracks && typeof tracks === 'object') {
      for (const [id, track] of Object.entries(tracks)) {
        if (track && typeof track === 'object' && this.branches.some(branch => branch.id === id)) {
          this.branchTracks[id] = track;
        }
      }
    }

    const bases = sessionData?.branchBases;
    if (bases && typeof bases === 'object') {
      for (const [id, base] of Object.entries(bases)) {
        if (base && Array.isArray(base.sections)) this.branchBases[id] = base;
      }
    }

    const notes = sessionData?.branchNotes;
    if (notes && typeof notes === 'object') {
      for (const [id, list] of Object.entries(notes)) {
        if (Array.isArray(list) && list.length) this.branchNotes[id] = list.filter(note => typeof note === 'string');
      }
    }

    this.branchId = this._resolveBranchId(sessionData?.branchId);
    this._ensureBranch(this.branchId);
    // The active branch's own track lives in the top-level session fields.
    delete this.branchTracks[this.branchId];
  },

  get hasDocument() { return this.sectionOrder.length > 0; },
};
