(() => {
  'use strict';

  const tabs = document.querySelectorAll('[data-workspace-tab]');
  const panels = document.querySelectorAll('[data-workspace-panel]');
  const selectedFiles = { before: [], after: [] };
  const allowedExtensions = /\.(pdf|docx|txt)$/i;

  function showPanel(name) {
    tabs.forEach((tab) => {
      if (tab.dataset.workspaceTab === name) tab.setAttribute('aria-current', 'page');
      else tab.removeAttribute('aria-current');
    });
    panels.forEach((panel) => { panel.hidden = panel.dataset.workspacePanel !== name; });
    if (location.hash !== `#${name}`) history.replaceState(null, '', `#${name}`);
  }
  tabs.forEach((tab) => tab.addEventListener('click', () => showPanel(tab.dataset.workspaceTab)));
  document.querySelector('[data-go-new]')?.addEventListener('click', () => showPanel('new'));
  window.addEventListener('hashchange', () => showPanel(location.hash === '#history' ? 'history' : 'new'));
  showPanel(location.hash === '#history' ? 'history' : 'new');

  function formatCount(count) {
    const lastTwo = count % 100;
    const last = count % 10;
    const word = lastTwo >= 11 && lastTwo <= 14 ? 'файлов'
      : last === 1 ? 'файл'
      : last >= 2 && last <= 4 ? 'файла' : 'файлов';
    return `${count} ${word}`;
  }

  function render(side) {
    const list = document.querySelector(`[data-file-list="${side}"]`);
    const count = document.querySelector(`[data-file-count="${side}"]`);
    if (!list || !count) return;
    list.replaceChildren();
    count.textContent = formatCount(selectedFiles[side].length);
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
      if (!allowedExtensions.test(file.name)) continue;
      if (selectedFiles[side].some((existing) => existing.name === file.name && existing.size === file.size)) continue;
      selectedFiles[side].push(file);
    }
    render(side);
  }

  document.querySelectorAll('[data-file-input]').forEach((input) => {
    input.addEventListener('change', () => {
      addFiles(input.dataset.fileInput, input.files);
      input.value = '';
    });
  });
  document.querySelectorAll('[data-upload-zone]').forEach((zone) => {
    const side = zone.dataset.uploadZone;
    for (const eventName of ['dragenter', 'dragover']) {
      zone.addEventListener(eventName, (event) => { event.preventDefault(); zone.classList.add('is-dragover'); });
    }
    for (const eventName of ['dragleave', 'drop']) {
      zone.addEventListener(eventName, (event) => { event.preventDefault(); zone.classList.remove('is-dragover'); });
    }
    zone.addEventListener('drop', (event) => addFiles(side, event.dataTransfer?.files || []));
  });
})();
