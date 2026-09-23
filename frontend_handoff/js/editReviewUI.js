// ============================================================
//  HECTRA — Edit proposal review + local structure draft UI
// ============================================================

(function (scope) {
  'use strict';

  const UI = {
    proposal: null,
    accepted: new Set(),
    callbacks: null,
    structure: null,
    _toastTimer: null,
    _openFrame: null,
    _structureAgentSeq: 0,

    init() {
      const modal = document.getElementById('edit-review-modal');
      if (!modal || modal.dataset.bound === 'true') return;
      modal.dataset.bound = 'true';
      modal.addEventListener('click', event => this._handleClick(event));
      modal.addEventListener('input', event => this._handleStructureInput(event));
      modal.addEventListener('dragstart', event => this._handleDragStart(event));
      modal.addEventListener('dragover', event => {
        if (event.target.closest('.structure-row')) event.preventDefault();
      });
      modal.addEventListener('drop', event => this._handleDrop(event));
      document.addEventListener('keydown', event => {
        if (event.key !== 'Escape' || !this.proposal || modal.hidden) return;
        event.preventDefault();
        event.stopPropagation();
        this._discardProposal();
      }, true);
    },

    openProposal(proposal, callbacks = {}) {
      this.init();
      this.proposal = proposal;
      this.callbacks = callbacks;
      this.accepted = new Set(proposal.operations
        .filter(operation => operation.authorization === 'scoped')
        .map(operation => operation.operationId));
      for (const operationId of this.accepted) callbacks.onDecision?.(operationId, 'accepted');
      this.structure = null;
      this._renderProposal();
      this._open();
    },

    closeProposal() {
      this.proposal = null;
      this.accepted = new Set();
      this.callbacks = null;
      this._close();
    },

    showProposalError(message) {
      const error = document.querySelector('#edit-review-modal .edit-review-error');
      if (!error) return;
      error.textContent = String(message || 'The proposal could not be applied.');
      error.hidden = false;
    },

    openStructureEditor(baseSnapshot, callbacks = {}) {
      this.init();
      const engine = scope.HectraEditEngine;
      const validation = engine.validateSnapshot(baseSnapshot);
      if (!validation.valid) {
        callbacks.onError?.(validation.errors.join(' '));
        return;
      }
      this.proposal = null;
      this.accepted = new Set();
      this.callbacks = callbacks;
      this.structure = {
        base: engine.clone(validation.snapshot),
        working: engine.clone(validation.snapshot),
        undo: [],
        draggedId: null,
        nextId: 1,
        agent: null,
        newSectionIds: new Set(),
      };
      this._renderStructure();
      this._open();
    },

    closeStructureEditor() {
      this.structure = null;
      this.callbacks = null;
      this._close();
    },

    showUndoToast(commit, onUndo) {
      this.dismissToast();
      const toast = document.createElement('div');
      toast.className = 'edit-undo-toast';
      toast.setAttribute('role', 'status');
      toast.innerHTML = `
        <span>All scoped changes applied</span>
        <button type="button">Revert applied change</button>
        <span class="edit-undo-countdown" aria-hidden="true"></span>`;
      document.body.appendChild(toast);
      requestAnimationFrame(() => toast.classList.add('is-open'));
      toast.querySelector('button').addEventListener('click', async () => {
        clearTimeout(this._toastTimer);
        const result = await onUndo?.(commit);
        if (result?.ok === false) this.showProposalError(result.error);
        this.dismissToast();
      });
      this._toastTimer = setTimeout(() => this.dismissToast(), 5000);
    },

    dismissToast() {
      clearTimeout(this._toastTimer);
      this._toastTimer = null;
      const toast = document.querySelector('.edit-undo-toast');
      if (!toast) return;
      toast.classList.remove('is-open');
      setTimeout(() => toast.remove(), 160);
    },

    _open() {
      const modal = document.getElementById('edit-review-modal');
      if (!modal) return;
      if (this._openFrame !== null) cancelAnimationFrame(this._openFrame);
      modal.hidden = false;
      this._openFrame = requestAnimationFrame(() => {
        this._openFrame = null;
        if (!modal.hidden && (this.proposal || this.structure)) modal.classList.add('is-open');
      });
    },

    _close() {
      const modal = document.getElementById('edit-review-modal');
      if (!modal) return;
      if (this._openFrame !== null) cancelAnimationFrame(this._openFrame);
      this._openFrame = null;
      modal.classList.remove('is-open');
      setTimeout(() => {
        if (!modal.classList.contains('is-open')) {
          modal.hidden = true;
          modal.innerHTML = '';
        }
      }, 150);
    },

    _renderProposal() {
      const modal = document.getElementById('edit-review-modal');
      const proposal = this.proposal;
      if (!modal || !proposal) return;
      const invalidCount = proposal.operations.filter(operation => operation.authorization === 'invalid').length;
      const approvalCount = proposal.operations.filter(operation => operation.authorization === 'requires-approval').length;
      const acceptedCount = this.accepted.size;

      modal.innerHTML = `
        <div class="edit-review-panel" role="dialog" aria-modal="true" aria-labelledby="edit-review-title">
          <div class="edit-review-head">
            <div>
              <div class="edit-review-kicker">Staged document edit</div>
              <h2 id="edit-review-title">Review proposed changes</h2>
              <p>${proposal.operations.length} operation${proposal.operations.length === 1 ? '' : 's'}${approvalCount ? ` · ${approvalCount} need extra approval` : ''}${invalidCount ? ` · ${invalidCount} invalid` : ''}</p>
            </div>
            <button class="edit-review-close" type="button" data-edit-review="discard-proposal" aria-label="Discard proposal">×</button>
          </div>
          <div class="edit-review-error" hidden></div>
          <div class="edit-review-list">
            ${proposal.operations.length
              ? proposal.operations.map(operation => this._operationCard(operation)).join('')
              : '<div class="edit-review-empty">The model proposed no document changes.</div>'}
          </div>
          <div class="edit-review-foot">
            <button class="ui-btn" type="button" data-edit-review="discard-proposal">Discard proposal</button>
            <button class="ui-btn" type="button" data-edit-review="include-all" ${proposal.operations.some(operation => operation.authorization !== 'invalid') ? '' : 'disabled'}>Include all reviewable</button>
            <button class="ui-btn" type="button" data-edit-review="exclude-all" ${acceptedCount ? '' : 'disabled'}>Exclude all</button>
            <span class="edit-review-foot-note">${acceptedCount ? `${acceptedCount} included in one atomic version` : 'Include at least one change to apply'}</span>
            <button class="ui-btn edit-review-primary" type="button" data-edit-review="apply-included" ${acceptedCount ? '' : 'disabled'}>Apply included changes</button>
          </div>
        </div>`;
    },

    _operationCard(operation) {
      const selected = this.accepted.has(operation.operationId);
      const structural = this._isStructural(operation);
      const status = operation.authorization === 'scoped'
        ? 'Within selected sections'
        : operation.authorization === 'requires-approval'
          ? (structural ? 'Changes document structure' : 'Outside selected sections')
          : 'Cannot apply';
      const authorizationHelp = operation.authorization === 'requires-approval'
        ? (structural
          ? 'Include only if you want to authorize this insert, deletion, or move.'
          : 'Include only if you want to authorize this additional change.')
        : '';
      const title = operation.after?.title || operation.before?.title || operation.sectionId;
      const kind = operation.kinds.length ? operation.kinds.join(' + ') : 'invalid operation';
      const before = this._sectionText(operation.before);
      const after = this._sectionText(operation.after);

      return `
        <article class="edit-operation is-${operation.authorization}${selected ? ' is-accepted' : ''}" data-operation-id="${this._esc(operation.operationId)}">
          <div class="edit-operation-head">
            <div>
              <strong>${this._esc(title)}</strong>
              <span>[#${this._esc(operation.sectionId)}] · ${this._esc(kind)}</span>
            </div>
            <span class="edit-operation-auth">${status}</span>
          </div>
          ${authorizationHelp ? `<p class="edit-operation-reason">${this._esc(authorizationHelp)}</p>` : ''}
          ${operation.reason ? `<p class="edit-operation-reason">${this._esc(operation.reason)}</p>` : ''}
          <div class="edit-operation-compare${before && after ? '' : ' is-single'}">
            ${before ? `<div><label>Before</label><pre>${this._esc(before)}</pre></div>` : ''}
            ${after ? `<div><label>After</label><pre>${this._esc(after)}</pre></div>` : ''}
          </div>
          <div class="edit-operation-actions">
            ${operation.authorization === 'invalid'
              ? '<span class="edit-operation-excluded">Excluded</span>'
              : `<button class="ui-btn" type="button" data-edit-review="exclude-one" ${selected ? '' : 'disabled'}>Exclude</button>
                 <button class="ui-btn" type="button" data-edit-review="include-one" ${selected ? 'disabled' : ''}>Include</button>`}
          </div>
        </article>`;
    },

    _sectionText(section) {
      if (!section) return '';
      return `${section.title || section.id}\n${section.content || ''}`.trim();
    },

    async _handleClick(event) {
      const action = event.target.closest('[data-edit-review]')?.dataset.editReview;
      if (!action) return;

      if (this.proposal) {
        const operationId = event.target.closest('[data-operation-id]')?.dataset.operationId;
        if (action === 'include-one' && operationId) {
          const operation = this.proposal.operations.find(item => item.operationId === operationId);
          if (operation?.authorization !== 'invalid') {
            this.accepted.add(operationId);
            this.callbacks?.onDecision?.(operationId, 'accepted');
            this._renderProposal();
          }
          return;
        }
        if (action === 'exclude-one' && operationId) {
          this.accepted.delete(operationId);
          this.callbacks?.onDecision?.(operationId, 'rejected');
          this._renderProposal();
          return;
        }
        if (action === 'apply-included') {
          await this._commit([...this.accepted]);
          return;
        }
        if (action === 'include-all') {
          const ids = this.proposal.operations
            .filter(operation => operation.authorization !== 'invalid')
            .map(operation => operation.operationId);
          this.accepted = new Set(ids);
          for (const operation of this.proposal.operations) {
            this.callbacks?.onDecision?.(
              operation.operationId,
              operation.authorization === 'invalid' ? 'rejected' : 'accepted'
            );
          }
          this._renderProposal();
          return;
        }
        if (action === 'exclude-all') {
          this.accepted.clear();
          for (const operation of this.proposal.operations) {
            this.callbacks?.onDecision?.(operation.operationId, 'rejected');
          }
          this._renderProposal();
          return;
        }
        if (action === 'discard-proposal') {
          await this._discardProposal();
          return;
        }
      }

      if (!this.structure) return;
      const item = event.target.closest('[data-section-id]');
      const id = item?.dataset.sectionId;
      if (action === 'structure-cancel') {
        this.callbacks?.onCancel?.();
        this.closeStructureEditor();
      } else if (action === 'structure-undo') {
        const previous = this.structure.undo.pop();
        if (previous) this.structure.working = previous;
        if (this.structure.agent && !this.structure.working.order.includes(this.structure.agent.sectionId)) {
          this.structure.agent = null;
        }
        this._renderStructure();
      } else if (action === 'structure-save') {
        const result = await this.callbacks?.onSave?.(
          scope.HectraEditEngine.clone(this.structure.working),
          scope.HectraEditEngine.clone(this.structure.base)
        );
        if (result?.ok === false) this._showStructureError(result.error);
        else this.closeStructureEditor();
      } else if (id && action === 'structure-agent-open') {
        this._openStructureAgent(id);
      } else if (id && action === 'structure-agent-close') {
        this.structure.agent = null;
        this._renderStructure();
      } else if (id && action === 'structure-agent-generate') {
        await this._generateStructureSuggestion(id);
      } else if (id && action === 'structure-agent-use') {
        const suggestion = this.structure.agent?.sectionId === id
          ? this.structure.agent.suggestion
          : null;
        if (suggestion) {
          this.structure.agent = null;
          this._structureCommand({ type: 'update', sectionId: id, section: suggestion });
        }
      } else if (id && action === 'structure-delete') {
        if (this.structure.agent?.sectionId === id) this.structure.agent = null;
        this._structureCommand({ type: 'delete', sectionId: id });
      } else if (id && (action === 'structure-add-before' || action === 'structure-add-after')) {
        const section = this._newSection();
        const added = this._structureCommand({
          type: 'add',
          section,
          position: { type: action.endsWith('before') ? 'before' : 'after', ref: id },
        });
        if (added) {
          this.structure.newSectionIds.add(section.id);
          this._openStructureAgent(section.id, true);
        }
      } else if (id && (action === 'structure-up' || action === 'structure-down')) {
        const order = this.structure.working.order;
        const index = order.indexOf(id);
        if (action === 'structure-up' && index > 0) {
          this._structureCommand({ type: 'move', sectionId: id, position: { type: 'before', ref: order[index - 1] } });
        } else if (action === 'structure-down' && index >= 0 && index < order.length - 1) {
          this._structureCommand({ type: 'move', sectionId: id, position: { type: 'after', ref: order[index + 1] } });
        }
      }
    },

    async _commit(ids) {
      const buttons = document.querySelectorAll('#edit-review-modal button');
      buttons.forEach(button => { button.disabled = true; });
      const result = await this.callbacks?.onCommit?.(this.proposal, ids);
      if (result?.ok === false) {
        this.showProposalError(result.error);
        buttons.forEach(button => { button.disabled = false; });
        return;
      }
      this.closeProposal();
    },

    async _discardProposal() {
      if (!this.proposal) return;
      await this.callbacks?.onDiscard?.(this.proposal);
      this.closeProposal();
    },

    _isStructural(operation) {
      return (operation?.kinds || []).some(kind => ['insert', 'delete', 'move'].includes(kind));
    },

    _renderStructure() {
      const modal = document.getElementById('edit-review-modal');
      if (!modal || !this.structure) return;
      const sections = new Map(this.structure.working.sections.map(section => [section.id, section]));
      const agentLoading = this.structure.agent?.status === 'loading';
      modal.innerHTML = `
        <div class="edit-review-panel structure-panel" role="dialog" aria-modal="true" aria-labelledby="structure-title">
          <div class="edit-review-head">
            <div>
              <div class="edit-review-kicker">Local structural batch</div>
              <h2 id="structure-title">Reorder, add or remove sections</h2>
              <p>Nothing changes until you apply the structure draft.</p>
              <p class="structure-guidance">To rewrite an existing section, save the structure and use Change section in the document.</p>
            </div>
            <button class="edit-review-close" type="button" data-edit-review="structure-cancel" aria-label="Discard unsaved structure changes" title="Discard unsaved structure changes">×</button>
          </div>
          <div class="edit-review-error" hidden></div>
          <div class="structure-list">
            ${this.structure.working.order.map((id, index) => {
              const section = sections.get(id);
              return `<div class="structure-item" data-section-id="${this._esc(id)}">
                <div class="structure-row" draggable="true" data-section-id="${this._esc(id)}">
                  <span class="structure-handle" title="Drag to reorder">⋮⋮</span>
                  <span class="structure-index">${index + 1}</span>
                  <div class="structure-copy">
                    <strong>${this._esc(section?.title || id)}</strong>
                    <small>[#${this._esc(id)}]${section?.content ? ` · ${this._esc(this._preview(section.content, 54))}` : ' · empty'}</small>
                  </div>
                  <div class="structure-actions">
                    <button type="button" data-edit-review="structure-up" ${index === 0 ? 'disabled' : ''} title="Move up">↑</button>
                    <button type="button" data-edit-review="structure-down" ${index === this.structure.working.order.length - 1 ? 'disabled' : ''} title="Move down">↓</button>
                    <button type="button" data-edit-review="structure-add-before">Add before</button>
                    <button type="button" data-edit-review="structure-add-after">Add after</button>
                    ${this._canDraftSection(section) ? '<button type="button" class="structure-agent-open" data-edit-review="structure-agent-open">Draft section with agent</button>' : ''}
                    <button type="button" class="is-danger" data-edit-review="structure-delete">Delete</button>
                  </div>
                </div>
                ${this.structure.agent?.sectionId === id ? this._renderStructureAgent(section) : ''}
              </div>`;
            }).join('')}
          </div>
          <div class="edit-review-foot">
            <button class="ui-btn" type="button" data-edit-review="structure-cancel" title="Discard unsaved structure changes">Cancel</button>
            <button class="ui-btn" type="button" data-edit-review="structure-undo" ${this.structure.undo.length ? '' : 'disabled'}>Undo last draft action</button>
            <span class="edit-review-foot-note">${this.structure.undo.length} unsaved action${this.structure.undo.length === 1 ? '' : 's'}</span>
            <button class="ui-btn edit-review-primary" type="button" data-edit-review="structure-save" ${this.structure.undo.length && !agentLoading ? '' : 'disabled'}>Apply structure changes</button>
          </div>
        </div>`;
    },

    _renderStructureAgent(section) {
      const agent = this.structure?.agent;
      if (!agent) return '';
      const loading = agent.status === 'loading';
      const suggestion = agent.suggestion;
      return `<div class="structure-agent" data-section-id="${this._esc(agent.sectionId)}">
        <div class="structure-agent-head">
          <div>
            <strong>Describe this section</strong>
            <span>The suggestion stays in this unsaved draft until you apply structure changes.</span>
          </div>
          <button type="button" data-edit-review="structure-agent-close" aria-label="Close section agent">×</button>
        </div>
        <textarea rows="2" data-structure-agent-instruction aria-label="Describe this section"
          placeholder="Example: Make this new section the conclusion." ${loading || suggestion ? 'disabled' : ''}>${this._esc(agent.instruction)}</textarea>
        ${agent.error ? `<div class="structure-agent-error">${this._esc(agent.error)}</div>` : ''}
        ${suggestion ? `<div class="structure-agent-suggestion">
          <label>Agent suggestion · not used yet</label>
          <strong>${this._esc(suggestion.title || section?.title || agent.sectionId)}</strong>
          <pre>${this._esc(suggestion.content || '')}</pre>
          <div>
            <button class="ui-btn" type="button" data-edit-review="structure-agent-close">Discard suggestion</button>
            <button class="ui-btn edit-review-primary" type="button" data-edit-review="structure-agent-use">Use in draft</button>
          </div>
        </div>` : `<div class="structure-agent-actions">
          <span>${loading ? 'Agent is drafting this section…' : 'The agent may change this section title and content only.'}</span>
          <button class="ui-btn edit-review-primary" type="button" data-edit-review="structure-agent-generate"
            ${loading || !agent.instruction.trim() ? 'disabled' : ''}>${loading ? 'Generating…' : 'Generate suggestion'}</button>
        </div>`}
      </div>`;
    },

    _openStructureAgent(sectionId, isNew = false) {
      if (!this.structure?.working.order.includes(sectionId)) return false;
      const section = this.structure.working.sections.find(item => item.id === sectionId);
      if (!this._canDraftSection(section)) return false;
      this.structure.agent = {
        sectionId,
        instruction: '',
        status: 'ready',
        error: '',
        suggestion: null,
        requestId: null,
        isNew,
      };
      this._renderStructure();
      setTimeout(() => document.querySelector('[data-structure-agent-instruction]')?.focus(), 0);
      return true;
    },

    _canDraftSection(section) {
      if (!section || !this.structure) return false;
      return this.structure.newSectionIds.has(section.id) || !String(section.content || '').trim();
    },

    async _generateStructureSuggestion(sectionId) {
      const agent = this.structure?.agent;
      if (!agent || agent.sectionId !== sectionId || !agent.instruction.trim()) return false;
      const requestId = `structure_agent_${Date.now()}_${++this._structureAgentSeq}`;
      agent.status = 'loading';
      agent.error = '';
      agent.suggestion = null;
      agent.requestId = requestId;
      this._renderStructure();

      let result;
      try {
        result = await this.callbacks?.onAskAgent?.({
          sectionId,
          instruction: agent.instruction,
          snapshot: scope.HectraEditEngine.clone(this.structure.working),
        });
      } catch (error) {
        result = { ok: false, error: error?.message || 'The agent request failed.' };
      }

      const current = this.structure?.agent;
      if (!current || current.requestId !== requestId) return false;
      current.status = 'ready';
      if (!result?.ok) current.error = result?.error || 'The agent returned no usable section.';
      else current.suggestion = scope.HectraEditEngine.clone(result.section);
      this._renderStructure();
      return !!result?.ok;
    },

    _newSection() {
      const existing = new Set(this.structure.working.order);
      let id;
      do { id = `new_section_${this.structure.nextId++}`; } while (existing.has(id));
      return { id, title: 'New section', content: '', position: null };
    },

    _structureCommand(command) {
      const before = scope.HectraEditEngine.clone(this.structure.working);
      const result = scope.HectraEditEngine.applyManualCommand(before, command);
      if (!result.ok) {
        this._showStructureError(result.error);
        return false;
      }
      this.structure.undo.push(before);
      this.structure.working = result.snapshot;
      this._renderStructure();
      return true;
    },

    _handleStructureInput(event) {
      if (!this.structure?.agent || !event.target.matches('[data-structure-agent-instruction]')) return;
      this.structure.agent.instruction = event.target.value;
      this.structure.agent.error = '';
      this.structure.agent.suggestion = null;
      const button = document.querySelector('[data-edit-review="structure-agent-generate"]');
      if (button) button.disabled = !this.structure.agent.instruction.trim();
    },

    _handleDragStart(event) {
      if (!this.structure) return;
      const row = event.target.closest('.structure-row');
      if (!row) return;
      this.structure.draggedId = row.dataset.sectionId;
      event.dataTransfer?.setData('text/plain', row.dataset.sectionId);
      if (event.dataTransfer) event.dataTransfer.effectAllowed = 'move';
    },

    _handleDrop(event) {
      if (!this.structure) return;
      const row = event.target.closest('.structure-row');
      const sourceId = this.structure.draggedId || event.dataTransfer?.getData('text/plain');
      const targetId = row?.dataset.sectionId;
      this.structure.draggedId = null;
      if (!sourceId || !targetId || sourceId === targetId) return;
      event.preventDefault();
      this._structureCommand({ type: 'move', sectionId: sourceId, position: { type: 'before', ref: targetId } });
    },

    _showStructureError(message) {
      const error = document.querySelector('#edit-review-modal .edit-review-error');
      if (!error) return;
      error.textContent = String(message || 'The structural draft is invalid.');
      error.hidden = false;
    },

    _preview(value, limit) {
      const text = String(value || '').replace(/\s+/g, ' ').trim();
      return text.length > limit ? `${text.slice(0, limit)}…` : text;
    },

    _esc(value) {
      return String(value ?? '')
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;');
    },
  };

  scope.HectraEditReviewUI = UI;
})(typeof globalThis !== 'undefined' ? globalThis : this);
