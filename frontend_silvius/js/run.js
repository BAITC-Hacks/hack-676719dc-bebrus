import { request, states, stages } from './hectra-api.js';

const id = new URLSearchParams(location.search).get('id');
const base = `/runs/${encodeURIComponent(id || '')}`;
const content = document.querySelector('#run-content');
const errorBox = document.querySelector('#run-error');
const sourceDialog = document.querySelector('#source-dialog');
const categories = { preserved: 'Сохранение', transfer: 'Перенос', split_merge: 'Разделение или объединение', authority: 'Полномочия', scope: 'Область ответственности', modality: 'Обязательность', deadline: 'Сроки', org_change: 'Структура', potential_loss: 'Возможная потеря', new_function: 'Новая функция', potential_duplication: 'Возможное дублирование', potential_conflict: 'Возможный конфликт', insufficient_data: 'Недостаточно данных' };
const judgeStates = { unreviewed: 'не проверено', passed: 'проверено в указанной области', needs_revision: 'требует исправления', inconclusive: 'недостаточно оснований' };
const humanStates = { unreviewed: 'не принято', confirmed: 'подтверждено', rejected: 'отклонено', edited: 'исправлено' };
let run;
let tab = 'summary';
let refreshing = false;

function el(tag, className = '', text = '') {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text !== undefined && text !== null) node.textContent = String(text);
  return node;
}
function button(label, handler, className = 'button button-outline') {
  const node = el('button', className, label);
  node.type = 'button';
  node.addEventListener('click', () => action(handler));
  return node;
}
function section(title) { const node = el('section', 'run-section'); node.append(el('h2', '', title)); return node; }
function textList(items, className = 'run-list') {
  const list = el('ul', className);
  for (const item of items || []) list.append(el('li', '', item));
  return list;
}
function showError(error) { errorBox.textContent = error.message || String(error); errorBox.hidden = false; }
async function action(work) { try { errorBox.hidden = true; await work(); } catch (error) { showError(error); } }
const enc = encodeURIComponent;

async function refresh() {
  if (refreshing || !id) return;
  refreshing = true;
  try { run = await request(base); render(); }
  catch (error) { showError(error); }
  finally { refreshing = false; }
}
function render() {
  document.querySelector('#run-title').textContent = run.name;
  document.querySelector('#run-subtitle').textContent = `${run.documents.length} документов · создано ${new Date(run.created_at).toLocaleString('ru')}`;
  document.querySelector('#run-state').textContent = states[run.state] || run.state;
  document.querySelector('#run-state').dataset.state = run.state;
  document.querySelector('#run-test-notice').hidden = run.mode !== 'test';
  const progress = document.querySelector('#run-progress');
  const currentTasks = run.tasks.filter(task => task.current !== false);
  const done = currentTasks.filter(task => task.status === 'done').length;
  const total = currentTasks.length;
  progress.textContent = `${run.stage ? stages[run.stage] || run.stage : states[run.state] || run.state}${run.current_task ? ` · ${run.current_task.label}` : ''}. Завершено задач: ${done} из ${total}.`;
  const track = document.querySelector('#run-progress-track');
  track.dataset.running = String(run.state === 'running');
  track.setAttribute('aria-valuetext', total ? `Завершено ${done} из ${total} задач` : 'Подготовка задач');
  if (total) track.setAttribute('aria-valuenow', String(Math.round(done / total * 100)));
  else track.removeAttribute('aria-valuenow');
  document.querySelector('#run-progress-fill').style.width = `${total ? done / total * 100 : 0}%`;
  if (run.last_error) showError(new Error(run.last_error.message));
  else errorBox.hidden = true;
  const resumable = ['draft', 'cancelled', 'interrupted', 'partial', 'prompts_not_configured', 'key_not_configured'].includes(run.state);
  document.querySelector('#run-start').hidden = !resumable;
  document.querySelector('#run-cancel').hidden = run.state !== 'running';
  document.querySelector('#run-synthesize').hidden = !run.plan || !run.report?.stale || run.state === 'running';
  const exportLink = document.querySelector('#run-export');
  exportLink.hidden = !run.report && !run.registry.findings.length;
  exportLink.href = `/api/hectra${base}/export.html`;
  const clarification = document.querySelector('#run-clarification');
  clarification.replaceChildren();
  clarification.hidden = run.state !== 'needs_clarification';
  if (!clarification.hidden) {
    const pending = run.clarifications.find(item => item.status === 'pending');
    if (pending) {
      clarification.append(el('h3', '', 'Уточнение'), el('p', '', pending.question), el('p', 'run-muted', pending.reason));
      const answer = el('textarea', 'text-input');
      answer.maxLength = 12000;
      answer.placeholder = 'Ваше пояснение';
      clarification.append(answer, button('Отправить пояснение', async () => {
        if (!answer.value.trim()) throw new Error('Введите пояснение или пропустите вопрос.');
        await request(`${base}/clarification`, { method: 'POST', body: { answer: answer.value.trim(), skip: false } });
        await refresh();
      }, 'button button-primary'), button('Продолжить без пояснения', async () => {
        await request(`${base}/clarification`, { method: 'POST', body: { skip: true } });
        await refresh();
      }));
    }
  }
  document.querySelectorAll('[data-run-tab]').forEach(item => {
    if (item.dataset.runTab === tab) item.setAttribute('aria-current', 'page');
    else item.removeAttribute('aria-current');
  });
  content.replaceChildren();
  if (tab === 'summary') renderSummary();
  else if (tab === 'findings') renderFindings();
  else if (tab === 'map') renderMap();
  else if (tab === 'functions') renderFunctions();
  else if (tab === 'documents') renderDocuments();
  else if (tab === 'diff') renderDiff();
  else renderCoverage();
}
function renderSummary() {
  if (run.state === 'prompts_not_configured') content.append(el('p', 'run-notice', 'Системные промпты не заполнены. Документы и текстовый diff доступны.'));
  if (run.state === 'key_not_configured') content.append(el('p', 'run-notice', 'Для смыслового анализа вставьте сам API-ключ в pipeline/server-config.local.cjs и перезапустите сервер. Ссылка вместо ключа не подходит. Документы и текстовый diff доступны.'));
  if (run.report?.stale) content.append(el('p', 'run-notice', 'Заключение устарело после изменения реестра. Обновите его кнопкой выше.'));
  const report = run.report;
  if (!report) content.append(el('p', 'run-muted', 'Заключение появится после завершения анализа. Пока можно просмотреть документы и текстовый diff.'));
  else for (const [key, title] of [['overview', 'Главное'], ['questions', 'Вопросы для проверки'], ['recommendations', 'Рекомендации']]) {
    const block = section(title);
    const rows = report[key] || [];
    if (!rows.length) block.append(el('p', 'run-muted', 'Нет записей.'));
    for (const item of rows) {
      const row = el('article', 'run-card');
      row.append(el('p', '', item.text));
      const refs = el('div', 'run-ref-list');
      for (const findingId of item.finding_refs || []) {
        const finding = run.registry.findings.find(value => value.id === findingId);
        if (finding) refs.append(button(`Находка: ${finding.claim.slice(0, 90)}`, () => { tab = 'findings'; render(); document.getElementById(`finding-${finding.id}`)?.scrollIntoView(); }));
      }
      row.append(refs);
      block.append(row);
    }
    content.append(block);
  }
  const limits = section('Ограничения');
  limits.append(textList(run.registry.limitations));
  content.append(limits);
}
function sourceButton(ref) {
  const doc = run.documents.find(item => item.id === ref.document_id);
  const evidence = run.evidence.find(item => item.ref.document_id === ref.document_id && item.ref.extraction_version === ref.extraction_version && item.ref.block_id === ref.block_id);
  return button(`${doc?.name || 'Источник'}${evidence?.coordinate ? ` · ${evidence.coordinate}` : ''}`, () => openSource(ref), 'run-source-button');
}
function renderFindings() {
  const findings = run.registry.findings;
  const heading = section(`Находки (${findings.length})`);
  heading.append(el('p', 'run-muted', 'Каждый вывод требует проверки ответственным сотрудником. Статус проверки агента и решение человека показаны отдельно.'));
  if (!findings.length) heading.append(el('p', '', 'Пока нет находок.'));
  for (const finding of findings) {
    const card = el('article', 'run-card run-finding');
    card.id = `finding-${finding.id}`;
    card.append(el('h3', '', finding.claim));
    card.append(el('p', 'run-muted', `${categories[finding.category] || finding.category} · Проверка агента: ${judgeStates[finding.judge_status] || finding.judge_status} · Решение человека: ${humanStates[finding.human_status] || finding.human_status}`));
    if (finding.explanation) card.append(el('p', '', finding.explanation));
    if (finding.uncertainty?.length) card.append(textList(finding.uncertainty));
    const refs = el('div', 'run-ref-list');
    for (const ref of [...finding.before_refs, ...finding.after_refs]) refs.append(sourceButton(ref));
    card.append(refs);
    const controls = el('div', 'run-actions');
    for (const [decision, title] of [['confirmed', 'Подтвердить'], ['rejected', 'Отклонить']]) controls.append(button(title, async () => {
      await request(`${base}/findings/${enc(finding.id)}/review`, { method: 'POST', body: { version: finding.version, decision } });
      await refresh();
    }));
    controls.append(button('Изменить формулировку', async () => {
      const text = prompt('Новая формулировка находки', finding.claim);
      if (text === null) return;
      if (!text.trim()) throw new Error('Формулировка не может быть пустой.');
      await request(`${base}/findings/${enc(finding.id)}/review`, { method: 'POST', body: { version: finding.version, decision: 'edited', text: text.trim() } });
      await refresh();
    }));
    card.append(controls);
    heading.append(card);
  }
  content.append(heading);
}
function renderMap() {
  const block = section('Карта соответствий');
  const groups = run.plan?.groups || [];
  if (!groups.length) block.append(el('p', 'run-muted', 'Карта появится после маршрутизации документов.'));
  for (const group of groups) {
    const card = el('article', 'run-card');
    card.append(el('h3', '', group.label), el('p', 'run-muted', `${group.relation} · ${group.method}`));
    for (const [side, ranges] of [['До', group.before], ['После', group.after]]) {
      const names = ranges.map(range => run.documents.find(doc => doc.id === range.document_id)?.name || 'Неизвестный документ');
      card.append(el('p', '', `${side}: ${[...new Set(names)].join('; ') || 'нет соответствия'}`));
    }
    if (group.rationale) card.append(el('p', '', group.rationale));
    const refs = el('div', 'run-ref-list');
    for (const ref of group.evidence_refs || []) refs.append(sourceButton(ref));
    card.append(refs);
    block.append(card);
  }
  if (run.plan?.remainder?.length) {
    block.append(el('h3', '', 'Участки без подтверждённого соответствия'));
    block.append(textList(run.plan.remainder.map(item => `${item.status}: ${item.reason}`)));
  }
  content.append(block);
  const links = section('Связи подразделений');
  const units = run.registry.org_units || [];
  if (!run.registry.org_links?.length) links.append(el('p', 'run-muted', 'Связи пока не установлены.'));
  for (const link of run.registry.org_links || []) {
    const name = id => units.find(unit => unit.id === id)?.name?.value || 'Неизвестное подразделение';
    const card = el('article', 'run-card');
    card.append(el('p', '', `${link.before_ids.map(name).join('; ') || '—'} → ${link.after_ids.map(name).join('; ') || '—'}`), el('p', 'run-muted', link.relation));
    const refs = el('div', 'run-ref-list');
    for (const ref of link.evidence_refs || []) refs.append(sourceButton(ref));
    card.append(refs);
    links.append(card);
  }
  content.append(links);
}
function renderFunctions() {
  const block = section('Реестр функций');
  const functions = run.registry.functions || [];
  if (!functions.length) block.append(el('p', 'run-muted', 'Функции появятся после извлечения моделью.'));
  for (const item of functions) {
    const card = el('article', 'run-card');
    card.append(el('h3', '', `${item.side === 'A' ? 'До' : 'После'} · ${item.action?.value || 'Действие не установлено'} ${item.object?.value || ''}`));
    for (const [key, label] of [['responsible', 'Ответственный'], ['scope', 'Область'], ['modality', 'Полномочие'], ['conditions', 'Условия'], ['deadlines', 'Сроки'], ['exceptions', 'Исключения']]) {
      if (item[key]?.value) card.append(el('p', '', `${label}: ${item[key].value}`));
    }
    if (item.uncertainty?.length) card.append(textList(item.uncertainty));
    const refs = el('div', 'run-ref-list');
    for (const ref of item.source_refs || []) refs.append(sourceButton(ref));
    card.append(refs);
    block.append(card);
  }
  content.append(block);
  const links = section('Сопоставление функций');
  if (!run.registry.function_links?.length) links.append(el('p', 'run-muted', 'Связи функций пока не установлены.'));
  for (const link of run.registry.function_links || []) {
    const name = id => { const item = functions.find(value => value.id === id); return item ? `${item.action?.value || 'Действие'} ${item.object?.value || ''}` : 'Неизвестная функция'; };
    const card = el('article', 'run-card');
    card.append(el('p', '', `${link.before_ids.map(name).join('; ') || '—'} → ${link.after_ids.map(name).join('; ') || '—'}`), el('p', 'run-muted', link.relation));
    const refs = el('div', 'run-ref-list');
    for (const ref of link.evidence_refs || []) refs.append(sourceButton(ref));
    card.append(refs);
    links.append(card);
  }
  content.append(links);
}
function renderDocuments() {
  const frozen = !!run.prompt_hashes || !!run.plan;
  for (const [side, title] of [['A', 'До изменений'], ['B', 'После изменений']]) {
    const group = section(title);
    if (!frozen) {
      const input = el('input');
      input.type = 'file';
      input.accept = '.pdf,.docx,.xlsx';
      input.multiple = true;
      input.setAttribute('aria-label', `Добавить документы: ${title}`);
      input.addEventListener('change', () => action(async () => {
        for (const file of input.files) {
          const body = new FormData();
          body.set('side', side);
          body.set('name', file.name);
          body.set('file', file);
          await request(`${base}/documents`, { method: 'POST', body });
        }
        await refresh();
      }));
      group.append(input);
    }
    for (const doc of run.documents.filter(item => item.side === side)) {
      const card = el('article', 'run-card');
      card.append(el('h3', '', doc.name), el('p', 'run-muted', `${{ ok: 'Текст извлечён', partial: 'Извлечён с ограничениями', failed: 'Текст не извлечён' }[doc.status] || doc.status} · ${doc.block_count} блоков · ${doc.text_chars} символов`));
      if (doc.warnings?.length) card.append(textList(doc.warnings));
      card.append(button('Читать извлечённый текст', () => openSource({ document_id: doc.id, extraction_version: doc.extraction_version })));
      const original = el('a', 'button button-outline', 'Скачать исходный файл');
      original.href = `/api/hectra${base}/originals/${enc(doc.id)}`;
      card.append(original);
      if (!frozen) card.append(button('Убрать документ', async () => {
        await request(`${base}/documents/${enc(doc.id)}`, { method: 'DELETE' });
        await refresh();
      }));
      group.append(card);
    }
    content.append(group);
  }
}
async function openSource(ref, offset = 0) {
  const params = new URLSearchParams({ version: String(ref.extraction_version), count: '30' });
  if (ref.block_id) { params.set('block', ref.block_id); params.set('count', '6'); }
  else params.set('offset', String(offset));
  const data = await request(`${base}/sources/${enc(ref.document_id)}?${params}`);
  const box = document.querySelector('#source-content');
  box.replaceChildren(el('h2', '', data.document.name), el('p', 'run-muted', `Версия ${data.document.extraction_version} · ${data.document.side === 'A' ? 'До' : 'После'} · ${data.document.status}`));
  if (data.document.warnings?.length) box.append(textList(data.document.warnings));
  if (data.context.length) {
    box.append(el('h3', '', 'Контекст'));
    for (const block of data.context) box.append(el('p', 'run-source-block', `${block.coordinate} · ${block.text}`));
  }
  box.append(el('h3', '', 'Исходные фрагменты'));
  for (const block of data.blocks) box.append(el('p', 'run-source-block', `${block.coordinate} · ${block.text || 'Нет доступного текста'}`));
  if (data.next_offset !== null) box.append(button('Читать дальше', () => openSource({ document_id: ref.document_id, extraction_version: ref.extraction_version }, data.next_offset)));
  if (!sourceDialog.open) sourceDialog.showModal();
}
function renderDiff() {
  const block = section('Текстовые изменения');
  block.append(el('p', 'run-muted', 'Текстовое отличие помогает найти изменение, но само по себе не подтверждает потерю функции.'));
  const before = el('select', 'text-input');
  const after = el('select', 'text-input');
  for (const doc of run.documents) {
    const option = el('option', '', doc.name); option.value = doc.id;
    (doc.side === 'A' ? before : after).append(option);
  }
  const controls = el('div', 'run-actions');
  controls.append(before, after);
  const output = el('div');
  controls.append(button('Показать изменения', async () => {
    const data = await request(`${base}/diff?before=${enc(before.value)}&after=${enc(after.value)}`);
    output.replaceChildren();
    for (const row of data.rows.filter(item => !['equal', 'normalized'].includes(item.kind))) {
      const card = el('article', 'run-card');
      card.append(el('strong', '', row.kind), el('p', '', `До: ${row.before_text || '—'}`), el('p', '', `После: ${row.after_text || '—'}`));
      const refs = el('div', 'run-ref-list');
      for (const ref of [...row.before_refs, ...row.after_refs]) refs.append(sourceButton(ref));
      card.append(refs);
      output.append(card);
    }
    if (!output.childElementCount) output.append(el('p', '', 'Текстовых отличий не найдено.'));
  }));
  block.append(controls, output);
  content.append(block);
}
function renderCoverage() {
  const block = section('Полнота проверки');
  const counts = run.registry.coverage?.counts || {};
  const table = el('table', 'run-table');
  for (const [key, title] of [['total', 'Всего блоков'], ['extracted', 'Извлечено'], ['assigned', 'Назначено задачам'], ['compared', 'Учтено сравнением'], ['judge_checked', 'Проверено агентом'], ['unchecked', 'Не проверено']]) {
    const row = el('tr'); row.append(el('th', '', title), el('td', '', counts[key] ?? '—')); table.append(row);
  }
  block.append(table, el('p', 'run-muted', 'Покрытие отражает журнал работы и заявленную область проверки; оно не гарантирует смысловую полноту.'));
  if (run.plan?.remainder?.length) {
    block.append(el('h3', '', 'Остатки карты'));
    block.append(textList(run.plan.remainder.map(item => `${item.status}: ${item.reason}`)));
  }
  content.append(block);
}

document.querySelectorAll('[data-run-tab]').forEach(item => item.addEventListener('click', () => { tab = item.dataset.runTab; render(); }));
document.querySelector('#run-start').addEventListener('click', () => action(async () => { await request(`${base}/start`, { method: 'POST', body: {} }); await refresh(); }));
document.querySelector('#run-cancel').addEventListener('click', () => action(async () => { await request(`${base}/cancel`, { method: 'POST', body: {} }); await refresh(); }));
document.querySelector('#run-synthesize').addEventListener('click', () => action(async () => { await request(`${base}/synthesize`, { method: 'POST', body: {} }); await refresh(); }));
if (!id) showError(new Error('Не указан ID анализа.'));
else await refresh();
async function poll() { if (run?.state === 'running') await refresh(); setTimeout(poll, 2500); }
setTimeout(poll, 2500);
