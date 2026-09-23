import express from 'express';
import session from 'express-session';
import { rateLimit } from 'express-rate-limit';
import * as oidc from 'openid-client';
import { randomBytes, randomUUID, timingSafeEqual } from 'node:crypto';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { openDatabase } from './database.js';
import { SqliteSessionStore } from './session-store.js';
import { hashPassword, verifyPassword } from './password.js';
import { createApplication } from '../pipeline/server/index.js';
import { loadConfig } from '../pipeline/server/config.js';

const root = resolve(import.meta.dirname, '..');
const frontend = join(root, 'frontend_silvius');
const maxAge = 7 * 24 * 60 * 60 * 1000;
const googleNotConfigured = 'Google sign-in is not configured for this installation. Use email and password.';

function sessionSecret(dataDir, production, environment) {
  if (environment.SESSION_SECRET) {
    if (environment.SESSION_SECRET.length < 32) throw new Error('SESSION_SECRET должен содержать не менее 32 символов.');
    return environment.SESSION_SECRET;
  }
  if (production) throw new Error('В production задайте SESSION_SECRET.');
  const path = join(dataDir, 'session-secret');
  if (!existsSync(path)) {
    try { writeFileSync(path, randomBytes(48).toString('base64url'), { flag: 'wx', mode: 0o600 }); }
    catch (error) { if (error.code !== 'EEXIST') throw error; }
  }
  return readFileSync(path, 'utf8').trim();
}

function safeEqual(a, b) {
  if (typeof a !== 'string' || typeof b !== 'string') return false;
  const aa = Buffer.from(a);
  const bb = Buffer.from(b);
  return aa.length === bb.length && timingSafeEqual(aa, bb);
}

function validEmail(value) {
  if (typeof value !== 'string') return null;
  const email = value.trim().toLowerCase();
  return email.length <= 254 && /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email) ? email : null;
}

function publicUser(row) {
  return { id: row.id, name: row.name, email: row.email };
}

function errorResponse(res, status, code, message) {
  return res.status(status).json({ error: { code, message } });
}

function regenerate(req) {
  return new Promise((resolvePromise, reject) => req.session.regenerate(error => error ? reject(error) : resolvePromise()));
}

function saveSession(req) {
  return new Promise((resolvePromise, reject) => req.session.save(error => error ? reject(error) : resolvePromise()));
}

export function createApp({ dbPath = join(root, 'data', 'silvius.sqlite'), env = process.env } = {}) {
  const app = express();
  const production = env.NODE_ENV === 'production';
  const appUrl = new URL(env.APP_URL || `http://localhost:${env.PORT || 3000}`);
  if (production && appUrl.protocol !== 'https:') throw new Error('APP_URL должен использовать HTTPS в production.');
  const db = openDatabase(dbPath);
  const store = new SqliteSessionStore(db);
  const secret = sessionSecret(resolve(dbPath, '..'), production, env);
  const googleEnabled = Boolean(env.GOOGLE_CLIENT_ID && env.GOOGLE_CLIENT_SECRET);
  const callbackUrl = env.GOOGLE_REDIRECT_URI || new URL('/api/auth/google/callback', appUrl).href;
  if (googleEnabled && new URL(callbackUrl).origin !== appUrl.origin) throw new Error('GOOGLE_REDIRECT_URI должен иметь тот же origin, что APP_URL.');
  let googleConfigPromise;
  const googleConfig = () => {
    if (!googleConfigPromise) {
      googleConfigPromise = oidc.discovery(new URL('https://accounts.google.com'), env.GOOGLE_CLIENT_ID, env.GOOGLE_CLIENT_SECRET)
        .catch(error => { googleConfigPromise = undefined; throw error; });
    }
    return googleConfigPromise;
  };

  app.disable('x-powered-by');
  if (production) app.set('trust proxy', 1);
  app.use(express.json({ limit: '4mb' }));
  app.use(session({
    name: 'silvius.sid', secret, store, resave: false, saveUninitialized: false, rolling: true,
    cookie: { httpOnly: true, sameSite: 'lax', secure: production, maxAge }
  }));
  app.use('/api/auth', (_req, res, next) => { res.set('Cache-Control', 'no-store'); next(); });
  const cleanupTimer = setInterval(() => store.cleanup(), 60 * 60 * 1000);
  cleanupTimer.unref();

  const authLimiter = rateLimit({ windowMs: 15 * 60 * 1000, limit: 10, standardHeaders: 'draft-8', legacyHeaders: false,
    message: { error: { code: 'RATE_LIMIT', message: 'Слишком много попыток. Попробуйте через 15 минут.' } }
  });
  const currentUser = req => req.session.userId
    ? db.prepare('SELECT id, name, email FROM users WHERE id = ?').get(req.session.userId)
    : null;
  const requireAuth = (req, res, next) => {
    const user = currentUser(req);
    if (!user) return errorResponse(res, 401, 'UNAUTHORIZED', 'Войдите, чтобы продолжить.');
    req.user = user;
    next();
  };
  const csrf = (req, res, next) => {
    const origin = req.get('origin');
    if (origin && origin !== appUrl.origin) return errorResponse(res, 403, 'CSRF', 'Недопустимый источник запроса.');
    if (!safeEqual(req.session.csrfToken, req.get('x-csrf-token'))) return errorResponse(res, 403, 'CSRF', 'Обновите страницу и повторите действие.');
    next();
  };
  const newCsrf = req => (req.session.csrfToken = randomBytes(32).toString('base64url'));
  const pipelineConfig = loadConfig({
    dataDir: env.HECTRA_DATA_DIR || join(resolve(dbPath, '..'), 'pipeline'),
    ...(env.OPENAI_MODEL ? { model: env.OPENAI_MODEL } : {}),
    testMode: env.HECTRA_TEST_MODE === '1'
  });
  let pipelineReady;
  const getPipeline = () => pipelineReady ||= createApplication({ config: pipelineConfig, requireOwner: true });
  async function stopPipeline() {
    if (!pipelineReady) return;
    const { store: pipelineStore, orchestrator } = await pipelineReady;
    for (const runId of orchestrator.active.keys()) await orchestrator.cancel(pipelineStore.get(runId));
    await Promise.all([...orchestrator.active.values()].map(entry => entry.promise));
    await Promise.all([...pipelineStore.queues.values()]);
  }

  app.get('/api/auth/config', (_req, res) => res.json({ googleEnabled }));
  app.get('/api/auth/csrf', (req, res) => res.json({ csrfToken: req.session.csrfToken || newCsrf(req) }));
  app.get('/api/auth/me', requireAuth, (req, res) => res.json({ user: publicUser(req.user), csrfToken: req.session.csrfToken || newCsrf(req) }));

  app.post('/api/auth/register', authLimiter, csrf, async (req, res, next) => {
    try {
      const name = typeof req.body?.name === 'string' ? req.body.name.trim().replace(/\s+/g, ' ') : '';
      const email = validEmail(req.body?.email);
      const password = req.body?.password;
      if (name.length < 2 || name.length > 80 || !email || typeof password !== 'string' || password.length < 10 || password.length > 256) {
        return errorResponse(res, 400, 'VALIDATION', 'Укажите имя (2–80 символов), корректный email и пароль от 10 символов.');
      }
      if (db.prepare('SELECT 1 FROM users WHERE email = ?').get(email)) {
        return errorResponse(res, 409, 'EMAIL_EXISTS', 'Аккаунт с этим email уже существует. Войдите выбранным ранее способом.');
      }
      const id = randomUUID();
      const now = new Date().toISOString();
      const passwordHash = await hashPassword(password);
      try {
        db.prepare('INSERT INTO users (id, name, email, password_hash, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)')
          .run(id, name, email, passwordHash, now, now);
      } catch (error) {
        if (error.code === 'ERR_SQLITE_ERROR' && /UNIQUE constraint failed/.test(error.message)) {
          return errorResponse(res, 409, 'EMAIL_EXISTS', 'Аккаунт с этим email уже существует.');
        }
        throw error;
      }
      await regenerate(req);
      req.session.userId = id;
      newCsrf(req);
      await saveSession(req);
      res.status(201).json({ user: { id, name, email }, csrfToken: req.session.csrfToken });
    } catch (error) { next(error); }
  });

  app.post('/api/auth/login', authLimiter, csrf, async (req, res, next) => {
    try {
      const email = validEmail(req.body?.email);
      const password = req.body?.password;
      if (!email || typeof password !== 'string') return errorResponse(res, 400, 'VALIDATION', 'Введите email и пароль.');
      const user = db.prepare('SELECT id, name, email, password_hash FROM users WHERE email = ?').get(email);
      if (!user?.password_hash || !(await verifyPassword(password, user.password_hash))) {
        return errorResponse(res, 401, 'BAD_CREDENTIALS', 'Неверный email или пароль.');
      }
      await regenerate(req);
      req.session.userId = user.id;
      newCsrf(req);
      await saveSession(req);
      res.json({ user: publicUser(user), csrfToken: req.session.csrfToken });
    } catch (error) { next(error); }
  });

  app.post('/api/auth/logout', requireAuth, csrf, (req, res, next) => {
    req.session.destroy(error => {
      if (error) return next(error);
      res.clearCookie('silvius.sid', { path: '/', sameSite: 'lax', secure: production });
      res.status(204).end();
    });
  });

  app.get('/api/auth/google', async (req, res, next) => {
    if (!googleEnabled) return errorResponse(res, 503, 'GOOGLE_AUTH_NOT_CONFIGURED', googleNotConfigured);
    try {
      const config = await googleConfig();
      const state = oidc.randomState();
      const nonce = oidc.randomNonce();
      const verifier = oidc.randomPKCECodeVerifier();
      req.session.googleFlow = { state, nonce, verifier, createdAt: Date.now() };
      await saveSession(req);
      const url = oidc.buildAuthorizationUrl(config, {
        redirect_uri: callbackUrl, scope: 'openid email profile', state, nonce,
        code_challenge: await oidc.calculatePKCECodeChallenge(verifier), code_challenge_method: 'S256'
      });
      res.redirect(url.href);
    } catch (error) { next(error); }
  });

  app.get('/api/auth/google/callback', async (req, res) => {
    if (!googleEnabled) return errorResponse(res, 503, 'GOOGLE_AUTH_NOT_CONFIGURED', googleNotConfigured);
    const flow = req.session.googleFlow;
    delete req.session.googleFlow;
    if (!flow || Date.now() - flow.createdAt > 10 * 60 * 1000 || !safeEqual(flow.state, req.query.state)) {
      return errorResponse(res, 400, 'INVALID_OAUTH_STATE', 'Вход через Google не подтверждён. Начните заново.');
    }
    if (req.query.error) return res.redirect('/auth.html?error=google_cancelled#login');
    try {
      const config = await googleConfig();
      const callback = new URL(callbackUrl);
      callback.search = new URLSearchParams(req.query).toString();
      const tokens = await oidc.authorizationCodeGrant(config, callback, {
        expectedState: flow.state, expectedNonce: flow.nonce, pkceCodeVerifier: flow.verifier, idTokenExpected: true
      });
      const claims = tokens.claims();
      const email = validEmail(claims?.email);
      if (!claims?.sub || !email || claims.email_verified !== true) return res.redirect('/auth.html?error=google_profile#login');
      let user = db.prepare(`SELECT u.id, u.name, u.email FROM google_accounts g
        JOIN users u ON u.id = g.user_id WHERE g.provider = ? AND g.provider_subject = ?`).get('google', claims.sub);
      if (!user) {
        if (db.prepare('SELECT 1 FROM users WHERE email = ?').get(email)) return res.redirect('/auth.html?error=google_conflict#login');
        const id = randomUUID();
        const now = new Date().toISOString();
        const name = typeof claims.name === 'string' && claims.name.trim() ? claims.name.trim().slice(0, 80) : email.split('@')[0];
        db.exec('BEGIN IMMEDIATE');
        try {
          db.prepare('INSERT INTO users (id, name, email, password_hash, email_verified_at, created_at, updated_at) VALUES (?, ?, ?, NULL, ?, ?, ?)')
            .run(id, name, email, now, now, now);
          db.prepare('INSERT INTO google_accounts (id, user_id, provider, provider_subject, created_at) VALUES (?, ?, ?, ?, ?)')
            .run(randomUUID(), id, 'google', claims.sub, now);
          db.exec('COMMIT');
        } catch (error) { db.exec('ROLLBACK'); throw error; }
        user = { id, name, email };
      }
      await regenerate(req);
      req.session.userId = user.id;
      newCsrf(req);
      await saveSession(req);
      res.redirect('/workspace.html');
    } catch (_error) {
      res.redirect('/auth.html?error=google_failed#login');
    }
  });

  app.get('/workspace.html', (req, res) => {
    if (!currentUser(req)) return res.redirect('/auth.html#login');
    res.set('Cache-Control', 'no-store');
    res.sendFile(join(frontend, 'workspace.html'));
  });
  app.get('/run.html', requireAuth, (_req, res) => {
    res.set('Cache-Control', 'no-store');
    res.sendFile(join(frontend, 'run.html'));
  });
  app.use('/api/hectra', requireAuth, (req, res, next) => {
    if (req.method !== 'GET' && req.method !== 'HEAD') return csrf(req, res, next);
    next();
  }, async (req, res, next) => {
    try {
      const { app: pipelineApp } = await getPipeline();
      req.url = `/api${req.url}`;
      pipelineApp(req, res, next);
    } catch (error) { next(error); }
  });
  app.get('/', (_req, res) => res.sendFile(join(frontend, 'index.html')));
  app.use(express.static(frontend, { index: false }));
  app.use('/api', (_req, res) => errorResponse(res, 404, 'NOT_FOUND', 'Маршрут не найден.'));
  app.use((error, _req, res, _next) => {
    if (error instanceof SyntaxError && error.status === 400) return errorResponse(res, 400, 'BAD_JSON', 'Некорректный JSON.');
    console.error('Ошибка сервера:', error?.code || 'INTERNAL');
    errorResponse(res, 500, 'SERVER_ERROR', 'Внутренняя ошибка сервера.');
  });

  return { app, db, store, initializePipeline: getPipeline, stopPipeline, close() { clearInterval(cleanupTimer); db.close(); } };
}
