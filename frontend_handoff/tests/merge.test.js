const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');
const vm = require('node:vm');

const projectRoot = path.resolve(__dirname, '..');
const readScript = rel => fs.readFileSync(path.join(projectRoot, rel), 'utf8');

function createMemoryStorage(initial = {}) {
  const map = new Map(Object.entries(initial));
  return {
    getItem: key => (map.has(key) ? map.get(key) : null),
    setItem: (key, value) => { map.set(key, String(value)); },
    removeItem: key => { map.delete(key); },
    raw: map,
  };
}

function loadState(options = {}) {
  const storage = options.storage || createMemoryStorage();
  const context = vm.createContext({
    console: { warn() {}, error() {}, log() {} },
    HectraConfig: { CHAT_SYSTEM_PROMPT: 'chat', CREATOR_SYSTEM_PROMPT: 'creator', EDIT_SYSTEM_PROMPT: 'edit' },
    HectraSecurity: {
      MAX_SESSION_BYTES: 8 * 1024 * 1024,
      isSafeImageDataUrl: () => true,
      storage: () => storage,
    },
  });
  vm.runInContext(
    `${readScript('js/actionLog.js')}\n${readScript('js/mergeEngine.js')}\n${readScript('js/editEngine.js')}\n${readScript('js/state.js')}\n` +
    'globalThis.__HectraState = HectraState;',
    context
  );
  const state = context.__HectraState;
  state.init();
  return { state, storage, log: context.HectraActionLog, engine: context.HectraMergeEngine };
}

const list = (values, mapper = v => v) => Array.from(values, mapper);
const section = (id, content = `${id} base`, title = id.toUpperCase()) => ({ id, title, content, position: null });
const bodyOf = (state, id) => state.documentSections.get(id)?.content ?? null;
const orderOf = state => list(state.sectionOrder);

/** main with a three-section document. */
function seed(state, sections = [section('intro'), section('goals'), section('metrics')]) {
  state.addUserMessage('build a plan');
  state.addAIMessage('raw', sections, ['created']);
}

/**
 * Sets up main + one branch, applies the given edits on each side and returns
 * the plan for merging the branch back into main.
 */
function diverge(state, { onBranch = () => {}, onMain = () => {}, branchName = 'Branch A' } = {}) {
  const branch = state.createBranch(branchName);
  onBranch(state);
  state.switchBranch('main');
  onMain(state);
  return { branch, plan: state.planMerge(branch.id, 'main') };
}

// ── Classification (§33.1–§33.11) ────────────────────────────────

test('1. branch modifies a section main never touched — compatible, applied', () => {
  const { state, engine } = loadState();
  seed(state);

  const { plan } = diverge(state, {
    onBranch: s => s.applyEdit([section('metrics', 'vibration metrics')], [], ['edited']),
  });

  assert.equal(plan.items.length, 1);
  assert.equal(plan.items[0].id, 'metrics');
  assert.equal(plan.items[0].status, engine.ITEM_STATUS.COMPATIBLE);
  assert.equal(plan.items[0].reason, engine.REASONS.SOURCE_ONLY);
  assert.equal(plan.items[0].resolution, engine.RESOLUTIONS.SOURCE);
  assert.equal(plan.canApply, true);

  const result = engine.buildResult(plan);
  assert.equal(result.sections.find(s => s.id === 'metrics').content, 'vibration metrics');
  assert.deepEqual(list(result.order), ['intro', 'goals', 'metrics']);
});

test('2. main modifies a section the branch never touched — main keeps its version', () => {
  const { state, engine } = loadState();
  seed(state);

  const { plan } = diverge(state, {
    onMain: s => s.applyEdit([section('goals', 'main goals v2')], [], ['edited on main']),
  });

  assert.equal(plan.items.length, 0, 'the branch changed nothing');
  assert.equal(plan.hasChanges, false);
  assert.equal(plan.canApply, false, 'nothing to apply');

  // Even when the branch does change something else, main's edit survives.
  const other = diverge(state, {
    branchName: 'Branch B',
    onBranch: s => s.applyEdit([section('metrics', 'branch metrics')], [], ['edited']),
    onMain: s => s.applyEdit([section('goals', 'main goals v3')], [], ['edited on main']),
  });
  const result = engine.buildResult(other.plan);
  assert.equal(result.sections.find(s => s.id === 'goals').content, 'main goals v3');
  assert.equal(result.sections.find(s => s.id === 'metrics').content, 'branch metrics');
});

test('3. both sides modify different sections — both changes land', () => {
  const { state, engine } = loadState();
  seed(state);

  const { plan } = diverge(state, {
    onBranch: s => s.applyEdit([section('metrics', 'branch metrics')], [], ['b']),
    onMain: s => s.applyEdit([section('intro', 'main intro')], [], ['m']),
  });

  assert.deepEqual(list(plan.items, i => i.id), ['metrics']);
  assert.equal(plan.conflicts.length, 0);

  const result = engine.buildResult(plan);
  assert.equal(result.sections.find(s => s.id === 'intro').content, 'main intro');
  assert.equal(result.sections.find(s => s.id === 'metrics').content, 'branch metrics');
});

test('4. both sides make the identical change — compatible, one result', () => {
  const { state, engine } = loadState();
  seed(state);

  const { plan } = diverge(state, {
    onBranch: s => s.applyEdit([section('goals', 'same new text')], [], ['b']),
    onMain: s => s.applyEdit([section('goals', 'same new text')], [], ['m']),
  });

  assert.equal(plan.items.length, 1);
  assert.equal(plan.items[0].status, engine.ITEM_STATUS.COMPATIBLE);
  assert.equal(plan.items[0].reason, engine.REASONS.IDENTICAL);
  assert.equal(plan.canApply, true);
  assert.equal(engine.buildResult(plan).sections.find(s => s.id === 'goals').content, 'same new text');
});

test('5. same section modified differently — structural conflict, no automatic winner', () => {
  const { state, engine } = loadState();
  seed(state);

  const { plan } = diverge(state, {
    onBranch: s => s.applyEdit([section('goals', 'branch goals')], [], ['b']),
    onMain: s => s.applyEdit([section('goals', 'main goals')], [], ['m']),
  });

  assert.deepEqual(list(plan.conflicts), ['goals']);
  assert.equal(plan.items[0].reason, engine.REASONS.BOTH_MODIFIED);
  assert.equal(plan.items[0].resolution, null);
  assert.equal(plan.canApply, false);
  assert.equal(engine.buildResult(plan), null, 'an undecided merge produces no state');

  engine.resolve(plan, 'goals', engine.RESOLUTIONS.SOURCE);
  assert.equal(plan.canApply, true);
  assert.equal(engine.buildResult(plan).sections.find(s => s.id === 'goals').content, 'branch goals');

  engine.resolve(plan, 'goals', engine.RESOLUTIONS.TARGET);
  assert.equal(engine.buildResult(plan).sections.find(s => s.id === 'goals').content, 'main goals');
});

test('6. branch deletes a section main never touched — compatible deletion', () => {
  const { state, engine } = loadState();
  seed(state);

  const { plan } = diverge(state, {
    onBranch: s => s.applyEdit([], ['metrics'], ['deleted']),
  });

  assert.equal(plan.items[0].kind, engine.CHANGE_KINDS.REMOVED);
  assert.equal(plan.items[0].status, engine.ITEM_STATUS.COMPATIBLE);

  const result = engine.buildResult(plan);
  assert.deepEqual(list(result.order), ['intro', 'goals']);
  assert.deepEqual(list(result.removedSectionIds), ['metrics']);
});

test('7. branch deletes a section main modified — conflict, deletion is not automatic', () => {
  const { state, engine } = loadState();
  seed(state);

  const { plan } = diverge(state, {
    onBranch: s => s.applyEdit([], ['goals'], ['deleted on branch']),
    onMain: s => s.applyEdit([section('goals', 'main improved goals')], [], ['edited on main']),
  });

  assert.deepEqual(list(plan.conflicts), ['goals']);
  assert.equal(plan.items[0].reason, engine.REASONS.DELETED_BY_SOURCE);
  assert.equal(plan.canApply, false);

  // Keep current — the section survives with main's text.
  engine.resolve(plan, 'goals', engine.RESOLUTIONS.TARGET);
  assert.equal(engine.buildResult(plan).sections.find(s => s.id === 'goals').content, 'main improved goals');

  // Delete section — the branch's deletion wins.
  engine.resolve(plan, 'goals', engine.RESOLUTIONS.SOURCE);
  assert.equal(engine.buildResult(plan).sections.find(s => s.id === 'goals'), undefined);
});

test('8. main deletes a section the branch modified — conflict', () => {
  const { state, engine } = loadState();
  seed(state);

  const { plan } = diverge(state, {
    onBranch: s => s.applyEdit([section('metrics', 'branch metrics')], [], ['b']),
    onMain: s => s.applyEdit([], ['metrics'], ['deleted on main']),
  });

  assert.deepEqual(list(plan.conflicts), ['metrics']);
  assert.equal(plan.items[0].reason, engine.REASONS.DELETED_BY_TARGET);

  engine.resolve(plan, 'metrics', engine.RESOLUTIONS.TARGET);
  assert.equal(engine.buildResult(plan).sections.find(s => s.id === 'metrics'), undefined, 'deletion kept');

  engine.resolve(plan, 'metrics', engine.RESOLUTIONS.SOURCE);
  assert.equal(engine.buildResult(plan).sections.find(s => s.id === 'metrics').content, 'branch metrics');
});

test('9. branch inserts a new section — it lands next to its branch neighbour', () => {
  const { state, engine } = loadState();
  seed(state);

  const { plan } = diverge(state, {
    onBranch: s => s.applyEdit([{ ...section('risks', 'branch risks'), position: { type: 'after', ref: 'goals' } }], [], ['added']),
  });

  assert.equal(plan.items[0].kind, engine.CHANGE_KINDS.ADDED);
  assert.deepEqual(list(engine.buildResult(plan).order), ['intro', 'goals', 'risks', 'metrics']);
});

test('10. both sides insert different sections — both survive', () => {
  const { state, engine } = loadState();
  seed(state);

  const { plan } = diverge(state, {
    onBranch: s => s.applyEdit([{ ...section('risks', 'branch risks'), position: { type: 'end' } }], [], ['b']),
    onMain: s => s.applyEdit([{ ...section('budget', 'main budget'), position: { type: 'end' } }], [], ['m']),
  });

  // Each new section keeps the neighbour its own side gave it.
  const result = engine.buildResult(plan);
  assert.deepEqual(list(result.order), ['intro', 'goals', 'metrics', 'risks', 'budget']);
});

test('11. order changes: one-sided reorder applies, a two-sided one conflicts', () => {
  const { state, engine } = loadState();
  seed(state);

  const oneSided = diverge(state, {
    onBranch: s => s.applyEdit([{ ...section('metrics', 'metrics base'), position: { type: 'start' } }], [], ['moved']),
  });
  const orderItem = engine.findItem(oneSided.plan, engine.ORDER_ITEM_ID);
  assert.ok(orderItem, 'the reorder is reported');
  assert.equal(orderItem.status, engine.ITEM_STATUS.COMPATIBLE);
  assert.deepEqual(list(engine.buildResult(oneSided.plan).order), ['metrics', 'intro', 'goals']);

  const twoSided = diverge(state, {
    branchName: 'Branch B',
    onBranch: s => s.applyEdit([{ ...section('metrics', 'metrics base'), position: { type: 'start' } }], [], ['moved on branch']),
    onMain: s => s.applyEdit([{ ...section('goals', 'goals base'), position: { type: 'start' } }], [], ['moved on main']),
  });
  const conflictItem = engine.findItem(twoSided.plan, engine.ORDER_ITEM_ID);
  assert.equal(conflictItem.status, engine.ITEM_STATUS.CONFLICT);
  assert.equal(twoSided.plan.canApply, false);

  engine.resolve(twoSided.plan, engine.ORDER_ITEM_ID, engine.RESOLUTIONS.SOURCE);
  assert.deepEqual(list(engine.buildResult(twoSided.plan).order), ['metrics', 'intro', 'goals']);
  engine.resolve(twoSided.plan, engine.ORDER_ITEM_ID, engine.RESOLUTIONS.TARGET);
  assert.deepEqual(list(engine.buildResult(twoSided.plan).order), ['goals', 'intro', 'metrics']);
});

// ── Combination (§33.12–§33.14) ──────────────────────────────────

test('12-14. a combination only counts once it is accepted', () => {
  const { state, engine } = loadState();
  seed(state);

  const { plan } = diverge(state, {
    onBranch: s => s.applyEdit([section('goals', 'branch goals')], [], ['b']),
    onMain: s => s.applyEdit([section('goals', 'main goals')], [], ['m']),
  });

  // A proposal that is not accepted changes nothing (rejected combination).
  assert.equal(plan.canApply, false);
  assert.equal(engine.resolve(plan, 'goals', engine.RESOLUTIONS.COMBINED, {}), null, 'no body, no resolution');
  assert.equal(plan.canApply, false);
  assert.equal(engine.buildResult(plan), null);

  // Accepting it puts exactly that text into the result.
  engine.resolve(plan, 'goals', engine.RESOLUTIONS.COMBINED, {
    combined: { title: 'GOALS', content: 'main goals, extended with the branch angle' },
  });
  assert.equal(plan.canApply, true);
  assert.equal(
    engine.buildResult(plan).sections.find(s => s.id === 'goals').content,
    'main goals, extended with the branch angle'
  );

  // Switching back to a plain resolution drops the combination.
  engine.resolve(plan, 'goals', engine.RESOLUTIONS.TARGET);
  assert.equal(engine.findItem(plan, 'goals').combined, null);
});

// ── Applying (§33.15–§33.20) ─────────────────────────────────────

test('15-18. applying a merge creates a new main state and writes the merge to the log', () => {
  const { state, log, engine } = loadState();
  seed(state);

  const { branch, plan } = diverge(state, {
    onBranch: s => s.applyEdit([section('metrics', 'vibration metrics')], [], ['b']),
    onMain: s => s.applyEdit([section('intro', 'main intro v2')], [], ['m']),
  });

  const seqBefore = state.lastActionSeq;
  const mainVersionsBefore = state.uiMessages[state.lastAIIndex].versions.length;

  const outcome = state.applyMerge(plan);

  assert.equal(outcome.ok, true);
  assert.equal(state.branchId, 'main', 'the merge leaves the user on the target branch');
  assert.deepEqual(list(outcome.appliedSectionIds), ['metrics']);

  // 15. New state on main, both changes present.
  assert.equal(bodyOf(state, 'metrics'), 'vibration metrics');
  assert.equal(bodyOf(state, 'intro'), 'main intro v2');

  // 16. The pre-merge state is still there and still restorable.
  const message = state.uiMessages[state.lastAIIndex];
  assert.equal(message.versions.length, mainVersionsBefore + 1);
  const previous = message.versions[message.versions.length - 2];
  assert.equal(previous.sections.find(s => s.id === 'metrics').content, 'metrics base');
  assert.equal(state.restoreVersion(state.lastAIIndex, message.versions.length - 2), true);
  assert.equal(bodyOf(state, 'metrics'), 'metrics base');
  state.restoreVersion(state.lastAIIndex, message.versions.length - 1);
  assert.equal(bodyOf(state, 'metrics'), 'vibration metrics');

  // 17. The branch survives as merged, with its own actions intact.
  const merged = state.getBranch(branch.id);
  assert.equal(merged.status, log.BRANCH_STATUSES.MERGED);
  assert.equal(merged.mergedIntoBranchId, 'main');
  assert.ok(merged.mergedAtMs > 0);
  assert.ok(state.getActionsByBranch(branch.id).length >= 2, 'branch history is not deleted');

  // A merge collapses two nodes into one, so the source has no node left to
  // stand on. It survives in the log and in the tree, not on the map.
  assert.equal(state.getVisibleBranches().length, 1, 'a merged branch leaves the map');
  assert.ok(state.getBranchTree()[0].children.some(node => node.branch.id === branch.id),
    'the tree still knows where it hung');

  // 18. The log gained the merge, in one workspace sequence, append-only.
  const added = state.getActionsAfter(seqBefore);
  const types = list(added, action => action.type);
  assert.ok(types.includes(log.ACTION_TYPES.MERGE_STARTED));
  assert.ok(types.includes(log.ACTION_TYPES.MERGE_COMPLETED));
  assert.ok(types.includes(log.ACTION_TYPES.BRANCH_MERGED));
  assert.ok(!types.includes(log.ACTION_TYPES.MERGE_CONFLICT), 'no conflicts in this merge');

  const completed = added.find(action => action.type === log.ACTION_TYPES.MERGE_COMPLETED);
  assert.equal(completed.branchId, 'main');
  assert.equal(completed.payload.sourceBranchId, branch.id);
  assert.deepEqual(list(completed.payload.appliedSectionIds), ['metrics']);
  assert.ok(completed.payload.delta.touchedSectionIds.includes('metrics'));
  assert.equal(completed.payload.contextMerge, 'not-applied', 'the boundary is recorded, not faked');

  const branchMerged = added.find(action => action.type === log.ACTION_TYPES.BRANCH_MERGED);
  assert.equal(branchMerged.branchId, branch.id);

  // A second merge of the same branch has nothing left to carry.
  const again = state.planMerge(branch.id, 'main');
  assert.equal(again.hasChanges, false);
  assert.equal(again.alreadyMerged, true);
});

test('19. a resolved conflict is recorded and the map data reflects the merge', () => {
  const { state, log, engine } = loadState();
  seed(state);

  const { branch, plan } = diverge(state, {
    onBranch: s => s.applyEdit([section('goals', 'branch goals')], [], ['b']),
    onMain: s => s.applyEdit([section('goals', 'main goals')], [], ['m']),
  });

  engine.resolve(plan, 'goals', engine.RESOLUTIONS.COMBINED, {
    combined: { title: 'GOALS', content: 'combined goals' },
  });

  const outcome = state.applyMerge(plan);
  assert.equal(outcome.ok, true);
  assert.equal(outcome.conflictCount, 1);
  assert.equal(bodyOf(state, 'goals'), 'combined goals');

  const conflictAction = state.getActions().find(action => action.type === log.ACTION_TYPES.MERGE_CONFLICT);
  assert.ok(conflictAction, 'the resolved conflict is in the log');
  assert.deepEqual(list(conflictAction.payload.sectionIds), ['goals']);
  assert.equal(conflictAction.payload.resolutions[0].resolution, 'combined');

  // Map data: the branch is still a child node of main, flagged as merged.
  const tree = state.getBranchTree();
  const child = tree[0].children.find(node => node.branch.id === branch.id);
  assert.ok(child, 'the merged branch stays in the tree');
  assert.equal(child.branch.status, log.BRANCH_STATUSES.MERGED);
  assert.equal(state.getBranchDivergence(branch.id).changedSectionCount, 0, 'nothing left unmerged');
});

test('20. the merged result survives save and reload', () => {
  const { state, log } = loadState();
  seed(state);

  const { branch, plan } = diverge(state, {
    onBranch: s => s.applyEdit([section('metrics', 'vibration metrics')], [], ['b']),
  });
  assert.equal(state.applyMerge(plan).ok, true);
  state.saveSession();

  const sessionId = state.sessionId;
  const seqAfterMerge = state.lastActionSeq;

  state.reset();
  state.loadSession(state.getSession(sessionId));

  assert.equal(state.branchId, 'main');
  assert.equal(bodyOf(state, 'metrics'), 'vibration metrics');
  assert.equal(state.getBranch(branch.id).status, log.BRANCH_STATUSES.MERGED);
  assert.equal(state.getBranch(branch.id).mergedIntoBranchId, 'main');
  assert.equal(state.lastActionSeq, seqAfterMerge, 'the sequence continues where it stopped');
  assert.equal(state.planMerge(branch.id, 'main').hasChanges, false);
});

// ── Guards ───────────────────────────────────────────────────────

test('an unresolved plan is refused and changes nothing', () => {
  const { state } = loadState();
  seed(state);

  const { plan } = diverge(state, {
    onBranch: s => s.applyEdit([section('goals', 'branch goals')], [], ['b']),
    onMain: s => s.applyEdit([section('goals', 'main goals')], [], ['m']),
  });

  const seqBefore = state.lastActionSeq;
  const outcome = state.applyMerge(plan);

  assert.equal(outcome.ok, false);
  assert.equal(outcome.reason, 'unresolved');
  assert.equal(bodyOf(state, 'goals'), 'main goals', 'main is untouched');
  assert.equal(state.lastActionSeq, seqBefore, 'a refused merge writes nothing to the log');
});

test('planning is read-only: previewing a merge never changes a document', () => {
  const { state, engine } = loadState();
  seed(state);

  const { plan } = diverge(state, {
    onBranch: s => s.applyEdit([section('metrics', 'branch metrics')], [], ['b']),
  });

  const seqBefore = state.lastActionSeq;
  engine.buildResult(plan);
  state.analyzeMerge(plan.sourceBranchId, 'main');

  assert.equal(bodyOf(state, 'metrics'), 'metrics base');
  assert.deepEqual(orderOf(state), ['intro', 'goals', 'metrics']);
  assert.equal(state.lastActionSeq, seqBefore);
});

test('a branch of a branch merges into its own parent by default', () => {
  const { state } = loadState();
  seed(state);

  const first = state.createBranch('First');
  state.applyEdit([section('goals', 'first goals')], [], ['b1']);
  const second = state.createBranch('Second');
  state.applyEdit([section('metrics', 'second metrics')], [], ['b2']);

  const plan = state.planMerge(second.id);
  assert.equal(plan.targetBranchId, first.id, 'the default target is the parent, not main');
  assert.deepEqual(list(plan.items, item => item.id), ['metrics']);

  assert.equal(state.applyMerge(plan).ok, true);
  assert.equal(state.branchId, first.id);
  assert.equal(bodyOf(state, 'metrics'), 'second metrics');
  assert.equal(bodyOf(state, 'goals'), 'first goals');
});
