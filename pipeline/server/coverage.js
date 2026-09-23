import { rangeBlocks } from './validate.js';
import { refKey, blockRef } from './util.js';
export function coverage(run) {
  const rows=new Map(run.documents.flatMap(d=>d.blocks.map(b=>[refKey(blockRef(b)),{...blockRef(b),side:d.side,extracted:!!b.text.trim()&&!b.unavailable,overview:false,tool_read:false,assigned:false,function_extracted:false,compared:false,judge_checked:false,comparison_judge_checked:false,crosscheck_checked:false,not_applicable:false,reasons:[]}])));
  const mark=(refs,field)=>refs.forEach(ref=>{const row=rows.get(refKey(ref));if(row)row[field]=true;});
  const rangeRefs=r=>rangeBlocks(run,r).map(blockRef);
  for(const r of run.plan?.remainder||[])if(r.status==='not_applicable')for(const ref of rangeRefs(r.range)){const row=rows.get(refKey(ref));row.not_applicable=true;row.reasons.push(r.reason);}
  for(const log of run.logs) {if(log.type==='overview')mark(log.refs,'overview');if(log.type==='tool'&&log.name==='read_blocks'&&!log.error)mark(log.returned_refs||[],'tool_read');}
  for(const e of run.extractions.filter(e=>e.current))for(const c of e.coverage){if(c.status==='considered')mark(rangeRefs(c.range),'function_extracted');if(c.status==='not_applicable')for(const ref of rangeRefs(c.range)){const r=rows.get(refKey(ref));r.not_applicable=true;r.reasons.push(c.reason);}}
  for(const t of run.tasks.filter(t=>t.current)) {
    [...t.before,...t.after].forEach(r=>mark(rangeRefs(r),'assigned'));
    if(t.kind==='comparison'&&t.result)for(const c of t.result.coverage){if(c.status==='considered')mark(rangeRefs(c.range),'compared');else if(c.status==='not_applicable')for(const ref of rangeRefs(c.range)){const r=rows.get(refKey(ref));r.not_applicable=true;r.reasons.push(c.reason);}}
    const j=run.judge_results.findLast(j=>j.current&&j.task_id===t.id&&j.task_version===t.version&&j.result_version===t.result_version);
    if(j)for(const r of j.checked_ranges){mark(rangeRefs(r),'judge_checked');if(t.kind==='comparison')mark(rangeRefs(r),'comparison_judge_checked');if(t.kind==='crosscheck')mark(rangeRefs(r),'crosscheck_checked');}
  }
  const blocks=[...rows.values()],counts={total:blocks.length};
  for(const field of ['extracted','overview','tool_read','assigned','function_extracted','compared','judge_checked','comparison_judge_checked','crosscheck_checked','not_applicable'])counts[field]=blocks.filter(b=>b[field]).length;
  counts.unavailable=blocks.filter(b=>!b.extracted).length;
  counts.unchecked=blocks.filter(b=>b.extracted&&!b.judge_checked&&!b.not_applicable).length;
  counts.incomplete_comparison=blocks.filter(b=>b.extracted&&!b.not_applicable&&(!b.compared||!b.comparison_judge_checked)).length;
  counts.incomplete_B_extraction=blocks.filter(b=>b.side==='B'&&b.extracted&&!b.not_applicable&&!b.function_extracted).length;
  return {counts,blocks,failed_documents:run.documents.filter(d=>d.status==='failed').map(d=>d.id)};
}
