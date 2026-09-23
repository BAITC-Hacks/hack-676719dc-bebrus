import Ajv from 'ajv';
import { roleSchemas, toolSchemas, runSchema } from '../shared/contracts.js';
import { check, AppError, refKey } from './util.js';
const ajv = new Ajv({ allErrors:true, strict:true });
const validators = Object.fromEntries(Object.entries({ ...roleSchemas, ...toolSchemas, Run:runSchema }).map(([name,schema]) => [name,ajv.compile(schema)]));
export function validate(name, value) {
  const fn = validators[name];
  if (!fn?.(value)) throw new AppError('invalid_structure', `Неверная структура ${name}`, 422, fn?.errors);
  return value;
}
export function document(run, documentId, version) {
  const d = run.documents.find(d => d.id === documentId);
  check(d && (version === undefined || d.extraction_version === version), 'Документ или версия недоступны в текущем запуске.', 'invalid_reference');
  return d;
}
export function resolveRef(run, ref) {
  const d = document(run,ref.document_id,ref.extraction_version), b = d.blocks.find(b=>b.id===ref.block_id);
  check(b, 'Блок источника не существует.', 'invalid_reference');
  if (ref.char_start !== null && ref.char_start !== undefined) check(Number.isInteger(ref.char_start) && Number.isInteger(ref.char_end) && ref.char_start >= 0 && ref.char_end > ref.char_start && ref.char_end <= b.text.length, 'Неверный диапазон символов.', 'invalid_reference');
  else check(ref.char_end === null || ref.char_end === undefined, 'Не задано начало диапазона.', 'invalid_reference');
  return b;
}
export function rangeBlocks(run, range, side) {
  const d = document(run,range.document_id,range.extraction_version);
  check(!side || d.side === side, 'Неверная сторона диапазона.', 'invalid_reference');
  const start = d.blocks.findIndex(b=>b.id===range.start_block_id), end = d.blocks.findIndex(b=>b.id===range.end_block_id);
  check(start >= 0 && end >= start, 'Неверные границы блоков.', 'invalid_reference');
  return d.blocks.slice(start,end+1);
}
export function validateRefs(run, value) {
  if (!value || typeof value !== 'object') return;
  if (value.document_id && value.block_id) resolveRef(run,value);
  if (value.document_id && value.start_block_id) rangeBlocks(run,value);
  for (const v of Object.values(value)) if (typeof v === 'object') validateRefs(run,v);
}
export function validatePlan(run, plan) {
  validate('routing',plan); validateRefs(run,plan);
  const ids = new Set(), signatures = new Set();
  for (const g of plan.groups) {
    check(!ids.has(g.id), 'Повтор ID группы.'); ids.add(g.id);
    check(g.before.length + g.after.length > 0, 'Пустая группа.');
    g.before.forEach(r=>rangeBlocks(run,r,'A')); g.after.forEach(r=>rangeBlocks(run,r,'B'));
    const a=new Set(g.before.map(r=>r.document_id)).size,b=new Set(g.after.map(r=>r.document_id)).size;
    check(g.relation==='remainder'?(!a||!b):g.relation==='1:1'?(a===1&&b===1):g.relation==='1:N'?(a===1&&b>=1):g.relation==='N:1'?(a>=1&&b===1):(a>=1&&b>=1),'Кардинальность группы не соответствует сторонам.');
    const sig = [...g.before.map(r=>'A'+JSON.stringify(r)),...g.after.map(r=>'B'+JSON.stringify(r))].sort().join('|');
    check(!signatures.has(sig), 'Точный повтор группы.'); signatures.add(sig);
  }
  for (const rest of plan.remainder) check(rest.reason.trim(), 'У остатка должно быть основание.');
  if (plan.clarification) plan.clarification.document_ids.forEach(d=>document(run,d));
  return plan;
}
export function validateResult(run, task, result, role) {
  validate(role,result); validateRefs(run,result);
  check(result.task_id === task.id && result.task_version === task.version, 'Ответ на устаревшую версию задачи.', 'stale_response');
  const functions = new Set(run.functions.filter(f=>f.current).map(f=>f.id));
  const orgs = new Set(run.org_units.filter(f=>f.current).map(f=>f.id));
  const ids = new Set();
  for (const f of result.findings) {
    check(!ids.has(f.id), 'Повтор находки в результате.'); ids.add(f.id);
    check(f.before_refs.length+f.after_refs.length > 0, 'Находка без доказательств.');
    for (const [side,refs] of [['A',f.before_refs],['B',f.after_refs]]) refs.forEach(r=>check(document(run,r.document_id).side===side,'Источник с неверной стороны.','invalid_reference'));
    f.function_refs.forEach(r=>check(functions.has(r),'Функция недоступна.','invalid_reference'));
    f.search_scope.document_ids.forEach(r=>document(run,r));
  }
  for (const [links,set,records] of [[result.function_links,functions,run.functions],[result.org_links,orgs,run.org_units]]) for (const link of links) for (const [side,ids] of [['A',link.before_ids],['B',link.after_ids]]) for(const fid of ids){check(set.has(fid),'Ссылка соответствия недоступна.','invalid_reference');check(records.some(f=>f.current&&f.id===fid&&f.side===side),'Ссылка соответствия с неверной стороны.','invalid_reference');}
  const assigned = new Set([...task.before,...task.after].flatMap(r=>rangeBlocks(run,r)).map(b=>refKey({document_id:b.document_id,extraction_version:b.extraction_version,block_id:b.id})));
  for (const c of result.coverage){check(c.status==='considered'||c.reason.trim(),'У пропущенного участка должно быть основание.');for (const b of rangeBlocks(run,c.range)) check(assigned.has(refKey({document_id:b.document_id,extraction_version:b.extraction_version,block_id:b.id})), 'Покрытие за границами задачи.');}
  return result;
}
