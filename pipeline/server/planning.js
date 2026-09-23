import { rangeBlocks, validatePlan } from './validate.js';
import { buildDiff } from './diff.js';
import { hash, id, blockRef, refKey, check, unique } from './util.js';
export const fullRange=d=>({document_id:d.id,extraction_version:d.extraction_version,start_block_id:d.blocks[0].id,end_block_id:d.blocks.at(-1).id});
export function rangesFromBlocks(blocks) {
  const uniqueBlocks=[...new Map(blocks.map(b=>[refKey(blockRef(b)),b])).values()].sort((a,b)=>a.document_id.localeCompare(b.document_id)||a.order-b.order),ranges=[];
  let last=null;
  for(const b of uniqueBlocks){if(last&&last.document_id===b.document_id&&last.extraction_version===b.extraction_version&&last.order+1===b.order){ranges.at(-1).end_block_id=b.id;}else ranges.push({document_id:b.document_id,extraction_version:b.extraction_version,start_block_id:b.id,end_block_id:b.id});last=b;}
  return ranges;
}
export function splitBlocks(blocks,budgets) {
  const chunks=[];let chunk=[],size=0;
  for(const block of blocks) {if(chunk.length&&(size+block.text.length>budgets.chunkChars||chunk.length>=budgets.chunkBlocks)){chunks.push(chunk);chunk=[];size=0;}chunk.push(block);size+=block.text.length;}
  if(chunk.length)chunks.push(chunk);return chunks;
}
export function explicitPlan(run) {
  const before=run.documents.filter(d=>d.side==='A'&&d.blocks.length),after=run.documents.filter(d=>d.side==='B'&&d.blocks.length);
  check(before.length===1&&after.length===1,'Для явно заданной пары нужен один пригодный документ на каждой стороне.');
  return {version:1,groups:[{id:'pair',label:'Явно заданная пара документов',before:before.map(fullRange),after:after.map(fullRange),relation:'1:1',method:'explicit_pair',rationale:'Пара задана пользователем. Детальное соответствие блоков ещё не проверено.',evidence_refs:[],uncertainty:[]}],remainder:[],clarification:null,limitations:[]};
}
export function withRemainders(run,plan) {
  const covered=new Set(plan.groups.flatMap(g=>[...g.before,...g.after].flatMap(r=>rangeBlocks(run,r))).map(b=>refKey(blockRef(b))));
  const notApplicable=new Set(plan.remainder.filter(r=>r.status==='not_applicable').flatMap(r=>rangeBlocks(run,r.range)).map(b=>refKey(blockRef(b))));
  for(const doc of run.documents) {
    const missing=doc.blocks.filter(b=>!covered.has(refKey(blockRef(b)))&&!notApplicable.has(refKey(blockRef(b))));
    for(const blocks of splitBlocks(missing,run.settings.budgets)) {
      const ranges=rangesFromBlocks(blocks),available=blocks.some(b=>b.text.trim()&&!b.unavailable);
      if(available) plan.groups.push({id:`remainder_${hash(ranges).slice(0,14)}`,label:`Исследование остатка: ${doc.name}`,before:doc.side==='A'?ranges:[],after:doc.side==='B'?ranges:[],relation:'remainder',method:'unmatched',rationale:'Пригодный участок без назначения; доступен поиск по противоположному пулу.',evidence_refs:[],uncertainty:['Соответствие ещё не установлено.']});
      for(const range of ranges)if(!plan.remainder.some(r=>JSON.stringify(r.range)===JSON.stringify(range)))plan.remainder.push({range,status:available?'unreviewed':'unavailable',reason:available?'Создана задача исследования остатка.':'Текст недоступен.'});
    }
  }
  return plan;
}
export function taskSignature(task) {return hash({kind:task.kind,before:task.before,after:task.after});}
export function makeTasks(run,plan) {
  const map=new Map();
  for(const g of plan.groups) {
    const before=g.before.flatMap(r=>rangeBlocks(run,r)),after=g.after.flatMap(r=>rangeBlocks(run,r));
    const diff=buildDiff(run,before,after),lookup=new Map([...before,...after].map(b=>[refKey(blockRef(b)),b]));
    let rows=[],chars=0;
    function flush(){if(!rows.length)return;const a=rows.flatMap(r=>r.before_refs).map(r=>lookup.get(refKey(r))),b=rows.flatMap(r=>r.after_refs).map(r=>lookup.get(refKey(r)));
      const t={kind:'comparison',before:rangesFromBlocks(a),after:rangesFromBlocks(b),source_groups:[g.id],label:g.label,diff:{rows}};
      t.signature=taskSignature(t);if(map.has(t.signature))map.get(t.signature).source_groups.push(g.id);else map.set(t.signature,t);rows=[];chars=0;}
    for(const row of diff.rows) {const n=row.before_text.length+row.after_text.length;if(rows.length&&(chars+n>run.settings.budgets.chunkChars||rows.length>=run.settings.budgets.chunkBlocks)){flush();}rows.push(row);chars+=n;}flush();
  }
  return [...map.values()].map(t=>({...t,routing_basis_hash:hash(plan.groups.filter(g=>t.source_groups.includes(g.id)).map(g=>({method:g.method,rationale:g.rationale,evidence_refs:g.evidence_refs,uncertainty:g.uncertainty,relation:g.relation})))}));
}
export function invalidateTask(run,task,reason) {
  task.current=false;task.status='stale';task.stale_reason=reason;
  run.findings.filter(f=>f.task_id===task.id&&f.task_version===task.version).forEach(f=>f.current=false);
  run.judge_results.filter(j=>j.task_id===task.id&&j.task_version===task.version).forEach(j=>j.current=false);
}
export function staleReport(run) {if(run.report)run.report.stale=true;run.registry_version++;run.reconcile_key=null;}
export function applyPlan(run,proposal,{parentTask=null,reason='Изменена карта соответствий'}={}) {
  validatePlan(run,proposal);const plan=withRemainders(run,structuredClone(proposal));validatePlan(run,plan);
  const old=run.tasks.filter(t=>t.current&&t.kind==='comparison'),fresh=makeTasks(run,plan),retained=new Set();
  const nextVersion=(run.plan?.version||0)+1;plan.version=nextVersion;
  if(run.plan)run.plan_history.push(run.plan);run.plan=plan;
  for(const shape of fresh) {
    const existing=old.find(t=>t.signature===shape.signature&&t.routing_basis_hash===shape.routing_basis_hash);
    if(existing){existing.source_groups=shape.source_groups;retained.add(existing);continue;}
    const touched=old.filter(t=>t.source_groups.some(g=>shape.source_groups.includes(g))||[...t.before,...t.after].some(r=>[...shape.before,...shape.after].some(n=>r.document_id===n.document_id&&r.start_block_id<=n.end_block_id&&r.end_block_id>=n.start_block_id)));
    const roots=unique([...touched.flatMap(t=>t.lineage),...(parentTask?.lineage||[])]);
    if(!roots.length){const root=id('lineage');run.lineages[root]={repairs_used:0};roots.push(root);}
    run.tasks.push({...shape,id:id('task'),version:1,input_hash:hash(shape),lineage:roots,dependencies:[...shape.before,...shape.after].map(r=>({document_id:r.document_id,extraction_version:r.extraction_version})),plan_version:nextVersion,status:'pending',current:true,result:null,result_version:0,additional:parentTask?.additional||null});
  }
  for(const task of old)if(!retained.has(task))invalidateTask(run,task,reason);
  for(const task of run.tasks.filter(t=>t.current&&t.kind!=='comparison'))invalidateTask(run,task,reason);
  staleReport(run);return plan;
}
export function repairAvailable(run,task) {return task.lineage.every(root=>(run.lineages[root]?.repairs_used||0)<1);}
export function consumeRepair(run,task) {check(repairAvailable(run,task),'Лимит смыслового исправления исчерпан.','repair_budget');for(const root of task.lineage)run.lineages[root].repairs_used++;}
export function reviseTask(run,task,additional) {
  invalidateTask(run,task,'Адресное исправление judge');
  const next={...structuredClone(task),version:task.version+1,status:'pending',current:true,result:null,result_version:0,additional};delete next.stale_reason;
  run.tasks.push(next);staleReport(run);return next;
}
