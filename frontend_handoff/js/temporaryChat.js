// ============================================================
//  HECTRA — In-memory, single-branch temporary Q&A session
// ============================================================

(function (scope) {
  'use strict';

  const DEFAULT_SYSTEM_PROMPT = `You are answering questions about one frozen content block from a Hectra branch.
Treat the supplied branch block as reference-only context.
Answer the user's questions directly.
Do not propose or apply document edits unless the user only asks for an explanation of a possible edit.
Do not claim access to the rest of the branch, other branches, or later changes.`;

  function clone(value) {
    return value === undefined ? undefined : JSON.parse(JSON.stringify(value));
  }

  function deepFreeze(value) {
    if (!value || typeof value !== 'object' || Object.isFrozen(value)) return value;
    Object.freeze(value);
    for (const child of Object.values(value)) deepFreeze(child);
    return value;
  }

  function sourceText(sourceBlock) {
    if (typeof sourceBlock === 'string') return sourceBlock;
    if (typeof sourceBlock?.markdown === 'string') return sourceBlock.markdown;
    const sections = Array.isArray(sourceBlock?.sections) ? sourceBlock.sections : [];
    return sections
      .map(section => `## ${section.title || section.id} [#${section.id}]\n${section.content || ''}`)
      .join('\n\n');
  }

  function createManager(options = {}) {
    let session = null;
    let sequence = 0;
    const now = typeof options.now === 'function' ? options.now : () => Date.now();
    const makeId = typeof options.makeId === 'function'
      ? options.makeId
      : prefix => `${prefix}_${now()}_${(++sequence).toString(36)}`;

    function open(input = {}) {
      if (session) return { ok: false, error: 'Close or reset the current temporary chat before choosing another branch.' };
      const branchId = typeof input.sourceBranchId === 'string' ? input.sourceBranchId.trim() : '';
      const block = clone(input.sourceBlock);
      if (!branchId) return { ok: false, error: 'Choose one branch for the temporary chat.' };
      if (!block || !sourceText(block).trim()) return { ok: false, error: 'This branch has no content block to ask about.' };

      session = {
        sessionId: makeId('temp'),
        sourceBranchId: branchId,
        sourceBranchName: String(input.sourceBranchName || branchId),
        sourceBlock: deepFreeze(block),
        capturedAtMs: now(),
        messages: [],
        status: 'ready',
        error: '',
      };
      return { ok: true, session };
    }

    function close() {
      const existed = !!session;
      session = null;
      return existed;
    }

    function reset() { return close(); }

    function getSession() { return session; }

    function completedPairs(maxPairs = 5) {
      if (!session) return [];
      const pairs = [];
      let current = null;
      for (const message of session.messages) {
        if (message.role === 'user' && message.status === 'complete') current = message;
        if (message.role === 'assistant' && current) {
          pairs.push([current, message]);
          current = null;
        }
      }
      return pairs.slice(-Math.max(0, maxPairs));
    }

    function buildMessages(questionMessage, maxPairs = 5) {
      if (!session || !questionMessage) return null;
      const systemPrompt = String(options.systemPrompt || scope.HectraConfig?.TEMPORARY_CHAT_SYSTEM_PROMPT || DEFAULT_SYSTEM_PROMPT);
      const history = completedPairs(maxPairs).flatMap(([user, assistant]) => [
        { role: 'user', content: user.text },
        { role: 'assistant', content: assistant.text },
      ]);
      return [
        { role: 'system', content: systemPrompt },
        {
          role: 'user',
          content: `Frozen Hectra branch block (reference only):\n\n${sourceText(session.sourceBlock)}`,
        },
        ...history,
        { role: 'user', content: questionMessage.text },
      ];
    }

    function beginQuestion(text, maxPairs = 5) {
      if (!session) return { ok: false, error: 'The temporary chat is closed.' };
      if (session.status === 'loading') return { ok: false, error: 'Wait for the current answer.' };
      const question = String(text || '').trim();
      if (!question) return { ok: false, error: 'Enter a question.' };

      const message = {
        id: makeId('temp_user'),
        role: 'user',
        text: question,
        status: 'pending',
        createdAtMs: now(),
      };
      session.messages.push(message);
      session.status = 'loading';
      session.error = '';
      return { ok: true, question: message, requestMessages: buildMessages(message, maxPairs) };
    }

    function resolve(answer) {
      if (!session || session.status !== 'loading') return false;
      const pending = [...session.messages].reverse().find(message => message.role === 'user' && message.status === 'pending');
      if (!pending) return false;
      pending.status = 'complete';
      session.messages.push({
        id: makeId('temp_assistant'),
        role: 'assistant',
        text: String(answer || '').trim(),
        status: 'complete',
        createdAtMs: now(),
      });
      session.status = 'ready';
      session.error = '';
      return true;
    }

    function fail(error) {
      if (!session) return false;
      const pending = [...session.messages].reverse().find(message => message.role === 'user' && message.status === 'pending');
      if (pending) pending.status = 'error';
      session.status = 'error';
      session.error = String(error?.message || error || 'The model request failed.');
      return true;
    }

    function retry(maxPairs = 5) {
      if (!session || session.status !== 'error') return { ok: false, error: 'There is no failed question to retry.' };
      const question = [...session.messages].reverse().find(message => message.role === 'user' && message.status === 'error');
      if (!question) return { ok: false, error: 'There is no failed question to retry.' };
      question.status = 'pending';
      session.status = 'loading';
      session.error = '';
      return { ok: true, question, requestMessages: buildMessages(question, maxPairs) };
    }

    return Object.freeze({ open, close, reset, getSession, beginQuestion, resolve, fail, retry, buildMessages });
  }

  const defaultManager = createManager();
  const api = Object.freeze({
    DEFAULT_SYSTEM_PROMPT,
    createManager,
    open: defaultManager.open,
    close: defaultManager.close,
    reset: defaultManager.reset,
    getSession: defaultManager.getSession,
    beginQuestion: defaultManager.beginQuestion,
    resolve: defaultManager.resolve,
    fail: defaultManager.fail,
    retry: defaultManager.retry,
    buildMessages: defaultManager.buildMessages,
  });

  scope.HectraTemporaryChat = api;
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
})(typeof globalThis !== 'undefined' ? globalThis : this);
