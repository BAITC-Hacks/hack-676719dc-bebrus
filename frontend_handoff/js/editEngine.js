// ============================================================
//  HECTRA — Pure staged document edit engine
// ============================================================

/**
 * This module is deliberately unaware of HectraState, the DOM, storage and the
 * model provider. It turns a parsed Markdown patch (or a local structural
 * draft) into reviewable operations and materializes an explicitly accepted
 * subset with the exact same code used to build the preview.
 */
(function (scope) {
  'use strict';

  const AUTHORIZATION = Object.freeze({
    SCOPED: 'scoped',
    APPROVAL: 'requires-approval',
    INVALID: 'invalid',
  });

  const DECISIONS = Object.freeze({
    PENDING: 'pending',
    ACCEPTED: 'accepted',
    REJECTED: 'rejected',
  });

  const KINDS = Object.freeze({
    UPDATE: 'update',
    INSERT: 'insert',
    DELETE: 'delete',
    MOVE: 'move',
  });

  function clone(value) {
    if (value === undefined) return undefined;
    return JSON.parse(JSON.stringify(value));
  }

  function deepFreeze(value) {
    if (!value || typeof value !== 'object' || Object.isFrozen(value)) return value;
    Object.freeze(value);
    for (const child of Object.values(value)) deepFreeze(child);
    return value;
  }

  function sectionBody(section) {
    if (!section) return null;
    return {
      id: String(section.id || ''),
      title: String(section.title ?? section.id ?? ''),
      content: String(section.content ?? ''),
      position: section.position ? clone(section.position) : null,
    };
  }

  function normalizeSnapshot(snapshot) {
    const sections = Array.isArray(snapshot?.sections)
      ? snapshot.sections.map(sectionBody)
      : [];
    const fallbackOrder = sections.map(section => section.id);
    return {
      sections,
      order: Array.isArray(snapshot?.order) ? [...snapshot.order] : fallbackOrder,
      changelogs: Array.isArray(snapshot?.changelogs) ? [...snapshot.changelogs] : [],
    };
  }

  function validateSnapshot(snapshot) {
    const normalized = normalizeSnapshot(snapshot);
    const errors = [];
    const ids = new Set();

    for (const section of normalized.sections) {
      if (!section.id) {
        errors.push('Every section must have a non-empty id.');
        continue;
      }
      if (ids.has(section.id)) errors.push(`Duplicate section id: ${section.id}.`);
      ids.add(section.id);
    }

    const orderIds = new Set();
    for (const id of normalized.order) {
      if (typeof id !== 'string' || !id) {
        errors.push('Section order contains an invalid id.');
        continue;
      }
      if (orderIds.has(id)) errors.push(`Section order contains ${id} more than once.`);
      orderIds.add(id);
      if (!ids.has(id)) errors.push(`Section order references missing section ${id}.`);
    }
    for (const id of ids) {
      if (!orderIds.has(id)) errors.push(`Section ${id} is missing from section order.`);
    }

    return { valid: errors.length === 0, errors, snapshot: normalized };
  }

  function createRequestContext(input = {}) {
    const base = validateSnapshot(input.baseSnapshot);
    const targetSectionIds = Array.isArray(input.targetSectionIds)
      ? [...new Set(input.targetSectionIds.filter(id => typeof id === 'string' && id))]
      : [];
    const context = {
      requestId: String(input.requestId || `edit_${Date.now()}`),
      branchId: String(input.branchId || ''),
      targetMessageIndex: Number.isInteger(input.targetMessageIndex) ? input.targetMessageIndex : null,
      targetSectionIds,
      selectedText: String(input.selectedText || ''),
      baseSnapshot: clone(base.snapshot),
      capturedAtMs: Number.isFinite(input.capturedAtMs) ? input.capturedAtMs : Date.now(),
    };
    return deepFreeze(context);
  }

  function getDelta(before, after, computeDelta) {
    const fn = computeDelta
      || scope.HectraActionLog?.computeDocumentDelta
      || (typeof require === 'function' ? require('./actionLog.js').computeDocumentDelta : null);
    if (typeof fn !== 'function') throw new Error('computeDocumentDelta() is unavailable.');
    return fn(before, after);
  }

  function location(order, id) {
    const index = order.indexOf(id);
    if (index === -1) return null;
    return {
      index,
      beforeId: index > 0 ? order[index - 1] : null,
      afterId: index < order.length - 1 ? order[index + 1] : null,
    };
  }

  function makeOperation({ requestId, sequence, sectionId, kinds, before, after, placement, authorization, reason }) {
    return {
      operationId: `${requestId}:op_${sequence}_${sectionId || 'unknown'}`,
      sequence,
      sectionId,
      kinds: [...kinds],
      before: clone(before),
      after: clone(after),
      placement: placement ? clone(placement) : null,
      positionBefore: null,
      positionAfter: null,
      authorization,
      decision: DECISIONS.PENDING,
      reason: reason || '',
    };
  }

  function classify(kinds, sectionId, targetIds, origin) {
    if (kinds.some(kind => kind === KINDS.INSERT || kind === KINDS.DELETE || kind === KINDS.MOVE)) {
      return {
        authorization: AUTHORIZATION.APPROVAL,
        reason: origin === 'manual-structure'
          ? 'Structural change; Save changes is the explicit approval.'
          : 'Structural changes need explicit approval.',
      };
    }
    if (kinds.includes(KINDS.UPDATE) && targetIds.has(sectionId)) {
      return { authorization: AUTHORIZATION.SCOPED, reason: 'Within selected scope.' };
    }
    return { authorization: AUTHORIZATION.APPROVAL, reason: 'Section was outside the frozen selected scope.' };
  }

  function normalizePlacement(position) {
    if (!position || typeof position !== 'object') return null;
    const type = position.type;
    if (type === 'start' || type === 'end') return { type, ref: null };
    if ((type === 'before' || type === 'after') && typeof position.ref === 'string' && position.ref) {
      return { type, ref: position.ref };
    }
    return { type: 'invalid', ref: position.ref || null };
  }

  function applyOne(working, operation) {
    const sections = new Map(working.sections.map(section => [section.id, sectionBody(section)]));
    const order = [...working.order];
    const id = operation.sectionId;

    if (operation.kinds.includes(KINDS.DELETE)) {
      if (!sections.has(id)) return { ok: false, error: `Cannot delete missing section ${id}.` };
      sections.delete(id);
      const index = order.indexOf(id);
      if (index === -1) return { ok: false, error: `Section ${id} has no position in the document.` };
      order.splice(index, 1);
    } else if (operation.kinds.includes(KINDS.INSERT)) {
      if (sections.has(id)) return { ok: false, error: `Cannot insert duplicate section id ${id}.` };
      if (!operation.after) return { ok: false, error: `Inserted section ${id} has no content.` };
      sections.set(id, { ...sectionBody(operation.after), position: null });
      order.push(id);
    } else {
      if (!sections.has(id)) return { ok: false, error: `Cannot update missing section ${id}.` };
      if (operation.kinds.includes(KINDS.UPDATE)) {
        if (!operation.after) return { ok: false, error: `Updated section ${id} has no replacement content.` };
        sections.set(id, { ...sectionBody(operation.after), position: null });
      }
    }

    if (operation.kinds.includes(KINDS.MOVE) || operation.kinds.includes(KINDS.INSERT)) {
      const placement = normalizePlacement(operation.placement);
      if (!placement || placement.type === 'invalid') {
        return { ok: false, error: `Section ${id} has an invalid position marker.` };
      }

      const currentIndex = order.indexOf(id);
      if (currentIndex === -1) return { ok: false, error: `Section ${id} cannot be positioned.` };
      order.splice(currentIndex, 1);

      if (placement.type === 'start') order.unshift(id);
      else if (placement.type === 'end') order.push(id);
      else {
        if (placement.ref === id) return { ok: false, error: `Section ${id} cannot use itself as an anchor.` };
        const anchorIndex = order.indexOf(placement.ref);
        if (anchorIndex === -1) {
          return { ok: false, error: `Position anchor ${placement.ref} for section ${id} is unavailable.` };
        }
        order.splice(placement.type === 'after' ? anchorIndex + 1 : anchorIndex, 0, id);
      }
    }

    const next = {
      sections: order.map(sectionId => sections.get(sectionId)),
      order,
      changelogs: [...working.changelogs],
    };
    const validation = validateSnapshot(next);
    return validation.valid
      ? { ok: true, snapshot: validation.snapshot }
      : { ok: false, error: validation.errors.join(' ') };
  }

  function applyOperations(baseSnapshot, operations) {
    const base = validateSnapshot(baseSnapshot);
    if (!base.valid) return { ok: false, error: base.errors.join(' '), snapshot: base.snapshot };

    let working = clone(base.snapshot);
    for (const operation of [...operations].sort((a, b) => a.sequence - b.sequence)) {
      const result = applyOne(working, operation);
      if (!result.ok) return { ok: false, error: result.error, failedOperationId: operation.operationId, snapshot: working };
      working = result.snapshot;
    }
    return { ok: true, snapshot: working };
  }

  function invalidOperation(context, sequence, id, reason, before = null, after = null) {
    return makeOperation({
      requestId: context.requestId,
      sequence,
      sectionId: id || 'unknown',
      kinds: [],
      before,
      after,
      placement: null,
      authorization: AUTHORIZATION.INVALID,
      reason,
    });
  }

  function operationsFromParsed(baseSnapshot, parsed, context, origin) {
    const baseMap = new Map(baseSnapshot.sections.map(section => [section.id, section]));
    const groups = new Map();
    let sequence = 0;
    const put = (id, type, value) => {
      const cleanId = typeof id === 'string' ? id.trim() : '';
      const key = cleanId || `__invalid_${sequence}`;
      if (!groups.has(key)) groups.set(key, { id: cleanId, sequence: sequence++, sections: [], deletes: 0 });
      const group = groups.get(key);
      if (type === 'section') group.sections.push(value); else group.deletes += 1;
    };

    // Deletion used to run before updates in HectraState.applyEdit(). Keep that
    // deterministic ordering, now under validation rather than fallback rules.
    for (const id of Array.isArray(parsed?.deletedIds) ? parsed.deletedIds : []) put(id, 'delete');
    for (const section of Array.isArray(parsed?.sections) ? parsed.sections : []) put(section?.id, 'section', section);

    const targetIds = new Set(context.targetSectionIds);
    const operations = [];

    for (const group of groups.values()) {
      const before = baseMap.get(group.id) || null;
      if (!group.id) {
        operations.push(invalidOperation(context, group.sequence, 'unknown', 'Operation has no section id.'));
        continue;
      }
      if (group.sections.length + group.deletes > 1) {
        operations.push(invalidOperation(
          context,
          group.sequence,
          group.id,
          `Section ${group.id} is targeted more than once in one response.`,
          before,
          group.sections[0] || null
        ));
        continue;
      }

      if (group.deletes) {
        if (!before) {
          operations.push(invalidOperation(context, group.sequence, group.id, `Cannot delete missing section ${group.id}.`));
          continue;
        }
        const classification = classify([KINDS.DELETE], group.id, targetIds, origin);
        operations.push(makeOperation({
          requestId: context.requestId,
          sequence: group.sequence,
          sectionId: group.id,
          kinds: [KINDS.DELETE],
          before,
          after: null,
          placement: null,
          ...classification,
        }));
        continue;
      }

      const incoming = sectionBody(group.sections[0]);
      if (!incoming) {
        operations.push(invalidOperation(context, group.sequence, group.id, `Section ${group.id} is malformed.`));
        continue;
      }
      const placement = normalizePlacement(incoming.position);

      if (!before) {
        if (!placement) {
          operations.push(invalidOperation(
            context,
            group.sequence,
            group.id,
            `New section ${group.id} needs an explicit @before/@after/@start/@end position.`,
            null,
            incoming
          ));
          continue;
        }
        const classification = classify([KINDS.INSERT], group.id, targetIds, origin);
        operations.push(makeOperation({
          requestId: context.requestId,
          sequence: group.sequence,
          sectionId: group.id,
          kinds: [KINDS.INSERT],
          before: null,
          after: incoming,
          placement,
          ...classification,
        }));
        continue;
      }

      // Preserve the historical, tested interpretation of a position-only
      // patch: it moves the complete existing section instead of erasing it.
      const after = placement && !String(incoming.content || '').trim()
        ? { ...incoming, title: before.title, content: before.content }
        : incoming;
      const changed = before.title !== after.title || before.content !== after.content;
      const kinds = [];
      if (changed) kinds.push(KINDS.UPDATE);
      if (placement) kinds.push(KINDS.MOVE);
      if (!kinds.length) continue;

      const classification = classify(kinds, group.id, targetIds, origin);
      operations.push(makeOperation({
        requestId: context.requestId,
        sequence: group.sequence,
        sectionId: group.id,
        kinds,
        before,
        after,
        placement,
        ...classification,
      }));
    }

    return operations;
  }

  function finalizeProposal(baseSnapshot, operations, context, options = {}) {
    const validOperations = operations.filter(operation => operation.authorization !== AUTHORIZATION.INVALID);
    let preview = applyOperations(baseSnapshot, validOperations);

    // A failure can depend on the combination (for example, deleting an anchor
    // used by a later insertion). Attach the reason to the first failing item,
    // then rebuild a preview without invalid operations. Nothing is silently
    // normalized to another location.
    while (!preview.ok && preview.failedOperationId) {
      const failed = operations.find(operation => operation.operationId === preview.failedOperationId);
      if (!failed || failed.authorization === AUTHORIZATION.INVALID) break;
      failed.authorization = AUTHORIZATION.INVALID;
      failed.reason = preview.error;
      preview = applyOperations(
        baseSnapshot,
        operations.filter(operation => operation.authorization !== AUTHORIZATION.INVALID)
      );
    }

    const candidateSnapshot = preview.ok ? preview.snapshot : normalizeSnapshot(baseSnapshot);
    for (const operation of operations) {
      operation.positionBefore = location(baseSnapshot.order, operation.sectionId);
      operation.positionAfter = location(candidateSnapshot.order, operation.sectionId);
    }

    return {
      requestId: context.requestId,
      branchId: context.branchId,
      origin: options.origin || 'model',
      createdAtMs: Date.now(),
      initialScope: [...context.targetSectionIds],
      selectedText: context.selectedText,
      baseSnapshot: clone(baseSnapshot),
      candidateSnapshot: clone(candidateSnapshot),
      candidateDelta: getDelta(baseSnapshot, candidateSnapshot, options.computeDelta),
      operations,
      status: 'pending',
      staleReason: '',
      logs: Array.isArray(options.logs) ? [...options.logs] : [],
    };
  }

  function createProposal(parsed, frozenContext, options = {}) {
    const context = frozenContext || createRequestContext({ baseSnapshot: {} });
    const baseValidation = validateSnapshot(context.baseSnapshot);
    if (!baseValidation.valid) {
      return finalizeProposal(baseValidation.snapshot, [
        invalidOperation(context, 0, 'document', baseValidation.errors.join(' ')),
      ], context, options);
    }
    const operations = operationsFromParsed(baseValidation.snapshot, parsed || {}, context, options.origin || 'model');
    return finalizeProposal(baseValidation.snapshot, operations, context, options);
  }

  function placementForCandidate(order, id) {
    const index = order.indexOf(id);
    if (index <= 0) return { type: 'start', ref: null };
    return { type: 'after', ref: order[index - 1] };
  }

  function createProposalFromCandidate(candidate, frozenContext, options = {}) {
    const context = frozenContext || createRequestContext({ baseSnapshot: {} });
    const baseValidation = validateSnapshot(context.baseSnapshot);
    const candidateValidation = validateSnapshot(candidate);
    if (!baseValidation.valid || !candidateValidation.valid) {
      const reason = [...baseValidation.errors, ...candidateValidation.errors].join(' ');
      return finalizeProposal(baseValidation.snapshot, [invalidOperation(context, 0, 'document', reason)], context, options);
    }

    const base = baseValidation.snapshot;
    const after = candidateValidation.snapshot;
    const delta = getDelta(base, after, options.computeDelta);
    const changed = new Map(delta.changedSections.map(item => [item.id, item]));
    const inserted = new Set(delta.insertedSections.map(item => item.id));
    const deleted = new Set(delta.deletedSections.map(item => item.id));
    const moved = new Set(delta.movedSections.map(item => item.id));
    const baseMap = new Map(base.sections.map(section => [section.id, section]));
    const afterMap = new Map(after.sections.map(section => [section.id, section]));
    const targetIds = new Set(context.targetSectionIds);
    const operations = [];
    let sequence = 0;

    for (const id of base.order) {
      if (!deleted.has(id)) continue;
      const kinds = [KINDS.DELETE];
      operations.push(makeOperation({
        requestId: context.requestId,
        sequence: sequence++,
        sectionId: id,
        kinds,
        before: baseMap.get(id),
        after: null,
        placement: null,
        ...classify(kinds, id, targetIds, options.origin || 'manual-structure'),
      }));
    }

    // Candidate order makes dependent positions deterministic: an inserted or
    // moved predecessor is materialized before a section anchored after it.
    for (const id of after.order) {
      const kinds = [];
      if (inserted.has(id)) kinds.push(KINDS.INSERT);
      else {
        if (changed.has(id)) kinds.push(KINDS.UPDATE);
        if (moved.has(id)) kinds.push(KINDS.MOVE);
      }
      if (!kinds.length) continue;
      operations.push(makeOperation({
        requestId: context.requestId,
        sequence: sequence++,
        sectionId: id,
        kinds,
        before: baseMap.get(id) || null,
        after: afterMap.get(id) || null,
        placement: kinds.includes(KINDS.INSERT) || kinds.includes(KINDS.MOVE)
          ? placementForCandidate(after.order, id)
          : null,
        ...classify(kinds, id, targetIds, options.origin || 'manual-structure'),
      }));
    }

    const proposal = finalizeProposal(base, operations, context, options);
    const mismatch = getDelta(proposal.candidateSnapshot, after, options.computeDelta);
    if (mismatch.hasChanges) {
      proposal.operations.push(invalidOperation(
        context,
        sequence,
        'document',
        'The structural operation set cannot reproduce the requested order exactly.'
      ));
    } else {
      proposal.candidateSnapshot = clone(after);
      proposal.candidateDelta = delta;
    }
    return proposal;
  }

  function materializeProposal(proposal, acceptedOperationIds, options = {}) {
    if (!proposal || !Array.isArray(proposal.operations)) {
      return { ok: false, error: 'Edit proposal is missing or malformed.' };
    }
    const accepted = new Set(Array.isArray(acceptedOperationIds) ? acceptedOperationIds : []);
    const selected = [];
    const knownOperationIds = new Set(proposal.operations.map(operation => operation.operationId));
    for (const operationId of accepted) {
      if (!knownOperationIds.has(operationId)) return { ok: false, error: `Unknown edit operation ${operationId}.` };
    }

    for (const operation of proposal.operations) {
      if (!accepted.has(operation.operationId)) continue;
      if (operation.authorization === AUTHORIZATION.INVALID) {
        return { ok: false, error: operation.reason || `Operation ${operation.operationId} is invalid.` };
      }
      if (operation.authorization === AUTHORIZATION.APPROVAL && options.explicitApproval !== true) {
        return { ok: false, error: `Operation on ${operation.sectionId} needs explicit approval.` };
      }
      selected.push(operation);
    }

    const applied = applyOperations(proposal.baseSnapshot, selected);
    if (!applied.ok) return applied;
    const validation = validateSnapshot(applied.snapshot);
    if (!validation.valid) return { ok: false, error: validation.errors.join(' ') };

    return {
      ok: true,
      snapshot: validation.snapshot,
      delta: getDelta(proposal.baseSnapshot, validation.snapshot, options.computeDelta),
      appliedOperations: selected.map(operation => operation.operationId),
    };
  }

  function canAutoApply(proposal) {
    return !!proposal
      && proposal.operations.length > 0
      && proposal.operations.every(operation =>
        operation.authorization === AUTHORIZATION.SCOPED
        && operation.kinds.length === 1
        && operation.kinds[0] === KINDS.UPDATE
        && proposal.initialScope.includes(operation.sectionId)
      );
  }

  function snapshotEquals(left, right, computeDelta) {
    return !getDelta(normalizeSnapshot(left), normalizeSnapshot(right), computeDelta).hasChanges;
  }

  /**
   * Manual structure controls use this function instead of mutating arrays in
   * the UI. The returned snapshot has passed the same operation applier and
   * invariant checks as a model proposal.
   */
  function applyManualCommand(snapshot, command = {}) {
    const validation = validateSnapshot(snapshot);
    if (!validation.valid) return { ok: false, error: validation.errors.join(' ') };
    const base = validation.snapshot;
    const id = String(command.sectionId || command.section?.id || '');
    const existing = base.sections.find(section => section.id === id) || null;
    let kinds = [];
    let after = existing;
    let placement = null;

    if (command.type === 'add') {
      kinds = [KINDS.INSERT];
      after = sectionBody(command.section);
      placement = normalizePlacement(command.position);
    } else if (command.type === 'delete') {
      kinds = [KINDS.DELETE];
      after = null;
    } else if (command.type === 'move') {
      kinds = [KINDS.MOVE];
      placement = normalizePlacement(command.position);
    } else if (command.type === 'update') {
      kinds = [KINDS.UPDATE];
      after = sectionBody(command.section);
    } else {
      return { ok: false, error: 'Unknown manual structure command.' };
    }

    const operation = makeOperation({
      requestId: 'manual',
      sequence: 0,
      sectionId: id,
      kinds,
      before: existing,
      after,
      placement,
      authorization: AUTHORIZATION.APPROVAL,
      reason: 'Manual structure command.',
    });
    return applyOperations(base, [operation]);
  }

  const api = Object.freeze({
    AUTHORIZATION,
    DECISIONS,
    KINDS,
    clone,
    createRequestContext,
    createProposal,
    createProposalFromCandidate,
    materializeProposal,
    applyManualCommand,
    validateSnapshot,
    normalizeSnapshot,
    snapshotEquals,
    canAutoApply,
  });

  scope.HectraEditEngine = api;
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
})(typeof globalThis !== 'undefined' ? globalThis : this);
