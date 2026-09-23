// ============================================================
//  HECTRA — Markdown Parser
// ============================================================

/**
 * Parses a Hectra Markdown response into structured sections.
 *
 * Accepts two heading formats:
 *   ## Title [#id]            — preferred, explicit id
 *   ## Title [#id] @after x  — with position marker
 *   ## Title [#id] DELETE     — deletion
 *   ## Title                  — fallback: id auto-generated from title
 *
 * Returns:
 *   {
 *     sections:   Array<{ id, title, content, position }>
 *     deletedIds: string[]
 *     duplicateIds: string[]
 *   }
 */
function parseMdResponse(raw) {
  const sections   = [];
  const deletedIds = [];
  const duplicateIds = [];
  const visibleRaw = stripHectraInternalNotes(raw);

  // Format 1: ## Title [#id] optional-position optional-DELETE
  const STRICT_RE = /^##[ \t]+(?:([^\[]+?)[ \t]+)?\[#([\w-]+)\]([ \t]+@(after|before|start|end)[ \t]+([\w-]+)|[ \t]+@(start|end))?[ \t]*(DELETE)?[ \t]*$/;

  // Format 2: ## Title (no [#id]) — fallback
  const LOOSE_RE  = /^##[ \t]+(.+)$/;

  const lines = visibleRaw.split('\n');

  let currentId    = null;
  let currentTitle = null;
  let currentPos   = null;
  let currentLines = [];
  let isDelete     = false;
  const usedIds    = new Set();

  function slugify(text) {
    return text
      .toLowerCase()
      .replace(/[^\w\s-]/g, '')   // strip emoji and special chars
      .trim()
      .replace(/[\s_]+/g, '_')
      .replace(/-+/g, '_')
      .slice(0, 32) || 'section';
  }

  function uniqueId(base) {
    let id = base;
    let n  = 2;
    while (usedIds.has(id)) id = `${base}_${n++}`;
    usedIds.add(id);
    return id;
  }

  function flush() {
    if (!currentId) return;
    if (isDelete) {
      deletedIds.push(currentId);
    } else {
      sections.push({
        id:       currentId,
        title:    currentTitle || currentId,
        content:  currentLines.join('\n').trim(),
        position: currentPos,
      });
    }
    currentId    = null;
    currentTitle = null;
    currentPos   = null;
    currentLines = [];
    isDelete     = false;
  }

  for (const line of lines) {
    // Try strict format first
    const strict = line.match(STRICT_RE);
    if (strict) {
      flush();
      currentTitle = (strict[1] || '').trim() || null;
      const rawId  = strict[2];
      // Explicit ids are a write target, not a presentation convenience. Keep
      // a duplicate visible so the edit engine can reject it instead of
      // silently turning it into a different inserted section.
      if (usedIds.has(rawId)) duplicateIds.push(rawId);
      currentId    = rawId;
      usedIds.add(currentId);
      isDelete     = !!strict[7];
      currentPos   = strict[4]
        ? { type: strict[4], ref: strict[5] }
        : strict[6]
          ? { type: strict[6], ref: null }
          : null;
      continue;
    }

    // Try loose format (## Title without [#id])
    const loose = line.match(LOOSE_RE);
    if (loose) {
      flush();
      currentTitle = loose[1].trim();
      currentId    = uniqueId(slugify(currentTitle));
      currentPos   = null;
      isDelete     = false;
      continue;
    }

    // Body line
    if (currentId !== null && !isDelete) {
      currentLines.push(line);
    }
  }
  flush();

  // ── Fallback: model returned prose with no headings at all ──
  if (sections.length === 0 && deletedIds.length === 0) {
    const content = visibleRaw.trim();
    if (content) {
      sections.push({
        id:       'response',
        title:    'Response',
        content,
        position: null,
      });
    }
  }

  return { sections, deletedIds, duplicateIds };
}

function stripHectraInternalNotes(raw) {
  return String(raw || '')
    .replace(/\n?---[ \t]*\nИСТОРИЯ ИЗМЕНЕНИЙ:[\s\S]*$/i, '')
    .replace(/\n?ИСТОРИЯ ИЗМЕНЕНИЙ:[\s\S]*$/i, '')
    .trim();
}
