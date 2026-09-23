const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');
const vm = require('node:vm');

const projectRoot = path.resolve(__dirname, '..');
const readScript = rel => fs.readFileSync(path.join(projectRoot, rel), 'utf8');
const TemporaryChat = require('../js/temporaryChat.js');

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
    'globalThis.__state = HectraState;',
    context
  );
  context.__state.init();
  return { state: context.__state, storage };
}

const section = (id, content) => ({ id, title: id.toUpperCase(), content, position: null });
const plain = value => JSON.parse(JSON.stringify(value));

function seedBranches(state) {
  state.branchNotes.main = ['PARENT_NOTE_MUST_NOT_LEAK'];
  state.addUserMessage('parent question marker');
  state.addAIMessage('parent raw', [section('parent', 'PARENT_BLOCK')], []);
  const branch = state.createBranch('Source branch');
  state.addUserMessage('older branch history marker');
  state.addAIMessage('older raw', [section('old', 'OLDER_BLOCK')], []);
  state.addUserMessage('latest branch question');
  state.addAIMessage('latest raw', [section('latest', 'LATEST_BLOCK')], []);
  state.switchBranch('main');
  return branch;
}

test('branch context reads only the last assistant document block without switching', () => {
  const { state } = loadState();
  const branch = seedBranches(state);
  const activeBefore = state.branchId;

  const block = state.getBranchLastContentBlock(branch.id);

  assert.equal(state.branchId, activeBefore);
  assert.deepEqual(Array.from(block.order), ['latest']);
  assert.match(block.markdown, /LATEST_BLOCK/);
  assert.doesNotMatch(block.markdown, /OLDER_BLOCK|PARENT_BLOCK/);
});

test('captured source is immutable after the source track changes', () => {
  const { state } = loadState();
  const branch = seedBranches(state);
  const block = state.getBranchLastContentBlock(branch.id);
  const manager = TemporaryChat.createManager({ now: () => 10, makeId: prefix => `${prefix}_fixed` });
  manager.open({ sourceBranchId: branch.id, sourceBranchName: branch.name, sourceBlock: block });

  const track = state.branchTracks[branch.id];
  const last = track.uiMessages.at(-1);
  last.versions[0].sections[0].content = 'LATER_CHANGE';

  assert.match(manager.getSession().sourceBlock.markdown, /LATEST_BLOCK/);
  assert.doesNotMatch(manager.getSession().sourceBlock.markdown, /LATER_CHANGE/);
});

test('one temporary session has exactly one source branch', () => {
  const manager = TemporaryChat.createManager();
  const first = manager.open({ sourceBranchId: 'one', sourceBranchName: 'One', sourceBlock: { markdown: 'ONE' } });
  const second = manager.open({ sourceBranchId: 'two', sourceBranchName: 'Two', sourceBlock: { markdown: 'TWO' } });

  assert.equal(first.ok, true);
  assert.equal(second.ok, false);
  assert.equal(manager.getSession().sourceBranchId, 'one');
  assert.match(second.error, /close or reset/i);
});

test('temporary Q&A includes frozen block and local pairs, never full branch context', () => {
  const manager = TemporaryChat.createManager();
  manager.open({ sourceBranchId: 'source', sourceBranchName: 'Source', sourceBlock: { markdown: 'ONLY_LATEST_BLOCK' } });
  let request = manager.beginQuestion('first question');
  manager.resolve('first answer');
  request = manager.beginQuestion('second question');
  const wire = JSON.stringify(request.requestMessages);

  assert.match(wire, /ONLY_LATEST_BLOCK/);
  assert.match(wire, /first question/);
  assert.match(wire, /first answer/);
  assert.match(wire, /second question/);
  assert.doesNotMatch(wire, /PARENT_NOTE|SIBLING|OLDER_BLOCK/);
  assert.equal(request.requestMessages.filter(message => /Frozen Hectra branch block/.test(message.content)).length, 1);
});

test('temporary messages do not mutate or serialize permanent state', () => {
  const { state, storage } = loadState();
  const branch = seedBranches(state);
  const before = plain({
    chatHistory: state.chatHistory,
    uiMessages: state.uiMessages,
    sections: state.getDocumentSectionsArray(),
    versions: state.uiMessages.at(-1).versions,
  });
  const manager = TemporaryChat.createManager();
  manager.open({ sourceBranchId: branch.id, sourceBranchName: branch.name, sourceBlock: state.getBranchLastContentBlock(branch.id) });
  manager.beginQuestion('temporary secret');
  manager.resolve('temporary answer');
  state.saveSession();

  assert.deepEqual(plain(state.chatHistory), before.chatHistory);
  assert.deepEqual(plain(state.uiMessages), before.uiMessages);
  assert.deepEqual(plain(state.getDocumentSectionsArray()), before.sections);
  assert.deepEqual(plain(state.uiMessages.at(-1).versions), before.versions);
  const serialized = storage.raw.get(`hectra_session_${state.sessionId}`);
  assert.doesNotMatch(serialized, /temporary secret|temporary answer/);
});

test('reset, close and workspace-switch hook destroy the in-memory session', () => {
  const manager = TemporaryChat.createManager();
  manager.open({ sourceBranchId: 'one', sourceBlock: { markdown: 'ONE' } });
  assert.equal(manager.reset(), true);
  assert.equal(manager.getSession(), null);
  manager.open({ sourceBranchId: 'two', sourceBlock: { markdown: 'TWO' } });
  assert.equal(manager.close(), true);
  assert.equal(manager.getSession(), null);

  const appSource = readScript('js/app.js');
  assert.match(appSource, /HectraMapUI\.destroyTemporaryChat\?\.\(\);\s*HectraState\.loadSession/);
});

test('failed question is retained and can be retried', () => {
  const manager = TemporaryChat.createManager();
  manager.open({ sourceBranchId: 'one', sourceBlock: { markdown: 'ONE' } });
  manager.beginQuestion('keep me');
  manager.fail(new Error('network down'));
  assert.equal(manager.getSession().messages[0].status, 'error');
  const retried = manager.retry();
  assert.equal(retried.ok, true);
  assert.match(JSON.stringify(retried.requestMessages), /keep me/);
});

test('deleted, unavailable and empty branches have no usable block', () => {
  const empty = loadState().state;
  assert.equal(empty.getBranchLastContentBlock('main'), null);
  assert.equal(empty.getBranchLastContentBlock('missing'), null);

  const { state } = loadState();
  const branch = seedBranches(state);
  state.deleteBranch(branch.id);
  assert.equal(state.getBranchLastContentBlock(branch.id), null);
});
