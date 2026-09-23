// ============================================================
//  HECTRA — Pure request/response boundary for structure AI help
// ============================================================

(function (scope) {
  'use strict';

  const DEFAULT_SYSTEM_PROMPT = `You revise exactly one section inside an unsaved Hectra document draft.
Use the supplied draft only as context and follow the user's instruction for the target section.
Return exactly one complete Markdown section with the requested section id.
Do not return DELETE, position markers, changelogs, other sections, or commentary.`;

  function engineFor(input) {
    if (input?.engine) return input.engine;
    if (scope.HectraEditEngine) return scope.HectraEditEngine;
    if (typeof require === 'function') return require('./editEngine.js');
    return null;
  }

  function orderedSections(snapshot) {
    const byId = new Map((snapshot.sections || []).map(section => [section.id, section]));
    return (snapshot.order || []).map(id => byId.get(id)).filter(Boolean);
  }

  function asMarkdown(snapshot) {
    return orderedSections(snapshot)
      .map(section => `## ${section.title || section.id} [#${section.id}]\n${section.content || ''}`)
      .join('\n\n');
  }

  function buildRequest(input = {}) {
    const engine = engineFor(input);
    if (!engine) return { ok: false, error: 'The edit engine is unavailable.' };
    const validation = engine.validateSnapshot(input.snapshot);
    if (!validation.valid) return { ok: false, error: validation.errors.join(' ') };

    const sectionId = String(input.sectionId || '').trim();
    const instruction = String(input.instruction || '').trim();
    const target = validation.snapshot.sections.find(section => section.id === sectionId);
    if (!target) return { ok: false, error: `Section ${sectionId || '(unknown)'} is unavailable in this draft.` };
    if (!instruction) return { ok: false, error: 'Describe what the agent should write in this section.' };

    const systemPrompt = String(input.systemPrompt || scope.HectraConfig?.STRUCTURE_SECTION_SYSTEM_PROMPT || DEFAULT_SYSTEM_PROMPT);
    return {
      ok: true,
      sectionId,
      messages: [
        { role: 'system', content: systemPrompt },
        {
          role: 'user',
          content: [
            `Target section id: ${sectionId}`,
            `Current target title: ${target.title || sectionId}`,
            `Instruction: ${instruction}`,
            'Unsaved document draft (reference only):',
            asMarkdown(validation.snapshot),
            `Return exactly:\n## <title> [#${sectionId}]\n<complete section content>`,
          ].join('\n\n'),
        },
      ],
    };
  }

  function parseSuggestion(parsed, sectionId) {
    const id = String(sectionId || '').trim();
    const sections = Array.isArray(parsed?.sections) ? parsed.sections : [];
    const deletedIds = Array.isArray(parsed?.deletedIds) ? parsed.deletedIds : [];
    const duplicateIds = Array.isArray(parsed?.duplicateIds) ? parsed.duplicateIds : [];

    if (deletedIds.length) return { ok: false, error: 'The agent proposed a deletion instead of section content.' };
    if (duplicateIds.length || sections.length !== 1) {
      return { ok: false, error: 'The agent must return exactly one section.' };
    }

    const section = sections[0];
    if (!section || section.id !== id) {
      return { ok: false, error: `The agent returned a different section id. Expected ${id}.` };
    }
    if (section.position) {
      return { ok: false, error: 'The agent tried to change structure. Only this section content is allowed here.' };
    }

    const content = String(section.content || '').trim();
    if (!content) return { ok: false, error: 'The agent returned empty section content.' };
    return {
      ok: true,
      section: {
        id,
        title: String(section.title || id).trim() || id,
        content,
        position: null,
      },
    };
  }

  const api = Object.freeze({ DEFAULT_SYSTEM_PROMPT, buildRequest, parseSuggestion, asMarkdown });
  scope.HectraStructureAssistant = api;
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
})(typeof globalThis !== 'undefined' ? globalThis : this);
