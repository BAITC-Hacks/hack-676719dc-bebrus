import fs from 'node:fs/promises';
import path from 'node:path';
import { parseFile, materialize, extractionCacheKey } from './extract.js';
import { hash, id, check } from './util.js';
import { applyPlan, fullRange, staleReport, invalidateTask } from './planning.js';
import { registry } from './registry.js';
import { resolveRef } from './validate.js';
import { coordinate } from './export.js';
import { refKey } from './util.js';
export async function addDocument(store,run,{name,side,buffer}) {
  check(['A','B'].includes(side),'Выберите сторону A или Б.');
  check(!run.prompt_snapshot&&!run.plan,'Состав начатого анализа зафиксирован. Создайте новый запуск для другого комплекта.');
  const l=run.settings.limits;
  check(run.documents.filter(d=>d.side===side).length<l.filesPerSide,`На сторону разрешено не более ${l.filesPerSide} файлов.`,'file_count_limit');
  check(buffer.length<=l.fileBytes,`Файл превышает лимит ${l.fileBytes} байт.`,'file_size_limit');
  const docId=id('doc'),cacheKey=extractionCacheKey(buffer,name),parsed=await store.cacheGet(`extract:${cacheKey}`)||await parseFile(buffer,name);
  await store.cachePut(`extract:${cacheKey}`,parsed);
  const chars=parsed.blocks.reduce((n,b)=>n+b.text.length,0),existing=run.documents.reduce((n,d)=>n+d.blocks.reduce((sum,b)=>sum+b.text.length,0),0);
  check(chars+existing<=l.totalTextChars,`Общий объём текста превышает ${l.totalTextChars} символов. Файл не добавлен; текст не обрезан.`,'text_limit');
  const doc={id:docId,side,name:path.basename(name.replace(/\\/g,'/')).slice(0,250),type:path.extname(name).slice(1).toLowerCase(),file_hash:hash(buffer),bytes:buffer.length,extraction_version:1,parser_version:parsed.parser_version,status:parsed.status,warnings:parsed.warnings,blocks:materialize(parsed,docId),history:[]};
  await store.saveOriginal(run,docId,buffer);run.documents.push(doc);run.version++;staleReport(run);store.log(run,{type:'document_added',document_id:docId,side,file_hash:doc.file_hash,status:doc.status});await store.save(run);return doc;
}
export async function reextract(store,run,doc) {
  const buffer=await fs.readFile(store.originalPath(run,doc)),parsed=await parseFile(buffer,doc.name);
  const oldVersion=doc.extraction_version;
  doc.history.push({extraction_version:oldVersion,status:doc.status,warnings:doc.warnings,blocks:doc.blocks,parser_version:doc.parser_version});
  doc.extraction_version++;doc.blocks=materialize(parsed,doc.id,doc.extraction_version);doc.status=parsed.status;doc.warnings=parsed.warnings;doc.parser_version=parsed.parser_version;
  for(const e of run.extractions)if(e.current&&e.ranges.some(r=>r.document_id===doc.id))e.current=false;
  for(const key of ['functions','org_units'])for(const f of run[key])if(f.current&&f.source_refs.some(r=>r.document_id===doc.id))f.current=false;
  if(run.plan){const plan=structuredClone(run.plan);plan.groups=plan.groups.filter(g=>![...g.before,...g.after].some(r=>r.document_id===doc.id));plan.remainder=plan.remainder.filter(r=>r.range.document_id!==doc.id);applyPlan(run,plan,{reason:'Новая версия извлечения'});}
  run.version++;run.epoch++;staleReport(run);store.log(run,{type:'reextraction',document_id:doc.id,before_version:oldVersion,after_version:doc.extraction_version});await store.save(run);
}
export function publicRun(run,{detail=true}={}) {
  const {prompt_snapshot,logs,owner_id,...safe}=run;
  const documents=run.documents.map(({blocks,history,...d})=>({...d,block_count:blocks.length,text_chars:blocks.reduce((n,b)=>n+b.text.length,0)}));
  if(!detail)return {id:run.id,name:run.name,state:run.state,mode:run.mode,created_at:run.created_at,updated_at:run.updated_at,documents};
  const reg=registry(run),refs=[...new Map(reg.findings.flatMap(f=>[...f.before_refs,...f.after_refs]).map(r=>[refKey(r),r])).values()];
  const evidence=refs.map(ref=>{const b=resolveRef(run,ref);return {ref,text:b.text,coordinate:coordinate(b)};});
  return {...safe,documents,registry:reg,evidence,tasks:run.tasks.filter(t=>t.current).map(({diff,result,...t})=>({...t,finding_count:result?.findings.length||0})),logs_count:logs.length,prompt_snapshot:undefined};
}
