// Small offline fallback for the deterministic film demo.
// The production workspace still uses marked.js when the CDN is available.
(() => {
  'use strict';

  if (window.marked) return;

  const escapeHtml = value => String(value)
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&#39;');

  const inline = value => escapeHtml(value)
    .replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>')
    .replace(/\*([^*]+)\*/g, '<em>$1</em>')
    .replace(/`([^`]+)`/g, '<code>$1</code>');

  window.marked = {
    setOptions() {},
    parse(markdown = '') {
      return String(markdown)
        .trim()
        .split(/\n{2,}/)
        .map(block => `<p>${block.split('\n').map(inline).join('<br>')}</p>`)
        .join('');
    },
  };
})();
