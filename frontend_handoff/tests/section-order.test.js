const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');
const vm = require('node:vm');

const projectRoot = path.resolve(__dirname, '..');

function readScript(relativePath) {
  return fs.readFileSync(path.join(projectRoot, relativePath), 'utf8');
}

function loadParser() {
  const context = vm.createContext({});
  vm.runInContext(
    `${readScript('js/mdParser.js')}\nglobalThis.__parseMdResponse = parseMdResponse;`,
    context
  );
  return context.__parseMdResponse;
}

function loadConfig() {
  const context = vm.createContext({});
  vm.runInContext(
    `${readScript('js/config.js')}\nglobalThis.__HectraConfig = HectraConfig;`,
    context
  );
  return context.__HectraConfig;
}

function loadState() {
  const context = vm.createContext({
    console,
    HectraConfig: {
      CHAT_SYSTEM_PROMPT: 'chat',
      CREATOR_SYSTEM_PROMPT: 'creator',
      EDIT_SYSTEM_PROMPT: 'edit',
    },
  });
  vm.runInContext(
    // HectraActionLog is a hard dependency of HectraState (workspace action log).
    `${readScript('js/actionLog.js')}\n${readScript('js/editEngine.js')}\n${readScript('js/state.js')}\nglobalThis.__HectraState = HectraState;`,
    context
  );
  context.__HectraState.init();
  return context.__HectraState;
}

function loadRenderer(extraGlobals = {}) {
  const context = vm.createContext({
    HectraSecurity: {
      sanitizeHtml(html) { return html; },
    },
    marked: {
      setOptions() {},
      parse(markdown) { return markdown; },
    },
    window: {},
    ...extraGlobals,
  });
  vm.runInContext(readScript('js/renderer.js'), context);
  return context.window.HectraRenderer;
}

class FakeClassList {
  constructor() {
    this.values = new Set();
  }

  add(...names) {
    names.forEach(name => this.values.add(name));
  }

  remove(...names) {
    names.forEach(name => this.values.delete(name));
  }

  contains(name) {
    return this.values.has(name);
  }
}

class FakeNode {
  constructor(isFragment = false) {
    this.isFragment = isFragment;
    this.childNodes = [];
    this.classList = new FakeClassList();
    this.dataset = {};
    this.style = {};
    this.offsetHeight = 0;
    this.scrollHeight = 0;
  }

  appendChild(node) {
    if (node.isFragment) {
      this.childNodes.push(...node.childNodes);
      node.childNodes = [];
    } else {
      this.childNodes.push(node);
    }
    return node;
  }

  replaceChildren(node) {
    this.childNodes = [];
    if (node) this.appendChild(node);
  }

  querySelectorAll() {
    return [];
  }
}

function createFakeDocument() {
  return {
    createDocumentFragment() { return new FakeNode(true); },
    createElement() { return new FakeNode(); },
  };
}

function section(id) {
  return { id, title: id.toUpperCase(), content: `${id} content`, position: null };
}

function planShape(plan) {
  return Array.from(plan, item => `${item.section.id}${item.isDeleted ? ':deleted' : ''}`);
}

test('parser preserves explicit @end and DELETE markers', () => {
  const parseMdResponse = loadParser();

  const added = parseMdResponse('## Final [#omega] @end\nFinal content.');
  assert.deepEqual(JSON.parse(JSON.stringify(added.sections[0].position)), {
    type: 'end',
    ref: null,
  });

  const deleted = parseMdResponse('## [#omega] DELETE');
  assert.deepEqual(Array.from(deleted.deletedIds), ['omega']);
});

test('editor prompt requires complete content when moving an existing section', () => {
  const config = loadConfig();

  assert.match(config.EDIT_SYSTEM_PROMPT, /при перемещении выдай ПОЛНУЮ существующую секцию/);
  assert.match(config.EDIT_SYSTEM_PROMPT, /Никогда не выдавай для перемещения только строку заголовка/);
});

test('state keeps a new @end section last', () => {
  const state = loadState();
  state.addUserMessage('create');
  state.addAIMessage('', [section('alpha'), section('beta'), section('gamma')], []);

  state.applyEdit([
    { ...section('omega'), position: { type: 'end', ref: null } },
  ], [], []);

  assert.deepEqual(Array.from(state.sectionOrder), ['alpha', 'beta', 'gamma', 'omega']);
  assert.deepEqual(
    Array.from(state.getDocumentSectionsArray(), item => item.id),
    ['alpha', 'beta', 'gamma', 'omega']
  );
});

test('state moves an existing section without losing content on a header-only patch', () => {
  const state = loadState();
  const parseMdResponse = loadParser();
  state.addUserMessage('create');
  state.addAIMessage('', [section('alpha'), section('conclusion')], []);

  const patch = parseMdResponse('## Заключение [#conclusion] @start');
  state.applyEdit(patch.sections, patch.deletedIds, []);

  const moved = state.getDocumentSectionsArray()[0];
  assert.equal(moved.id, 'conclusion');
  assert.equal(moved.title, 'CONCLUSION');
  assert.equal(moved.content, 'conclusion content');
  assert.deepEqual(Array.from(state.sectionOrder), ['conclusion', 'alpha']);
});

test('state still applies content changes when repositioning an existing section', () => {
  const state = loadState();
  state.addUserMessage('create');
  state.addAIMessage('', [section('alpha'), section('conclusion')], []);

  state.applyEdit([{
    id: 'conclusion',
    title: 'Новое заключение',
    content: 'Новый текст.',
    position: { type: 'start', ref: null },
  }], [], []);

  const moved = state.getDocumentSectionsArray()[0];
  assert.equal(moved.title, 'Новое заключение');
  assert.equal(moved.content, 'Новый текст.');
});

test('diff plan keeps a deleted section in place and the @end section last', () => {
  const renderer = loadRenderer();
  const oldSnapshot = {
    sections: [section('alpha'), section('beta'), section('gamma')],
    order: ['alpha', 'beta', 'gamma'],
  };
  const current = [section('alpha'), section('gamma'), section('omega')];

  const plan = renderer._buildSectionRenderPlan(current, oldSnapshot, true);

  assert.deepEqual(planShape(plan), [
    'alpha',
    'beta:deleted',
    'gamma',
    'omega',
  ]);
  assert.equal(plan.at(-1).section.id, 'omega');
  assert.equal(plan.at(-1).isDeleted, false);
});

test('diff renderer writes current and deleted sections to the DOM in the merged order', async () => {
  const renderer = loadRenderer({ document: createFakeDocument() });
  const oldSections = [section('alpha'), section('beta'), section('gamma')];
  const oldSnapshot = {
    sections: oldSections,
    order: ['alpha', 'beta', 'gamma'],
  };
  const current = [section('alpha'), section('gamma'), section('omega')];
  const contentEl = new FakeNode();
  const responseEl = new FakeNode();

  await renderer._applyRender(
    responseEl,
    contentEl,
    current,
    {},
    ['omega'],
    new Map(oldSections.map(item => [item.id, item])),
    oldSnapshot,
    true
  );

  const renderedSections = contentEl.childNodes.filter(node => node.dataset.secId);
  assert.deepEqual(
    renderedSections.map(node => node.dataset.secId),
    ['alpha', 'beta', 'gamma', 'omega']
  );
  assert.equal(renderedSections[1].classList.contains('sec-deleted-static'), true);
  assert.equal(renderedSections.at(-1).dataset.secId, 'omega');
  assert.equal(renderedSections.at(-1).classList.contains('sec-deleted-static'), false);
});

test('diff plan anchors a removed middle section between surviving neighbours', () => {
  const renderer = loadRenderer();
  const oldSnapshot = {
    sections: [section('alpha'), section('delta'), section('beta'), section('gamma')],
    order: ['alpha', 'delta', 'beta', 'gamma'],
  };
  const current = [section('alpha'), section('beta'), section('gamma')];

  const plan = renderer._buildSectionRenderPlan(current, oldSnapshot, true);

  assert.deepEqual(planShape(plan), [
    'alpha',
    'delta:deleted',
    'beta',
    'gamma',
  ]);
});

test('non-diff render plan exactly follows current section order', () => {
  const renderer = loadRenderer();
  const current = [section('alpha'), section('beta'), section('gamma'), section('omega')];

  const plan = renderer._buildSectionRenderPlan(current, null, false);

  assert.deepEqual(planShape(plan), ['alpha', 'beta', 'gamma', 'omega']);
});
