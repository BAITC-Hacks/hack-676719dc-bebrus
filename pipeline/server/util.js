import { createHash, randomUUID } from 'node:crypto';
export const hash = value => createHash('sha256').update(typeof value === 'string' || Buffer.isBuffer(value) ? value : stable(value)).digest('hex');
export function stable(value) {
  if (Array.isArray(value)) return `[${value.map(stable).join(',')}]`;
  if (value && typeof value === 'object') return `{${Object.keys(value).sort().map(k => `${JSON.stringify(k)}:${stable(value[k])}`).join(',')}}`;
  return JSON.stringify(value);
}
export const id = prefix => `${prefix}_${randomUUID()}`;
export const now = () => new Date().toISOString();
export const unique = values => [...new Set(values)];
export const normalize = text => text.normalize('NFKC').replace(/\s+/g, ' ').trim().toLocaleLowerCase('ru');
export class AppError extends Error {
  constructor(code, message, status = 400, details = null) { super(message); Object.assign(this, { code, status, details }); }
}
export function check(condition, message, code = 'invalid_data') { if (!condition) throw new AppError(code, message); }
export const escapeHtml = value => String(value ?? '').replace(/[&<>"']/g, c => ({ '&':'&amp;', '<':'&lt;', '>':'&gt;', '"':'&quot;', "'":'&#39;' }[c]));
export const refKey = ref => `${ref.document_id}:v${ref.extraction_version}:${ref.block_id}`;
export const blockRef = b => ({ document_id:b.document_id, extraction_version:b.extraction_version, block_id:b.id, char_start:null, char_end:null });
