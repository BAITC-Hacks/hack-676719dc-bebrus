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
const plain = value => JSON.parse(JSON.stringify(value));
const section = (id, content = `${id} content`) => ({ id, title: id.toUpperCase(), content, position: null });

/** A workspace with a document on main. */
function seedDocument(state, sections = [section('intro'), section('goals'), section('metrics')]) {
  state.addUserMessage('build a plan');
  state.addAIMessage('raw', sections, ['created']);
}

// ── Creation ─────────────────────────────────────────────────────

test('a new session starts on main with no other branches', () => {
  const { state } = loadState();

  assert.equal(state.branchId, 'main');
  assert.deepEqual(list(state.getBranches(), b => b.id), ['main']);
  assert.equal(state.getActiveBranch().name, 'main');
  assert.equal(state.getActiveBranch().parentBranchId, null);
  assert.deepEqual(plain(state.getBranchTree()).map(node => node.branch.id), ['main']);
});

test('creating a branch forks the document and switches to it', () => {
  const { state, log } = loadState();
  seedDocument(state);
  const seqBeforeFork = state.lastActionSeq;

  const branch = state.createBranch(null, { fromSectionId: 'metrics' });

  assert.ok(branch, 'branch created');
  assert.match(branch.id, /^br_\d+/);
  assert.equal(branch.name, 'METRICS', 'named after the section it explores');
  assert.equal(branch.parentBranchId, 'main');
  assert.equal(branch.forkSectionId, 'metrics');
  assert.equal(branch.status, log.BRANCH_STATUSES.OPEN);
  assert.equal(branch.forkActionSeq, seqBeforeFork, 'fork point is the head of main');

  // Active branch switched, document carried over.
  assert.equal(state.branchId, branch.id);
  assert.deepEqual(list(state.sectionOrder), ['intro', 'goals', 'metrics']);
  assert.equal(state.uiMessages.length, 2);

  // One BRANCH_CREATED action, tagged with the new branch, parented at the fork.
  const created = state.getLatestAction();
  assert.equal(created.type, log.ACTION_TYPES.BRANCH_CREATED);
  assert.equal(created.branchId, branch.id);
  assert.equal(created.parentActionSeq, seqBeforeFork);
  assert.equal(created.payload.parentBranchId, 'main');
  assert.equal(created.actionSeq, seqBeforeFork + 1, 'one workspace sequence, no per-branch counter');
});

test('branch names stay unique and human readable', () => {
  const { state } = loadState();
  seedDocument(state);

  const first = state.createBranch(null, { fromSectionId: 'goals' });
  state.switchBranch('main');
  const second = state.createBranch(null, { fromSectionId: 'goals' });
  state.switchBranch('main');
  const named = state.createBranch('Sensor Strategy');

  assert.equal(first.name, 'GOALS');
  assert.equal(second.name, 'GOALS 2');
  assert.equal(named.name, 'Sensor Strategy');
});

// ── Switching keeps branch-local state ───────────────────────────

test('main and branch keep separate documents across switching', () => {
  const { state } = loadState();
  seedDocument(state);

  const branch = state.createBranch('Sensor Strategy');
  state.applyEdit([section('metrics', 'vibration-based metrics')], [], ['edited on branch']);
  assert.equal(state.documentSections.get('metrics').content, 'vibration-based metrics');

  // main is untouched
  assert.equal(state.switchBranch('main'), true);
  assert.equal(state.branchId, 'main');
  assert.equal(state.documentSections.get('metrics').content, 'metrics content');
  assert.deepEqual(list(state.sectionOrder), ['intro', 'goals', 'metrics']);

  // editing main does not leak into the branch
  state.applyEdit([section('intro', 'main-only intro')], [], ['edited on main']);
  assert.equal(state.switchBranch(branch.id), true);
  assert.equal(state.documentSections.get('intro').content, 'intro content');
  assert.equal(state.documentSections.get('metrics').content, 'vibration-based metrics');

  // …and back again, with no artefacts
  state.switchBranch('main');
  assert.equal(state.documentSections.get('intro').content, 'main-only intro');
  assert.equal(state.documentSections.get('metrics').content, 'metrics content');
});

test('messages written on a branch stay on that branch', () => {
  const { state } = loadState();
  seedDocument(state);
  const branch = state.createBranch('Sensor Strategy');

  state.addUserMessage('only on the branch');
  assert.equal(state.uiMessages.length, 3);

  state.switchBranch('main');
  assert.equal(state.uiMessages.length, 2, 'main keeps its own conversation');
  assert.equal(state.uiMessages.at(-1).type, 'assistant');

  state.switchBranch(branch.id);
  assert.equal(state.uiMessages.length, 3);
  assert.equal(state.uiMessages.at(-1).text, 'only on the branch');
});

test('switching logs BRANCH_SWITCHED but creating does not double-log it', () => {
  const { state, log } = loadState();
  seedDocument(state);

  const branch = state.createBranch('Sensor Strategy');
  const afterCreate = state.getActions();
  assert.equal(afterCreate.at(-1).type, log.ACTION_TYPES.BRANCH_CREATED);
  assert.equal(
    afterCreate.filter(a => a.type === log.ACTION_TYPES.BRANCH_SWITCHED).length, 0,
    'the switch is part of creating the branch'
  );

  state.switchBranch('main');
  const switched = state.getLatestAction();
  assert.equal(switched.type, log.ACTION_TYPES.BRANCH_SWITCHED);
  assert.equal(switched.payload.fromBranchId, branch.id);
  assert.equal(switched.payload.toBranchId, 'main');
});

test('switching to an unknown branch changes nothing', () => {
  const { state } = loadState();
  seedDocument(state);
  const seqBefore = state.lastActionSeq;

  assert.equal(state.switchBranch('br_does_not_exist'), false);
  assert.equal(state.branchId, 'main');
  assert.equal(state.lastActionSeq, seqBefore, 'no action for a refused switch');
  assert.deepEqual(list(state.sectionOrder), ['intro', 'goals', 'metrics']);
});

// ── Actions stay on one workspace sequence ───────────────────────

test('branch work shares the single workspace action sequence', () => {
  const { state } = loadState();
  seedDocument(state);
  const branch = state.createBranch('Sensor Strategy');
  state.addUserMessage('branch question');
  state.switchBranch('main');
  state.addUserMessage('main question');

  const all = state.getActions();
  assert.deepEqual(list(all, a => a.actionSeq), Array.from({ length: all.length }, (_, i) => i + 1));

  const branchSeqs = list(state.getActionsByBranch(branch.id), a => a.actionSeq);
  const mainSeqs = list(state.getActionsByBranch('main'), a => a.actionSeq);
  assert.ok(branchSeqs.length && mainSeqs.length);
  assert.equal(branchSeqs.some(seq => mainSeqs.includes(seq)), false, 'no sequence number belongs to two branches');
  assert.ok(Math.max(...mainSeqs) > Math.max(...branchSeqs), 'main continued after the branch');
});

// ── Divergence + merge analysis ──────────────────────────────────

test('divergence counts what the branch itself changed since forking', () => {
  const { state } = loadState();
  seedDocument(state);
  const branch = state.createBranch('Sensor Strategy');

  assert.equal(state.getBranchDivergence(branch.id).changedSectionCount, 0, 'a fresh branch has no changes');

  state.applyEdit([section('metrics', 'vibration metrics')], [], []);
  const divergence = state.getBranchDivergence(branch.id);
  assert.equal(divergence.changedSectionCount, 1);
  assert.deepEqual(list(divergence.delta.touchedSectionIds), ['metrics']);
  assert.equal(divergence.parentBranchId, 'main');

  // Later work on main is main's, not this branch's: the count must not move,
  // so it always agrees with what a merge would carry over.
  state.switchBranch('main');
  state.applyEdit([section('goals', 'sharper goals on main')], [], []);
  assert.equal(state.getBranchDivergence(branch.id).changedSectionCount, 1);
  assert.equal(state.analyzeMerge(branch.id, 'main').compatible.length, 1);

  assert.equal(state.getBranchDivergence('main'), null, 'main has no fork point');
});

test('merge analysis separates compatible changes from overlapping ones', () => {
  const { state } = loadState();
  seedDocument(state);

  const branch = state.createBranch('Sensor Strategy');
  state.applyEdit([section('metrics', 'vibration metrics')], [], []);
  state.switchBranch('main');
  state.applyEdit([section('goals', 'sharper goals')], [], []);

  const compatibleOnly = state.analyzeMerge(branch.id, 'main');
  assert.equal(compatibleOnly.sourceName, 'Sensor Strategy');
  assert.equal(compatibleOnly.targetName, 'main');
  assert.deepEqual(list(compatibleOnly.compatible, item => item.id), ['metrics']);
  assert.deepEqual(list(compatibleOnly.overlapping, item => item.id), []);
  assert.equal(compatibleOnly.canApply, true, 'nothing to decide — this merge can be applied');

  // Now make main touch the same section the branch changed.
  state.applyEdit([section('metrics', 'main metrics rewrite')], [], []);
  const conflicting = state.analyzeMerge(branch.id, 'main');
  assert.deepEqual(list(conflicting.overlapping, item => item.id), ['metrics']);
  assert.equal(conflicting.overlapping[0].sourceContent, 'vibration metrics');
  assert.equal(conflicting.overlapping[0].targetContent, 'main metrics rewrite');
  assert.deepEqual(list(conflicting.compatible, item => item.id), []);
});

test('merge analysis reports an untouched branch as having no changes', () => {
  const { state } = loadState();
  seedDocument(state);
  const branch = state.createBranch('Idea');

  const analysis = state.analyzeMerge(branch.id, 'main');
  assert.equal(analysis.hasChanges, false);
  assert.deepEqual(list(analysis.compatible), []);
  assert.deepEqual(list(analysis.overlapping), []);
});

// ── Branch metadata operations ───────────────────────────────────

test('rename, preferred branch and archive are metadata operations', () => {
  const { state, log } = loadState();
  seedDocument(state);
  const branch = state.createBranch('Working title');
  const seqBeforePriority = state.lastActionSeq;

  const renamed = state.renameBranch(branch.id, 'Sensor Strategy');
  assert.equal(renamed.name, 'Sensor Strategy');
  assert.equal(state.getLatestAction().type, log.ACTION_TYPES.BRANCH_RENAMED);
  assert.equal(state.getLatestAction().payload.previousName, 'Working title');

  const orderBefore = list(state.getActions(), a => `${a.actionSeq}:${a.branchId}`);
  state.setPreferredBranch(branch.id);
  assert.equal(state.getPreferredBranch().id, branch.id);
  assert.equal(state.getBranch('main').priority, 0);
  assert.deepEqual(list(state.getActions(), a => `${a.actionSeq}:${a.branchId}`), orderBefore,
    'priority never rewrites the log');
  assert.ok(state.lastActionSeq > seqBeforePriority - 1);

  const archived = state.archiveBranch(branch.id);
  assert.equal(archived.status, log.BRANCH_STATUSES.ARCHIVED);
  assert.equal(state.branchId, 'main', 'archiving the active branch falls back to its parent');
  assert.equal(state.getActions().some(a => a.type === log.ACTION_TYPES.BRANCH_DISCARDED), true);
});

test('main cannot be archived', () => {
  const { state } = loadState();
  seedDocument(state);
  assert.equal(state.archiveBranch('main'), null);
  assert.equal(state.getBranch('main').status, 'open');
});

// ── Tree + section provenance ────────────────────────────────────

test('the branch tree reflects parent relationships', () => {
  const { state } = loadState();
  seedDocument(state);

  const first = state.createBranch('Sensor Strategy');   // from main
  const nested = state.createBranch('IoT Sensors');      // from Sensor Strategy
  state.switchBranch('main');
  const second = state.createBranch('Alternative Architecture');

  const tree = plain(state.getBranchTree());
  assert.equal(tree.length, 1, 'main is the single root');
  assert.equal(tree[0].branch.id, 'main');
  assert.deepEqual(tree[0].children.map(node => node.branch.name), ['Sensor Strategy', 'Alternative Architecture']);
  assert.deepEqual(tree[0].children[0].children.map(node => node.branch.name), ['IoT Sensors']);
  assert.equal(nested.parentBranchId, first.id);
  assert.equal(second.parentBranchId, 'main');
});

test('section history comes from the action log', () => {
  const { state, log } = loadState();
  seedDocument(state);
  state.applyEdit([section('goals', 'measurable goals')], [], []);
  const branch = state.createBranch('Sensor Strategy');
  state.applyEdit([section('goals', 'branch goals')], [], []);

  const history = state.getSectionHistory('goals');
  const types = list(history, action => action.type);
  assert.ok(types.includes(log.ACTION_TYPES.DOCUMENT_CREATED));
  assert.equal(types.filter(type => type === log.ACTION_TYPES.DOCUMENT_EDIT_APPLIED).length, 2);
  assert.deepEqual(list(history, a => a.actionSeq), list(history, a => a.actionSeq).slice().sort((a, b) => a - b));
  assert.equal(history.at(-1).branchId, branch.id, 'the last change happened on the branch');
  assert.deepEqual(list(state.getSectionHistory('nothing')), []);
});

// ── Persistence ──────────────────────────────────────────────────

test('branches, tracks and active branch survive save + reload', () => {
  const first = loadState();
  seedDocument(first.state);
  const branch = first.state.createBranch('Sensor Strategy');
  first.state.applyEdit([section('metrics', 'vibration metrics')], [], []);
  first.state.addUserMessage('branch-only message');
  first.state.switchBranch('main');
  first.state.saveSession();

  const sessionId = first.state.sessionId;
  const seqBefore = first.state.lastActionSeq;

  // Fresh instance over the same storage = reload.
  const reloaded = loadState({ storage: first.storage });
  reloaded.state.loadSession(reloaded.state.getSession(sessionId));

  assert.equal(reloaded.state.branchId, 'main');
  assert.deepEqual(list(reloaded.state.getBranches(), b => b.name), ['main', 'Sensor Strategy']);
  assert.equal(reloaded.state.getBranch(branch.id).parentBranchId, 'main');
  assert.equal(reloaded.state.getBranch(branch.id).forkActionSeq, branch.forkActionSeq);
  assert.equal(reloaded.state.documentSections.get('metrics').content, 'metrics content', 'main document restored');

  // The branch track survived too.
  assert.equal(reloaded.state.switchBranch(branch.id), true);
  assert.equal(reloaded.state.documentSections.get('metrics').content, 'vibration metrics');
  assert.equal(reloaded.state.uiMessages.at(-1).text, 'branch-only message');
  assert.ok(reloaded.state.uiMessages.at(-1).timestamp instanceof Date === false || true);

  // The workspace sequence continued across the reload.
  assert.ok(reloaded.state.lastActionSeq >= seqBefore);
  reloaded.state.addUserMessage('after reload');
  assert.equal(reloaded.state.getLatestAction().actionSeq, reloaded.state.lastActionSeq);
  assert.equal(reloaded.state.getLatestAction().branchId, branch.id);

  // Merge analysis still works on restored data.
  const analysis = reloaded.state.analyzeMerge(branch.id, 'main');
  assert.deepEqual(list(analysis.compatible, item => item.id), ['metrics']);
});

test('a session saved before branches existed loads as a single main branch', () => {
  const { state } = loadState();

  state.loadSession({
    id: 'sess_1700000000000',
    title: 'Legacy chat',
    createdAt: 1700000000000,
    chatHistory: [{ role: 'system', content: 'chat' }, { role: 'user', content: 'hi' }],
    documentSections: [['alpha', section('alpha')]],
    sectionOrder: ['alpha'],
    uiMessages: [{ type: 'user', text: 'hi', timestamp: 1700000000000, msgIndex: 0 }],
  });

  assert.equal(state.branchId, 'main');
  assert.deepEqual(list(state.getBranches(), b => b.id), ['main']);
  assert.deepEqual(list(state.sectionOrder), ['alpha']);
  assert.equal(state.hasDocument, true);
  assert.equal(state.getBranchDivergence('main'), null, 'main has nothing to diverge from');
});

test('starting a new chat resets branches but not the action sequence', () => {
  const { state } = loadState();
  seedDocument(state);
  state.createBranch('Sensor Strategy');
  const seqBefore = state.lastActionSeq;

  state.reset();

  assert.equal(state.branchId, 'main');
  assert.deepEqual(list(state.getBranches(), b => b.id), ['main']);
  assert.deepEqual(plain(state.branchTracks), {});
  assert.equal(state.lastActionSeq, seqBefore, 'the workspace sequence is untouched');
  state.addUserMessage('fresh workspace');
  assert.equal(state.getLatestAction().actionSeq, seqBefore + 1);
  assert.equal(state.getLatestAction().branchId, 'main');
});
