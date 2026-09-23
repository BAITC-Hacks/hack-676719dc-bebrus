const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');

const projectRoot = path.resolve(__dirname, '..');
const read = rel => fs.readFileSync(path.join(projectRoot, rel), 'utf8');

/**
 * An author rule with `display: <anything>` beats the user-agent rule for the
 * `hidden` attribute. An overlay that forgets `[hidden] { display: none }` stays
 * laid out over the whole page at opacity 0 and silently swallows every click —
 * invisible to unit tests and to any test that calls element.click().
 *
 * So: every element that workspace.html marks `hidden` must either have no
 * author `display` rule at all, or an explicit `[hidden]` rule that hides it.
 */
test('every overlay that starts hidden is really hidden by CSS', () => {
  const html = read('workspace.html');
  const css = ['css/workspace.css', 'css/workspace-branches.css'].map(read).join('\n');

  // `hidden`, not `aria-hidden`.
  const hiddenElements = [...html.matchAll(/<(\w+)((?:[^>"]|"[^"]*")*?(?<!aria-)\bhidden\b(?:[^>"]|"[^"]*")*)>/g)]
    .map(match => match[2])
    .map(attrs => ({
      id: (attrs.match(/\bid="([^"]+)"/) || [])[1] || null,
      classes: ((attrs.match(/\bclass="([^"]+)"/) || [])[1] || '').split(/\s+/).filter(Boolean),
    }))
    .filter(element => element.id || element.classes.length);

  assert.ok(hiddenElements.length >= 5, 'the page should still have hidden overlays to check');

  const offenders = [];
  for (const element of hiddenElements) {
    const selectors = [...element.classes.map(name => `.${name}`), ...(element.id ? [`#${element.id}`] : [])];

    // Only a rule that makes the element visible is dangerous: `display: none`
    // in a media query is exactly what we want.
    const setsVisibleDisplay = selectors.some(selector => {
      const block = new RegExp(`(^|[,}])\\s*${escapeSelector(selector)}\\s*\\{[^}]*display\\s*:\\s*([\\w-]+)`, 'gm');
      for (const match of css.matchAll(block)) if (match[2] !== 'none') return true;
      return false;
    });
    if (!setsVisibleDisplay) continue;

    const hides = selectors.some(selector => {
      const rule = new RegExp(`${escapeSelector(selector)}\\[hidden\\][^{]*\\{[^}]*display\\s*:\\s*none`, 'm');
      return rule.test(css);
    });
    if (!hides) offenders.push(element.id ? `#${element.id}` : `.${element.classes[0]}`);
  }

  assert.deepEqual(offenders, [], 'these overlays would cover the page while "hidden"');
});

function escapeSelector(selector) {
  return selector.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}
