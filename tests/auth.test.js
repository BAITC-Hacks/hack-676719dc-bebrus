import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createApp } from '../server/app.js';

async function launch(dbPath, env = {}) {
  const service = createApp({ dbPath, env: { APP_URL: 'http://localhost:3000', ...env } });
  const server = await new Promise((resolve, reject) => {
    const listener = service.app.listen(0, '127.0.0.1');
    listener.once('listening', () => resolve(listener));
    listener.once('error', reject);
  });
  return {
    ...service,
    url: `http://127.0.0.1:${server.address().port}`,
    async stop() { await new Promise(resolve => server.close(resolve)); service.close(); }
  };
}

function client(service) {
  let cookie = '';
  return {
    get cookie() { return cookie; },
    set cookie(value) { cookie = value; },
    async request(path, { method = 'GET', body, csrf, headers = {}, redirect = 'manual' } = {}) {
      const response = await fetch(service.url + path, {
        method, redirect,
        headers: { ...(cookie ? { cookie } : {}), ...(csrf ? { 'x-csrf-token': csrf } : {}),
          ...(body ? { 'content-type': 'application/json' } : {}), ...headers },
        body: body ? JSON.stringify(body) : undefined
      });
      const setCookie = response.headers.get('set-cookie');
      if (setCookie) cookie = setCookie.split(';', 1)[0];
      let json;
      if (response.headers.get('content-type')?.includes('application/json')) json = await response.json();
      return { response, json };
    }
  };
}

test('авторизация, миграции и сессия переживают перезапуск', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'silvius-test-'));
  const dbPath = join(dir, 'silvius.sqlite');
  let service = await launch(dbPath);
  try {
    let browser = client(service);
    let result = await browser.request('/api/auth/me');
    assert.equal(result.response.status, 401);
    result = await browser.request('/workspace.html');
    assert.equal(result.response.status, 302);
    assert.equal(result.response.headers.get('location'), '/auth.html#login');

    result = await browser.request('/api/auth/config');
    assert.deepEqual(result.json, { googleEnabled: false }, 'публичная конфигурация не раскрывает секреты');
    result = await browser.request('/api/auth/google');
    assert.equal(result.response.status, 503);
    assert.equal(result.json.error.code, 'GOOGLE_AUTH_NOT_CONFIGURED');
    assert.equal(result.json.error.message, 'Google sign-in is not configured for this installation. Use email and password.');
    result = await browser.request('/api/auth/google/callback?code=invalid&state=wrong');
    assert.equal(result.response.status, 503);
    assert.equal(result.json.error.code, 'GOOGLE_AUTH_NOT_CONFIGURED');

    result = await browser.request('/api/auth/csrf');
    const csrf = result.json.csrfToken;
    const anonymousCookie = browser.cookie;
    const account = { name: '<Alice & Bob>', email: '  USER@Example.COM ', password: 'long-secret-123' };
    result = await browser.request('/api/auth/register', { method: 'POST', body: account });
    assert.equal(result.response.status, 403, 'регистрация требует CSRF');
    result = await browser.request('/api/auth/register', { method: 'POST', body: account, csrf,
      headers: { origin: 'https://evil.example' } });
    assert.equal(result.response.status, 403, 'чужой Origin отклоняется');
    result = await browser.request('/api/auth/register', { method: 'POST', body: account, csrf });
    assert.equal(result.response.status, 201);
    assert.equal(result.json.user.email, 'user@example.com');
    assert.equal(result.json.user.name, '<Alice & Bob>');
    assert.ok(!('password_hash' in result.json.user));
    assert.equal(service.db.prepare('SELECT email_verified_at FROM users WHERE email = ?').get('user@example.com').email_verified_at, null);
    const activeCookie = browser.cookie;
    assert.notEqual(activeCookie, '');
    assert.notEqual(activeCookie, anonymousCookie, 'идентификатор сессии меняется при входе');
    assert.equal(result.response.headers.get('set-cookie').includes('HttpOnly'), true);
    assert.equal(result.response.headers.get('set-cookie').includes('SameSite=Lax'), true);

    result = await browser.request('/api/auth/me');
    assert.equal(result.response.status, 200);
    assert.equal(result.json.user.name, account.name);
    result = await browser.request('/workspace.html');
    assert.equal(result.response.status, 200);

    const another = client(service);
    const otherCsrf = (await another.request('/api/auth/csrf')).json.csrfToken;
    result = await another.request('/api/auth/register', { method: 'POST', csrf: otherCsrf,
      body: { ...account, email: 'user@example.com' } });
    assert.equal(result.response.status, 409, 'email уникален без учёта регистра');
    result = await another.request('/api/auth/login', { method: 'POST', csrf: otherCsrf,
      body: { email: account.email, password: 'wrong-password' } });
    assert.equal(result.response.status, 401);
    result = await another.request('/api/auth/login', { method: 'POST', csrf: otherCsrf,
      body: { email: 'USER@example.com', password: account.password } });
    assert.equal(result.response.status, 200);
    assert.equal(result.json.user.id, service.db.prepare('SELECT id FROM users WHERE email = ?').get('user@example.com').id);

    const logoutCsrf = result.json.csrfToken;
    const beforeLogoutCookie = another.cookie;
    result = await another.request('/api/auth/logout', { method: 'POST', csrf: logoutCsrf });
    assert.equal(result.response.status, 204);
    another.cookie = beforeLogoutCookie;
    result = await another.request('/api/auth/me');
    assert.equal(result.response.status, 401, 'старая сессия недействительна');

    await service.stop();
    service = await launch(dbPath);
    browser = client(service);
    browser.cookie = activeCookie;
    result = await browser.request('/api/auth/me');
    assert.equal(result.response.status, 200, 'пользователь и сессия сохранились');
    assert.equal(service.db.prepare('SELECT count(*) AS count FROM users').get().count, 1);
    assert.equal(service.db.prepare('SELECT count(*) AS count FROM schema_migrations').get().count, 1);

    const fresh = client(service);
    const newCsrf = (await fresh.request('/api/auth/csrf')).json.csrfToken;
    result = await fresh.request('/api/auth/login', { method: 'POST', csrf: newCsrf,
      body: { email: 'user@example.com', password: account.password } });
    assert.equal(result.response.status, 200, 'пароль работает после перезапуска');
  } finally {
    await service.stop();
    rmSync(dir, { recursive: true, force: true });
  }
});

test('истёкшие сессии и частые попытки входа отклоняются', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'silvius-limit-test-'));
  const service = await launch(join(dir, 'silvius.sqlite'));
  try {
    const browser = client(service);
    const csrf = (await browser.request('/api/auth/csrf')).json.csrfToken;
    for (let attempt = 0; attempt < 10; attempt++) {
      const result = await browser.request('/api/auth/login', { method: 'POST', csrf,
        body: { email: 'missing@example.com', password: 'wrong-password' } });
      assert.equal(result.response.status, 401);
    }
    const blocked = await browser.request('/api/auth/login', { method: 'POST', csrf,
      body: { email: 'missing@example.com', password: 'wrong-password' } });
    assert.equal(blocked.response.status, 429);
    service.db.prepare('UPDATE sessions SET expires_at = ?').run(Date.now() - 1000);
    service.store.cleanup();
    assert.equal(service.db.prepare('SELECT count(*) AS count FROM sessions').get().count, 0);
  } finally {
    await service.stop();
    rmSync(dir, { recursive: true, force: true });
  }
});

test('неверный OAuth state отклоняется до обращения к Google', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'silvius-oauth-test-'));
  const service = await launch(join(dir, 'silvius.sqlite'), {
    GOOGLE_CLIENT_ID: 'test-client', GOOGLE_CLIENT_SECRET: 'test-secret'
  });
  try {
    const result = await client(service).request('/api/auth/google/callback?code=invalid&state=wrong');
    assert.equal(result.response.status, 400);
    assert.equal(result.json.error.code, 'INVALID_OAUTH_STATE');
  } finally {
    await service.stop();
    rmSync(dir, { recursive: true, force: true });
  }
});
