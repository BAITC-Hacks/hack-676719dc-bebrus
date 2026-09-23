// ============================================================
//  HECTRA — Merge engine (three-way document merge)
// ============================================================

/**
 * Real three-way merge over the section model.
 *
 *   BASE   — the document at the point the branch forked (HectraState.branchBases)
 *   TARGET — the document the branch is being merged into (usually main)
 *   SOURCE — the document on the branch
 *
 * Every section id is classified by comparing BASE→TARGET and BASE→SOURCE.
 * Nothing is ever resolved by "take the whole branch": a section only enters the
 * result through an explicit per-section decision, and structural conflicts have
 * no automatic winner at all.
 *
 * This module is pure data: no DOM, no storage, no HectraState knowledge, no
 * model calls. The LLM combination arrives here as a finished body through
 * resolve(..., { combined }).
 */
(function (scope) {

  const CHANGE_KINDS = Object.freeze({
    CHANGED: 'changed',
    ADDED:   'added',
    REMOVED: 'removed',
    ORDER:   'order',
  });

  const ITEM_STATUS = Object.freeze({
    COMPATIBLE: 'compatible',
    CONFLICT:   'conflict',
  });

  /** Why an item looks the way it does. Drives the wording in the merge UI. */
  const REASONS = Object.freeze({
    SOURCE_ONLY:       'source-only',        // branch changed it, target did not
    IDENTICAL:         'identical',          // both sides made the same change
    BOTH_MODIFIED:     'both-modified',      // structural conflict
    BOTH_ADDED:        'both-added',         // same new id, different content
    DELETED_BY_SOURCE: 'deleted-by-source',  // branch removed a section target edited
    DELETED_BY_TARGET: 'deleted-by-target',  // target removed a section the branch edited
    ORDER:             'order',              // both sides reordered differently
  });

  const RESOLUTIONS = Object.freeze({
    SOURCE:   'source',    // take the branch version (or accept its deletion)
    TARGET:   'target',    // keep the current version (or its deletion)
    COMBINED: 'combined',  // take an explicitly accepted combination
  });

  const ORDER_ITEM_ID = '__order__';

  // ── Normalisation ─────────────────────────────────────────────

  function isPlainObject(value) {
    return !!value && typeof value === 'object' && !Array.isArray(value);
  }

  /** Accepts { sections, order } (HectraState._snapshot / getBranchDocument). */
  function toDocument(snapshot) {
    const sections = new Map();
    const raw = isPlainObject(snapshot) && Array.isArray(snapshot.sections) ? snapshot.sections : [];

    for (const section of raw) {
      if (!isPlainObject(section) || typeof section.id !== 'string' || !section.id.trim()) continue;
      sections.set(section.id, { ...section });
    }

    const order = (isPlainObject(snapshot) && Array.isArray(snapshot.order) ? snapshot.order : [...sections.keys()])
      .filter(id => sections.has(id));
    for (const id of sections.keys()) if (!order.includes(id)) order.push(id);

    return { sections, order };
  }

  function body(document, id) {
    const section = document.sections.get(id);
    if (!section) return null;
    return { title: String(section.title ?? ''), content: String(section.content ?? '') };
  }

  function sameBody(a, b) {
    if (!a && !b) return true;
    if (!a || !b) return false;
    return a.title === b.title && a.content === b.content;
  }

  function sameList(a, b) {
    return a.length === b.length && a.every((value, index) => value === b[index]);
  }

  function titleOf(...bodies) {
    for (const value of bodies) if (value && value.title) return value.title;
    return '';
  }

  // ── Planning ──────────────────────────────────────────────────

  /**
   * Classifies every section and returns a merge plan. Compatible items arrive
   * pre-resolved; conflicts arrive with resolution === null and must be decided
   * before the plan can be applied.
   */
  function planMerge(input = {}) {
    const base   = toDocument(input.base);
    const target = toDocument(input.target);
    const source = toDocument(input.source);

    const ids = [];
    const seen = new Set();
    for (const id of [...target.order, ...source.order, ...base.order]) {
      if (seen.has(id)) continue;
      seen.add(id);
      ids.push(id);
    }

    const items = [];

    for (const id of ids) {
      const b = body(base, id);
      const t = body(target, id);
      const s = body(source, id);

      // The branch left this section exactly as it forked it: nothing to merge,
      // the target's own version simply stays.
      if (sameBody(b, s)) continue;

      const kind = !b && s ? CHANGE_KINDS.ADDED
        : !s ? CHANGE_KINDS.REMOVED
        : CHANGE_KINDS.CHANGED;

      const item = {
        id,
        title: titleOf(s, t, b) || id,
        kind,
        status: ITEM_STATUS.COMPATIBLE,
        reason: REASONS.SOURCE_ONLY,
        base: b,
        target: t,
        source: s,
        resolution: RESOLUTIONS.SOURCE,
        combined: null,
      };

      if (sameBody(b, t)) {
        // Case A / compatible insert / compatible delete: only the branch moved.
        items.push(item);
        continue;
      }

      if (sameBody(t, s)) {
        // Case D: both sides ended up with the same text — one result, no choice.
        item.reason = REASONS.IDENTICAL;
        item.resolution = RESOLUTIONS.TARGET;
        items.push(item);
        continue;
      }

      // Case E and the delete/insert variants: a real structural conflict.
      item.status = ITEM_STATUS.CONFLICT;
      item.resolution = null;
      item.reason = !s ? REASONS.DELETED_BY_SOURCE
        : !t ? REASONS.DELETED_BY_TARGET
        : !b ? REASONS.BOTH_ADDED
        : REASONS.BOTH_MODIFIED;
      items.push(item);
    }

    const plan = {
      base,
      target,
      source,
      sourceName: typeof input.sourceName === 'string' ? input.sourceName : '',
      targetName: typeof input.targetName === 'string' ? input.targetName : '',
      items,
      order: planOrder(base, target, source),
    };

    if (plan.order.status === ITEM_STATUS.CONFLICT) {
      plan.items.push({
        id: ORDER_ITEM_ID,
        title: 'Section order',
        kind: CHANGE_KINDS.ORDER,
        status: ITEM_STATUS.CONFLICT,
        reason: REASONS.ORDER,
        base: null,
        target: null,
        source: null,
        resolution: null,
        combined: null,
      });
    } else if (plan.order.sourceMoved) {
      plan.items.push({
        id: ORDER_ITEM_ID,
        title: 'Section order',
        kind: CHANGE_KINDS.ORDER,
        status: ITEM_STATUS.COMPATIBLE,
        reason: REASONS.ORDER,
        base: null,
        target: null,
        source: null,
        resolution: RESOLUTIONS.SOURCE,
        combined: null,
      });
    }

    return refresh(plan);
  }

  /**
   * Order is merged separately from content: a pure reorder on one side is
   * compatible, the same sections reordered differently on both sides is not.
   */
  function planOrder(base, target, source) {
    const common = new Set([...base.order].filter(id => target.sections.has(id) && source.sections.has(id)));
    const baseSeq   = base.order.filter(id => common.has(id));
    const targetSeq = target.order.filter(id => common.has(id));
    const sourceSeq = source.order.filter(id => common.has(id));

    const targetMoved = !sameList(baseSeq, targetSeq);
    const sourceMoved = !sameList(baseSeq, sourceSeq);

    const status = targetMoved && sourceMoved && !sameList(targetSeq, sourceSeq)
      ? ITEM_STATUS.CONFLICT
      : ITEM_STATUS.COMPATIBLE;

    return { common: [...common], baseSeq, targetSeq, sourceSeq, targetMoved, sourceMoved, status };
  }

  /** Recomputes the derived fields after a resolution changed. */
  function refresh(plan) {
    const conflicts = plan.items.filter(item => item.status === ITEM_STATUS.CONFLICT);
    plan.conflicts = conflicts.map(item => item.id);
    plan.compatible = plan.items.filter(item => item.status === ITEM_STATUS.COMPATIBLE).map(item => item.id);
    plan.unresolved = conflicts
      .filter(item => !item.resolution || (item.resolution === RESOLUTIONS.COMBINED && !item.combined))
      .map(item => item.id);
    plan.hasChanges = plan.items.length > 0;
    plan.canApply = plan.hasChanges && plan.unresolved.length === 0;
    return plan;
  }

  function findItem(plan, id) {
    return plan.items.find(item => item.id === id) || null;
  }

  /**
   * Records a decision for one item. `options.combined` carries an accepted
   * combination — the engine never produces one itself.
   */
  function resolve(plan, id, resolution, options = {}) {
    const item = findItem(plan, id);
    if (!item) return null;

    if (resolution === RESOLUTIONS.COMBINED) {
      const combined = options.combined;
      if (!isPlainObject(combined)) return null;
      item.combined = { title: String(combined.title ?? item.title), content: String(combined.content ?? '') };
      item.resolution = RESOLUTIONS.COMBINED;
    } else if (resolution === RESOLUTIONS.SOURCE || resolution === RESOLUTIONS.TARGET) {
      item.resolution = resolution;
      if (resolution !== RESOLUTIONS.COMBINED) item.combined = null;
    } else {
      return null;
    }

    refresh(plan);
    return item;
  }

  // ── Result ────────────────────────────────────────────────────

  /**
   * Builds the merged document. Returns null while any conflict is undecided —
   * a partially resolved merge never produces a state.
   */
  function buildResult(plan) {
    if (!plan || !plan.canApply) return null;

    const { base, target, source } = plan;
    const decisions = new Map(plan.items.filter(item => item.id !== ORDER_ITEM_ID).map(item => [item.id, item]));
    const orderItem = findItem(plan, ORDER_ITEM_ID);

    const sections = new Map();
    const applied = [];
    const removed = [];

    const takeFrom = (document, id) => {
      const section = document.sections.get(id);
      return section ? { ...section, position: null } : null;
    };

    // 1. Sections the branch never touched keep the target's version.
    for (const id of target.order) {
      if (decisions.has(id)) continue;
      sections.set(id, takeFrom(target, id));
    }

    // 2. Everything the branch touched follows its decision.
    for (const [id, item] of decisions) {
      if (item.resolution === RESOLUTIONS.COMBINED) {
        const anchor = takeFrom(source, id) || takeFrom(target, id) || { id };
        sections.set(id, { ...anchor, id, title: item.combined.title, content: item.combined.content, position: null });
        applied.push(id);
        continue;
      }

      const from = item.resolution === RESOLUTIONS.SOURCE ? source : target;
      const section = takeFrom(from, id);
      if (section) {
        sections.set(id, section);
        // Taking the target's version is not a change to the target.
        if (item.resolution === RESOLUTIONS.SOURCE) applied.push(id);
      } else {
        removed.push(id);
        if (item.resolution === RESOLUTIONS.SOURCE) applied.push(id);
      }
    }

    const resultIds = new Set(sections.keys());
    const order = buildOrder(plan, resultIds, orderItem);

    return {
      sections: order.map(id => sections.get(id)),
      order,
      appliedSectionIds: applied,
      removedSectionIds: removed,
    };
  }

  function buildOrder(plan, resultIds, orderItem) {
    const { target, source, order: analysis } = plan;
    const common = new Set(analysis.common);

    // Which relative order wins for the sections both sides know about.
    const useSourceSpine = analysis.status === ITEM_STATUS.CONFLICT
      ? (orderItem && orderItem.resolution === RESOLUTIONS.SOURCE)
      : analysis.sourceMoved && (!orderItem || orderItem.resolution !== RESOLUTIONS.TARGET);

    const spine = (useSourceSpine ? analysis.sourceSeq : analysis.targetSeq).filter(id => resultIds.has(id));
    const queue = [...spine];

    const list = [];
    for (const id of target.order) {
      if (!resultIds.has(id)) continue;
      if (common.has(id)) {
        const next = queue.shift();
        if (next && !list.includes(next)) list.push(next);
        continue;
      }
      if (!list.includes(id)) list.push(id);
    }
    for (const id of queue) if (resultIds.has(id) && !list.includes(id)) list.push(id);

    // Sections that only exist on the branch land next to their branch neighbour.
    for (let index = 0; index < source.order.length; index++) {
      const id = source.order[index];
      if (!resultIds.has(id) || list.includes(id)) continue;

      let position = -1;
      for (let before = index - 1; before >= 0; before--) {
        const anchor = list.indexOf(source.order[before]);
        if (anchor !== -1) { position = anchor + 1; break; }
      }
      if (position === -1) {
        for (let after = index + 1; after < source.order.length; after++) {
          const anchor = list.indexOf(source.order[after]);
          if (anchor !== -1) { position = anchor; break; }
        }
      }
      if (position === -1) list.push(id); else list.splice(position, 0, id);
    }

    for (const id of resultIds) if (!list.includes(id)) list.push(id);
    return list;
  }

  /** Counts for the merge UI header. */
  function summarize(plan) {
    if (!plan) return { compatible: 0, conflicts: 0, unresolved: 0, hasChanges: false };
    return {
      compatible: plan.compatible.length,
      conflicts: plan.conflicts.length,
      unresolved: plan.unresolved.length,
      hasChanges: plan.hasChanges,
    };
  }

  const api = Object.freeze({
    CHANGE_KINDS,
    ITEM_STATUS,
    REASONS,
    RESOLUTIONS,
    ORDER_ITEM_ID,

    planMerge,
    resolve,
    buildResult,
    findItem,
    refresh,
    summarize,
  });

  scope.HectraMergeEngine = api;
  if (typeof module !== 'undefined' && module.exports) module.exports = api;

})(typeof globalThis !== 'undefined' ? globalThis : this);
