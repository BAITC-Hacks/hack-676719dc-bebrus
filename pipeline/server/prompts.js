import fs from 'node:fs/promises';
import path from 'node:path';
import { ROOT } from './config.js';
import { hash } from './util.js';
export const ROLES = ['routing','extraction','comparison','crosscheck','judge','synthesis'];
export async function loadPrompts(dir = path.join(ROOT, 'prompts/system')) {
  const texts = {}, hashes = {};
  for (const role of ['common', ...ROLES]) { texts[role] = await fs.readFile(path.join(dir, `${role}.txt`), 'utf8'); hashes[role] = hash(texts[role]); }
  return { texts, hashes, missing:ROLES.filter(r => !texts[r].trim()), loaded_at:new Date().toISOString() };
}
export function instructions(snapshot, role) { return [snapshot.texts.common, snapshot.texts[role]].filter(x => x?.trim()).join('\n\n'); }
