import { request, runUrl, states } from './hectra-api.js';

const tabs = document.querySelectorAll('[data-workspace-tab]');
const panels = document.querySelectorAll('[data-workspace-panel]');
const selectedFiles = { before: [], after: [] };
const allowedExtensions = /\.(pdf|docx|xlsx)$/i;
const status = document.querySelector('[data-upload-status]');
const startButton = document.querySelector('[data-start-analysis]');
let activeRunId = null;
let config = null;

function showPanel(name) {
  tabs.forEach(tab => {
    if (tab.dataset.workspaceTab === name) tab.setAttribute('aria-current', 'page');
    else tab.removeAttribute('aria-current');
  });
  panels.forEach(panel => { panel.hidden = panel.dataset.workspacePanel !== name; });
  if (location.hash !== `#${name}`) history.replaceState(null, '', `#${name}`);
  if (name === 'history') loadHistory();
}
tabs.forEach(tab => tab.addEventListener('click', () => showPanel(tab.dataset.workspaceTab)));
document.querySelector('[data-go-new]')?.addEventListener('click', () => showPanel('new'));
window.addEventListener('hashchange', () => showPanel(location.hash === '#history' ? 'history' : 'new'));
showPanel(location.hash === '#history' ? 'history' : 'new');

function formatCount(count) {
  const lastTwo = count % 100;
  const last = count % 10;
  return `${count} ${lastTwo >= 11 && lastTwo <= 14 ? 'файлов' : last === 1 ? 'файл' : last >= 2 && last <= 4 ? 'файла' : 'файлов'}`;
}
function render(side) {
  const list = document.querySelector(`[data-file-list="${side}"]`);
  document.querySelector(`[data-file-count="${side}"]`).textContent = formatCount(selectedFiles[side].length);
  list.replaceChildren();
  selectedFiles[side].forEach((file, index) => {
    const row = document.createElement('li');
    const name = document.createElement('span');
    name.className = 'file-name';
    name.textContent = file.name;
    name.title = file.name;
    const remove = document.createElement('button');
    remove.type = 'button';
    remove.textContent = '×';
    remove.setAttribute('aria-label', `Убрать ${file.name}`);
    remove.addEventListener('click', () => { selectedFiles[side].splice(index, 1); render(side); });
    row.append(name, remove);
    list.append(row);
  });
}
function addFiles(side, files) {
  for (const file of files) {
    if (!allowedExtensions.test(file.name)) { status.textContent = 'Поддерживаются только PDF, DOCX и XLSX.'; continue; }
    if (config && file.size > config.limits.fileBytes) { status.textContent = `${file.name}: превышен лимит ${Math.round(config.limits.fileBytes / 1048576)} МиБ.`; continue; }
    if (selectedFiles[side].some(existing => existing.name === file.name && existing.size === file.size)) continue;
    if (config && selectedFiles[side].length >= config.limits.filesPerSide) { status.textContent = `Не более ${config.limits.filesPerSide} файлов на сторону.`; break; }
    selectedFiles[side].push(file);
  }
  render(side);
}
document.querySelectorAll('[data-file-input]').forEach(input => input.addEventListener('change', () => {
  addFiles(input.dataset.fileInput, input.files);
  input.value = '';
}));
document.querySelectorAll('[data-upload-zone]').forEach(zone => {
  const side = zone.dataset.uploadZone;
  for (const name of ['dragenter', 'dragover']) zone.addEventListener(name, event => { event.preventDefault(); zone.classList.add('is-dragover'); });
  for (const name of ['dragleave', 'drop']) zone.addEventListener(name, event => { event.preventDefault(); zone.classList.remove('is-dragover'); });
  zone.addEventListener('drop', event => addFiles(side, event.dataTransfer?.files || []));
});

startButton.addEventListener('click', async () => {
  if (!selectedFiles.before.length || !selectedFiles.after.length) { status.textContent = 'Добавьте хотя бы один документ «до» и один «после».'; return; }
  startButton.disabled = true;
  try {
    const name = document.querySelector('#comparison-title').value.trim() || `Сравнение ${new Date().toLocaleDateString('ru')}`;
    const mode = document.querySelector('#test-mode').checked ? 'test' : 'live';
    const created = await request('/runs', { method: 'POST', body: { name, mode } });
    activeRunId = created.id;
    for (const [side, files] of [['A', selectedFiles.before], ['B', selectedFiles.after]]) {
      for (const file of files) {
        status.textContent = `Загрузка и извлечение: ${file.name}`;
        const body = new FormData();
        body.set('side', side);
        body.set('name', file.name);
        body.set('file', file);
        const uploaded = await request(`/runs/${encodeURIComponent(activeRunId)}/documents`, { method: 'POST', body });
        if (uploaded.status === 'failed') throw new Error(`${file.name}: текст не извлечён. Откройте сохранённый запуск для проверки.`);
      }
    }
    const preflight = await request(`/runs/${encodeURIComponent(activeRunId)}/preflight`);
    if (preflight.state === 'ready') await request(`/runs/${encodeURIComponent(activeRunId)}/start`, { method: 'POST', body: {} });
    location.assign(runUrl(activeRunId));
  } catch (error) {
    status.replaceChildren(document.createTextNode(error.message));
    if (activeRunId) {
      const link = document.createElement('a');
      link.href = runUrl(activeRunId);
      link.textContent = ' Открыть сохранённый запуск';
      status.append(link);
    }
    startButton.disabled = false;
  }
});

let historyRuns = [];
async function loadHistory() {
  const list = document.querySelector('[data-history-list]');
  list.textContent = 'Загрузка истории…';
  try {
    historyRuns = await request('/runs');
    renderHistory();
  } catch (error) { list.textContent = error.message; }
}
function renderHistory() {
  const list = document.querySelector('[data-history-list]');
  const query = document.querySelector('#history-search').value.trim().toLocaleLowerCase();
  const runs = historyRuns.filter(run => run.name.toLocaleLowerCase().includes(query));
  list.replaceChildren();
  if (!runs.length) { list.textContent = query ? 'Ничего не найдено.' : 'Пока нет сравнений.'; return; }
  for (const run of runs) {
    const item = document.createElement('a');
    item.className = 'history-item';
    item.href = runUrl(run.id);
    const name = document.createElement('strong');
    name.textContent = run.name;
    const detail = document.createElement('span');
    detail.textContent = `${states[run.state] || run.state} · ${new Date(run.updated_at).toLocaleString('ru')}`;
    item.append(name, detail);
    list.append(item);
  }
}
document.querySelector('#history-search').addEventListener('input', renderHistory);
request('/config').then(value => {
  config = value;
  document.querySelector('#test-mode-option').hidden = !value.test_mode_available;
  if (value.key_error) status.textContent = value.key_error;
}).catch(error => { status.textContent = error.message; });
