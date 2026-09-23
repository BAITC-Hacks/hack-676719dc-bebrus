const test = require('node:test');
const assert = require('node:assert/strict');

const actionLog = require('../js/actionLog.js');
global.HectraActionLog = actionLog;
const engine = require('../js/editEngine.js');
const assistant = require('../js/structureAssistant.js');

function snapshot() {
  return {
    sections: [
      { id: 'intro', title: 'Introduction', content: 'Opening', position: null },
      { id: 'new_section_1', title: 'New section', content: '', position: null },
    ],
    order: ['intro', 'new_section_1'],
    changelogs: [],
  };
}

test('structure assistant request targets exactly one section in the unsaved draft', () => {
  const result = assistant.buildRequest({
    snapshot: snapshot(),
    sectionId: 'new_section_1',
    instruction: 'Make this new section the conclusion.',
    engine,
  });

  assert.equal(result.ok, true);
  assert.equal(result.messages.length, 2);
  assert.match(result.messages[0].content, /exactly one section/i);
  assert.match(result.messages[1].content, /Target section id: new_section_1/);
  assert.match(result.messages[1].content, /Make this new section the conclusion/);
  assert.match(result.messages[1].content, /Introduction \[#intro\]/);
  assert.match(result.messages[1].content, /\[#new_section_1\]/);
});

test('structure assistant accepts only one non-structural response for the requested id', () => {
  const valid = assistant.parseSuggestion({
    sections: [{ id: 'new_section_1', title: 'Conclusion', content: 'Final takeaway.', position: null }],
    deletedIds: [],
    duplicateIds: [],
  }, 'new_section_1');
  assert.deepEqual(valid, {
    ok: true,
    section: { id: 'new_section_1', title: 'Conclusion', content: 'Final takeaway.', position: null },
  });

  assert.equal(assistant.parseSuggestion({ sections: [], deletedIds: ['new_section_1'] }, 'new_section_1').ok, false);
  assert.equal(assistant.parseSuggestion({
    sections: [{ id: 'other', title: 'Other', content: 'Wrong', position: null }],
  }, 'new_section_1').ok, false);
  assert.equal(assistant.parseSuggestion({
    sections: [{ id: 'new_section_1', title: 'Conclusion', content: 'Moved', position: { type: 'end', ref: null } }],
  }, 'new_section_1').ok, false);
  assert.equal(assistant.parseSuggestion({
    sections: [{ id: 'new_section_1', title: 'Conclusion', content: '', position: null }],
  }, 'new_section_1').ok, false);
});

test('using an agent suggestion updates only the local draft through the edit engine', () => {
  const base = {
    sections: [{ id: 'intro', title: 'Introduction', content: 'Opening', position: null }],
    order: ['intro'],
    changelogs: [],
  };
  const inserted = engine.applyManualCommand(base, {
    type: 'add',
    section: { id: 'new_section_1', title: 'New section', content: '', position: null },
    position: { type: 'after', ref: 'intro' },
  });
  assert.equal(inserted.ok, true);

  const updated = engine.applyManualCommand(inserted.snapshot, {
    type: 'update',
    sectionId: 'new_section_1',
    section: { id: 'new_section_1', title: 'Conclusion', content: 'Final takeaway.', position: null },
  });
  assert.equal(updated.ok, true);
  assert.equal(updated.snapshot.sections.find(section => section.id === 'new_section_1').content, 'Final takeaway.');
  assert.deepEqual(base.order, ['intro']);
  assert.equal(base.sections.length, 1, 'the live/base snapshot is untouched');

  const context = engine.createRequestContext({ branchId: 'main', targetSectionIds: ['intro'], baseSnapshot: base });
  const proposal = engine.createProposalFromCandidate(updated.snapshot, context, {
    origin: 'manual-structure',
    computeDelta: actionLog.computeDocumentDelta,
  });
  assert.deepEqual(proposal.operations.map(operation => operation.kinds), [['insert']]);
  assert.equal(proposal.operations[0].after.content, 'Final takeaway.');
});
