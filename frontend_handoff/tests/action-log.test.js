const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');
const vm = require('node:vm');

const projectRoot = path.resolve(__dirname, '..');

function readScript(relativePath) {
  return fs.readFileSync(path.join(projectRoot, relativePath), 'utf8');
}

/**
 * Storage shim shared between "reloads": handing the same object to two
 * separate HectraState instances is exactly what a page reload looks like.
 */
function createMemoryStorage(initial = {}) {
  const map = new Map(Object.entries(initial));
  return {
    getItem: key => (map.has(key) ? map.get(key) : null),
    setItem: (key, value) => { map.set(key, String(value)); },
    removeItem: key => { map.delete(key); },
    keys: () => [...map.keys()],
    raw: map,
  };
}

function loadActionLog() {
  const context = vm.createContext({});
  vm.runInContext(readScript('js/actionLog.js'), context);
  return context.HectraActionLog;
}

function loadState(options = {}) {
  const storage = options.storage || createMemoryStorage();
  const context = vm.createContext({
    console: options.console || { warn() {}, error() {}, log() {} },
    HectraConfig: {
      CHAT_SYSTEM_PROMPT: 'chat',
      CREATOR_SYSTEM_PROMPT: 'creator',
      EDIT_SYSTEM_PROMPT: 'edit',
    },
    HectraSecurity: {
      MAX_SESSION_BYTES: 4 * 1024 * 1024,
      isSafeImageDataUrl: () => true,
      storage: () => storage,
    },
  });
  vm.runInContext(
    `${readScript('js/actionLog.js')}\n${readScript('js/editEngine.js')}\n${readScript('js/state.js')}\nglobalThis.__HectraState = HectraState;`,
    context
  );

  const state = context.__HectraState;
  if (options.init !== false) state.init();
  return { state, storage, log: context.HectraActionLog };
}

function section(id, content = `${id} content`) {
  return { id, title: id.toUpperCase(), content, position: null };
}

// Values produced inside the vm realm carry that realm's prototypes, which
// deepStrictEqual rejects. These helpers bring them back into the host realm.
function plain(value) {
  return value === undefined ? undefined : JSON.parse(JSON.stringify(value));
}

function list(values, mapper = value => value) {
  return Array.from(values, mapper);
}

function seqs(actions) {
  return Array.from(actions, action => action.actionSeq);
}

function typesOf(actions) {
  return Array.from(actions, action => action.type);
}

/** Minimal real workflow: prompt → document → edit. */
function runDocumentFlow(state) {
  state.addUserMessage('create a document');
  state.addAIMessage('raw', [section('alpha'), section('beta')], ['created']);
  state.applyEdit([section('beta', 'beta rewritten')], [], ['updated beta']);
}

// ── 1..2: sequence allocation ────────────────────────────────────

test('action sequence starts at 1 and 0 stays reserved for root', () => {
  const { state, log } = loadState();

  assert.equal(state.lastActionSeq, 0);
  assert.equal(state.getActions().length, 0);

  const first = state.addUserMessage('hello');
  assert.equal(first.msgIndex, 0);

  const action = state.getLatestAction();
  assert.equal(action.actionSeq, 1);
  assert.equal(action.type, log.ACTION_TYPES.USER_MESSAGE);
  assert.equal(action.parentActionSeq, null, 'the first action of a branch is a root');
  assert.equal(action.branchId, 'main');
  assert.equal(action.schemaVersion, log.ACTION_SCHEMA_VERSION);
  assert.equal(state.lastActionSeq, 1);
});

test('action sequence increases monotonically across the whole workspace', () => {
  const { state, log } = loadState();
  runDocumentFlow(state);

  const actions = state.getActions();
  assert.deepEqual(seqs(actions), [1, 2, 3, 4, 5]);
  assert.deepEqual(typesOf(actions), [
    log.ACTION_TYPES.USER_MESSAGE,
    log.ACTION_TYPES.AI_MESSAGE,
    log.ACTION_TYPES.DOCUMENT_CREATED,
    log.ACTION_TYPES.DOCUMENT_EDIT_PROPOSED,
    log.ACTION_TYPES.DOCUMENT_EDIT_APPLIED,
  ]);
  assert.equal(state.lastActionSeq, 5);
});

// ── 3..5: sessions and branches share one sequence ───────────────

test('switching session does not reset the sequence', () => {
  const { state } = loadState();
  state.addUserMessage('first session message');
  const firstSessionId = state.sessionId;
  const seqBefore = state.lastActionSeq;

  state.sessionId = 'sess_' + (Number(firstSessionId.slice(5)) + 1);
  state.addUserMessage('second session message');

  assert.equal(state.lastActionSeq, seqBefore + 1);
  assert.equal(state.getActionsBySession(firstSessionId).length, 1);
  assert.equal(state.getActionsBySession(state.sessionId).length, 1);
  assert.deepEqual(seqs(state.getActions()), [1, 2]);
});

test('reset (New chat) keeps the workspace sequence', () => {
  const { state } = loadState();
  runDocumentFlow(state);
  const seqBefore = state.lastActionSeq;
  const workspaceId = state.workspaceId;

  state.reset();

  assert.equal(state.workspaceId, workspaceId);
  assert.equal(state.lastActionSeq, seqBefore, 'reset must not renumber or drop history');
  assert.equal(state.getActions().length, seqBefore);
  assert.equal(state.uiMessages.length, 0, 'reset starts a fresh session');
  assert.equal(state.hasDocument, false);

  state.addUserMessage('after new chat');
  assert.equal(state.getLatestAction().actionSeq, seqBefore + 1);
});

test('switching branch does not reset the sequence', () => {
  const { state } = loadState();
  state.addUserMessage('on main');

  state.branchId = 'branch_A';
  state.addUserMessage('on branch A');

  assert.deepEqual(seqs(state.getActions()), [1, 2]);
  assert.equal(state.getAction(2).branchId, 'branch_A');
  assert.equal(state.lastActionSeq, 2);
});

test('actions of different branches share one sequential workspace order', () => {
  const { state, log } = loadState();

  state.appendAction(log.ACTION_TYPES.USER_MESSAGE, { messageIndex: 0 });                          // 1 main
  state.appendAction(log.ACTION_TYPES.AI_MESSAGE, { messageIndex: 1 });                            // 2 main
  state.appendAction(log.ACTION_TYPES.USER_MESSAGE, { messageIndex: 2 }, { branchId: 'branch_A' }); // 3 branch_A
  state.appendAction(log.ACTION_TYPES.USER_MESSAGE, { messageIndex: 3 }, { branchId: 'branch_A' }); // 4 branch_A
  state.appendAction(log.ACTION_TYPES.USER_MESSAGE, { messageIndex: 4 });                          // 5 main
  state.appendAction(log.ACTION_TYPES.USER_MESSAGE, { messageIndex: 5 }, { branchId: 'branch_B' }); // 6 branch_B
  state.appendAction(log.ACTION_TYPES.AI_MESSAGE, { messageIndex: 6 }, { branchId: 'branch_A' });   // 7 branch_A

  assert.deepEqual(
    list(state.getActions(), action => `${action.actionSeq} ${action.branchId}`),
    ['1 main', '2 main', '3 branch_A', '4 branch_A', '5 main', '6 branch_B', '7 branch_A']
  );
  assert.deepEqual(seqs(state.getActionsByBranch('main')), [1, 2, 5]);
  assert.deepEqual(seqs(state.getActionsByBranch('branch_A')), [3, 4, 7]);
  assert.deepEqual(seqs(state.getActionsByBranch('branch_B')), [6]);

  // No per-branch counter exists: every branch reads the workspace sequence.
  assert.equal(state.lastActionSeq, 7);
});

// ── 6..8: append-only history ────────────────────────────────────

test('actionSeq is never reused', () => {
  const { state } = loadState();
  runDocumentFlow(state);
  state.rejectVersion(state.lastAIIndex);
  state.restoreVersion(state.lastAIIndex, 0);
  state.reset();
  state.addUserMessage('brand new chat');

  const all = seqs(state.getActions());
  assert.equal(new Set(all).size, all.length, 'no duplicate sequence numbers');
  assert.deepEqual(all, [...all].sort((a, b) => a - b));
  assert.equal(all[all.length - 1], state.lastActionSeq);
});

test('rollback appends a new action instead of deleting history', () => {
  const { state, log } = loadState();
  runDocumentFlow(state);
  const editApplied = state.getLatestAction();
  const before = state.getActions().length;

  const rejected = state.rejectVersion(state.lastAIIndex);
  assert.equal(rejected, true);

  const actions = state.getActions();
  assert.equal(actions.length, before + 1);
  assert.equal(state.getAction(editApplied.actionSeq).type, log.ACTION_TYPES.DOCUMENT_EDIT_APPLIED,
    'the rolled back edit is still in the log');

  const rejection = state.getLatestAction();
  assert.equal(rejection.type, log.ACTION_TYPES.VERSION_REJECTED);
  assert.equal(rejection.payload.rejectedVersionIndex, 1);
  assert.equal(rejection.payload.restoredVersionIndex, 0);
  // The document went back to the pre-edit text; the delta records the reversal.
  assert.equal(state.documentSections.get('beta').content, 'beta content');
  assert.deepEqual(list(rejection.payload.delta.touchedSectionIds), ['beta']);
});

test('restore appends a new action and keeps the restored-from history', () => {
  const { state, log } = loadState();
  runDocumentFlow(state);
  const editApplied = state.getLatestAction();

  const restored = state.restoreVersion(state.lastAIIndex, 0);
  assert.equal(restored, true);

  const action = state.getLatestAction();
  assert.equal(action.type, log.ACTION_TYPES.VERSION_RESTORED);
  assert.equal(action.actionSeq, editApplied.actionSeq + 1);
  assert.equal(action.payload.fromVersionIndex, 1);
  assert.equal(action.payload.toVersionIndex, 0);
  assert.ok(state.getAction(editApplied.actionSeq), 'restore never removes action 100-style history');
});

test('accepting a version appends VERSION_ACCEPTED without touching earlier actions', () => {
  const { state, log } = loadState();
  runDocumentFlow(state);
  const beforeSeqs = seqs(state.getActions());

  state.acceptVersion(state.lastAIIndex);

  const action = state.getLatestAction();
  assert.equal(action.type, log.ACTION_TYPES.VERSION_ACCEPTED);
  assert.equal(action.payload.discardedVersionCount, 1);
  assert.deepEqual(seqs(state.getActions()).slice(0, beforeSeqs.length), beforeSeqs);
});

// ── 9..11: persistence ───────────────────────────────────────────

test('persistence stores the action log and lastActionSeq with the workspace', () => {
  const { state, storage } = loadState();
  runDocumentFlow(state);
  state.saveSession();

  const record = JSON.parse(storage.getItem(`hectra_workspace_${state.workspaceId}`));
  assert.equal(record.workspaceId, state.workspaceId);
  assert.equal(record.lastActionSeq, state.lastActionSeq);
  assert.equal(record.actions.length, state.getActions().length);
  assert.deepEqual(seqs(record.actions), seqs(state.getActions()));
  assert.equal(record.activeBranchId, 'main');
  // The workspace record only registers branch ids; branch records belong to
  // the session (see tests/branches.test.js).
  assert.deepEqual(record.branchIds, ['main']);

  const session = JSON.parse(storage.getItem(`hectra_session_${state.sessionId}`));
  assert.equal(session.workspaceId, state.workspaceId);
  assert.equal(session.branchId, 'main');
});

test('after reload the next action continues at previous + 1', () => {
  const first = loadState();
  runDocumentFlow(first.state);
  first.state.saveSession();
  const lastSeqBeforeReload = first.state.lastActionSeq;
  const workspaceId = first.state.workspaceId;

  // Fresh HectraState instance over the same storage = page reload.
  const reloaded = loadState({ storage: first.storage });
  assert.equal(reloaded.state.workspaceId, workspaceId);
  assert.equal(reloaded.state.lastActionSeq, lastSeqBeforeReload);
  assert.deepEqual(seqs(reloaded.state.getActions()), seqs(first.state.getActions()));

  reloaded.state.addUserMessage('after reload');
  assert.equal(reloaded.state.getLatestAction().actionSeq, lastSeqBeforeReload + 1);

  // Loading the persisted session must not renumber anything either.
  const session = reloaded.state.getSession(first.state.sessionId);
  reloaded.state.loadSession(session);
  assert.equal(reloaded.state.lastActionSeq, lastSeqBeforeReload + 1);
  reloaded.state.addUserMessage('after session load');
  assert.equal(reloaded.state.getLatestAction().actionSeq, lastSeqBeforeReload + 2);
});

test('a legacy session without actions loads and starts an empty log', () => {
  const { state } = loadState();

  // Shape written by the pre-action-log version of saveSession().
  const legacySession = {
    id: 'sess_1700000000000',
    title: 'Legacy chat',
    createdAt: 1700000000000,
    updatedAt: 1700000000000,
    chatHistory: [{ role: 'system', content: 'chat' }, { role: 'user', content: 'hi' }],
    documentSections: [['alpha', section('alpha')]],
    sectionOrder: ['alpha'],
    uiMessages: [{ type: 'user', text: 'hi', timestamp: 1700000000000, msgIndex: 0 }],
  };

  state.loadSession(legacySession);

  assert.equal(state.sessionId, 'sess_1700000000000');
  assert.equal(state.hasDocument, true);
  assert.deepEqual(list(state.sectionOrder), ['alpha']);
  assert.deepEqual(list(state.getActions()), [], 'historical actions are never reconstructed');
  assert.equal(state.lastActionSeq, 0);
  assert.equal(state.branchId, 'main');

  state.addUserMessage('continue the legacy chat');
  assert.equal(state.getLatestAction().actionSeq, 1);
});

test('a legacy workspace record without actions loads as an empty log', () => {
  const storage = createMemoryStorage({
    hectra_workspace_id: 'ws_1700000000000',
    hectra_workspace_ws_1700000000000: JSON.stringify({ workspaceId: 'ws_1700000000000' }),
  });
  const { state } = loadState({ storage });

  assert.equal(state.workspaceId, 'ws_1700000000000');
  assert.deepEqual(list(state.getActions()), []);
  assert.equal(state.lastActionSeq, 0);
  assert.deepEqual(list(state.getActionLogIssues()), []);
});

// ── 12..14: integrity ────────────────────────────────────────────

test('duplicate actionSeq is detected and isolated on load', () => {
  const log = loadActionLog();
  const base = {
    workspaceId: 'ws_1',
    type: log.ACTION_TYPES.USER_MESSAGE,
    createdAtMs: 1700000000000,
    parentActionSeq: null,
    branchId: 'main',
    sessionId: 'sess_1',
    payload: {},
    schemaVersion: 1,
  };

  const result = log.normalizeLog([
    { ...base, actionSeq: 1 },
    { ...base, actionSeq: 2 },
    { ...base, actionSeq: 2, payload: { duplicate: true } },
  ], { workspaceId: 'ws_1' });

  assert.deepEqual(seqs(result.actions), [1, 2]);
  assert.equal(result.rejected.length, 1);
  assert.equal(result.issues.length, 1);
  assert.equal(result.issues[0].code, 'duplicate_action_seq');
  assert.equal(result.issues[0].actionSeq, 2);
  assert.equal(result.actions[1].payload.duplicate, undefined, 'the first record wins');
  assert.equal(result.lastActionSeq, 2);
});

test('invalid INTEGER sequence values are rejected', () => {
  const log = loadActionLog();
  const valid = {
    actionSeq: 5,
    workspaceId: 'ws_1',
    type: log.ACTION_TYPES.USER_MESSAGE,
    createdAtMs: 1700000000000,
    parentActionSeq: 4,
    branchId: 'main',
    sessionId: null,
    payload: {},
    schemaVersion: 1,
  };
  assert.equal(log.validateAction(valid).valid, true);

  for (const badSeq of [0, -1, 1.5, '5', null, undefined, NaN, Infinity, log.MAX_ACTION_SEQ + 1]) {
    const result = log.validateAction({ ...valid, actionSeq: badSeq });
    assert.equal(result.valid, false, `actionSeq ${String(badSeq)} must be rejected`);
    assert.match(result.errors.join(' '), /actionSeq/);
  }

  assert.equal(log.isActionSeq(log.MAX_ACTION_SEQ), true);
  assert.equal(log.isActionSeq(log.MAX_ACTION_SEQ + 1), false);
  assert.equal(log.isActionSeq(log.ROOT_ACTION_SEQ), false, '0 is root, not a real action');

  // Corrupted records never let a sequence number be handed out twice.
  const corrupted = log.normalizeLog([{ ...valid, actionSeq: 9 }, { ...valid, actionSeq: 1.5 }], { workspaceId: 'ws_1' });
  assert.deepEqual(seqs(corrupted.actions), [9]);
  assert.equal(corrupted.issues[0].code, 'invalid_action');
  assert.equal(corrupted.lastActionSeq, 9);

  // Other fields are validated too.
  assert.equal(log.validateAction({ ...valid, type: 'NOT_A_TYPE' }).valid, false);
  assert.equal(log.validateAction({ ...valid, workspaceId: '' }).valid, false);
  assert.equal(log.validateAction({ ...valid, branchId: '  ' }).valid, false);
  assert.equal(log.validateAction({ ...valid, createdAtMs: Number.NaN }).valid, false);
  assert.equal(log.validateAction({ ...valid, payload: [] }).valid, false);
  assert.equal(log.validateAction({ ...valid, parentActionSeq: 5 }).valid, false, 'parent must be < actionSeq');
  assert.equal(log.validateAction({ ...valid, parentActionSeq: 0 }).valid, true, 'root parent is allowed');
});

test('reaching INTEGER_MAX fails loudly instead of wrapping around', () => {
  const { state, log } = loadState();

  state.lastActionSeq = log.MAX_ACTION_SEQ - 1;
  const last = state.appendAction(log.ACTION_TYPES.USER_MESSAGE, { messageIndex: 0 });
  assert.equal(last.actionSeq, log.MAX_ACTION_SEQ);

  assert.throws(
    () => state.appendAction(log.ACTION_TYPES.USER_MESSAGE, { messageIndex: 1 }),
    /action sequence exhausted/
  );
  assert.equal(state.lastActionSeq, log.MAX_ACTION_SEQ, 'no wraparound, no reuse');
  assert.equal(state.getActions().length, 1);

  // A failed append must not damage document state.
  state.addUserMessage('still works');
  assert.equal(state.uiMessages.length, 1);
  assert.equal(state.lastActionSeq, log.MAX_ACTION_SEQ);
  assert.equal(state.getActionLogIssues().at(-1).code, 'append_failed');
});

test('a corrupted action log does not destroy the document', () => {
  const storage = createMemoryStorage({
    hectra_workspace_id: 'ws_1700000000000',
    hectra_workspace_ws_1700000000000: '{ this is not json',
  });
  const { state } = loadState({ storage });

  assert.deepEqual(list(state.getActions()), []);
  assert.equal(state.lastActionSeq, 0);
  assert.equal(state.getActionLogIssues()[0].code, 'workspace_unreadable');

  // The document still works end to end on top of an unreadable history.
  runDocumentFlow(state);
  assert.deepEqual(list(state.sectionOrder), ['alpha', 'beta']);
  assert.equal(state.documentSections.get('beta').content, 'beta rewritten');
  assert.equal(state.getLatestAction().actionSeq, 5);
});

// ── 15: time vs order ────────────────────────────────────────────

test('identical timestamps do not affect actionSeq order', () => {
  const { state, log } = loadState();
  const sameMs = 1700000000128;

  state.appendAction(log.ACTION_TYPES.USER_MESSAGE, { messageIndex: 0 }, { createdAtMs: sameMs });
  state.appendAction(log.ACTION_TYPES.AI_MESSAGE, { messageIndex: 1 }, { createdAtMs: sameMs });
  state.appendAction(log.ACTION_TYPES.USER_MESSAGE, { messageIndex: 2 }, { createdAtMs: sameMs });

  const actions = state.getActions();
  assert.deepEqual(list(actions, action => action.createdAtMs), [sameMs, sameMs, sameMs]);
  assert.deepEqual(seqs(actions), [1, 2, 3]);

  // Canonical order survives a timestamp-based shuffle.
  const shuffled = [actions[2], actions[0], actions[1]];
  assert.deepEqual(seqs(log.sortActions(shuffled)), [1, 2, 3]);
});

// ── 16..17: causal graph ─────────────────────────────────────────

test('parentActionSeq stores the graph relation explicitly', () => {
  const { state, log } = loadState();
  runDocumentFlow(state);

  const [userMessage, aiMessage, documentCreated, proposed, applied] = state.getActions();

  assert.equal(userMessage.parentActionSeq, null);
  assert.equal(aiMessage.parentActionSeq, userMessage.actionSeq);
  assert.equal(documentCreated.parentActionSeq, aiMessage.actionSeq,
    'DOCUMENT_CREATED is caused by the AI message, not by "seq - 1" arithmetic');
  assert.equal(proposed.parentActionSeq, documentCreated.actionSeq);
  assert.equal(applied.parentActionSeq, proposed.actionSeq);

  // A fork: two children of the same parent, chronology stays linear.
  const left = state.appendAction(log.ACTION_TYPES.USER_MESSAGE, { messageIndex: 9 }, {
    branchId: 'branch_A',
    parentActionSeq: aiMessage.actionSeq,
  });
  const right = state.appendAction(log.ACTION_TYPES.USER_MESSAGE, { messageIndex: 10 }, {
    branchId: 'branch_B',
    parentActionSeq: aiMessage.actionSeq,
  });
  const leftChild = state.appendAction(log.ACTION_TYPES.AI_MESSAGE, { messageIndex: 11 }, { branchId: 'branch_A' });
  const rightChild = state.appendAction(log.ACTION_TYPES.AI_MESSAGE, { messageIndex: 12 }, { branchId: 'branch_B' });

  assert.equal(left.parentActionSeq, aiMessage.actionSeq);
  assert.equal(right.parentActionSeq, aiMessage.actionSeq);
  assert.equal(leftChild.parentActionSeq, left.actionSeq, 'default parent is the last action of the same branch');
  assert.equal(rightChild.parentActionSeq, right.actionSeq);
  assert.deepEqual(seqs(state.getActions()), [1, 2, 3, 4, 5, 6, 7, 8, 9]);
});

test('a branch action can reference an ancestor that lives on main', () => {
  const { state, log } = loadState();
  state.addUserMessage('on main');
  const mainAnchor = state.getLatestAction();
  state.addUserMessage('later on main');

  const branchAction = state.appendAction(log.ACTION_TYPES.BRANCH_CREATED, {
    branchId: 'branch_A',
    forkedFromBranchId: 'main',
  }, { branchId: 'branch_A', parentActionSeq: mainAnchor.actionSeq });

  assert.equal(branchAction.branchId, 'branch_A');
  assert.equal(branchAction.parentActionSeq, mainAnchor.actionSeq);
  assert.ok(branchAction.actionSeq > mainAnchor.actionSeq + 1,
    'the fork point may be older than the previous chronological action');

  const followUp = state.appendAction(log.ACTION_TYPES.USER_MESSAGE, { messageIndex: 0 }, { branchId: 'branch_A' });
  assert.equal(followUp.parentActionSeq, branchAction.actionSeq);
});

// ── 18: structured delta ─────────────────────────────────────────

test('a document edit records a structured before/after delta', () => {
  const { state, log } = loadState();
  state.addUserMessage('create');
  state.addAIMessage('raw', [section('one'), section('two'), section('three')], []);

  state.applyEdit([
    { id: 'two', title: 'TWO v2', content: 'two rewritten', position: null },
    { id: 'four', title: 'FOUR', content: 'four content', position: { type: 'start', ref: null } },
  ], ['three'], ['edited']);

  const applied = state.getLatestAction();
  assert.equal(applied.type, log.ACTION_TYPES.DOCUMENT_EDIT_APPLIED);
  assert.equal(applied.payload.targetMessageIndex, 1);
  assert.equal(applied.payload.previousVersionIndex, 0);
  assert.equal(applied.payload.newVersionIndex, 1);
  assert.deepEqual(list(applied.payload.updatedSectionIds), ['two', 'four']);
  assert.deepEqual(list(applied.payload.deletedSectionIds), ['three']);

  const delta = applied.payload.delta;
  assert.deepEqual(plain(delta.changedSections), [{
    id: 'two',
    before: { title: 'TWO', content: 'two content' },
    after: { title: 'TWO v2', content: 'two rewritten' },
  }]);
  assert.deepEqual(plain(delta.insertedSections), [{
    id: 'four',
    index: 0,
    after: { title: 'FOUR', content: 'four content' },
  }]);
  assert.deepEqual(plain(delta.deletedSections), [{
    id: 'three',
    index: 2,
    before: { title: 'THREE', content: 'three content' },
  }]);
  assert.deepEqual(list(delta.orderBefore), ['one', 'two', 'three']);
  assert.deepEqual(list(delta.orderAfter), ['four', 'one', 'two']);
  assert.deepEqual(list(delta.touchedSectionIds), ['four', 'three', 'two']);
  assert.equal(delta.hasChanges, true);

  // The proposal that produced it is a separate, earlier action.
  const proposed = state.getAction(applied.parentActionSeq);
  assert.equal(proposed.type, log.ACTION_TYPES.DOCUMENT_EDIT_PROPOSED);
  assert.deepEqual(list(proposed.payload.proposedSectionIds), ['two', 'four']);
  assert.deepEqual(list(proposed.payload.proposedDeletedSectionIds), ['three']);

  // Payloads carry the delta, never a copy of the whole document/state.
  assert.equal(applied.payload.sections, undefined);
  assert.equal(applied.payload.documentSections, undefined);
});

test('the delta reports a pure reorder and is deterministic', () => {
  const log = loadActionLog();
  const before = { sections: [section('a'), section('b'), section('c')], order: ['a', 'b', 'c'] };
  const after = { sections: [section('c'), section('a'), section('b')], order: ['c', 'a', 'b'] };

  const delta = log.computeDocumentDelta(before, after);
  assert.deepEqual(list(delta.changedSections), []);
  assert.deepEqual(list(delta.insertedSections), []);
  assert.deepEqual(list(delta.deletedSections), []);
  assert.deepEqual(list(delta.movedSections, item => item.id), ['c', 'a', 'b']);
  assert.deepEqual(list(delta.touchedSectionIds), ['a', 'b', 'c']);

  assert.deepEqual(plain(delta), plain(log.computeDocumentDelta(before, after)));
  assert.equal(log.computeDocumentDelta(before, before).hasChanges, false);
});

test('deltas of two branches expose whether a structural merge is safe', () => {
  const log = loadActionLog();
  const base = { sections: [section('s1'), section('s2'), section('s5')], order: ['s1', 's2', 's5'] };
  const branchA = { sections: [section('s1'), section('s2', 'A edit'), section('s5')], order: ['s1', 's2', 's5'] };
  const branchB = { sections: [section('s1'), section('s2'), section('s5', 'B edit')], order: ['s1', 's2', 's5'] };
  const branchBConflicting = { sections: [section('s1'), section('s2', 'B edit'), section('s5')], order: ['s1', 's2', 's5'] };

  const deltaA = log.computeDocumentDelta(base, branchA);
  const deltaB = log.computeDocumentDelta(base, branchB);
  const deltaConflict = log.computeDocumentDelta(base, branchBConflicting);

  const overlap = (left, right) => list(left.touchedSectionIds).filter(id => right.touchedSectionIds.includes(id));
  assert.deepEqual(overlap(deltaA, deltaB), [], 'disjoint sections → structural merge is safe');
  assert.deepEqual(overlap(deltaA, deltaConflict), ['s2'], 'same section → merge conflict');
});

// ── 19..20: ordering and branch priority ─────────────────────────

test('actions are always returned in canonical actionSeq order', () => {
  const log = loadActionLog();
  const base = {
    workspaceId: 'ws_1',
    type: log.ACTION_TYPES.USER_MESSAGE,
    createdAtMs: 1700000000000,
    branchId: 'main',
    sessionId: null,
    payload: {},
    schemaVersion: 1,
  };
  const stored = [
    { ...base, actionSeq: 3, parentActionSeq: 2, createdAtMs: 1700000000001 },
    { ...base, actionSeq: 1, parentActionSeq: null, createdAtMs: 1700000000009 },
    { ...base, actionSeq: 2, parentActionSeq: 1, createdAtMs: 1700000000005 },
  ];

  const result = log.normalizeLog(stored, { workspaceId: 'ws_1' });
  assert.deepEqual(seqs(result.actions), [1, 2, 3]);
  assert.equal(result.issues.some(issue => issue.code === 'log_out_of_order'), true);
  assert.equal(result.lastActionSeq, 3);

  const storage = createMemoryStorage({
    hectra_workspace_id: 'ws_1700000000000',
    hectra_workspace_ws_1700000000000: JSON.stringify({
      workspaceId: 'ws_1700000000000',
      lastActionSeq: 3,
      actions: stored.map(action => ({ ...action, workspaceId: 'ws_1700000000000' })),
    }),
  });
  const { state } = loadState({ storage });

  assert.deepEqual(seqs(state.getActions()), [1, 2, 3]);
  assert.deepEqual(seqs(state.getActionsAfter(1)), [2, 3]);
  assert.deepEqual(seqs(state.getActionsBetween(2, 3)), [2, 3]);
  assert.equal(state.getLatestAction().actionSeq, 3);
  assert.equal(state.getAction(2).actionSeq, 2);
  assert.equal(state.getAction(99), null);
});

test('branch priority is metadata and never changes an actionSeq', () => {
  const { state, log } = loadState();

  state.appendAction(log.ACTION_TYPES.USER_MESSAGE, { messageIndex: 0 });                          // 1 main
  state.appendAction(log.ACTION_TYPES.USER_MESSAGE, { messageIndex: 1 }, { branchId: 'branch_A' }); // 2 branch_A
  state.appendAction(log.ACTION_TYPES.USER_MESSAGE, { messageIndex: 2 }, { branchId: 'branch_B' }); // 3 branch_B
  state.appendAction(log.ACTION_TYPES.USER_MESSAGE, { messageIndex: 3 });                          // 4 main

  const before = list(state.getActions(), action => `${action.actionSeq} ${action.branchId}`);

  state.setBranchPriority('branch_B', 10);
  state.setBranchPriority('branch_A', 5);

  assert.equal(state.getBranch('branch_B').priority, 10);
  assert.equal(state.getBranch('branch_A').priority, 5);
  assert.equal(state.getBranch('main').priority, 0);
  assert.deepEqual(list(state.getActions(), action => `${action.actionSeq} ${action.branchId}`), before);
  assert.equal(state.lastActionSeq, 4);
});

// ── Records are immutable ────────────────────────────────────────

test('a stored action record cannot be rewritten', () => {
  const { state } = loadState();
  state.addUserMessage('hello');
  const action = state.getLatestAction();

  assert.throws(() => { 'use strict'; action.actionSeq = 99; }, TypeError);
  assert.throws(() => { 'use strict'; action.payload.text = 'tampered'; }, TypeError);
  assert.equal(state.getAction(1).actionSeq, 1);
  assert.equal(state.getAction(1).payload.text, 'hello');
});

test('the debug history view renders one line per action', () => {
  const { state, log } = loadState();
  state.appendAction(log.ACTION_TYPES.USER_MESSAGE, { messageIndex: 0 }, { createdAtMs: Date.parse('2026-01-01T10:42:13.582Z') });
  runDocumentFlow(state);

  const lines = state.formatActionLog().split('\n');
  assert.equal(lines.length, state.getActions().length);
  assert.match(lines[0], /^#1 · \d{2}:\d{2}:\d{2}\.\d{3} · main · USER_MESSAGE · parent root · msg#0$/);
  assert.match(lines.at(-1), /^#6 · .* · main · DOCUMENT_EDIT_APPLIED · parent #5 · beta$/);
});
