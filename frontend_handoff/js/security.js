// ============================================================
//  HECTRA - Client-side security helpers
// ============================================================

window.HectraSecurity = {
  MAX_TEXT_ATTACHMENT_BYTES: 512 * 1024,
  MAX_PDF_ATTACHMENT_BYTES: 10 * 1024 * 1024,
  MAX_IMAGE_ATTACHMENT_BYTES: 5 * 1024 * 1024,
  MAX_SESSION_BYTES: 4 * 1024 * 1024,

  ALLOWED_TAGS: new Set([
    'a', 'abbr', 'b', 'blockquote', 'br', 'code', 'del', 'em', 'hr', 'i',
    'li', 'ol', 'p', 'pre', 's', 'span', 'strong', 'table', 'tbody', 'td',
    'th', 'thead', 'tr', 'ul'
  ]),

  ALLOWED_ATTRS: {
    a: new Set(['href', 'title']),
    abbr: new Set(['title']),
    code: new Set(['class']),
    span: new Set(['class']),
  },

  isSafeUrl(value) {
    if (!value) return false;
    try {
      const url = new URL(value, window.location.href);
      return ['http:', 'https:', 'mailto:'].includes(url.protocol);
    } catch {
      return false;
    }
  },

  isSafeImageDataUrl(value) {
    if (typeof value !== 'string') return false;
    return /^data:image\/(?:png|jpeg|gif|webp);base64,[a-z0-9+/=]+$/i.test(value);
  },

  sanitizeHtml(html) {
    const template = document.createElement('template');
    template.innerHTML = String(html);

    const cleanNode = (node) => {
      if (node.nodeType === Node.COMMENT_NODE) {
        node.remove();
        return;
      }

      if (node.nodeType !== Node.ELEMENT_NODE) return;

      const tag = node.tagName.toLowerCase();
      if (!this.ALLOWED_TAGS.has(tag)) {
        for (const child of Array.from(node.childNodes)) cleanNode(child);
        node.replaceWith(...Array.from(node.childNodes));
        return;
      }

      const allowedAttrs = this.ALLOWED_ATTRS[tag] || new Set();
      for (const attr of Array.from(node.attributes)) {
        const name = attr.name.toLowerCase();
        const value = attr.value;

        if (!allowedAttrs.has(name)) {
          node.removeAttribute(attr.name);
          continue;
        }

        if (tag === 'a' && name === 'href' && !this.isSafeUrl(value)) {
          node.removeAttribute(attr.name);
        }

        if (name === 'class' && !/^language-[a-z0-9_-]+$/i.test(value)) {
          node.removeAttribute(attr.name);
        }
      }

      if (tag === 'a' && node.hasAttribute('href')) {
        node.setAttribute('target', '_blank');
        node.setAttribute('rel', 'noopener noreferrer nofollow');
      }

      for (const child of Array.from(node.childNodes)) cleanNode(child);
    };

    for (const child of Array.from(template.content.childNodes)) cleanNode(child);
    return template.innerHTML;
  },

  getApiKey() {
    return '';
  },

  storage() {
    return HectraConfig.STORAGE_MODE === 'local' ? localStorage : sessionStorage;
  },
};
