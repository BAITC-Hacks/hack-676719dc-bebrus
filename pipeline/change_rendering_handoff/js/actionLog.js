// ============================================================
//  HECTRA — Action log (append-only workspace history)
// ============================================================

/**
 * Workspace-level append-only journal of everything significant that happens
 * in a workspace, across sessions and (later) across branches.
 *
 * Four concepts stay strictly separate:
 *
 *   version snapshot — how did the document look at a point in time?
 *   action           — what happened?
 *   delta            — what exactly changed?
 *   graph relation   — which action did the next one grow out of?
 *
 * actionSeq answers only "in what global order did events appear inside this
 * workspace?". It is allocated in exactly one place (HectraState.appendAction),
 * never reused, never reordered and never rewritten — not by rollback, not by
 * restore, and not by future branch priority.
 *
 * This module is pure data: no DOM, no storage, no HectraState knowledge.
 */
(function (scope) {

  const ACTION_SCHEMA_VERSION = 1;

  // Plain signed 32-bit INTEGER semantics (matches a PostgreSQL INTEGER column).
  // 0 is reserved for "root / no action".
  const ROOT_ACTION_SEQ = 0;
  const MIN_ACTION_SEQ  = 1;
  const MAX_ACTION_SEQ  = 2147483647;

  const DEFAULT_BRANCH_ID       = 'main';
  const DEFAULT_BRANCH_PRIORITY = 0;

  const ACTION_TYPES = Object.freeze({
    // ── Conversation ──
    USER_MESSAGE:                'USER_MESSAGE',
    AI_MESSAGE:                  'AI_MESSAGE',
    USER_MESSAGE_EDITED:         'USER_MESSAGE_EDITED',
    MESSAGE_PAIR_DELETED:        'MESSAGE_PAIR_DELETED',
    ASSISTANT_MESSAGE_DISCARDED: 'ASSISTANT_MESSAGE_DISCARDED',

    // ── Document ──
    DOCUMENT_CREATED:            'DOCUMENT_CREATED',
    DOCUMENT_EDIT_PROPOSED:      'DOCUMENT_EDIT_PROPOSED',
    DOCUMENT_EDIT_APPLIED:       'DOCUMENT_EDIT_APPLIED',

    // ── Versions ──
    VERSION_ACCEPTED:            'VERSION_ACCEPTED',
    VERSION_REJECTED:            'VERSION_REJECTED',
    VERSION_RESTORED:            'VERSION_RESTORED',

    // ── Branches ──
    BRANCH_CREATED:              'BRANCH_CREATED',
    BRANCH_SWITCHED:             'BRANCH_SWITCHED',
    BRANCH_RENAMED:              'BRANCH_RENAMED',
    BRANCH_DISCARDED:            'BRANCH_DISCARDED',
    BRANCH_DELETED:              'BRANCH_DELETED',

    // ── Merge ──
    // A merge is three events: it starts, it may resolve conflicts, it
    // completes. BRANCH_MERGED marks the source branch itself.
    MERGE_STARTED:               'MERGE_STARTED',
    MERGE_CONFLICT:              'MERGE_CONFLICT',
    MERGE_COMPLETED:             'MERGE_COMPLETED',
    BRANCH_MERGED:               'BRANCH_MERGED',

    // Structure, not content: a branch and its parent were one run of writing
    // with a boundary through it, and the boundary was removed.
    BRANCH_COLLAPSED:            'BRANCH_COLLAPSED',
  });

  const KNOWN_ACTION_TYPES = new Set(Object.values(ACTION_TYPES));
  const MAX_SUMMARY_IDS    = 6;

  /**
   * History is not "everything that happened".
   *
   * The log records all workspace activity — asking, answering, switching
   * branch, opening a merge. History is the narrower question "what was written,
   * removed or rewritten?", so only the actions that actually changed document
   * content belong to it.
   *
   * A proposal is deliberately absent: it is reviewable intent and may be
   * rejected without ever becoming a version or DOCUMENT_EDIT_APPLIED action.
   * Accepting a version is absent because it collapses the version stack; the
   * content it leaves behind is the content that was already live.
   */
  const CONTENT_ACTION_TYPES = Object.freeze([
    ACTION_TYPES.DOCUMENT_CREATED,             // written
    ACTION_TYPES.DOCUMENT_EDIT_APPLIED,        // rewritten
    ACTION_TYPES.VERSION_RESTORED,             // rewritten, from an earlier state
    ACTION_TYPES.VERSION_REJECTED,             // rewritten, back to the previous one
    ACTION_TYPES.MESSAGE_PAIR_DELETED,         // removed
    ACTION_TYPES.ASSISTANT_MESSAGE_DISCARDED,  // removed
    ACTION_TYPES.MERGE_COMPLETED,              // rewritten, from another branch
  ]);

  const CONTENT_ACTION_TYPE_SET = new Set(CONTENT_ACTION_TYPES);

  function isContentAction(action) {
    return isPlainObject(action) && CONTENT_ACTION_TYPE_SET.has(action.type);
  }

  // ── Primitive checks ──────────────────────────────────────────

  function isPlainObject(value) {
    return !!value && typeof value === 'object' && !Array.isArray(value);
  }

  function isNonEmptyString(value) {
    return typeof value === 'string' && value.trim().length > 0;
  }

  /**
   * Sequence numbers are validated with plain numeric conditions on purpose.
   * Bitwise normalisation (| 0, >>>, <<) would silently wrap around and is
   * never used on an actionSeq.
   */
  function isActionSeq(value) {
    return Number.isInteger(value) && value >= MIN_ACTION_SEQ && value <= MAX_ACTION_SEQ;
  }

  function isParentActionSeq(value) {
    return Number.isInteger(value) && value >= ROOT_ACTION_SEQ && value <= MAX_ACTION_SEQ;
  }

  // ── ActionRecord ──────────────────────────────────────────────

  function validateAction(action) {
    if (!isPlainObject(action)) {
      return { valid: false, errors: ['action must be a plain object'] };
    }

    const errors = [];

    if (!isActionSeq(action.actionSeq)) {
      errors.push(`actionSeq must be an integer in ${MIN_ACTION_SEQ}..${MAX_ACTION_SEQ}, got ${describe(action.actionSeq)}`);
    }
    if (!isNonEmptyString(action.workspaceId)) {
      errors.push('workspaceId must be a non-empty string');
    }
    if (!KNOWN_ACTION_TYPES.has(action.type)) {
      errors.push(`type must be a known ACTION_TYPE, got ${describe(action.type)}`);
    }
    if (typeof action.createdAtMs !== 'number' || !Number.isFinite(action.createdAtMs) || action.createdAtMs < 0) {
      errors.push(`createdAtMs must be a finite non-negative number, got ${describe(action.createdAtMs)}`);
    }
    if (action.parentActionSeq !== null && action.parentActionSeq !== undefined) {
      if (!isParentActionSeq(action.parentActionSeq)) {
        errors.push(`parentActionSeq must be null or an integer in ${ROOT_ACTION_SEQ}..${MAX_ACTION_SEQ}, got ${describe(action.parentActionSeq)}`);
      } else if (isActionSeq(action.actionSeq) && action.parentActionSeq >= action.actionSeq) {
        errors.push(`parentActionSeq (${action.parentActionSeq}) must be smaller than actionSeq (${action.actionSeq})`);
      }
    }
    if (!isNonEmptyString(action.branchId)) {
      errors.push('branchId must be a non-empty string');
    }
    if (action.sessionId !== null && action.sessionId !== undefined && !isNonEmptyString(action.sessionId)) {
      errors.push('sessionId must be null or a non-empty string');
    }
    if (!isPlainObject(action.payload)) {
      errors.push('payload must be a plain object');
    }
    if (!Number.isInteger(action.schemaVersion) || action.schemaVersion < 1) {
      errors.push(`schemaVersion must be a positive integer, got ${describe(action.schemaVersion)}`);
    }

    return { valid: errors.length === 0, errors };
  }

  function describe(value) {
    if (typeof value === 'string') return JSON.stringify(value);
    if (typeof value === 'number' || value === null || value === undefined) return String(value);
    return typeof value;
  }

  /**
   * Builds a validated, frozen ActionRecord. Throws on invalid input — the
   * caller decides whether an unloggable action is fatal.
   */
  function createAction(fields) {
    const source = isPlainObject(fields) ? fields : {};
    const record = {
      actionSeq:       source.actionSeq,
      workspaceId:     source.workspaceId,
      type:            source.type,
      createdAtMs:     source.createdAtMs,
      parentActionSeq: source.parentActionSeq === undefined ? null : source.parentActionSeq,
      branchId:        source.branchId,
      sessionId:       source.sessionId === undefined ? null : source.sessionId,
      payload:         source.payload === undefined ? {} : source.payload,
      schemaVersion:   Number.isInteger(source.schemaVersion) ? source.schemaVersion : ACTION_SCHEMA_VERSION,
    };

    const { valid, errors } = validateAction(record);
    if (!valid) throw new Error(`[Hectra] invalid action record: ${errors.join('; ')}`);
    return freezeAction(record);
  }

  function freezeAction(record) {
    Object.freeze(record.payload);
    return Object.freeze(record);
  }

  function projectAction(action) {
    return {
      actionSeq:       action.actionSeq,
      workspaceId:     action.workspaceId,
      type:            action.type,
      createdAtMs:     action.createdAtMs,
      parentActionSeq: action.parentActionSeq === undefined ? null : action.parentActionSeq,
      branchId:        action.branchId,
      sessionId:       action.sessionId === undefined ? null : action.sessionId,
      payload:         action.payload,
      schemaVersion:   action.schemaVersion,
    };
  }

  /**
   * Canonical order is actionSeq ASC. createdAtMs is metadata only: two actions
   * may share a millisecond, the sequence still orders them unambiguously.
   */
  function sortActions(actions) {
    return (Array.isArray(actions) ? [...actions] : []).sort((a, b) => a.actionSeq - b.actionSeq);
  }

  // ── Log loading / integrity ───────────────────────────────────

  /**
   * Validates a persisted action log.
   *
   * Corrupted records are isolated, never silently repaired: they are moved to
   * `rejected` with an entry in `issues`, while the rest of the log — and the
   * document state that lives outside this module — stays usable.
   *
   * Returns { actions, lastActionSeq, issues, rejected }.
   */
  function normalizeLog(rawActions, options = {}) {
    const settings           = isPlainObject(options) ? options : {};
    const expectedWorkspace  = isNonEmptyString(settings.workspaceId) ? settings.workspaceId.trim() : null;
    const issues   = [];
    const rejected = [];
    const accepted = [];
    const seenSeq  = new Set();
    let highestSeq = ROOT_ACTION_SEQ;

    if (rawActions !== undefined && rawActions !== null && !Array.isArray(rawActions)) {
      issues.push({ code: 'log_not_an_array', actionSeq: null, message: 'stored action log is not an array; starting from an empty log' });
    }

    for (const entry of Array.isArray(rawActions) ? rawActions : []) {
      // Every plausible sequence number is tracked, even on a rejected record:
      // a corrupted entry must never let a sequence number be handed out twice.
      if (isPlainObject(entry) && isActionSeq(entry.actionSeq) && entry.actionSeq > highestSeq) {
        highestSeq = entry.actionSeq;
      }

      const { valid, errors } = validateAction(entry);
      if (!valid) {
        rejected.push(entry);
        issues.push({
          code: 'invalid_action',
          actionSeq: isPlainObject(entry) && Number.isInteger(entry.actionSeq) ? entry.actionSeq : null,
          message: errors.join('; '),
        });
        continue;
      }

      if (expectedWorkspace && entry.workspaceId !== expectedWorkspace) {
        rejected.push(entry);
        issues.push({
          code: 'workspace_mismatch',
          actionSeq: entry.actionSeq,
          message: `action belongs to workspace ${describe(entry.workspaceId)}, expected ${describe(expectedWorkspace)}`,
        });
        continue;
      }

      if (seenSeq.has(entry.actionSeq)) {
        rejected.push(entry);
        issues.push({
          code: 'duplicate_action_seq',
          actionSeq: entry.actionSeq,
          message: `duplicate actionSeq ${entry.actionSeq}; the first record wins`,
        });
        continue;
      }

      seenSeq.add(entry.actionSeq);
      accepted.push(freezeAction(projectAction(entry)));
    }

    let outOfOrder = false;
    for (let i = 1; i < accepted.length; i++) {
      if (accepted[i].actionSeq < accepted[i - 1].actionSeq) { outOfOrder = true; break; }
    }
    if (outOfOrder) {
      issues.push({ code: 'log_out_of_order', actionSeq: null, message: 'stored action log was not in actionSeq order; canonical order restored' });
    }
    const actions = outOfOrder ? sortActions(accepted) : accepted;

    const storedLast = settings.storedLastActionSeq;
    if (storedLast !== undefined && storedLast !== null) {
      if (Number.isInteger(storedLast) && storedLast >= ROOT_ACTION_SEQ && storedLast <= MAX_ACTION_SEQ) {
        if (storedLast > highestSeq) highestSeq = storedLast;
      } else {
        issues.push({ code: 'invalid_last_action_seq', actionSeq: null, message: `stored lastActionSeq is not a valid INTEGER: ${describe(storedLast)}` });
      }
    }
    if (actions.length && actions[actions.length - 1].actionSeq > highestSeq) {
      highestSeq = actions[actions.length - 1].actionSeq;
    }

    return { actions, lastActionSeq: highestSeq, issues, rejected };
  }

  // ── Branches (metadata only) ──────────────────────────────────

  const BRANCH_STATUSES = Object.freeze({
    OPEN:     'open',
    MERGED:   'merged',
    ARCHIVED: 'archived',
    // Soft delete: the branch leaves the normal UI, its actions stay in the log
    // so provenance and older states remain readable.
    DELETED:  'deleted',
  });

  const KNOWN_BRANCH_STATUSES = new Set(Object.values(BRANCH_STATUSES));

  /**
   * A branch record: identity, topology and presentation policy.
   *
   * Document state does NOT live here — HectraState keeps the per-branch tracks.
   * forkActionSeq points at the action in the parent branch this branch grew
   * out of; forkMessageIndex at the message the fork was taken from, so a
   * "branch from here" keeps its provenance. priority is presentation /
   * merge-policy metadata and never reorders the log: actionSeq is the
   * immutable chronology.
   *
   * `options` may also be a bare number for the legacy createBranch(id, priority)
   * form.
   */
  function createBranch(id, options = {}) {
    if (!isNonEmptyString(id)) throw new Error('[Hectra] branch id must be a non-empty string');
    const settings = isPlainObject(options) ? options : { priority: options };
    const trimmed = id.trim();

    return {
      id: trimmed,
      name: isNonEmptyString(settings.name) ? settings.name.trim() : trimmed,
      parentBranchId: isNonEmptyString(settings.parentBranchId) ? settings.parentBranchId.trim() : null,
      forkActionSeq: isParentActionSeq(settings.forkActionSeq) ? settings.forkActionSeq : null,
      forkSectionId: isNonEmptyString(settings.forkSectionId) ? settings.forkSectionId.trim() : null,
      forkSectionIds: Array.isArray(settings.forkSectionIds)
        ? settings.forkSectionIds.filter(isNonEmptyString).map(value => value.trim())
        : [],
      forkMessageIndex: Number.isInteger(settings.forkMessageIndex) ? settings.forkMessageIndex : null,
      createdAtMs: Number.isFinite(settings.createdAtMs) ? settings.createdAtMs : null,
      status: KNOWN_BRANCH_STATUSES.has(settings.status) ? settings.status : BRANCH_STATUSES.OPEN,
      priority: Number.isFinite(settings.priority) ? settings.priority : DEFAULT_BRANCH_PRIORITY,
      // Merge / delete bookkeeping. Null until the corresponding event happens.
      mergedIntoBranchId: isNonEmptyString(settings.mergedIntoBranchId) ? settings.mergedIntoBranchId.trim() : null,
      mergedAtMs: Number.isFinite(settings.mergedAtMs) ? settings.mergedAtMs : null,
      deletedAtMs: Number.isFinite(settings.deletedAtMs) ? settings.deletedAtMs : null,
    };
  }

  function normalizeBranches(rawBranches) {
    const branches = [];
    const seen = new Set();

    for (const entry of Array.isArray(rawBranches) ? rawBranches : []) {
      const id = isPlainObject(entry) ? entry.id : entry;
      if (!isNonEmptyString(id)) continue;
      const trimmed = id.trim();
      if (seen.has(trimmed)) continue;
      seen.add(trimmed);
      branches.push(createBranch(trimmed, isPlainObject(entry) ? entry : {}));
    }

    if (!seen.has(DEFAULT_BRANCH_ID)) {
      branches.unshift(createBranch(DEFAULT_BRANCH_ID, {}));
    }

    // A parent that no longer exists would break the tree; treat it as a root.
    const known = new Set(branches.map(branch => branch.id));
    for (const branch of branches) {
      if (branch.parentBranchId && (!known.has(branch.parentBranchId) || branch.parentBranchId === branch.id)) {
        branch.parentBranchId = null;
      }
    }
    return branches;
  }

  // ── Structured document delta ─────────────────────────────────

  function toSectionList(snapshot) {
    if (Array.isArray(snapshot)) return snapshot.filter(isPlainObject);
    if (isPlainObject(snapshot) && Array.isArray(snapshot.sections)) return snapshot.sections.filter(isPlainObject);
    return [];
  }

  function toOrder(snapshot, sections) {
    if (isPlainObject(snapshot) && Array.isArray(snapshot.order)) {
      const known = new Set(sections.map(section => section.id));
      return snapshot.order.filter(id => known.has(id));
    }
    return sections.map(section => section.id);
  }

  function sectionBody(section) {
    return {
      title:   String(section.title ?? ''),
      content: String(section.content ?? ''),
    };
  }

  /**
   * Deterministic structural diff between two document snapshots
   * ({ sections, order } — e.g. HectraState._snapshot() results).
   *
   * Deliberately shaped for two future consumers:
   *   apply / reverse  — before+after bodies and both orders are present;
   *   merge analysis   — touchedSectionIds tells which sections a branch owns.
   */
  function computeDocumentDelta(before, after) {
    const beforeSections = toSectionList(before);
    const afterSections  = toSectionList(after);
    const beforeMap = new Map(beforeSections.map(section => [section.id, section]));
    const afterMap  = new Map(afterSections.map(section => [section.id, section]));
    const orderBefore = toOrder(before, beforeSections);
    const orderAfter  = toOrder(after, afterSections);

    const changedSections  = [];
    const insertedSections = [];
    const deletedSections  = [];
    const movedSections    = [];

    orderAfter.forEach((id, index) => {
      const next = afterMap.get(id);
      if (!next) return;

      const previous = beforeMap.get(id);
      if (!previous) {
        insertedSections.push({ id, index, after: sectionBody(next) });
        return;
      }

      const from = sectionBody(previous);
      const to   = sectionBody(next);
      if (from.title !== to.title || from.content !== to.content) {
        changedSections.push({ id, before: from, after: to });
      }
    });

    orderBefore.forEach((id, index) => {
      if (afterMap.has(id)) return;
      const previous = beforeMap.get(id);
      if (!previous) return;
      deletedSections.push({ id, index, before: sectionBody(previous) });
    });

    // Moves are measured over the sections that survive the change, so a pure
    // reorder is visible even when no body changed and nothing was inserted.
    const survivingBefore = orderBefore.filter(id => afterMap.has(id));
    const survivingAfter  = orderAfter.filter(id => beforeMap.has(id));
    survivingAfter.forEach((id, toIndex) => {
      const fromIndex = survivingBefore.indexOf(id);
      if (fromIndex !== -1 && fromIndex !== toIndex) movedSections.push({ id, fromIndex, toIndex });
    });

    const touched = new Set();
    for (const item of changedSections)  touched.add(item.id);
    for (const item of insertedSections) touched.add(item.id);
    for (const item of deletedSections)  touched.add(item.id);
    for (const item of movedSections)    touched.add(item.id);

    return {
      changedSections,
      insertedSections,
      deletedSections,
      movedSections,
      orderBefore: [...orderBefore],
      orderAfter:  [...orderAfter],
      touchedSectionIds: [...touched].sort(),
      hasChanges: touched.size > 0,
    };
  }

  // ── Debug formatting ──────────────────────────────────────────

  function formatTimeOfDay(createdAtMs) {
    if (!Number.isFinite(createdAtMs)) return '--:--:--.---';
    const date = new Date(createdAtMs);
    const pad = (value, length = 2) => String(value).padStart(length, '0');
    return `${pad(date.getHours())}:${pad(date.getMinutes())}:${pad(date.getSeconds())}.${pad(date.getMilliseconds(), 3)}`;
  }

  function formatIdList(ids) {
    const list = Array.isArray(ids) ? ids.filter(Boolean) : [];
    if (!list.length) return '';
    if (list.length <= MAX_SUMMARY_IDS) return list.join(', ');
    return `${list.slice(0, MAX_SUMMARY_IDS).join(', ')} +${list.length - MAX_SUMMARY_IDS} more`;
  }

  function summarizeAction(action) {
    const payload = isPlainObject(action.payload) ? action.payload : {};

    switch (action.type) {
      case ACTION_TYPES.USER_MESSAGE:
      case ACTION_TYPES.USER_MESSAGE_EDITED:
        return `msg#${payload.messageIndex}`;
      case ACTION_TYPES.AI_MESSAGE:
        return `msg#${payload.messageIndex} · ${payload.sectionCount ?? 0} sections`;
      case ACTION_TYPES.MESSAGE_PAIR_DELETED:
      case ACTION_TYPES.ASSISTANT_MESSAGE_DISCARDED:
        return `msg#${payload.messageIndex ?? payload.userMessageIndex}`;
      case ACTION_TYPES.DOCUMENT_CREATED:
        return formatIdList(payload.sectionIds);
      case ACTION_TYPES.DOCUMENT_EDIT_PROPOSED:
        return formatIdList([...(payload.proposedSectionIds || []), ...(payload.proposedDeletedSectionIds || [])]);
      case ACTION_TYPES.DOCUMENT_EDIT_APPLIED:
        return formatIdList(payload.delta && payload.delta.touchedSectionIds) || 'no structural change';
      case ACTION_TYPES.VERSION_RESTORED:
        return `v${payload.fromVersionIndex} → v${payload.toVersionIndex}`;
      case ACTION_TYPES.VERSION_ACCEPTED:
        return `v${payload.acceptedVersionIndex}`;
      case ACTION_TYPES.VERSION_REJECTED:
        return `v${payload.rejectedVersionIndex} → v${payload.restoredVersionIndex}`;
      case ACTION_TYPES.BRANCH_CREATED:
        return `${payload.name || payload.branchId} from ${payload.parentBranchId || 'root'}`;
      case ACTION_TYPES.BRANCH_SWITCHED:
        return `${payload.fromBranchId} → ${payload.toBranchId}`;
      case ACTION_TYPES.BRANCH_RENAMED:
        return `${payload.previousName} → ${payload.name}`;
      case ACTION_TYPES.BRANCH_DISCARDED:
      case ACTION_TYPES.BRANCH_DELETED:
        return `${payload.name || payload.branchId}`;
      case ACTION_TYPES.MERGE_STARTED:
        return `${payload.sourceBranchId} → ${payload.targetBranchId} · ${payload.changeCount ?? 0} change(s)`;
      case ACTION_TYPES.MERGE_CONFLICT:
        return `${formatIdList(payload.sectionIds)} resolved`;
      case ACTION_TYPES.MERGE_COMPLETED:
        return `${payload.sourceBranchId} → ${payload.targetBranchId} · ${formatIdList(payload.appliedSectionIds)}`;
      case ACTION_TYPES.BRANCH_MERGED:
        return `${payload.name || payload.branchId} into ${payload.intoBranchId}`;
      case ACTION_TYPES.BRANCH_COLLAPSED:
        return `${payload.previousName} + ${payload.childName} → ${payload.name}`;
      default:
        return '';
    }
  }

  function formatAction(action) {
    if (!isPlainObject(action)) return '';
    const parent = Number.isInteger(action.parentActionSeq) ? `#${action.parentActionSeq}` : 'root';
    const parts = [
      `#${action.actionSeq}`,
      formatTimeOfDay(action.createdAtMs),
      action.branchId,
      action.type,
      `parent ${parent}`,
    ];
    const summary = summarizeAction(action);
    if (summary) parts.push(summary);
    return parts.join(' · ');
  }

  function formatActions(actions) {
    return sortActions(actions).map(formatAction).join('\n');
  }

  // ── Export ────────────────────────────────────────────────────

  const api = Object.freeze({
    ACTION_SCHEMA_VERSION,
    ROOT_ACTION_SEQ,
    MIN_ACTION_SEQ,
    MAX_ACTION_SEQ,
    DEFAULT_BRANCH_ID,
    DEFAULT_BRANCH_PRIORITY,
    ACTION_TYPES,
    CONTENT_ACTION_TYPES,
    BRANCH_STATUSES,

    isActionSeq,
    isParentActionSeq,
    isContentAction,
    validateAction,
    createAction,
    sortActions,
    normalizeLog,

    createBranch,
    normalizeBranches,

    computeDocumentDelta,

    summarizeAction,
    formatAction,
    formatActions,
  });

  scope.HectraActionLog = api;
  if (typeof module !== 'undefined' && module.exports) module.exports = api;

})(typeof globalThis !== 'undefined' ? globalThis : this);
