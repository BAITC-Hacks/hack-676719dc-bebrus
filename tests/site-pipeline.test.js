import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createApp } from '../server/app.js';
import { docxBuffer } from '../pipeline/test-support/helpers.js';

function client(url) {
  let cookie = '';
  let csrf = '';
  async function call(path, { method = 'GET', body, token = csrf } = {}) {
    const multipart = body instanceof FormData;
    const response = await fetch(url + path, {
      method, redirect: 'manual',
      headers: {
        ...(cookie ? { cookie } : {}),
        ...(method !== 'GET' && token ? { 'x-csrf-token': token } : {}),
        ...(body && !multipart ? { 'content-type': 'application/json' } : {})
      },
      body: body === undefined ? undefined : multipart ? body : JSON.stringify(body)
    });
    const setCookie = response.headers.get('set-cookie');
    if (setCookie) cookie = setCookie.split(';', 1)[0];
    const value = response.headers.get('content-type')?.includes('application/json') ? await response.json() : null;
    return { response, value };
  }
  return {
    call,
    async register(email) {
      csrf = (await call('/api/auth/csrf')).value.csrfToken;
      const result = await call('/api/auth/register', { method: 'POST', body: { name: email, email, password: 'long-password-123' } });
      assert.equal(result.response.status, 201);
      csrf = result.value.csrfToken;
    }
  };
}

test('Silvius serves one protected pipeline with per-user runs, CSRF and saved results', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'silvius-pipeline-'));
  const service = createApp({ dbPath: join(dir, 'silvius.sqlite'), env: { APP_URL: 'http://localhost:3000', HECTRA_TEST_MODE: '1' } });
  await service.initializePipeline();
  const server = service.app.listen(0, '127.0.0.1');
  await new Promise(resolve => server.once('listening', resolve));
  const url = `http://127.0.0.1:${server.address().port}`;
  const alice = client(url);
  const bob = client(url);
  try {
    assert.equal((await alice.call('/run.html')).response.status, 401);
    assert.equal((await alice.call('/api/hectra/runs')).response.status, 401);
    assert.equal((await alice.call('/analysis.html')).response.status, 404);
    await alice.register('alice@example.com');
    await bob.register('bob@example.com');
    assert.equal((await alice.call('/run.html')).response.status, 200);
    const forbidden = await alice.call('/api/hectra/runs', { method: 'POST', body: { name: 'Denied' }, token: '' });
    assert.equal(forbidden.response.status, 403);
    const created = await alice.call('/api/hectra/runs', { method: 'POST', body: { name: 'Контроль', mode: 'test' } });
    assert.equal(created.response.status, 201);
    const runId = created.value.id;
    for (const side of ['A', 'B']) {
      const form = new FormData();
      form.set('side', side);
      form.set('name', `${side}.docx`);
      form.set('file', new Blob([docxBuffer([`${side}. Проверять документы.`])]), `${side}.docx`);
      const uploaded = await alice.call(`/api/hectra/runs/${runId}/documents`, { method: 'POST', body: form });
      assert.equal(uploaded.response.status, 201);
      assert.equal(uploaded.value.status, 'ok');
    }
    const saved = (await alice.call(`/api/hectra/runs/${runId}`)).value;
    const docId = saved.documents[0].id;
    assert.equal((await bob.call('/api/hectra/runs')).value.length, 0);
    for (const path of [`/api/hectra/runs/${runId}`, `/api/hectra/runs/${runId}/logs`, `/api/hectra/runs/${runId}/export.html`, `/api/hectra/runs/${runId}/sources/${docId}`, `/api/hectra/runs/${runId}/originals/${docId}`]) {
      const denied = await bob.call(path);
      assert.notEqual(denied.response.status, 200);
    }
    const preflight = await alice.call(`/api/hectra/runs/${runId}/preflight`);
    assert.equal(preflight.value.state, 'ready');
    const started = await alice.call(`/api/hectra/runs/${runId}/start`, { method: 'POST', body: {} });
    assert.equal(started.response.status, 200);
    let run = started.value;
    for (let attempt = 0; attempt < 100 && run.state === 'running'; attempt++) {
      await new Promise(resolve => setTimeout(resolve, 50));
      run = (await alice.call(`/api/hectra/runs/${runId}`)).value;
    }
    assert.ok(['completed', 'completed_with_limits'].includes(run.state), JSON.stringify(run.last_error));
    assert.ok(run.registry.findings.length);
    assert.ok(run.report);
    assert.equal((await alice.call(`/api/hectra/runs/${runId}/export.html`)).response.status, 200);
  } finally {
    await service.stopPipeline();
    server.closeAllConnections();
    await new Promise(resolve => server.close(resolve));
    service.close();
    rmSync(dir, { recursive: true, force: true });
  }
});
