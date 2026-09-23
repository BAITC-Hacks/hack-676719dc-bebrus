import { createRequire } from 'node:module';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import fs from 'node:fs';
import { check } from './util.js';
const require = createRequire(import.meta.url);
export const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const defaults = require('../server-config.example.cjs');
export function loadConfig(overrides = {}) {
  const localPath = path.join(ROOT, 'server-config.local.cjs');
  if (fs.existsSync(localPath)) delete require.cache[require.resolve(localPath)];
  const local = fs.existsSync(localPath) ? require(localPath) : {};
  const result = { ...defaults, ...local, ...overrides };
  if (typeof result.apiKey === 'string' && /^https?:\/\//i.test(result.apiKey.trim())) {
    result.apiKey = '';
    result.keyError = 'Вместо API-ключа указана ссылка. Вставьте сам ключ в первую строку pipeline/server-config.local.cjs и перезапустите сервер.';
  }
  for (const key of ['limits', 'budgets', 'effortByRole', 'modelByRole']) result[key] = { ...defaults[key], ...local[key], ...overrides[key] };
  check(['fast','default','auto'].includes(result.serviceTier), 'Допустимые serviceTier: fast, default, auto.');
  check(Number.isInteger(result.extractionConcurrency)&&result.extractionConcurrency>=1&&result.extractionConcurrency<=4, 'extractionConcurrency должно быть целым числом от 1 до 4.');
  for (const value of Object.values(result.effortByRole)) check(['low','medium','high','xhigh'].includes(value), 'Допустимые effort: low, medium, high, xhigh.');
  for (const value of [...Object.values(result.limits), ...Object.entries(result.budgets).filter(([key])=>key!=='transientRetries').map(([,value])=>value)]) check(Number.isInteger(value) && value > 0, 'Лимиты и бюджеты должны быть положительными целыми числами.');
  check(Number.isInteger(result.budgets.transientRetries)&&result.budgets.transientRetries>=0,'Число технических повторов должно быть целым неотрицательным.');
  result.dataDir = overrides.dataDir || process.env.HECTRA_DATA_DIR || path.join(ROOT, 'data');
  result.testMode = overrides.testMode ?? process.env.HECTRA_TEST_MODE === '1';
  return result;
}
export function publicConfig(c) { return { model:c.model, modelByRole:c.modelByRole, effortByRole:c.effortByRole, serviceTier:c.serviceTier, limits:c.limits, budgets:c.budgets }; }
