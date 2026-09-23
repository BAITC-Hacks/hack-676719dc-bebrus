const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');
const vm = require('node:vm');

const projectRoot = path.resolve(__dirname, '..');
const readScript = rel => fs.readFileSync(path.join(projectRoot, rel), 'utf8');

function memoryStorage() {
  const map = new Map();
  return {
    getItem: key => map.get(key) ?? null,
    setItem: (key, value) => map.set(key, String(value)),
    removeItem: key => map.delete(key),
    raw: map,
  };
}

function loadState() {
  const storage = memoryStorage();
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
    `${readScript('js/actionLog.js')}\n${readScript('js/editEngine.js')}\n${readScript('js/state.js')}\n` +
    'globalThis.__state = HectraState; globalThis.__engine = HectraEditEngine; globalThis.__log = HectraActionLog;',
    context
  );
  context.__state.init();
  return { state: context.__state, engine: context.__engine, log: context.__log, storage };
}

const section = (id, content = `${id} content`) => ({ id, title: id.toUpperCase(), content, position: null });
const plain = value => JSON.parse(JSON.stringify(value));
const ids = values => Array.from(values);

function seed(state) {
  state.addUserMessage('create');
  state.addAIMessage('raw', [section('a'), section('b'), section('c')], ['created']);
}

function proposalFor(state, parsed, targetSectionIds = ['a'], logs = ['edited']) {
  const context = state.createEditRequestContext({ targetSectionIds, selectedText: 'frozen selection' });
  return { context, proposal: state.createEditProposal(parsed, context, logs) };
}

test('model response creates a pending proposal without mutating any live document or version state', () => {
  const { state, log } = loadState();
  seed(state);
  const before = plain({
    sections: state.getDocumentSectionsArray(),
    order: state.sectionOrder,
    history: state.chatHistory,
    ui: state.uiMessages,
  });

  const { proposal } = proposalFor(state, { sections: [section('a', 'new a')], deletedIds: [] });

  assert.equal(proposal.status, 'pending');
  assert.deepEqual(plain(state.getDocumentSectionsArray()), before.sections);
  assert.deepEqual(ids(state.sectionOrder), before.order);
  assert.deepEqual(plain(state.chatHistory), before.history);
  assert.equal(state.uiMessages[1].versions.length, before.ui[1].versions.length);
  assert.equal(state.getLatestAction().type, log.ACTION_TYPES.DOCUMENT_EDIT_PROPOSED);
});

test('scope and structural authorization are classified at the engine boundary', () => {
  const { state, engine } = loadState();
  seed(state);

  let built = proposalFor(state, { sections: [section('a', 'new a'), section('b', 'new b')], deletedIds: [] }, ['a']);
  const byId = new Map(built.proposal.operations.map(operation => [operation.sectionId, operation]));
  assert.equal(byId.get('a').authorization, engine.AUTHORIZATION.SCOPED);
  assert.equal(byId.get('b').authorization, engine.AUTHORIZATION.APPROVAL);

  built = proposalFor(state, {
    sections: [
      { ...section('d'), position: { type: 'after', ref: 'a' } },
      { ...section('c'), position: { type: 'start', ref: null } },
    ],
    deletedIds: ['b'],
  }, ['a']);
  for (const operation of built.proposal.operations) {
    assert.equal(operation.authorization, engine.AUTHORIZATION.APPROVAL);
  }
  assert.deepEqual(
    new Set(built.proposal.operations.flatMap(operation => operation.kinds)),
    new Set([engine.KINDS.INSERT, engine.KINDS.DELETE, engine.KINDS.MOVE])
  );
});

test('invalid targets and broken anchors cannot be accepted', () => {
  const { state, engine } = loadState();
  seed(state);
  const { proposal } = proposalFor(state, {
    sections: [{ ...section('d'), position: { type: 'after', ref: 'missing' } }],
    deletedIds: ['also_missing'],
  });

  assert.equal(proposal.operations.every(operation => operation.authorization === engine.AUTHORIZATION.INVALID), true);
  const invalid = proposal.operations[0];
  assert.equal(state.setEditProposalDecision(invalid.operationId, engine.DECISIONS.ACCEPTED), false);
  const committed = state.commitEditProposal(proposal, [invalid.operationId]);
  assert.equal(committed.ok, false);
  assert.deepEqual(ids(state.sectionOrder), ['a', 'b', 'c']);
  assert.equal(state.uiMessages[1].versions.length, 1);
});

test('duplicate section ids become one invalid review operation', () => {
  const { state, engine } = loadState();
  seed(state);
  const { proposal } = proposalFor(state, {
    sections: [section('a', 'first'), section('a', 'second')],
    deletedIds: [],
  }, ['a']);

  assert.equal(proposal.operations.length, 1);
  assert.equal(proposal.operations[0].authorization, engine.AUTHORIZATION.INVALID);
  assert.match(proposal.operations[0].reason, /more than once/i);
});

test('a rejected operation stays out and the accepted subset creates exactly one version', () => {
  const { state } = loadState();
  seed(state);
  const { proposal } = proposalFor(state, {
    sections: [section('a', 'accepted a'), section('b', 'rejected b')],
    deletedIds: [],
  }, ['a']);
  const acceptedId = proposal.operations.find(operation => operation.sectionId === 'a').operationId;
  const beforeVersions = state.uiMessages[1].versions.length;

  const result = state.commitEditProposal(proposal, [acceptedId]);

  assert.equal(result.ok, true);
  assert.equal(result.committed, true);
  assert.equal(state.documentSections.get('a').content, 'accepted a');
  assert.equal(state.documentSections.get('b').content, 'b content');
  assert.equal(state.uiMessages[1].versions.length, beforeVersions + 1);
});

test('an invalid accepted combination is atomic and leaves no partial insert', () => {
  const { state } = loadState();
  seed(state);
  const { proposal } = proposalFor(state, {
    sections: [
      { ...section('d'), position: { type: 'after', ref: 'a' } },
      { ...section('e'), position: { type: 'after', ref: 'd' } },
    ],
    deletedIds: [],
  });
  const onlyDependent = proposal.operations.find(operation => operation.sectionId === 'e').operationId;
  const before = plain(state.getDocumentSectionsArray());

  const result = state.commitEditProposal(proposal, [onlyDependent]);

  assert.equal(result.ok, false);
  assert.match(result.error, /anchor d/i);
  assert.deepEqual(plain(state.getDocumentSectionsArray()), before);
  assert.equal(state.documentSections.has('e'), false);
  assert.equal(state.uiMessages[1].versions.length, 1);
});

test('auto-apply is limited to fully scoped non-structural updates', () => {
  const { state, engine } = loadState();
  seed(state);

  const safe = proposalFor(state, { sections: [section('a', 'safe')], deletedIds: [] }, ['a']).proposal;
  assert.equal(engine.canAutoApply(safe), true);
  assert.equal(state.commitEditProposal(safe, safe.operations.map(operation => operation.operationId), { auto: true }).ok, true);

  const structural = proposalFor(state, {
    sections: [{ ...section('d'), position: { type: 'end', ref: null } }],
    deletedIds: [],
  }, ['a']).proposal;
  assert.equal(engine.canAutoApply(structural), false);
  const refused = state.commitEditProposal(structural, structural.operations.map(operation => operation.operationId), { auto: true });
  assert.equal(refused.ok, false);
  assert.equal(state.documentSections.has('d'), false);
});

test('branch switch and changed base make a proposal stale', () => {
  const first = loadState();
  seed(first.state);
  const pendingOnMain = proposalFor(first.state, { sections: [section('a', 'later')], deletedIds: [] }, ['a']).proposal;
  first.state.createBranch('other');
  const switched = first.state.commitEditProposal(pendingOnMain, pendingOnMain.operations.map(operation => operation.operationId));
  assert.equal(switched.stale, true);
  assert.match(switched.error, /branch changed/i);

  const second = loadState();
  seed(second.state);
  const old = proposalFor(second.state, { sections: [section('a', 'old proposal')], deletedIds: [] }, ['a']).proposal;
  second.state.applyEdit([section('b', 'concurrent')], [], ['concurrent']);
  const changed = second.state.commitEditProposal(old, old.operations.map(operation => operation.operationId));
  assert.equal(changed.stale, true);
  assert.match(changed.error, /document changed/i);
  assert.equal(second.state.documentSections.get('a').content, 'a content');
});

test('undo restores the previous snapshot as one new version', () => {
  const { state, log } = loadState();
  seed(state);
  const { proposal } = proposalFor(state, { sections: [section('a', 'changed')], deletedIds: [] }, ['a']);
  const applied = state.commitEditProposal(proposal, proposal.operations.map(operation => operation.operationId));
  const versionsAfterApply = state.uiMessages[1].versions.length;

  const undone = state.undoLastEdit(applied.requestId);

  assert.equal(undone.ok, true);
  assert.equal(state.documentSections.get('a').content, 'a content');
  assert.equal(state.uiMessages[1].versions.length, versionsAfterApply + 1);
  const action = state.getLatestAction();
  assert.equal(action.type, log.ACTION_TYPES.DOCUMENT_EDIT_APPLIED);
  assert.equal(action.payload.origin, 'undo');
});

test('manual add/delete/move use the engine and preview equals the committed snapshot', () => {
  const { state, engine } = loadState();
  seed(state);
  const context = state.createEditRequestContext({ targetSectionIds: ['a', 'b', 'c'] });
  let draft = plain(context.baseSnapshot);

  let command = engine.applyManualCommand(draft, {
    type: 'add',
    section: section('d'),
    position: { type: 'after', ref: 'a' },
  });
  assert.equal(command.ok, true);
  draft = command.snapshot;
  command = engine.applyManualCommand(draft, { type: 'move', sectionId: 'c', position: { type: 'start' } });
  assert.equal(command.ok, true);
  draft = command.snapshot;
  command = engine.applyManualCommand(draft, { type: 'delete', sectionId: 'b' });
  assert.equal(command.ok, true);
  draft = command.snapshot;

  const proposal = state.createManualStructureProposal(draft, { context });
  const accepted = proposal.operations.map(operation => operation.operationId);
  const preview = engine.materializeProposal(proposal, accepted, { explicitApproval: true });
  assert.equal(preview.ok, true);
  const result = state.commitEditProposal(proposal, accepted);
  assert.equal(result.ok, true);
  assert.deepEqual(plain(result.afterSnapshot.sections), plain(preview.snapshot.sections));
  assert.deepEqual(ids(result.afterSnapshot.order), ids(preview.snapshot.order));
  assert.deepEqual(ids(state.sectionOrder), ['c', 'a', 'd']);
  assert.equal(state.uiMessages[1].versions.length, 2);
});

test('full reject creates no fake version or applied action', () => {
  const { state, log } = loadState();
  seed(state);
  const { proposal } = proposalFor(state, { sections: [section('a', 'no')], deletedIds: [] }, ['a']);
  const beforeVersions = state.uiMessages[1].versions.length;
  const beforeApplied = state.getActions().filter(action => action.type === log.ACTION_TYPES.DOCUMENT_EDIT_APPLIED).length;

  const result = state.commitEditProposal(proposal, []);

  assert.equal(result.committed, false);
  assert.equal(state.uiMessages[1].versions.length, beforeVersions);
  assert.equal(state.getActions().filter(action => action.type === log.ACTION_TYPES.DOCUMENT_EDIT_APPLIED).length, beforeApplied);
  assert.equal(state.getActions().filter(action => action.type === log.ACTION_TYPES.DOCUMENT_EDIT_PROPOSED).length, 1);
});
