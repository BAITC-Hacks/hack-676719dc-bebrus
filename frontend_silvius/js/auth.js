(() => {
  'use strict';
  const form = document.querySelector('[data-auth-form]');
  const submit = document.querySelector('[data-auth-submit]');
  const message = document.getElementById('auth-message');
  const google = document.querySelector('[data-google-button]');
  const googleNote = document.querySelector('[data-google-note]');
  const connectionError = 'Нет соединения с сервером Silvius. Из корня проекта выполните npm ci и npm start, затем откройте http://localhost:3000.';
  let sending = false;
  let csrfToken;

  function showError(text) {
    message.textContent = text;
    message.hidden = false;
  }
  function setBusy(value) {
    sending = value;
    submit.disabled = value;
    submit.textContent = value ? 'Подождите…' : location.hash === '#register' ? 'Зарегистрироваться' : 'Войти';
    form.setAttribute('aria-busy', String(value));
  }
  async function getCsrf() {
    if (csrfToken) return csrfToken;
    let response;
    try { response = await fetch('/api/auth/csrf', { credentials: 'same-origin' }); }
    catch { throw new Error(connectionError); }
    if (!response.ok || !response.headers.get('content-type')?.includes('application/json')) throw new Error(connectionError);
    const data = await response.json().catch(() => null);
    if (typeof data?.csrfToken !== 'string') throw new Error(connectionError);
    csrfToken = data.csrfToken;
    return csrfToken;
  }

  if (location.protocol === 'file:') {
    showError('Форма открыта как локальный HTML-файл. Для регистрации и входа запустите приложение из корня проекта: npm ci, затем npm start. ');
    const link = document.createElement('a');
    link.href = `http://localhost:3000/auth.html${location.hash === '#register' ? '#register' : '#login'}`;
    link.textContent = 'Открыть форму на localhost:3000';
    message.append(link);
    submit.disabled = true;
    google.disabled = true;
    googleNote.hidden = true;
    return;
  }

  const queryError = new URLSearchParams(location.search).get('error');
  const errors = {
    google_cancelled: 'Вход через Google отменён. Попробуйте ещё раз или используйте email.',
    google_profile: 'Google не передал подтверждённый email. Используйте другой способ входа.',
    google_conflict: 'Этот email уже зарегистрирован. Войдите тем способом, которым создавали аккаунт.',
    google_failed: 'Не удалось завершить вход через Google. Попробуйте ещё раз.'
  };
  if (errors[queryError]) showError(errors[queryError]);

  document.querySelector('[data-password-toggle]')?.addEventListener('click', event => {
    const password = document.getElementById('password');
    const visible = password.type === 'password';
    password.type = visible ? 'text' : 'password';
    event.currentTarget.textContent = visible ? 'Скрыть' : 'Показать';
    event.currentTarget.setAttribute('aria-label', visible ? 'Скрыть пароль' : 'Показать пароль');
  });

  fetch('/api/auth/config').then(response => {
    if (!response.ok) throw new Error('Config unavailable');
    return response.json();
  }).then(config => {
    const enabled = config?.googleEnabled === true;
    google.disabled = !enabled;
    googleNote.hidden = enabled;
  }).catch(() => {
    google.disabled = true;
    googleNote.hidden = false;
  });
  google.addEventListener('click', () => { location.assign('/api/auth/google'); });

  form.addEventListener('submit', async event => {
    event.preventDefault();
    if (sending) return;
    message.hidden = true;
    message.textContent = '';
    const register = location.hash === '#register';
    const body = {
      email: form.elements.email.value.trim(),
      password: form.elements.password.value
    };
    if (register) body.name = form.elements.name.value.trim();
    setBusy(true);
    try {
      const token = await getCsrf();
      let response;
      try {
        response = await fetch(register ? '/api/auth/register' : '/api/auth/login', {
          method: 'POST', credentials: 'same-origin', headers: { 'content-type': 'application/json', 'x-csrf-token': token }, body: JSON.stringify(body)
        });
      } catch { throw new Error(connectionError); }
      if (!response.headers.get('content-type')?.includes('application/json')) throw new Error(connectionError);
      const result = await response.json().catch(() => null);
      if (!result) throw new Error(connectionError);
      if (!response.ok) {
        if (result.error?.code === 'CSRF') csrfToken = undefined;
        throw new Error(result.error?.message || 'Не удалось выполнить вход.');
      }
      location.assign('/workspace.html');
    } catch (error) {
      showError(error.message || connectionError);
      setBusy(false);
    }
  });
})();
