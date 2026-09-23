const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');
const vm = require('node:vm');

const projectRoot = path.resolve(__dirname, '..');
const readScript = rel => fs.readFileSync(path.join(projectRoot, rel), 'utf8');

/**
 * The shape of a workspace, and the two operations that change it.
 *
 * One rule holds the whole thing together: a node is one continuous run of
 * writing, so the moment something branches off it, it stops being written to.
 * Its document is the base every child measured itself against — move it and
 * every child inherits conflicts nobody caused.
 *
 * Everything else follows. All children of a node share one base, so siblings
 * can be compared honestly (the only place a conflict can exist). A branch is
 * its parent's track continued, so merging into the parent compares nothing at
 * all — it removes a boundary. And since a merged branch is absorbed, it leaves
 * the map instead of sitting there wearing a badge.
 */

function createMemoryStorage() {
  const map = new Map();
  return {
    getItem: key => (map.has(key) ? map.get(key) : null),
    setItem: (key, value) => { map.set(key, String(value)); },
    removeItem: key => { map.delete(key); },
  };
}

function loadState() {
  const storage = createMemoryStorage();
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
  return { state, log: context.HectraActionLog, engine: context.HectraMergeEngine };
}

const section = (id, content = `${id} content`) => ({ id, title: id.toUpperCase(), content, position: null });
// Array.from, not .map: values cross a vm realm boundary and a foreign array is
// never deep-equal to a native one.
const names = branches => Array.from(branches, branch => branch.name).sort();
const bodyOf = (state, id) => state.documentSections.get(id).content;

function seed(state) {
  state.addUserMessage('build a plan');
  state.addAIMessage('raw', [section('intro'), section('goals'), section('metrics')], ['created']);
}

/** Two branches off main, each having changed one section. */
function twoSiblings(state) {
  const first = state.createBranch('tone');
  state.applyEdit([section('goals', 'tone goals')], [], ['b1']);
  state.switchBranch('main');

  const second = state.createBranch('scope');
  state.applyEdit([section('metrics', 'scope metrics')], [], ['b2']);
  return { first, second };
}

// ── Where writing is allowed ─────────────────────────────────────

test('a node is closed to writing as soon as something branches off it', () => {
  const { state } = loadState();
  seed(state);

  assert.equal(state.canWriteToBranch('main').allowed, true, 'a leaf takes writing');

  const branch = state.createBranch('tone');
  const main = state.canWriteToBranch('main');
  assert.equal(main.allowed, false);
  assert.equal(main.code, 'has-branches');
  assert.deepEqual(names(main.children), ['tone']);
  assert.match(main.reason, /tone/, 'the reason names what branched off');

  assert.equal(state.canWriteToBranch(branch.id).allowed, true, 'the branch itself is a leaf');
});

test('a node becomes writable again once its branches have collapsed back', () => {
  const { state } = loadState();
  seed(state);

  const branch = state.createBranch('tone');
  assert.equal(state.canWriteToBranch('main').allowed, false);

  state.collapseIntoParent(branch.id);
  assert.equal(state.canWriteToBranch('main').allowed, true, 'nothing hangs off main any more');
});

test('archived and merged branches do not hold a node closed', () => {
  const { state } = loadState();
  seed(state);

  const branch = state.createBranch('tone');
  state.archiveBranch(branch.id);

  assert.equal(state.canWriteToBranch('main').allowed, true);
  assert.equal(state.isBranchLeaf('main'), true);
});

// ── What may merge with what ─────────────────────────────────────

test('siblings can merge with each other, cousins cannot', () => {
  const { state } = loadState();
  seed(state);

  const { first, second } = twoSiblings(state);
  assert.deepEqual(names(state.getSiblingMergeCandidates(first.id)), ['scope']);
  assert.deepEqual(names(state.getSiblingMergeCandidates(second.id)), ['tone']);

  // A branch of a branch shares no base with anything under the other parent.
  state.switchBranch(first.id);
  const nested = state.createBranch('nested');
  assert.deepEqual(names(state.getSiblingMergeCandidates(nested.id)), [],
    'a lone child has nobody at its own fork point');
  assert.deepEqual(names(state.getSiblingMergeCandidates(second.id)), [],
    'its sibling is no longer a leaf, so it is somebody’s base');
});

test('a branch with branches of its own cannot be merged away', () => {
  const { state, engine } = loadState();
  seed(state);

  const parent = state.createBranch('tone');
  state.applyEdit([section('goals', 'tone goals')], [], ['b1']);
  const child = state.createBranch('nested');

  state.switchBranch('main');
  const plan = state.planMerge(parent.id, 'main');
  const outcome = state.applyMerge(plan);

  assert.equal(outcome.ok, false);
  assert.equal(outcome.reason, 'source-has-branches');
  assert.equal(bodyOf(state, 'goals'), 'goals content', 'main is untouched');
  assert.equal(state.getBranch(child.id).status, 'open');
});

test('merging a sibling collapses it into the survivor and leaves a note behind', () => {
  const { state } = loadState();
  seed(state);

  const { first, second } = twoSiblings(state);
  const plan = state.planMerge(first.id, second.id);
  assert.equal(plan.targetBranchId, second.id);

  const outcome = state.applyMerge(plan);
  assert.equal(outcome.ok, true);
  assert.equal(state.branchId, second.id, 'the survivor is where the user ends up');

  // One node holds both explorations now.
  assert.equal(bodyOf(state, 'goals'), 'tone goals');
  assert.equal(bodyOf(state, 'metrics'), 'scope metrics');
  assert.deepEqual(names(state.getVisibleBranches()), ['main', 'scope']);

  // The conversation never asked for "goals", so the next instruction says so.
  const notes = state.takeBranchNotes(second.id);
  assert.equal(notes.length, 1);
  assert.match(notes[0], /GOALS/);
  assert.match(notes[0], /tone/);
  assert.deepEqual(Array.from(state.takeBranchNotes(second.id)), [], 'the note is said once');
});

// ── Merging with the ancestor ────────────────────────────────────

test('an only child dissolves into its ancestor: one chat, one name', () => {
  const { state, log } = loadState();
  seed(state);

  const branch = state.createBranch('tone');
  state.applyEdit([section('goals', 'tone goals')], [], ['b1']);
  const messagesOnBranch = state.uiMessages.length;

  const check = state.canCollapseIntoParent(branch.id);
  assert.equal(check.allowed, true);
  assert.equal(check.code, 'only-child');
  assert.equal(check.mergedName, 'main & tone');

  const result = state.collapseIntoParent(branch.id);
  assert.equal(result.name, 'main & tone');
  assert.equal(state.branchId, 'main', 'the surviving node is the ancestor');
  assert.equal(state.getBranch('main').name, 'main & tone');
  assert.equal(bodyOf(state, 'goals'), 'tone goals', 'the branch’s work is simply kept');
  assert.equal(state.uiMessages.length, messagesOnBranch, 'and so is its conversation');
  assert.deepEqual(names(state.getVisibleBranches()), ['main & tone']);

  const collapsed = state.getActions().find(action => action.type === log.ACTION_TYPES.BRANCH_COLLAPSED);
  assert.ok(collapsed, 'the log records that a boundary was removed');
  assert.equal(collapsed.payload.previousName, 'main');
  assert.equal(collapsed.payload.childName, 'tone');
});

test('branches taken off the child move up to the surviving node', () => {
  const { state } = loadState();
  seed(state);

  const child = state.createBranch('tone');
  state.applyEdit([section('goals', 'tone goals')], [], ['b1']);
  const grandchild = state.createBranch('nested');
  state.switchBranch(child.id);

  state.collapseIntoParent(child.id);

  assert.equal(state.getBranch(grandchild.id).parentBranchId, 'main');
  assert.deepEqual(names(state.getChildBranches('main')), ['nested']);
  assert.equal(state.canWriteToBranch('main').allowed, false, 'it still has a branch hanging off it');
});

test('an ancestor with several branches is not collapsed by accident', () => {
  const { state } = loadState();
  seed(state);

  const { first, second } = twoSiblings(state);
  const check = state.canCollapseIntoParent(first.id);

  assert.equal(check.allowed, false);
  assert.equal(check.code, 'has-siblings');
  assert.equal(check.abandonedCount, 1);
  assert.deepEqual(names(check.siblings), ['scope']);
  assert.equal(state.collapseIntoParent(first.id), null, 'refused without an explicit choice');
  assert.deepEqual(names(state.getVisibleBranches()), ['main', 'scope', 'tone']);
});

test('giving up the alternatives archives them, never destroys them', () => {
  const { state } = loadState();
  seed(state);

  const { first, second } = twoSiblings(state);
  state.switchBranch(second.id);
  const nested = state.createBranch('nested');   // a whole subtree hangs off the sibling
  state.switchBranch(first.id);

  const result = state.collapseIntoParent(first.id, { adopt: true });

  assert.equal(result.name, 'main & tone');
  assert.deepEqual(Array.from(result.abandoned, entry => entry.name).sort(), ['nested', 'scope'],
    'the whole subtree is given up, not just the sibling');
  assert.equal(state.getBranch(second.id).status, 'archived');
  assert.equal(state.getBranch(nested.id).status, 'archived');
  assert.ok(state.getActionsByBranch(second.id).length >= 1, 'their history stays in the log');
  assert.deepEqual(names(state.getVisibleBranches()), ['main & tone']);
});

test('nobody is left standing on a branch that was just given up', () => {
  const { state } = loadState();
  seed(state);

  const { first, second } = twoSiblings(state);
  state.switchBranch(second.id);                 // standing on the one about to go

  const result = state.collapseIntoParent(first.id, { adopt: true });

  assert.equal(result.name, 'main & tone');
  assert.equal(state.getBranch(second.id).status, 'archived');
  assert.equal(state.branchId, 'main', 'the user was moved to the surviving node');
  assert.equal(bodyOf(state, 'goals'), 'tone goals', 'and sees its document, not the archived one');
});

test('the root has no ancestor to merge into', () => {
  const { state } = loadState();
  seed(state);

  const check = state.canCollapseIntoParent('main');
  assert.equal(check.allowed, false);
  assert.equal(check.code, 'root');
  assert.equal(state.collapseIntoParent('main'), null);
});

// ── After a collapse, the workspace still reloads ────────────────

test('a collapsed workspace survives save and reload', () => {
  const { state } = loadState();
  seed(state);

  const branch = state.createBranch('tone');
  state.applyEdit([section('goals', 'tone goals')], [], ['b1']);
  state.collapseIntoParent(branch.id);
  state.saveSession();

  const sessionId = state.sessionId;
  state.reset();
  state.loadSession(state.getSession(sessionId));

  assert.equal(state.branchId, 'main');
  assert.equal(state.getBranch('main').name, 'main & tone');
  assert.equal(bodyOf(state, 'goals'), 'tone goals');
  assert.deepEqual(names(state.getVisibleBranches()), ['main & tone']);
  assert.equal(state.canWriteToBranch('main').allowed, true, 'the surviving node is writable again');
});
