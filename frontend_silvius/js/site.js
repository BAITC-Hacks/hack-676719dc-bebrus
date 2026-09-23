(() => {
  'use strict';

  const root = document.documentElement;
  const logoFiles = {
    light: 'assets/silvius-logo-light.svg',
    dark: 'assets/silvius-logo-dark.svg'
  };
  const logoCache = new Map();

  function storedTheme() {
    try {
      const value = localStorage.getItem('silvius-theme');
      if (value === 'light' || value === 'dark') return value;
    } catch (_) { /* Private browsing can disallow storage. */ }
    return window.matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light';
  }

  function updateLogo(theme) {
    const path = logoFiles[theme];
    const show = (available) => {
      if (root.dataset.theme !== theme) return;
      document.querySelectorAll('[data-brand-mark]').forEach((mark) => {
        const image = mark.querySelector('[data-brand-image]');
        const fallback = mark.querySelector('.brand-mark-fallback');
        if (!image || !fallback) return;
        image.hidden = !available;
        fallback.hidden = available;
        mark.classList.toggle('has-image', available);
        if (available) image.src = path;
      });
    };

    if (logoCache.has(theme)) {
      show(logoCache.get(theme));
      return;
    }
    const probe = new Image();
    probe.onload = () => { logoCache.set(theme, true); show(true); };
    probe.onerror = () => { logoCache.set(theme, false); show(false); };
    probe.src = path;
  }

  function setTheme(theme) {
    root.dataset.theme = theme;
    const favicon = document.getElementById('site-favicon');
    if (favicon) favicon.href = logoFiles[theme];
    document.querySelectorAll('[data-theme-toggle]').forEach((button) => {
      button.setAttribute('aria-label', theme === 'dark' ? 'Включить светлую тему' : 'Включить тёмную тему');
    });
    updateLogo(theme);
    try { localStorage.setItem('silvius-theme', theme); } catch (_) { /* Optional preference. */ }
  }

  setTheme(storedTheme());
  document.querySelectorAll('[data-theme-toggle]').forEach((button) => {
    button.addEventListener('click', () => setTheme(root.dataset.theme === 'dark' ? 'light' : 'dark'));
  });

  const menuButton = document.querySelector('[data-menu-toggle]');
  const mainNav = document.getElementById('main-nav');
  function closeMenu() {
    mainNav?.classList.remove('is-open');
    menuButton?.setAttribute('aria-expanded', 'false');
    menuButton?.setAttribute('aria-label', 'Открыть меню');
  }
  menuButton?.addEventListener('click', () => {
    const open = mainNav?.classList.toggle('is-open');
    menuButton.setAttribute('aria-expanded', String(Boolean(open)));
    menuButton.setAttribute('aria-label', open ? 'Закрыть меню' : 'Открыть меню');
  });
  mainNav?.querySelectorAll('a').forEach((link) => link.addEventListener('click', closeMenu));
  document.addEventListener('keydown', (event) => { if (event.key === 'Escape') closeMenu(); });

  const guestActions = document.querySelector('[data-guest-actions]');
  const userMenu = document.querySelector('[data-user-menu]');
  const userMenuButton = document.querySelector('[data-user-menu-button]');
  const userMenuPanel = document.getElementById('user-menu-panel');
  window.SilviusHeader = {
    setUser(user) {
      const name = typeof user?.name === 'string' && user.name.trim() ? user.name.trim() : null;
      if (!name) { this.clearUser(); return; }
      const nameElement = userMenu?.querySelector('[data-user-name]');
      if (nameElement) nameElement.textContent = name;
      if (guestActions) guestActions.hidden = true;
      if (userMenu) userMenu.hidden = false;
    },
    clearUser() {
      if (guestActions) guestActions.hidden = false;
      if (userMenu) userMenu.hidden = true;
      if (userMenuPanel) userMenuPanel.hidden = true;
      userMenuButton?.setAttribute('aria-expanded', 'false');
    }
  };
  userMenuButton?.addEventListener('click', () => {
    if (!userMenuPanel) return;
    userMenuPanel.hidden = !userMenuPanel.hidden;
    userMenuButton.setAttribute('aria-expanded', String(!userMenuPanel.hidden));
  });
  document.addEventListener('click', (event) => {
    if (userMenu && !userMenu.contains(event.target) && userMenuPanel) {
      userMenuPanel.hidden = true;
      userMenuButton?.setAttribute('aria-expanded', 'false');
    }
  });
  document.querySelector('[data-logout]')?.addEventListener('click', () => {
    window.dispatchEvent(new CustomEvent('silvius:logout-request'));
  });

  let csrfToken;
  async function loadUser() {
    try {
      const response = await fetch('/api/auth/me', { credentials: 'same-origin' });
      if (!response.ok) {
        window.SilviusHeader.clearUser();
        if (response.status === 401 && location.pathname === '/workspace.html') location.replace('/auth.html#login');
        return;
      }
      const data = await response.json();
      csrfToken = data.csrfToken;
      window.SilviusHeader.setUser(data.user);
    } catch (_) { window.SilviusHeader.clearUser(); }
  }
  loadUser();
  window.addEventListener('silvius:logout-request', async () => {
    try {
      if (!csrfToken) {
        const response = await fetch('/api/auth/csrf');
        csrfToken = (await response.json()).csrfToken;
      }
      const response = await fetch('/api/auth/logout', { method: 'POST', credentials: 'same-origin', headers: { 'x-csrf-token': csrfToken } });
      if (response.status === 401) {
        window.SilviusHeader.clearUser();
        location.assign('/auth.html#login');
        return;
      }
      if (!response.ok) throw new Error('Не удалось выйти из аккаунта.');
      window.SilviusHeader.clearUser();
      location.assign('/index.html');
    } catch (_) { alert('Не удалось выйти. Обновите страницу и повторите попытку.'); }
  });

  const authTabs = document.querySelectorAll('[data-auth-tab]');
  if (authTabs.length) {
    const updateAuthView = () => {
      const mode = location.hash === '#register' ? 'register' : 'login';
      authTabs.forEach((tab) => {
        if (tab.dataset.authTab === mode) tab.setAttribute('aria-current', 'page');
        else tab.removeAttribute('aria-current');
      });
      const title = document.querySelector('[data-auth-title]');
      const description = document.querySelector('[data-auth-description]');
      const submit = document.querySelector('[data-auth-submit]');
      if (title) title.textContent = mode === 'register' ? 'Создать аккаунт Silvius' : 'Вход в Silvius';
      if (description) description.textContent = mode === 'register'
        ? 'Создайте аккаунт, чтобы открыть рабочее пространство.'
        : 'Войдите, чтобы открыть рабочее пространство.';
      if (submit) submit.textContent = mode === 'register' ? 'Зарегистрироваться' : 'Войти';
      const password = document.getElementById('password');
      if (password) password.autocomplete = mode === 'register' ? 'new-password' : 'current-password';
      const registerFields = document.querySelector('[data-register-fields]');
      if (registerFields) registerFields.hidden = mode !== 'register';
      const name = document.getElementById('name');
      if (name) name.required = mode === 'register';
      if (password) password.minLength = mode === 'register' ? 10 : 1;
      const hint = document.querySelector('[data-password-hint]');
      if (hint) hint.hidden = mode !== 'register';
      const message = document.getElementById('auth-message');
      if (message) { message.hidden = true; message.textContent = ''; }
    };
    window.addEventListener('hashchange', updateAuthView);
    updateAuthView();
  }
})();
