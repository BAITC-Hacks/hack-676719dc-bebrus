/* eslint-disable no-console */
// Headless interaction smoke for the staged edit and temporary Map chat UI.
// Run manually: node diagnostics/browser-qa.js

const assert = require('node:assert/strict');
const childProcess = require('node:child_process');
const http = require('node:http');
const os = require('node:os');
const path = require('node:path');
const WebSocket = require('ws');

const root = path.resolve(__dirname, '..');
const port = 3219;
const debugPort = 9321;
const browserPath = process.env.HECTRA_BROWSER
  || 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe';
const profile = path.join(os.tmpdir(), `hectra-browser-qa-${process.pid}`);
let server;
let browser;

const delay = ms => new Promise(resolve => setTimeout(resolve, ms));

function requestJson(url) {
  return new Promise((resolve, reject) => {
    http.get(url, response => {
      let body = '';
      response.setEncoding('utf8');
      response.on('data', chunk => { body += chunk; });
      response.on('end', () => {
        try { resolve(JSON.parse(body)); } catch (error) { reject(error); }
      });
    }).on('error', reject);
  });
}

async function waitFor(url, parseJson = false) {
  let lastError;
  for (let attempt = 0; attempt < 80; attempt++) {
    try {
      if (parseJson) return await requestJson(url);
      await new Promise((resolve, reject) => {
        http.get(url, response => { response.resume(); response.on('end', resolve); }).on('error', reject);
      });
      return true;
    } catch (error) {
      lastError = error;
      await delay(100);
    }
  }
  throw lastError || new Error(`Timed out waiting for ${url}`);
}

function connect(webSocketDebuggerUrl) {
  return new Promise((resolve, reject) => {
    const socket = new WebSocket(webSocketDebuggerUrl);
    const pending = new Map();
    let sequence = 0;
    const exceptions = [];

    socket.on('open', () => resolve({
      exceptions,
      close: () => socket.close(),
      call(method, params = {}) {
        return new Promise((callResolve, callReject) => {
          const id = ++sequence;
          pending.set(id, { resolve: callResolve, reject: callReject });
          socket.send(JSON.stringify({ id, method, params }));
        });
      },
    }));
    socket.on('error', reject);
    socket.on('message', raw => {
      const message = JSON.parse(String(raw));
      if (message.method === 'Runtime.exceptionThrown') exceptions.push(message.params.exceptionDetails.text);
      if (!message.id || !pending.has(message.id)) return;
      const waiter = pending.get(message.id);
      pending.delete(message.id);
      if (message.error) waiter.reject(new Error(message.error.message));
      else waiter.resolve(message.result);
    });
  });
}

async function main() {
  server = childProcess.spawn(process.execPath, ['server.js'], {
    cwd: root,
    env: { ...process.env, PORT: String(port) },
    windowsHide: true,
    stdio: ['ignore', 'ignore', 'pipe'],
  });
  await waitFor(`http://127.0.0.1:${port}/workspace.html`);

  browser = childProcess.spawn(browserPath, [
    '--headless=new',
    '--disable-gpu',
    '--no-first-run',
    '--no-default-browser-check',
    '--disable-background-networking',
    `--remote-debugging-port=${debugPort}`,
    `--user-data-dir=${profile}`,
    '--window-size=1440,900',
    `http://127.0.0.1:${port}/workspace.html`,
  ], { windowsHide: true, stdio: 'ignore' });

  const targets = await waitFor(`http://127.0.0.1:${debugPort}/json/list`, true);
  const target = targets.find(item => item.type === 'page');
  assert.ok(target?.webSocketDebuggerUrl, 'Chrome page target is available');
  const cdp = await connect(target.webSocketDebuggerUrl);
  await cdp.call('Runtime.enable');
  await cdp.call('Page.enable');
  await cdp.call('Emulation.setDeviceMetricsOverride', { width: 1440, height: 900, deviceScaleFactor: 1, mobile: false });

  async function evaluate(expression) {
    const response = await cdp.call('Runtime.evaluate', {
      expression: `(async () => { ${expression} })()`,
      awaitPromise: true,
      returnByValue: true,
    });
    if (response.exceptionDetails) {
      throw new Error(response.exceptionDetails.exception?.description || response.exceptionDetails.text);
    }
    return response.result.value;
  }

  for (let attempt = 0; attempt < 80; attempt++) {
    const ready = await evaluate(`return typeof HectraState !== 'undefined' && document.readyState === 'complete';`);
    if (ready) break;
    await delay(100);
  }

  const welcome = await evaluate(`
    return {
      text: document.getElementById('welcome-screen')?.textContent || '',
      placeholder: document.getElementById('user-input')?.placeholder || '',
    };
  `);
  assert.equal(welcome.text.includes('Press Edit on a response'), false, 'welcome copy no longer points to a removed Edit button');
  assert.match(welcome.text, /live document/i);
  assert.match(welcome.text, /whole section is the authorized change boundary/i);
  assert.equal(welcome.placeholder, 'Tell Hectra what to write or change…');

  const seeded = await evaluate(`
    HectraState.addUserMessage('QA parent prompt');
    HectraState.addAIMessage('raw', [
      { id: 'a', title: 'Alpha', content: 'alpha original', position: null },
      { id: 'b', title: 'Beta', content: 'beta original', position: null },
      { id: 'c', title: 'Gamma', content: 'gamma original', position: null },
    ], ['created']);
    const branch = HectraState.createBranch('QA source');
    HectraState.addUserMessage('OLDER_BRANCH_HISTORY_MARKER');
    HectraState.addAIMessage('raw', [{ id: 'old', title: 'Old', content: 'OLDER_BLOCK_MARKER', position: null }], []);
    HectraState.addUserMessage('latest');
    HectraState.addAIMessage('raw', [{ id: 'latest', title: 'Latest', content: 'LATEST_BLOCK_MARKER', position: null }], []);
    HectraState.switchBranch('main', { log: false });
    window.__qaBranchId = branch.id;
    await renderAllMessages();
    return { active: HectraState.branchId, branchId: branch.id };
  `);
  assert.equal(seeded.active, 'main');

  const terminology = await evaluate(`
    HectraSelectionUI._render(['a']);
    const oneSection = document.getElementById('selection-toolbar').textContent.trim();
    HectraSelectionUI._render(['a', 'b']);
    const manySections = document.getElementById('selection-toolbar').textContent.trim();
    HectraBranchUI.focusSections(['a'], 'edit', { selectedText: 'alpha' });
    const oneContext = document.getElementById('composer-context').textContent.replace(/\\s+/g, ' ').trim();
    cancelInputMode();
    HectraBranchUI.focusSections(['a', 'b'], 'edit', { selectedText: 'alpha beta' });
    const manyContext = document.getElementById('composer-context').textContent.replace(/\\s+/g, ' ').trim();
    cancelInputMode();
    enterEditMode(HectraState.lastAIIndex);
    const wholeContext = document.getElementById('composer-context').textContent.replace(/\\s+/g, ' ').trim();
    cancelInputMode();
    enterPromptEditMode(0);
    const promptContext = document.getElementById('composer-context').textContent.replace(/\\s+/g, ' ').trim();
    cancelInputMode();
    HectraBranchUI.openDocumentMenu(1, document.querySelector('.edit-trigger'), () => {});
    const documentMenu = document.getElementById('context-menu').textContent.replace(/\\s+/g, ' ').trim();
    HectraUI.closeMenu();
    return {
      oneSection,
      manySections,
      oneContext,
      manyContext,
      wholeContext,
      promptContext,
      documentMenu,
      promptAction: document.querySelector('[data-action="edit-user-prompt"]')?.title,
    };
  `);
  assert.match(terminology.oneSection, /Change section/);
  assert.match(terminology.manySections, /Change sections/);
  assert.match(terminology.oneContext, /Changing section: Alpha/);
  assert.match(terminology.oneContext, /whole section may be changed/i);
  assert.match(terminology.manyContext, /Changing 2 sections/);
  assert.match(terminology.manyContext, /limited to these sections/i);
  assert.match(terminology.wholeContext, /Changing whole document/);
  assert.match(terminology.promptContext, /Revising request/);
  assert.match(terminology.documentMenu, /Change whole document/);
  assert.match(terminology.documentMenu, /Reorder, add or remove sections/);
  assert.equal(terminology.promptAction, 'Revise request');

  const staged = await evaluate(`
    const context = HectraState.createEditRequestContext({ targetSectionIds: ['a'], selectedText: 'alpha' });
    const versionsBefore = HectraState.uiMessages[1].versions.length;
    const proposal = HectraState.createEditProposal({
      sections: [{ id: 'a', title: 'Alpha', content: 'alpha scoped', position: null }],
      deletedIds: [],
    }, context, ['scoped']);
    const beforeCommit = HectraState.documentSections.get('a').content;
    const result = HectraState.commitEditProposal(proposal, proposal.operations.map(item => item.operationId), { auto: true });
    return {
      beforeCommit,
      authorization: proposal.operations[0].authorization,
      afterCommit: HectraState.documentSections.get('a').content,
      versionDelta: HectraState.uiMessages[1].versions.length - versionsBefore,
      requestId: result.requestId,
    };
  `);
  assert.deepEqual(staged, {
    beforeCommit: 'alpha original',
    authorization: 'scoped',
    afterCommit: 'alpha scoped',
    versionDelta: 1,
    requestId: staged.requestId,
  });

  const undone = await evaluate(`
    const beforeVersions = HectraState.uiMessages[1].versions.length;
    const result = HectraState.undoLastEdit(${JSON.stringify(staged.requestId)});
    return {
      ok: result.ok,
      content: HectraState.documentSections.get('a').content,
      versionDelta: HectraState.uiMessages[1].versions.length - beforeVersions,
    };
  `);
  assert.deepEqual(undone, { ok: true, content: 'alpha original', versionDelta: 1 });

  const reviewed = await evaluate(`
    const rejectedVersionsBefore = HectraState.uiMessages[1].versions.length;
    const rejectedContext = HectraState.createEditRequestContext({ targetSectionIds: ['a'] });
    const rejectedProposal = HectraState.createEditProposal({
      sections: [{ id: 'b', title: 'Beta', content: 'beta rejected', position: null }],
      deletedIds: [],
    }, rejectedContext, ['rejected']);
    openEditProposalReview(rejectedProposal);
    const outDefaultExcluded = HectraEditReviewUI.accepted.size === 0;
    const zeroIncludedDisabled = document.querySelector('[data-edit-review="apply-included"]').disabled;
    document.querySelector('[data-edit-review="discard-proposal"]').click();
    await new Promise(resolve => setTimeout(resolve, 700));
    const rejectedUnchanged = HectraState.documentSections.get('b').content === 'beta original';
    const rejectedVersionDelta = HectraState.uiMessages[1].versions.length - rejectedVersionsBefore;

    const context = HectraState.createEditRequestContext({ targetSectionIds: ['a'] });
    const proposal = HectraState.createEditProposal({
      sections: [
        { id: 'a', title: 'Alpha', content: 'alpha included', position: null },
        { id: 'b', title: 'Beta', content: 'beta excluded', position: null },
      ],
      deletedIds: [],
    }, context, ['approved']);
    const subsetVersionsBefore = HectraState.uiMessages[1].versions.length;
    openEditProposalReview(proposal);
    const scoped = proposal.operations.find(item => item.sectionId === 'a');
    const outside = proposal.operations.find(item => item.sectionId === 'b');
    const scopedDefaultIncluded = HectraEditReviewUI.accepted.has(scoped.operationId);
    const outsideDefaultExcluded = !HectraEditReviewUI.accepted.has(outside.operationId);
    const outsideCard = document.querySelector('[data-operation-id="' + outside.operationId + '"]');
    const auth = outsideCard.querySelector('.edit-operation-auth').textContent.trim();
    outsideCard.querySelector('[data-edit-review="include-one"]').click();
    const includeDidNotCommit = HectraState.documentSections.get('b').content === 'beta original'
      && HectraState.uiMessages[1].versions.length === subsetVersionsBefore;
    document.querySelector('[data-operation-id="' + outside.operationId + '"] [data-edit-review="exclude-one"]').click();
    document.querySelector('[data-edit-review="apply-included"]').click();
    await new Promise(resolve => setTimeout(resolve, 700));

    const approvalContext = HectraState.createEditRequestContext({ targetSectionIds: ['a'] });
    const approvalProposal = HectraState.createEditProposal({
      sections: [{ id: 'b', title: 'Beta', content: 'beta approved', position: null }],
      deletedIds: [],
    }, approvalContext, ['explicit approval']);
    const approvalVersionsBefore = HectraState.uiMessages[1].versions.length;
    openEditProposalReview(approvalProposal);
    document.querySelector('[data-edit-review="include-one"]').click();
    const explicitApprovalRecorded = approvalProposal.operations[0].decision === 'accepted';
    document.querySelector('[data-edit-review="apply-included"]').click();
    await new Promise(resolve => setTimeout(resolve, 700));

    const invalidContext = HectraState.createEditRequestContext({ targetSectionIds: ['a'] });
    const invalidProposal = HectraState.createEditProposal({
      sections: [
        { id: 'a', title: 'Alpha', content: 'duplicate one', position: null },
        { id: 'a', title: 'Alpha', content: 'duplicate two', position: null },
      ],
      deletedIds: [],
    }, invalidContext, []);
    openEditProposalReview(invalidProposal);
    const invalidCard = document.querySelector('.edit-operation');
    const invalidCannotInclude = !invalidCard.querySelector('[data-edit-review="include-one"]')
      && invalidCard.querySelector('.edit-operation-auth').textContent.trim() === 'Cannot apply'
      && document.querySelector('[data-edit-review="apply-included"]').disabled;
    document.querySelector('[data-edit-review="include-all"]').click();
    const bulkSkippedInvalid = HectraEditReviewUI.accepted.size === 0
      && document.querySelector('[data-edit-review="apply-included"]').disabled;
    document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
    await new Promise(resolve => setTimeout(resolve, 200));
    return {
      outDefaultExcluded,
      zeroIncludedDisabled,
      rejectedUnchanged,
      rejectedVersionDelta,
      scopedDefaultIncluded,
      outsideDefaultExcluded,
      includeDidNotCommit,
      auth,
      scopedContent: HectraState.documentSections.get('a').content,
      content: HectraState.documentSections.get('b').content,
      subsetVersionDelta: approvalVersionsBefore - subsetVersionsBefore,
      approvalVersionDelta: HectraState.uiMessages[1].versions.length - approvalVersionsBefore,
      explicitApprovalRecorded,
      invalidCannotInclude,
      bulkSkippedInvalid,
      escapeDiscarded: !HectraState.pendingEditProposal,
      modalClosing: !document.getElementById('edit-review-modal').classList.contains('is-open'),
    };
  `);
  assert.deepEqual(reviewed, {
    outDefaultExcluded: true,
    zeroIncludedDisabled: true,
    rejectedUnchanged: true,
    rejectedVersionDelta: 0,
    scopedDefaultIncluded: true,
    outsideDefaultExcluded: true,
    includeDidNotCommit: true,
    auth: 'Outside selected sections',
    scopedContent: 'alpha included',
    content: 'beta approved',
    subsetVersionDelta: 1,
    approvalVersionDelta: 1,
    explicitApprovalRecorded: true,
    invalidCannotInclude: true,
    bulkSkippedInvalid: true,
    escapeDiscarded: true,
    modalClosing: true,
  });

  const structuralReview = await evaluate(`
    const versionsBefore = HectraState.uiMessages[1].versions.length;
    const context = HectraState.createEditRequestContext({ targetSectionIds: ['a'] });
    const proposal = HectraState.createEditProposal({
      sections: [
        { id: 'b', title: 'Beta', content: 'beta approved', position: { type: 'before', ref: 'a' } },
        { id: 'model-insert', title: 'Model insert', content: 'inserted', position: { type: 'after', ref: 'a' } },
      ],
      deletedIds: ['c'],
    }, context, ['structural']);
    openEditProposalReview(proposal);
    const structuralDefaultExcluded = HectraEditReviewUI.accepted.size === 0;
    const structuralStatus = [...document.querySelectorAll('.edit-operation-auth')].map(item => item.textContent.trim());
    document.querySelector('[data-edit-review="include-all"]').click();
    const includeAllDidNotCommit = HectraState.uiMessages[1].versions.length === versionsBefore;
    const deleteOperation = proposal.operations.find(item => item.sectionId === 'c');
    document.querySelector('[data-operation-id="' + deleteOperation.operationId + '"] [data-edit-review="exclude-one"]').click();
    document.querySelector('[data-edit-review="apply-included"]').click();
    await new Promise(resolve => setTimeout(resolve, 700));
    return {
      keptRejectedDelete: HectraState.documentSections.has('c'),
      acceptedInsert: HectraState.documentSections.has('model-insert'),
      acceptedMove: HectraState.sectionOrder[0] === 'b',
      versionDelta: HectraState.uiMessages[1].versions.length - versionsBefore,
      structuralDefaultExcluded,
      structuralStatus,
      includeAllDidNotCommit,
    };
  `);
  assert.deepEqual(structuralReview, {
    keptRejectedDelete: true,
    acceptedInsert: true,
    acceptedMove: true,
    versionDelta: 1,
    structuralDefaultExcluded: true,
    structuralStatus: structuralReview.structuralStatus,
    includeAllDidNotCommit: true,
  });
  assert.ok(structuralReview.structuralStatus.every(status => status === 'Changes document structure'));

  const structure = await evaluate(`
    window.requestStructureSectionSuggestion = async ({ sectionId, instruction }) => ({
      ok: true,
      section: { id: sectionId, title: 'Conclusion', content: 'Agent-filled conclusion: ' + instruction, position: null },
    });
    const versionsBefore = HectraState.uiMessages[1].versions.length;
    enterStructureMode();
    let first = document.querySelector('.structure-row');
    const filledHasNoAgent = !first.querySelector('[data-edit-review="structure-agent-open"]');
    const structureCopy = document.querySelector('.structure-panel').textContent.replace(/\\s+/g, ' ');
    first.querySelector('[data-edit-review="structure-add-after"]').click();
    const newRow = [...document.querySelectorAll('.structure-row')].find(row => row.dataset.sectionId.startsWith('new_section_'));
    const newHasAgent = !!newRow.querySelector('[data-edit-review="structure-agent-open"]');
    const describeLabel = document.querySelector('[data-structure-agent-instruction]')?.getAttribute('aria-label');
    const instruction = document.querySelector('[data-structure-agent-instruction]');
    instruction.value = 'Make this new section the conclusion.';
    instruction.dispatchEvent(new Event('input', { bubbles: true }));
    document.querySelector('[data-edit-review="structure-agent-generate"]').click();
    await new Promise(resolve => setTimeout(resolve, 50));
    const suggestionVisible = !!document.querySelector('.structure-agent-suggestion');
    const suggestionActions = document.querySelector('.structure-agent-suggestion')?.textContent.replace(/\\s+/g, ' ');
    document.querySelector('[data-edit-review="structure-agent-use"]').click();
    let rows = [...document.querySelectorAll('.structure-row')];
    const added = rows.find(row => row.dataset.sectionId.startsWith('new_section_'));
    added.querySelector('[data-edit-review="structure-down"]')?.click();
    rows = [...document.querySelectorAll('.structure-row')];
    rows.find(row => row.dataset.sectionId === 'c').querySelector('[data-edit-review="structure-delete"]').click();
    document.querySelector('[data-edit-review="structure-undo"]').click();
    document.querySelector('[data-edit-review="structure-save"]').click();
    await new Promise(resolve => setTimeout(resolve, 100));
    return {
      hasAdded: HectraState.sectionOrder.some(id => id.startsWith('new_section_')),
      agentFilled: [...HectraState.documentSections.values()].some(section => section.title === 'Conclusion' && section.content.includes('Make this new section the conclusion.')),
      suggestionVisible,
      restoredDelete: HectraState.documentSections.has('c'),
      versionDelta: HectraState.uiMessages[1].versions.length - versionsBefore,
      filledHasNoAgent,
      newHasAgent,
      describeLabel,
      structureCopy,
      suggestionActions,
    };
  `);
  assert.deepEqual(structure, {
    hasAdded: true,
    agentFilled: true,
    suggestionVisible: true,
    restoredDelete: true,
    versionDelta: 1,
    filledHasNoAgent: true,
    newHasAgent: true,
    describeLabel: 'Describe this section',
    structureCopy: structure.structureCopy,
    suggestionActions: structure.suggestionActions,
  });
  assert.match(structure.structureCopy, /Undo last draft action/);
  assert.match(structure.structureCopy, /rewrite an existing section/i);
  assert.match(structure.suggestionActions, /Use in draft/);
  assert.match(structure.suggestionActions, /Discard suggestion/);

  const reversibility = await evaluate(`
    HectraRenderer.renderGlobalVersionBar(1);
    const versionBar = document.getElementById('global-version-bar');
    HectraEditReviewUI.showUndoToast({ requestId: 'qa' }, async () => ({ ok: true }));
    const toastText = document.querySelector('.edit-undo-toast')?.textContent.replace(/\\s+/g, ' ').trim();
    HectraEditReviewUI.dismissToast();
    HectraMergeUI.proposal = { sectionId: 'qa', status: 'ready', title: 'QA', content: 'combined' };
    const mergeCombination = HectraMergeUI._proposalBlock({ id: 'qa', resolution: null });
    HectraMergeUI.proposal = null;
    return {
      previousTitle: versionBar.querySelector('[data-action="prev-version"]')?.title,
      nextTitle: versionBar.querySelector('[data-action="next-version"]')?.title,
      keepText: versionBar.querySelector('[data-action="accept-version"]')?.textContent.trim(),
      discardText: versionBar.querySelector('[data-action="reject-version"]')?.textContent.trim(),
      toastText,
      mergeCombination,
    };
  `);
  assert.equal(reversibility.previousTitle, 'Switch document to previous version');
  assert.equal(reversibility.nextTitle, 'Switch document to next version');
  assert.equal(reversibility.keepText, 'Keep this version only');
  assert.equal(reversibility.discardText, 'Discard latest version');
  assert.match(reversibility.toastText, /Revert applied change/);
  assert.match(reversibility.mergeCombination, /Use combined text/);
  assert.match(reversibility.mergeCombination, /Discard combination/);

  const temporary = await evaluate(`
    window.requestTemporaryChatAnswer = async messages => {
      window.__qaTempWire = JSON.stringify(messages);
      return 'Temporary answer';
    };
    const before = JSON.stringify({
      chatHistory: HectraState.chatHistory,
      uiMessages: HectraState.uiMessages,
      order: HectraState.sectionOrder,
    });
    HectraMapUI.show();
    HectraMapUI.selectedBranchId = null;
    HectraMapUI.render();
    const pickHint = document.querySelector('.map-source-picker')?.textContent.replace(/\\s+/g, ' ').trim();
    const highlightedChoices = document.querySelectorAll('.map-node.is-selection-option').length;
    const activeBeforeSelection = HectraState.branchId;
    document.querySelector('.map-node[data-branch-id="' + window.__qaBranchId + '"]').click();
    const selectedHint = document.querySelector('.map-source-picker')?.textContent.trim();
    const activeAfterSelection = HectraState.branchId;
    const actionText = document.querySelector('.map-context-actions')?.textContent.replace(/\\s+/g, ' ').trim();
    const selectedRole = document.querySelector('.map-node[data-branch-id="' + window.__qaBranchId + '"] .map-node-role.is-selected')?.textContent.trim();
    const currentRole = document.querySelector('.map-node[data-branch-id="main"] .map-node-role.is-current')?.textContent.trim();
    document.querySelector('[data-temporary-chat-action="open"]').click();
    await new Promise(resolve => setTimeout(resolve, 300));
    const activeAfterOpen = HectraState.branchId;
    const questionSourceRole = document.querySelector('.map-node[data-branch-id="' + window.__qaBranchId + '"] .map-node-role.is-question-source')?.textContent.trim();
    const viewWidth = document.getElementById('map-view').getBoundingClientRect().width;
    const stageWidth = document.getElementById('map-stage').getBoundingClientRect().width;
    document.getElementById('temporary-chat-input').value = 'Question one';
    await HectraMapUI._sendTemporaryQuestion();
    document.getElementById('temporary-chat-input').value = 'Question two';
    await HectraMapUI._sendTemporaryQuestion();
    const messageCount = HectraTemporaryChat.getSession().messages.length;
    const wire = window.__qaTempWire;
    const permanentUnchanged = before === JSON.stringify({
      chatHistory: HectraState.chatHistory,
      uiMessages: HectraState.uiMessages,
      order: HectraState.sectionOrder,
    });
    HectraMapUI.destroyTemporaryChat();
    HectraMapUI._selectNode(window.__qaBranchId);
    HectraMapUI.openTemporaryChat();
    const reopenedCount = HectraTemporaryChat.getSession().messages.length;
    return {
      activeAfterOpen,
      activeBeforeSelection,
      activeAfterSelection,
      pickHint,
      highlightedChoices,
      selectedHint,
      actionText,
      selectedRole,
      currentRole,
      questionSourceRole,
      desktopReleasedSpace: stageWidth < viewWidth,
      viewWidth: Math.round(viewWidth),
      stageWidth: Math.round(stageWidth),
      messageCount,
      onlyLatest: wire.includes('LATEST_BLOCK_MARKER') && !wire.includes('OLDER_BLOCK_MARKER') && !wire.includes('QA parent prompt'),
      permanentUnchanged,
      reopenedCount,
    };
  `);
  assert.deepEqual(temporary, {
    activeAfterOpen: 'main',
    activeBeforeSelection: 'main',
    activeAfterSelection: 'main',
    pickHint: 'Select a highlighted branch to open its document or ask about its snapshot.',
    highlightedChoices: temporary.highlightedChoices,
    selectedHint: 'Selected branch: QA source',
    actionText: 'Open branch Ask about snapshot',
    selectedRole: 'SELECTED',
    currentRole: 'CURRENT',
    questionSourceRole: 'QUESTION SOURCE',
    desktopReleasedSpace: true,
    viewWidth: temporary.viewWidth,
    stageWidth: temporary.stageWidth,
    messageCount: 4,
    onlyLatest: true,
    permanentUnchanged: true,
    reopenedCount: 0,
  });
  assert.ok(temporary.highlightedChoices >= 2, 'every visible branch is highlighted until a navigation selection is made');

  await cdp.call('Emulation.setDeviceMetricsOverride', { width: 600, height: 800, deviceScaleFactor: 1, mobile: false });
  const responsive = await evaluate(`
    await new Promise(resolve => setTimeout(resolve, 300));
    return {
      viewWidth: Math.round(document.getElementById('map-view').getBoundingClientRect().width),
      stageWidth: Math.round(document.getElementById('map-stage').getBoundingClientRect().width),
      drawerWidth: Math.round(document.getElementById('temporary-chat-drawer').getBoundingClientRect().width),
    };
  `);
  assert.equal(responsive.stageWidth, responsive.viewWidth, 'narrow viewport uses the permitted overlay layout');
  assert.ok(responsive.drawerWidth <= responsive.viewWidth, 'drawer remains inside the narrow viewport');

  await cdp.call('Emulation.setDeviceMetricsOverride', { width: 1440, height: 900, deviceScaleFactor: 1, mobile: false });
  const navigation = await evaluate(`
    HectraMapUI.destroyTemporaryChat();
    HectraMapUI.hide();

    HectraBranchUI.focusSections(['a'], 'edit', { selectedText: 'alpha' });
    userInput.value = 'protected branch instruction';
    userInput.dispatchEvent(new Event('input'));
    let pendingSwitch = HectraBranchUI.switchTo(window.__qaBranchId);
    await new Promise(resolve => setTimeout(resolve, 30));
    const stayLabels = document.getElementById('confirm-modal').textContent.replace(/\\s+/g, ' ').trim();
    document.querySelector('[data-confirm="cancel"]').click();
    const stayed = (await pendingSwitch) === false;
    const stayPreserved = HectraState.branchId === 'main'
      && userInput.value === 'protected branch instruction'
      && HectraState.isEditMode;
    await new Promise(resolve => setTimeout(resolve, 180));

    pendingAttachments = [{ name: 'draft.txt', kind: 'text', text: 'draft', size: 5 }];
    renderAttachPreviews();
    pendingSwitch = HectraBranchUI.switchTo(window.__qaBranchId);
    await new Promise(resolve => setTimeout(resolve, 30));
    const switchLabels = document.getElementById('confirm-modal').textContent.replace(/\\s+/g, ' ').trim();
    document.querySelector('[data-confirm="ok"]').click();
    const switched = await pendingSwitch;
    const discardCleared = HectraState.branchId === window.__qaBranchId
      && userInput.value === ''
      && pendingAttachments.length === 0
      && !HectraState.isEditMode
      && !HectraBranchUI.sectionFocus;
    await new Promise(resolve => setTimeout(resolve, 180));

    HectraMapUI.show();
    HectraMapUI._selectNode('main');
    userInput.value = 'map navigation draft';
    document.querySelector('[data-map-action="open-selected"]').click();
    await new Promise(resolve => setTimeout(resolve, 30));
    const mapGuardVisible = !document.getElementById('confirm-modal').hidden;
    document.querySelector('[data-confirm="cancel"]').click();
    await new Promise(resolve => setTimeout(resolve, 180));
    const mapStayPreserved = HectraState.branchId === window.__qaBranchId
      && userInput.value === 'map navigation draft'
      && HectraMapUI.isVisible();
    cancelInputMode();
    HectraMapUI.hide();

    const fakeWorkspace = JSON.parse(JSON.stringify(HectraState.getSession(HectraState.sessionId)));
    fakeWorkspace.id = 'qa_workspace_target';
    fakeWorkspace.title = 'QA other workspace';
    userInput.value = 'workspace draft';
    const workspaceSwitch = restoreSessionUI(fakeWorkspace);
    await new Promise(resolve => setTimeout(resolve, 30));
    const workspaceGuardVisible = !document.getElementById('confirm-modal').hidden;
    document.querySelector('[data-confirm="cancel"]').click();
    const workspaceStayed = (await workspaceSwitch) === false
      && HectraState.branchId === window.__qaBranchId
      && userInput.value === 'workspace draft';
    cancelInputMode();
    await new Promise(resolve => setTimeout(resolve, 180));

    await HectraBranchUI.switchTo('main');
    const frozenNotice = document.getElementById('composer-context').textContent.replace(/\\s+/g, ' ').trim();
    const originalCallAPI = callAPI;
    const originalConfirm = HectraUI.confirm;
    let confirmCalls = 0;
    HectraUI.confirm = (...args) => { confirmCalls += 1; return originalConfirm.apply(HectraUI, args); };
    callAPI = async () => HectraState.getDocumentSectionsArray()
      .map(section => '## ' + section.title + ' [#' + section.id + ']\\n' + section.content)
      .join('\\n\\n');
    userInput.value = 'continue from frozen parent';
    await handleSend();
    callAPI = originalCallAPI;
    HectraUI.confirm = originalConfirm;
    const continuedBranch = HectraState.getActiveBranch();
    const continued = continuedBranch?.parentBranchId === 'main'
      && HectraState.uiMessages.some(message => message.type === 'user' && message.text === 'continue from frozen parent');
    const continuedToast = document.querySelector('.navigation-toast')?.textContent.trim();

    await new Promise(resolve => setTimeout(resolve, 180));
    userInput.value = 'new workspace draft';
    const sessionBeforeNew = HectraState.sessionId;
    const newWasDirty = isComposerDirty();
    const loadingBeforeNew = HectraState.isLoading;
    document.getElementById('new-chat-btn').click();
    await new Promise(resolve => setTimeout(resolve, 30));
    const newLabels = document.getElementById('confirm-modal').textContent.replace(/\\s+/g, ' ').trim();
    const newCancel = document.querySelector('[data-confirm="cancel"]');
    const newConfirmVisible = !!newCancel && !document.getElementById('confirm-modal').hidden;
    newCancel?.click();
    await new Promise(resolve => setTimeout(resolve, 30));
    const newStayPreserved = HectraState.sessionId === sessionBeforeNew && userInput.value === 'new workspace draft';
    document.getElementById('new-chat-btn').click();
    await new Promise(resolve => setTimeout(resolve, 30));
    document.querySelector('[data-confirm="ok"]')?.click();
    await new Promise(resolve => setTimeout(resolve, 120));
    const newDiscarded = HectraState.sessionId !== sessionBeforeNew
      && userInput.value === ''
      && pendingAttachments.length === 0
      && HectraState.uiMessages.length === 0;

    return {
      stayLabels,
      switchLabels,
      stayed,
      stayPreserved,
      switched,
      discardCleared,
      mapGuardVisible,
      mapStayPreserved,
      workspaceGuardVisible,
      workspaceStayed,
      frozenNotice,
      confirmCalls,
      continued,
      continuedToast,
      newLabels,
      newWasDirty,
      loadingBeforeNew,
      newConfirmVisible,
      newStayPreserved,
      newDiscarded,
    };
  `);
  assert.match(navigation.stayLabels, /Discard this draft/);
  assert.match(navigation.stayLabels, /Stay here/);
  assert.match(navigation.switchLabels, /Switch and discard/);
  assert.equal(navigation.stayed, true);
  assert.equal(navigation.stayPreserved, true);
  assert.equal(navigation.switched, true);
  assert.equal(navigation.discardCleared, true);
  assert.equal(navigation.mapGuardVisible, true);
  assert.equal(navigation.mapStayPreserved, true);
  assert.equal(navigation.workspaceGuardVisible, true);
  assert.equal(navigation.workspaceStayed, true);
  assert.match(navigation.frozenNotice, /This branch already has alternatives/);
  assert.match(navigation.frozenNotice, /Sending will continue in a new branch/);
  assert.equal(navigation.confirmCalls, 0, 'frozen-parent Send bypasses the draft navigation confirm');
  assert.equal(navigation.continued, true);
  assert.equal(navigation.continuedToast, 'Continued in a new branch');
  assert.match(navigation.newLabels, /Start new and discard/);
  assert.equal(navigation.newWasDirty, true);
  assert.equal(navigation.loadingBeforeNew, false);
  assert.equal(navigation.newConfirmVisible, true);
  assert.equal(navigation.newStayPreserved, true);
  assert.equal(navigation.newDiscarded, true);
  assert.deepEqual(cdp.exceptions, [], 'no uncaught page exceptions');
  cdp.close();

  console.log(JSON.stringify({
    ok: true,
    checks: [
      'staged scoped commit and undo',
      'document-first terminology and selection-boundary explanation',
      'proposal inclusion defaults, explicit approval, one final Apply, discard, and invalid exclusion',
      'model structural review includes a subset and commits once',
      'manual structure add/agent draft/move/delete/draft undo/apply',
      'structure agent is limited to new or empty sections',
      'explicit Map selection with Open branch and Ask about snapshot actions',
      'CURRENT, SELECTED, and QUESTION SOURCE text roles',
      'non-active frozen last-block temporary chat with two questions',
      'desktop drawer releases map width',
      'narrow drawer uses responsive overlay',
      'version, staged revert, and merge-combination terminology',
      'dirty composer guard for branch, Map, workspace, and New navigation',
      'frozen-parent Send auto-continues without draft confirmation',
      'no uncaught browser exceptions',
    ],
  }, null, 2));
}

main().catch(error => {
  console.error(error.stack || error);
  process.exitCode = 1;
}).finally(() => {
  if (browser && !browser.killed) browser.kill();
  if (server && !server.killed) server.kill();
});
