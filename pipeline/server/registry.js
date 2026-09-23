import { hash, refKey, unique, check, now, id } from './util.js';
import { coverage } from './coverage.js';
import { validate, validateRefs, rangeBlocks, resolveRef } from './validate.js';
import { staleReport, invalidateTask } from './planning.js';
const findingSignature=f=>hash({category:f.category,claim:f.claim.trim(),before:f.before_refs.map(refKey).sort(),after:f.after_refs.map(refKey).sort()});
export function currentFindings(run) {return run.findings.filter(f=>f.current&&!f.merged_into);}
export function commitFindings(run,task,result) {
  const remap=new Map();
  for(const raw of result.findings) {
    const signature=findingSignature(raw);
    const findingId=`finding_${hash({task:task.id,signature}).slice(0,24)}`;
    const previous=run.findings.filter(f=>f.id===findingId);
    const f={...structuredClone(raw),id:findingId,version:previous.length+1,task_id:task.id,task_version:task.version,signature,current:true,judge_status:'unreviewed',human_status:'unreviewed',provenance:[{task_id:task.id,task_version:task.version}],created_at:now()};
    remap.set(raw.id,findingId);run.findings.push(f);
  }
  result.findings=result.findings.map(f=>run.findings.findLast(x=>x.id===remap.get(f.id)));
  staleReport(run);
}
export function checkJudge(run,task,judge) {
  validate('judge',judge);validateRefs(run,judge);
  check(judge.task_id===task.id&&judge.task_version===task.version&&judge.result_version===task.result_version,'Judge проверил устаревший результат.','stale_response');
  const ids=new Set((task.kind==='reconcile'?task.review_finding_ids:task.result.findings.map(f=>f.id))||[]);
  for(const fid of [...judge.checked_finding_refs,...judge.issues.flatMap(i=>i.finding_refs),...judge.resolutions.flatMap(i=>i.finding_refs)])check(ids.has(fid),'Judge ссылается на неизвестную находку.','invalid_reference');
  const assigned=new Set([...task.before,...task.after].flatMap(r=>rangeBlocks(run,r)).map(b=>`${b.document_id}:${b.extraction_version}:${b.id}`));
  for(const r of judge.checked_ranges)for(const b of rangeBlocks(run,r))check(assigned.has(`${b.document_id}:${b.extraction_version}:${b.id}`),'Judge заявил проверку вне области задачи.');
  for(const issue of judge.issues){
    issue.log_refs.forEach(lid=>check(run.logs.some(l=>l.id===lid),'Журнал для замечания не найден.'));
    if(issue.target!=='uncertainty')check(issue.evidence_refs.length+issue.log_refs.length>0,'Локализация ошибки без источника или журнала.');
  }
  if(judge.verdict==='needs_revision')check(judge.issues.length>0,'Исправление без замечаний.');
  return judge;
}
export function commitJudge(run,task,judge) {
  const j={...judge,id:id('judge'),version:run.judge_results.filter(j=>j.task_id===task.id).length+1,current:true,created_at:now()};run.judge_results.push(j);
  for(const f of run.findings.filter(f=>f.current&&f.task_id===task.id&&f.task_version===task.version))f.judge_status=j.checked_finding_refs.includes(f.id)?j.verdict:'unreviewed';
  task.judge_status=j.verdict;staleReport(run);return j;
}
export function deduplicate(run) {
  const seen=new Map();
  for(const f of currentFindings(run)) {
    // Exact same change + sources. Semantic similarities remain for judge.
    const same=seen.get(f.signature);
    if(same){same.provenance.push(...f.provenance);same.provenance=unique(same.provenance.map(JSON.stringify)).map(JSON.parse);f.merged_into=same.id;
      const rank={unreviewed:0,passed:1,inconclusive:2,needs_revision:3};if(rank[f.judge_status]>rank[same.judge_status])same.judge_status=f.judge_status;
    } else seen.set(f.signature,f);
  }
}
export function reconciliationCandidates(run) {
  const findings=currentFindings(run),pairs=[];
  for(let i=0;i<findings.length;i++)for(let j=i+1;j<findings.length;j++) {
    const a=findings[i],b=findings[j],sources=new Set([...a.before_refs,...a.after_refs].map(refKey));
    const overlap=[...b.before_refs,...b.after_refs].some(r=>sources.has(refKey(r))),sameFunction=a.function_refs.some(f=>b.function_refs.includes(f));
    const words=s=>new Set(s.toLowerCase().split(/[^\p{L}\p{N}]+/u).filter(w=>w.length>3)),wa=words(a.claim),wb=words(b.claim);
    const similar=wa.size&&wb.size&&[...wa].filter(w=>wb.has(w)).length/Math.max(wa.size,wb.size)>0.65;
    const sourceWords=f=>words([...f.before_refs,...f.after_refs].map(r=>resolveRef(run,r).text).join(' '));
    const sa=sourceWords(a),sb=sourceWords(b),sourceSimilar=sa.size>3&&sb.size>3&&[...sa].filter(w=>sb.has(w)).length/Math.max(sa.size,sb.size)>0.72;
    if(overlap||sameFunction||(similar&&sourceSimilar))pairs.push([a.id,b.id]);
  }
  const limit=run.settings.budgets.reconciliationPairs||120,selected=pairs.slice(0,limit);selected.omitted=Math.max(0,pairs.length-limit);return selected;
}
export function registry(run) {
  const cov=coverage(run),findings=currentFindings(run),limitations=unique([
    ...run.limitations,...run.documents.flatMap(d=>d.warnings.map(w=>`${d.name}: ${w}`)),
    ...run.extractions.filter(e=>e.current).flatMap(e=>e.limitations),...run.tasks.filter(t=>t.current).flatMap(t=>t.result?.limitations||[]),
    ...run.judge_results.filter(j=>j.current).flatMap(j=>j.limitations),
    ...(run.plan?.limitations||[]),
    ...(run.plan?.remainder||[]).filter(r=>r.status==='not_applicable').map(r=>`Участок признан неприменимым маршрутизацией: ${r.reason}`),
    ...findings.flatMap(f=>f.limitations),...findings.flatMap(f=>f.uncertainty),
    ...(cov.counts.unchecked?[`Не проверены judge: ${cov.counts.unchecked} доступных блоков.`]:[]),
    ...(cov.counts.incomplete_comparison?[`Не завершено сравнение и его локальная проверка: ${cov.counts.incomplete_comparison} блоков.`]:[]),
    ...(cov.counts.incomplete_B_extraction?[`Не подтверждена обработка реестра функций Б: ${cov.counts.incomplete_B_extraction} блоков.`]:[]),
    ...(cov.failed_documents.length?[`Не удалось извлечь текст документов: ${cov.failed_documents.length}.`]:[]),
    ...(findings.some(f=>f.judge_status!=='passed')?['Часть находок не прошла подтверждающую проверку judge.']:[]),
    ...(run.judge_results.some(j=>j.current&&j.verdict!=='passed')?['Есть проверки с нерешёнными замечаниями или недостаточными основаниями.']:[]),
    ...(run.tasks.some(t=>t.current&&t.status!=='done')?['Есть незавершённые задачи.']:[]),
    'Проверка ограничена загруженными источниками; внешние нормативные проверки не выполнялись.',
    'Счётчик прочитанных и проверенных блоков отражает журнал и заявленную область judge; он не гарантирует смысловую полноту.'
  ]);
  return {version:run.registry_version,findings,functions:run.functions.filter(f=>f.current),org_units:run.org_units.filter(f=>f.current),coverage:cov,limitations,plan:run.plan,
    function_links:run.tasks.filter(t=>t.current&&t.result).flatMap(t=>t.result.function_links||[]),org_links:run.tasks.filter(t=>t.current&&t.result).flatMap(t=>t.result.org_links||[])};
}
export function validateReport(run,report) {
  validate('synthesis',report);check(report.registry_version===run.registry_version,'Заключение использует устаревший реестр.','stale_response');
  const findings=currentFindings(run),ids=new Set(findings.filter(f=>f.human_status!=='rejected').map(f=>f.id));
  for(const claim of [...report.overview,...report.questions,...report.recommendations]) {
    check(claim.finding_refs.length>0,'Существенный тезис без finding_refs.');
    for(const fid of claim.finding_refs)check(ids.has(fid),'Тезис ссылается на неактуальную или отклонённую находку.','invalid_reference');
  }
  return {...report,limitations:unique([...registry(run).limitations,...report.limitations]),version:(run.report?.version||0)+1,created_at:now(),stale:false,state:'generated'};
}
export function reviewFinding(run,findingId,{version,decision,text='',author='Пользователь'}) {
  const f=currentFindings(run).find(f=>f.id===findingId);check(f&&f.version===version,'Карточка устарела. Обновите страницу.','stale_response');
  check(['confirmed','rejected','edited','commented'].includes(decision),'Неизвестное решение.');check(typeof text==='string'&&text.length<=10000,'Слишком длинный текст.');
  const review={id:id('review'),finding_id:f.id,finding_version:f.version,decision,text,author:String(author).slice(0,100),created_at:now()};run.reviews.push(review);
  if(decision==='edited') {check(text.trim(),'Введите новую формулировку.');f.current=false;const edited={...structuredClone(f),version:f.version+1,current:true,claim:text,judge_status:'unreviewed',human_status:'edited',edited_by:review.id};edited.signature=findingSignature(edited);run.findings.push(edited);for(const t of run.tasks.filter(t=>t.current&&t.kind==='reconcile'&&t.review_finding_ids.includes(f.id)))invalidateTask(run,t,'Изменена формулировка человеком');if(run.state==='completed')run.state='completed_with_limits';}
  else if(decision!=='commented')f.human_status=decision;
  staleReport(run);return review;
}
