const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');

const HectraActionLog = require('../js/actionLog.js');

const projectRoot = path.resolve(__dirname, '..');
const read = rel => fs.readFileSync(path.join(projectRoot, rel), 'utf8');

/**
 * Two decisions this file protects.
 *
 * History is content history: what was written, removed or rewritten. The log
 * keeps recording everything else — that is what it is for — but "history" is
 * not a synonym for "every event".
 *
 * And history is ours, not the product's: an internal way to read the log while
 * working on Hectra, with no entry point in the interface.
 */

test('history is content: written, removed, rewritten', () => {
  const types = HectraActionLog.ACTION_TYPES;

  for (const type of [
    types.DOCUMENT_CREATED,
    types.DOCUMENT_EDIT_APPLIED,
    types.VERSION_RESTORED,
    types.VERSION_REJECTED,
    types.MESSAGE_PAIR_DELETED,
    types.ASSISTANT_MESSAGE_DISCARDED,
    types.MERGE_COMPLETED,
  ]) {
    assert.equal(HectraActionLog.isContentAction({ type }), true, `${type} changes content`);
  }
});

test('activity is not history', () => {
  const types = HectraActionLog.ACTION_TYPES;

  for (const type of [
    types.USER_MESSAGE,               // asking is not writing
    types.AI_MESSAGE,                 // the document it carries is DOCUMENT_CREATED
    types.USER_MESSAGE_EDITED,        // the request changed, the document did not
    types.DOCUMENT_EDIT_PROPOSED,     // reviewable intent; it may be fully rejected
    types.VERSION_ACCEPTED,           // collapses versions, leaves the live content as it was
    types.BRANCH_CREATED,
    types.BRANCH_SWITCHED,
    types.BRANCH_RENAMED,
    types.BRANCH_DISCARDED,
    types.BRANCH_DELETED,
    types.MERGE_STARTED,              // bookkeeping halves of MERGE_COMPLETED
    types.MERGE_CONFLICT,
    types.BRANCH_MERGED,
  ]) {
    assert.equal(HectraActionLog.isContentAction({ type }), false, `${type} is activity, not history`);
  }

  assert.equal(HectraActionLog.isContentAction(null), false);
  assert.equal(HectraActionLog.isContentAction({ type: 'NOT_A_TYPE' }), false);
});

test('every content type is a known action type', () => {
  const known = new Set(Object.values(HectraActionLog.ACTION_TYPES));
  for (const type of HectraActionLog.CONTENT_ACTION_TYPES) {
    assert.ok(known.has(type), `${type} must exist in ACTION_TYPES`);
  }
});

test('history has no entry point in the interface', () => {
  const html = read('workspace.html');
  assert.ok(!/id="history-btn"/.test(html), 'the top bar must not offer History');

  // The panel itself stays in the page — it is how we read the log — but nothing
  // in the product may point at it.
  const sources = ['js/branchUI.js', 'js/workspaceHeader.js', 'js/renderer.js', 'js/selectionUI.js', 'js/app.js']
    .filter(rel => /history/i.test(read(rel)));

  const offenders = sources.filter(rel => /label:\s*'[^']*[Hh]istory/.test(read(rel)));
  assert.deepEqual(offenders, [], 'these files still offer history as a menu item');
});
