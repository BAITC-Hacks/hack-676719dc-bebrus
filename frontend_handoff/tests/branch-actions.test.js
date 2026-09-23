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
  return { state, storage, log: context.HectraActionLog };
}

const list = (values, mapper = v => v) => Array.from(values, mapper);
const section = (id, content = `${id} content`) => ({ id, title: id.toUpperCase(), content, position: null });

function seedDocument(state) {
  state.addUserMessage('build a plan');
  state.addAIMessage('raw', [section('intro'), section('goals'), section('metrics')], ['created']);
}

/**
 * Two full exchanges — messages 0/1 and 2/3. Each chat turn adds its own
 * assistant message, and each assistant message carries its own document
 * snapshot; an edit would instead add a version to the message it targets.
 */
function seedTwoExchanges(state) {
  state.addUserMessage('write a plan');
  state.addAIMessage('raw', [section('intro'), section('goals')], ['created']);
  state.addUserMessage('add metrics');
  state.addAIMessage('raw 2', [section('intro'), section('goals', 'goals v2'), section('metrics')], ['created']);
}

// ── Branching from a message (§31) ───────────────────────────────

test('branching from a user message forks the state as it was at that message', () => {
  const { state, log } = loadState();
  seedTwoExchanges(state);
  const forkAction = state.getActions()
    .find(action => action.type === log.ACTION_TYPES.USER_MESSAGE && action.payload.messageIndex === 0);

  const branch = state.createBranch('From the first request', { fromMessageIndex: 0 });

  assert.ok(branch);
  assert.equal(branch.forkMessageIndex, 0);
  assert.equal(branch.parentBranchId, 'main');
  assert.equal(branch.forkActionSeq, forkAction.actionSeq, 'causality points at that message, not at the head');

  // Only the messages up to the fork came along, and the document is empty
  // because no response existed at that point yet.
  assert.equal(state.branchId, branch.id);
  assert.equal(state.uiMessages.length, 1);
  assert.equal(state.uiMessages[0].type, 'user');
  assert.deepEqual(list(state.sectionOrder), []);

  // main is untouched.
  state.switchBranch('main');
  assert.equal(state.uiMessages.length, 4);
  assert.deepEqual(list(state.sectionOrder), ['intro', 'goals', 'metrics']);
});

test('branching from an AI message carries that response and its document', () => {
  const { state, log } = loadState();
  seedTwoExchanges(state);

  const branch = state.createBranch(null, { fromMessageIndex: 1 });

  assert.equal(branch.forkMessageIndex, 1);
  assert.equal(state.uiMessages.length, 2, 'the later exchange stays on main');
  assert.deepEqual(list(state.sectionOrder), ['intro', 'goals'], 'the document as it was at that response');
  assert.equal(state.documentSections.get('goals').content, 'goals content', 'not the later version');

  // The fork inherits the document, not the parent's later version stack.
  const message = state.uiMessages[state.lastAIIndex];
  assert.equal(message.versions.length, 1);
  assert.equal(message.currentVersionIndex, 0);

  const created = state.getLatestAction();
  assert.equal(created.type, log.ACTION_TYPES.BRANCH_CREATED);
  assert.equal(created.payload.forkMessageIndex, 1);
  assert.equal(created.payload.sectionCount, 2);

  // Editing on the branch does not touch main.
  state.applyEdit([section('goals', 'branch goals')], [], ['b']);
  state.switchBranch('main');
  assert.equal(state.documentSections.get('goals').content, 'goals v2');
});

test('branching from a response takes the version the reader is looking at', () => {
  const { state } = loadState();
  state.addUserMessage('write a plan');
  state.addAIMessage('raw', [section('intro'), section('goals')], ['created']);
  state.applyEdit([section('goals', 'goals v2')], [], ['updated']);

  // Browsing back to the first version and branching from there forks what is
  // on screen, not the newest version.
  state.restoreVersion(state.lastAIIndex, 0);
  const branch = state.createBranch('From the earlier version', { fromMessageIndex: state.lastAIIndex });

  assert.equal(state.documentSections.get('goals').content, 'goals content');
  assert.equal(state.uiMessages[state.lastAIIndex].versions.length, 1, 'the fork starts with one version');

  state.switchBranch('main');
  assert.equal(state.getBranchDocument(branch.id).sections.find(s => s.id === 'goals').content, 'goals content');
});

test('a branch cannot be forked from a message that does not exist', () => {
  const { state } = loadState();
  seedTwoExchanges(state);
  const seqBefore = state.lastActionSeq;

  assert.equal(state.createBranch('Nope', { fromMessageIndex: 99 }), null);
  assert.equal(state.createBranch('Nope', { fromMessageIndex: -1 }), null);
  assert.deepEqual(list(state.getBranches(), branch => branch.id), ['main'], 'no half-created branch');
  assert.equal(state.lastActionSeq, seqBefore, 'nothing was logged');
});

test('a branch forked from a message survives save and reload', () => {
  const { state } = loadState();
  seedTwoExchanges(state);
  const branch = state.createBranch('Early fork', { fromMessageIndex: 1 });
  state.applyEdit([section('goals', 'branch goals')], [], ['b']);
  state.saveSession();

  const sessionId = state.sessionId;
  state.reset();
  state.loadSession(state.getSession(sessionId));

  const restored = state.getBranch(branch.id);
  assert.equal(restored.forkMessageIndex, 1);
  assert.equal(restored.parentBranchId, 'main');
  assert.equal(state.branchId, branch.id, 'the active branch comes back');
  assert.equal(state.documentSections.get('goals').content, 'branch goals');
  assert.equal(state.getBranchDocument('main').sections.find(s => s.id === 'goals').content, 'goals v2');
});

// ── Exploring sections (§31.3–4) ─────────────────────────────────

test('exploring one section names the branch after it', () => {
  const { state } = loadState();
  seedDocument(state);

  const branch = state.createBranch(null, { fromSectionIds: ['metrics'], fromSectionId: 'metrics' });

  assert.equal(branch.name, 'METRICS');
  assert.deepEqual(list(branch.forkSectionIds), ['metrics']);
  assert.equal(branch.forkSectionId, 'metrics');
});

test('exploring several sections records all of them on the branch', () => {
  const { state } = loadState();
  seedDocument(state);

  const branch = state.createBranch(null, { fromSectionIds: ['goals', 'metrics'], fromSectionId: 'goals' });

  assert.deepEqual(list(branch.forkSectionIds), ['goals', 'metrics']);
  assert.equal(branch.name, 'GOALS +1', 'the suggested name says how many');
  assert.equal(state.getLatestAction().payload.forkSectionIds.length, 2);

  // It appears in the map data as a child of main.
  const tree = state.getBranchTree();
  assert.equal(tree[0].children[0].branch.id, branch.id);
});

// ── Safe deletion (§32) ──────────────────────────────────────────

test('main can never be deleted', () => {
  const { state } = loadState();
  seedDocument(state);

  const check = state.canDeleteBranch('main');
  assert.equal(check.allowed, false);
  assert.equal(check.code, 'root');
  assert.equal(state.deleteBranch('main'), null);
  assert.equal(state.getBranch('main').status, 'open');
});

test('a leaf branch can be deleted and leaves its history behind', () => {
  const { state, log } = loadState();
  seedDocument(state);

  const branch = state.createBranch('Leaf');
  state.applyEdit([section('metrics', 'branch metrics')], [], ['b']);
  const actionsBefore = state.getActionsByBranch(branch.id).length;

  const check = state.canDeleteBranch(branch.id);
  assert.equal(check.allowed, true);
  assert.equal(check.hasUnmergedChanges, true, 'unmerged work is flagged for the warning');

  const deleted = state.deleteBranch(branch.id);
  assert.equal(deleted.status, log.BRANCH_STATUSES.DELETED);
  assert.ok(deleted.deletedAtMs > 0);

  // Gone from the normal UI, still in the graph and in the log.
  assert.deepEqual(list(state.getVisibleBranches(), item => item.id), ['main']);
  assert.equal(state.branchId, 'main', 'the UI never stays on a deleted branch');
  assert.equal(state.getActionsByBranch(branch.id).length, actionsBefore + 1, 'the deletion is appended, nothing is removed');
  assert.equal(state.getLatestAction().type, log.ACTION_TYPES.BRANCH_DELETED);
  assert.equal(state.getLatestAction().payload.hadUnmergedChanges, true);
  assert.equal(state.switchBranch(branch.id), false, 'a deleted branch cannot be reopened');
});

test('a branch between an ancestor and a living descendant cannot be deleted', () => {
  const { state } = loadState();
  seedDocument(state);

  const b = state.createBranch('B');          // main → B
  const c = state.createBranch('C');          // main → B → C

  const check = state.canDeleteBranch(b.id);
  assert.equal(check.allowed, false);
  assert.equal(check.code, 'has-children');
  assert.match(check.reason, /child branch/i);
  assert.equal(state.deleteBranch(b.id), null);
  assert.equal(state.getBranch(b.id).status, 'open');

  // Deleting the leaf first unblocks the parent.
  state.switchBranch('main');
  assert.equal(state.deleteBranch(c.id).status, 'deleted');
  assert.equal(state.canDeleteBranch(b.id).allowed, true);
  assert.equal(state.deleteBranch(b.id).status, 'deleted');
});

test('a branch with several children cannot be deleted either', () => {
  const { state } = loadState();
  seedDocument(state);

  const b = state.createBranch('B');
  const c = state.createBranch('C');
  state.switchBranch(b.id);
  const d = state.createBranch('D');

  const check = state.canDeleteBranch(b.id);
  assert.equal(check.allowed, false);
  assert.equal(check.childCount, 2);
  assert.deepEqual(
    list(state.getBranches().filter(branch => branch.parentBranchId === b.id), branch => branch.id).sort(),
    [c.id, d.id].sort()
  );
});

test('an archived child still protects its parent from deletion', () => {
  const { state } = loadState();
  seedDocument(state);

  const b = state.createBranch('B');
  const c = state.createBranch('C');
  state.archiveBranch(c.id);

  assert.equal(state.getBranch(c.id).status, 'archived');
  assert.equal(state.canDeleteBranch(b.id).allowed, false, 'an archived branch is still a descendant');
});

test('a deleted branch stays out of the UI after reload but keeps its state', () => {
  const { state } = loadState();
  seedDocument(state);

  const branch = state.createBranch('Leaf');
  state.applyEdit([section('metrics', 'branch metrics')], [], ['b']);
  state.switchBranch('main');
  state.deleteBranch(branch.id);
  state.saveSession();

  const sessionId = state.sessionId;
  state.reset();
  state.loadSession(state.getSession(sessionId));

  assert.deepEqual(list(state.getVisibleBranches(), item => item.id), ['main']);
  assert.equal(state.getBranch(branch.id).status, 'deleted');
  assert.equal(
    state.getBranchDocument(branch.id).sections.find(item => item.id === 'metrics').content,
    'branch metrics',
    'the state is kept for provenance'
  );
});

test('deleting the active branch moves the user to its parent', () => {
  const { state, log } = loadState();
  seedDocument(state);

  const parent = state.createBranch('Parent');
  const child = state.createBranch('Child');
  assert.equal(state.branchId, child.id);

  state.deleteBranch(child.id);

  assert.equal(state.branchId, parent.id, 'back to the parent, not to main');
  const switched = state.getActions().reverse()
    .find(action => action.type === log.ACTION_TYPES.BRANCH_SWITCHED);
  assert.equal(switched.payload.toBranchId, parent.id, 'the move is a real logged event');
});
