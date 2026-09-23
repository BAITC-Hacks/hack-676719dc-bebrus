import { loadPrompts } from './prompts.js';
import { overview, contextBlocks } from './extract.js';
import { rangeBlocks, resolveRef, validateRefs, validateResult, validatePlan, validate } from './validate.js';
import { explicitPlan, applyPlan, rangesFromBlocks, splitBlocks, repairAvailable, consumeRepair, reviseTask, staleReport, fullRange } from './planning.js';
import { coverage } from './coverage.js';
import { commitFindings, checkJudge, commitJudge, currentFindings, deduplicate, reconciliationCandidates, registry, validateReport } from './registry.js';
import { blockRef, refKey, hash, id, unique, check, AppError, now } from './util.js';
import { safeError } from './provider.js';
const compactLog=l=>({id:l.id,type:l.type,role:l.role,name:l.name,args:l.args,returned_refs:l.returned_refs,error:l.error,result:l.name==='search_documents'?l.result:undefined});
export class Orchestrator {
  constructor(store,client,config) {Object.assign(this,{store,client,config});this.active=new Map();}
  async preflight(run) {
    const prompts=run.prompt_snapshot||await loadPrompts();
    const missing=prompts.missing;
    return {state:run.mode==='test'?'ready':missing.length?'prompts_not_configured':!this.config.apiKey?'key_not_configured':'ready',missing_roles:missing,key_ready:!!this.config.apiKey,test_mode:run.mode==='test',prompt_hashes:prompts.hashes};
  }
  async start(run,{synthesisOnly=false}={}) {
    check(!this.active.has(run.id),'Запуск уже выполняется.','already_running');
    check(this.active.size===0,'Сейчас выполняется другой запуск. Оркестратор обрабатывает задачи последовательно.','already_running');
    check(run.documents.some(d=>d.side==='A')&&run.documents.some(d=>d.side==='B'),'Загрузите документы в оба пула.');
    if(run.state==='needs_clarification'&&!synthesisOnly)return run;
    const ready=await this.preflight(run);
    if(ready.state!=='ready'){run.state=ready.state;await this.store.save(run);return run;}
    if(!run.prompt_snapshot){run.prompt_snapshot=await loadPrompts();run.prompt_hashes=run.prompt_snapshot.hashes;}
    run.epoch++;run.state='running';run.last_error=null;
    const epoch=run.epoch,controller=new AbortController();
    const entry={controller,promise:null};this.active.set(run.id,entry);await this.store.save(run);
    entry.promise=this.execute(run,epoch,controller.signal,synthesisOnly).catch(async e=>{
      if(run.epoch===epoch){run.state=controller.signal.aborted?'cancelled':'partial';run.last_error={code:e.code||'pipeline_error',message:safeError(e,this.config.apiKey)};run.errors.push({...run.last_error,at:now(),stage:run.stage});}
      await this.store.save(run);
    }).finally(async()=>{if(this.active.get(run.id)===entry)this.active.delete(run.id);run.current_task=null;await this.store.save(run);});
    return run;
  }
  async wait(run) {await this.active.get(run.id)?.promise;return run;}
  async cancel(run) {run.epoch++;run.state='cancelled';this.active.get(run.id)?.controller.abort();for(const t of run.tasks)if(t.status==='running')t.status='pending';await this.store.save(run);}
  async stage(run,name,task=null){run.stage=name;run.current_task=task?{id:task.id,label:task.label}:null;await this.store.save(run);}
  guard(run,epoch,task) {return ()=>run.epoch===epoch&&run.state==='running'&&(!task||(task.current&&run.tasks.some(t=>t===task&&t.version===task.version)));}
  async role(run,role,data,epoch,signal,task=null) {
    await this.stage(run,role,task);
    const validateOutput=result=>{
      if(role==='routing')validatePlan(run,result);
      if(['comparison','crosscheck'].includes(role)&&task)validateResult(run,task,result,role);
      if(role==='judge'&&task)checkJudge(run,task,result);
      if(role==='synthesis')validateReport(run,result);
      if(role==='extraction'){
        const assigned=new Set(data.ranges.flatMap(r=>rangeBlocks(run,r)).map(b=>refKey(blockRef(b))));
        for(const record of [...result.functions,...result.org_units]){
          check(record.source_refs.length>0&&record.source_refs.some(r=>assigned.has(refKey(r))),'Запись извлечения вне назначенных блоков.');
          for(const value of Object.values(record))if(value&&typeof value==='object'&&!Array.isArray(value)&&'basis'in value)check(value.basis==='unknown'?value.value===null:value.source_refs.length>0,'Признак без основания.');
        }
        for(const c of result.coverage){check(c.status==='considered'||c.reason.trim(),'У пропущенного участка должно быть основание.');for(const b of rangeBlocks(run,c.range))check(assigned.has(refKey(blockRef(b))),'Покрытие извлечения вне назначенных блоков.');}
      }
    };
    return this.client.call(run,role,data,{signal,guard:this.guard(run,epoch,task),validateOutput});
  }
  catalogue(run){return run.documents.map(d=>({id:d.id,name:d.name,side:d.side,status:d.status,extraction_version:d.extraction_version,warnings:d.warnings,block_count:d.blocks.length}));}
  context(run,ranges) {
    const blocks=[...new Map(ranges.flatMap(r=>rangeBlocks(run,r)).map(b=>[refKey(blockRef(b)),b])).values()];
    const assigned=new Set(blocks.map(b=>refKey(blockRef(b)))),all=new Map();
    for(const b of blocks){const doc=run.documents.find(d=>d.id===b.document_id);for(const item of [b,...contextBlocks(doc,b)])all.set(refKey(blockRef(item)),item);}
    return [...all.values()].map(b=>{const {normalized,...block}=b;return {block,document_name:run.documents.find(d=>d.id===b.document_id).name,assigned:assigned.has(refKey(blockRef(b)))};});
  }
  async route(run,epoch,signal,additional=null) {
    const docs=run.documents.map(d=>overview(d,run.settings.budgets.overviewChars));
    this.store.log(run,{type:'overview',role:'routing',refs:docs.flatMap(d=>d.blocks.map(b=>({document_id:d.id,extraction_version:d.extraction_version,block_id:b.id,char_start:null,char_end:null})))});
    const data={task_type:'routing',versions:{run:run.version,plan:run.plan?.version||0},documents:docs,previous_plan:run.plan,clarifications:run.clarifications,clarification_rounds_remaining:run.clarifications.length?0:1,...(additional?{additional}: {})};
    const plan=await this.role(run,'routing',data,epoch,signal);validatePlan(run,plan);
    if(plan.clarification&&!run.clarifications.length) {
      run.clarifications.push({id:id('clarification'),...plan.clarification,plan_version:plan.version,status:'pending',answer:null,author:null,created_at:now()});
      run.pending_plan=plan;run.pending_routing={additional};run.state='needs_clarification';await this.store.save(run);return false;
    }
    if(plan.clarification) {plan.limitations.push('Повторное уточнение не запрашивалось: один раунд уже использован. Неопределённые участки направлены в исследование остатков.');plan.clarification=null;}
    applyPlan(run,plan,{parentTask:additional?run.tasks.find(t=>t.id===additional.task_id&&t.version===additional.task_version):null});run.pending_routing=null;run.pending_plan=null;await this.store.save(run);return true;
  }
  async clarify(run,{answer=null,skip=false}) {
    check(run.state==='needs_clarification','Нет ожидающего уточнения.');const c=run.clarifications.find(c=>c.status==='pending');check(c,'Нет вопроса.');
    check(skip||(typeof answer==='string'&&answer.trim()&&answer.length<=12000),'Введите пояснение или пропустите вопрос.');
    Object.assign(c,{answer:skip?null:answer,status:skip?'skipped':'answered',author:'Пользователь',answered_at:now()});run.state='draft';await this.store.save(run);return this.start(run);
  }
  extractionJobs(run) {return run.documents.flatMap(d=>splitBlocks(d.blocks.filter(b=>b.text.trim()&&!b.unavailable),run.settings.budgets).map(blocks=>({doc:d,blocks,ranges:rangesFromBlocks(blocks)})));}
  async extractJobs(run,jobs,epoch,signal) {
    for(const job of jobs) {
      const dependency=hash({document_id:job.doc.id,document:job.doc.file_hash,version:job.doc.extraction_version,blocks:job.blocks.map(b=>({id:b.id,text:b.text,context:contextBlocks(job.doc,b)})),prompts:run.prompt_hashes,model:run.settings.modelByRole.extraction||run.settings.model,effort:run.settings.effortByRole.extraction,clarifications:run.clarifications});
      if(run.extractions.some(e=>e.current&&e.dependency===dependency))continue;
      const data={task_type:'function_extraction',versions:{document:job.doc.extraction_version},ranges:job.ranges,document:this.catalogue(run).find(d=>d.id===job.doc.id),context:this.context(run,job.ranges)};
      const result=await this.role(run,'extraction',data,epoch,signal);validate('extraction',result);validateRefs(run,result);
      const assigned=new Set(job.blocks.map(b=>refKey(blockRef(b))));
      for(const record of [...result.functions,...result.org_units]) {
        check(record.source_refs.length>0&&record.source_refs.some(r=>assigned.has(refKey(r))),'Запись извлечения не связана с назначенными блоками.');
        for(const value of Object.values(record))if(value&&typeof value==='object'&&!Array.isArray(value)&&'basis'in value){check(value.basis==='unknown'?value.value===null:value.source_refs.length>0,'Признак без основания.');}
      }
      for(const c of result.coverage)for(const b of rangeBlocks(run,c.range))check(assigned.has(refKey(blockRef(b))),'Покрытие извлечения вне задачи.');
      const extractionId=id('extraction');
      for(const [field,prefix] of [['functions','fn'],['org_units','org']]) for(const record of result[field]) {
        const recordId=`${prefix}_${hash({document:job.doc.id,content:{...record,id:undefined,version:undefined}}).slice(0,24)}`;
        if(!run[field].some(f=>f.id===recordId&&f.current))run[field].push({...record,id:recordId,version:1,side:job.doc.side,current:true,extraction_id:extractionId});
      }
      run.extractions.push({id:extractionId,dependency,ranges:job.ranges,current:true,coverage:result.coverage,limitations:result.limitations});staleReport(run);await this.store.save(run);
    }
  }
  async ensureTaskFunctions(run,task,epoch,signal) {
    const assigned=new Set([...task.before,...task.after].flatMap(r=>rangeBlocks(run,r)).map(b=>refKey(blockRef(b))));
    await this.extractJobs(run,this.extractionJobs(run).filter(job=>job.blocks.some(b=>assigned.has(refKey(blockRef(b))))),epoch,signal);
  }
  taskData(run,task) {
    const ranges=[...task.before,...task.after],keys=new Set(ranges.flatMap(r=>rangeBlocks(run,r)).map(b=>refKey(blockRef(b))));
    const related=f=>f.current&&(task.function_ids?task.function_ids.includes(f.id):f.source_refs.some(r=>keys.has(refKey(r))));
    return {task_type:task.kind,task_id:task.id,task_version:task.version,versions:{plan:task.plan_version,dependencies:task.dependencies,registry:run.registry_version},before:task.before,after:task.after,
      documents:this.catalogue(run),context:this.context(run,ranges),diff:task.diff||null,functions:run.functions.filter(related),org_units:run.org_units.filter(f=>f.current&&f.source_refs.some(r=>keys.has(refKey(r)))),
      plan_groups:run.plan.groups.filter(g=>task.source_groups?.includes(g.id)),related_tasks:run.tasks.filter(t=>t.current).map(t=>({id:t.id,version:t.version,kind:t.kind,label:t.label,status:t.status})),
      ...(task.additional?{additional:task.additional}:{})};
  }
  proceduralIssues(run,task,result) {
    const issues=[],logs=run.logs.filter(l=>l.task_id===task.id&&l.task_version===task.version&&l.type==='tool');
    for(const f of result.findings)if(['potential_loss','new_function'].includes(f.category)) {
      const side=f.category==='potential_loss'?'B':'A',docs=run.documents.filter(d=>d.side===side&&d.status!=='failed').map(d=>d.id);
      const searches=logs.filter(l=>l.name==='search_documents'&&!l.error&&(l.args.side===side||l.args.side===null)&&docs.every(d=>l.result.searched_document_ids.includes(d)));
      if(!searches.length)issues.push({id:id('procedure'),finding_refs:[f.id],error_type:'missing_global_search',target:task.kind==='crosscheck'?'crosscheck':'comparison',evidence_refs:[...f.before_refs,...f.after_refs],log_refs:[],alternative_causes:[],instruction:'',acceptance_condition:''});
    }
    return issues;
  }
  async compare(run,task,epoch,signal) {
    if(task.kind==='comparison')await this.ensureTaskFunctions(run,task,epoch,signal);
    if(!task.result) {
      task.status='running';const data=this.taskData(run,task),result=await this.role(run,task.kind,data,epoch,signal,task);
      validateResult(run,task,result,task.kind);
      for(const proposal of result.mapping_proposals)validatePlan(run,{version:1,groups:[proposal],remainder:[],clarification:null,limitations:[]});
      commitFindings(run,task,result);task.result=result;task.result_version++;task.status='comparing_done';await this.store.save(run);
    }
    const checked=run.judge_results.findLast(j=>j.current&&j.task_id===task.id&&j.task_version===task.version&&j.result_version===task.result_version);
    let judge=checked;
    if(!judge) {
      const cov=coverage(run),assigned=new Set([...task.before,...task.after].flatMap(r=>rangeBlocks(run,r)).map(b=>refKey(blockRef(b))));
      const data={...this.taskData(run,task),task_type:'local_judge',result_version:task.result_version,result:task.result,action_log:run.logs.filter(l=>l.task_id===task.id).map(compactLog),coverage:{counts:cov.counts,blocks:cov.blocks.filter(b=>assigned.has(refKey(b))),failed_documents:cov.failed_documents},limitations:registry(run).limitations};
      // additional must be the final block in all revision requests.
      if(data.additional){const additional=data.additional;delete data.additional;data.additional=additional;}
      const response=await this.role(run,'judge',data,epoch,signal,task);checkJudge(run,task,response);
      const procedural=this.proceduralIssues(run,task,task.result);
      if(procedural.length){response.verdict='needs_revision';response.issues.push(...procedural);response.limitations.push('Сервер не нашёл обязательный поиск по полному противоположному пулу.');}
      judge=commitJudge(run,task,response);await this.store.save(run);
    }
    if(judge.verdict==='needs_revision'&&repairAvailable(run,task)) {
      const targets=new Set(judge.issues.map(i=>i.target));
      if(targets.has('preparation')){run.limitations.push('Judge обнаружил проблему подготовки. Нужна проверка исходного файла; отсутствующий текст автоматически не восстанавливался.');}
      else if(targets.has('routing')||targets.has('comparison')||targets.has('crosscheck')) {
        consumeRepair(run,task);
        const additional={type:'judge_revision',target:targets.has('routing')?'routing':task.kind,task_id:task.id,task_version:task.version,finding_ids:unique(judge.issues.flatMap(i=>i.finding_refs)),issues:judge.issues};
        task.additional=additional;
        if(targets.has('routing')){
          const previousVersion=task.version;
          await this.route(run,epoch,signal,additional);
          if(task.current&&task.version===previousVersion)reviseTask(run,task,{...additional,target:task.kind});
        } else reviseTask(run,task,additional);
        await this.store.save(run);return;
      }
    }
    task.status='done';
    if(judge.verdict!=='passed')run.limitations.push(`${task.label}: проверка ${judge.verdict}; автоматические исправления завершены или неприменимы.`);
    // New links are proposed data, validated and applied only here. Existing tasks are retained by signature.
    const proposals=task.result.mapping_proposals.filter(p=>!run.plan.groups.some(g=>hash({before:g.before,after:g.after})===hash({before:p.before,after:p.after})));
    if(proposals.length) {
      const plan=structuredClone(run.plan);
      for(const p of proposals)plan.groups.push({...p,id:`mapping_${hash({before:p.before,after:p.after}).slice(0,18)}`});
      applyPlan(run,plan,{parentTask:task,reason:'Найдено соответствие за пределами группы'});
    }
    await this.store.save(run);
  }
  async drain(run,epoch,signal,kind='comparison') {
    while(true) {check(this.guard(run,epoch)(),'Запуск остановлен.','cancelled');const task=run.tasks.find(t=>t.current&&t.kind===kind&&t.status!=='done');if(!task)break;await this.compare(run,task,epoch,signal);if(run.state==='needs_clarification')break;}
  }
  crosscheckTasks(run) {
    const functions=run.functions.filter(f=>f.current&&f.side==='B'),size=run.settings.budgets.crosscheckBatch;
    const tokens=f=>[f.action.value,f.object.value,f.scope.value].filter(Boolean).join(' ').toLowerCase().split(/[^\p{L}\p{N}]+/u).filter(w=>w.length>3);
    const remaining=new Set(functions.map(f=>f.id)),groups=[];
    while(remaining.size) {
      const seed=functions.find(f=>remaining.has(f.id)),terms=new Set(tokens(seed));
      const candidates=functions.filter(f=>remaining.has(f.id)).sort((a,b)=>tokens(b).filter(w=>terms.has(w)).length-tokens(a).filter(w=>terms.has(w)).length);
      const batch=candidates.slice(0,size);batch.forEach(f=>remaining.delete(f.id));groups.push(batch);
    }
    if(!groups.length)groups.push([]); // Empty registry is also checked.
    const signature=hash(functions.map(f=>[f.id,f.version]));
    for(const [i,batch] of groups.entries()) {
      const key=hash({signature,ids:batch.map(f=>f.id)});
      if(run.tasks.some(t=>t.current&&t.kind==='crosscheck'&&t.signature===key))continue;
      const blocks=batch.flatMap(f=>f.source_refs.map(r=>resolveRef(run,r))),after=rangesFromBlocks(blocks),root=id('lineage');run.lineages[root]={repairs_used:0};
      run.tasks.push({id:id('task'),kind:'crosscheck',label:`Общая проверка ${i+1} / ${groups.length}`,version:1,lineage:[root],input_hash:key,signature:key,function_ids:batch.map(f=>f.id),registry_signature:signature,before:[],after,dependencies:after.map(r=>({document_id:r.document_id,extraction_version:r.extraction_version})),plan_version:run.plan.version,source_groups:[],current:true,status:'pending',result:null,result_version:0,additional:null});
    }
    if(groups.length>1)run.limitations.push(`Реестр Б проверяется в ${groups.length} пакетах. Межпакетные связи доступны поиском; полный перебор всех пар не выполняется.`);
  }
  async reconcile(run,epoch,signal) {
    await this.stage(run,'reconcile');deduplicate(run);
    const candidates=reconciliationCandidates(run),key=hash(currentFindings(run).map(f=>[f.id,f.version]));
    if(candidates.omitted)run.limitations.push(`Лимит сверки противоречий: ${candidates.omitted} пар кандидатов остались непроверенными.`);
    if(run.reconcile_key===key)return;
    for(let offset=0;offset<candidates.length;offset+=12) {
      const pairs=candidates.slice(offset,offset+12),ids=unique(pairs.flat()),findings=currentFindings(run).filter(f=>ids.includes(f.id)),blocks=findings.flatMap(f=>[...f.before_refs,...f.after_refs].map(r=>resolveRef(run,r)));
      const reconciliationSignature=hash({pairs,versions:findings.map(f=>[f.id,f.version])});
      const existing=run.tasks.find(t=>t.current&&t.kind==='reconcile'&&t.signature===reconciliationSignature);if(existing?.status==='done')continue;
      const root=id('lineage');run.lineages[root]={repairs_used:0};
      let task=existing||{id:id('task'),version:1,kind:'reconcile',label:'Проверка повторов и противоречий',signature:reconciliationSignature,lineage:[root],before:rangesFromBlocks(blocks.filter(b=>run.documents.find(d=>d.id===b.document_id).side==='A')),after:rangesFromBlocks(blocks.filter(b=>run.documents.find(d=>d.id===b.document_id).side==='B')),current:true,status:'pending',result_version:1,review_finding_ids:ids,dependencies:[],plan_version:run.plan.version,source_groups:[]};
      if(!existing)run.tasks.push(task);
      const baseData={task_type:'reconciliation',pairs,findings,context:this.context(run,[...task.before,...task.after]),versions:{registry:run.registry_version}};
      let result=await this.role(run,'judge',{...baseData,task_id:task.id,task_version:task.version,result_version:task.result_version},epoch,signal,task);
      checkJudge(run,task,result);commitJudge(run,task,result);
      if(result.verdict==='needs_revision'&&repairAvailable(run,task)) {
        consumeRepair(run,task);const additional={type:'judge_revision',target:'judge',task_id:task.id,task_version:task.version,finding_ids:ids,issues:result.issues};
        task=reviseTask(run,task,additional);task.result_version=1;
        result=await this.role(run,'judge',{...baseData,task_id:task.id,task_version:task.version,result_version:task.result_version,previous_assessment:result,additional},epoch,signal,task);
        checkJudge(run,task,result);commitJudge(run,task,result);
      }
      for(const resolution of result.resolutions){
        if(resolution.disposition==='duplicate'&&resolution.finding_refs.length>1){const kept=currentFindings(run).find(f=>f.id===resolution.finding_refs[0]);for(const fid of resolution.finding_refs.slice(1)){const duplicate=currentFindings(run).find(f=>f.id===fid);if(kept&&duplicate){duplicate.merged_into=kept.id;kept.provenance.push(...duplicate.provenance);}}}
        else if(['contradiction','unresolved'].includes(resolution.disposition)){run.limitations.push(`Неразрешённое противоречие: ${resolution.reason}`);for(const f of currentFindings(run).filter(f=>resolution.finding_refs.includes(f.id)))f.judge_status='inconclusive';}
      }
      if(result.verdict!=='passed')run.limitations.push('Сверка реестра оставила нерешённые вопросы; последний ответ не выбран как истина.');
      task.status='done';await this.store.save(run);
    }
    run.reconcile_key=key;
  }
  async synthesize(run,epoch,signal) {
    const reg=registry(run),inputFindings=reg.findings.filter(f=>f.human_status!=='rejected'),data={task_type:'synthesis',registry_version:reg.version,findings:inputFindings,coverage:reg.coverage.counts,limitations:reg.limitations,documents:this.catalogue(run),reviews:run.reviews,evidence:inputFindings.flatMap(f=>[...f.before_refs,...f.after_refs]).map(r=>({ref:r,block:resolveRef(run,r)}))};
    try {
      const result=await this.role(run,'synthesis',data,epoch,signal);const report=validateReport(run,result);
      if(run.report)run.report_history.push(run.report);run.report=report;
    }catch(e) {
      if(signal.aborted||run.epoch!==epoch)throw e;
      run.errors.push({code:e.code||'synthesis_error',message:safeError(e,this.config.apiKey),at:now(),stage:'synthesis'});
      if(run.report)run.report_history.push(run.report);
      run.report={registry_version:reg.version,version:(run.report?.version||0)+1,overview:[],questions:[],recommendations:[],limitations:unique([...reg.limitations,`Текстовое заключение не собрано: ${safeError(e,this.config.apiKey)}. Доступен структурированный реестр.`]),created_at:now(),stale:false,state:'structured_fallback'};
    }
    const cov=coverage(run),incomplete=run.tasks.some(t=>t.current&&t.status!=='done')||cov.counts.unchecked>0||cov.counts.incomplete_comparison>0||cov.counts.incomplete_B_extraction>0;
    run.state=incomplete?'partial':reg.limitations.length>2||run.documents.some(d=>d.status!=='ok')||run.judge_results.some(j=>j.current&&j.verdict!=='passed')||run.report.state!=='generated'||run.mode==='test'?'completed_with_limits':'completed';
    await this.store.save(run);
  }
  async execute(run,epoch,signal,synthesisOnly) {
    if(synthesisOnly){await this.synthesize(run,epoch,signal);return;}
    if(run.pending_routing){if(!await this.route(run,epoch,signal,run.pending_routing.additional))return;}
    if(!run.plan) {
      const usablePair=['A','B'].every(side=>run.documents.filter(d=>d.side===side&&d.blocks.length&&d.status!=='failed').length===1);
      if(run.explicit_pair&&usablePair&&!run.clarifications.length)applyPlan(run,explicitPlan(run));else if(!await this.route(run,epoch,signal))return;
    }
    await this.drain(run,epoch,signal);if(run.state==='needs_clarification')return;
    await this.extractJobs(run,this.extractionJobs(run).filter(j=>j.doc.side==='B'),epoch,signal);
    this.crosscheckTasks(run);await this.drain(run,epoch,signal,'crosscheck');
    // A crosscheck may propose additional mapping. Drain these once before reconciliation.
    if(run.tasks.some(t=>t.current&&t.kind==='comparison'&&t.status!=='done')){await this.drain(run,epoch,signal);this.crosscheckTasks(run);await this.drain(run,epoch,signal,'crosscheck');}
    const cov=coverage(run),unassigned=cov.blocks.filter(b=>b.extracted&&!b.assigned&&!b.not_applicable);
    if(unassigned.length){run.limitations.push(`Общая сверка обнаружила ${unassigned.length} блоков без назначения.`);applyPlan(run,run.plan);await this.drain(run,epoch,signal);}
    const audit=coverage(run),missing=audit.blocks.filter(b=>b.extracted&&!b.not_applicable&&(!b.compared||!b.comparison_judge_checked));
    if(missing.length&&!run.coverage_audit_attempted){
      run.coverage_audit_attempted=true;
      if(run.budgets.llm_calls+4<=run.settings.budgets.llmCalls){
        for(const blocks of splitBlocks(missing.map(r=>resolveRef(run,r)),run.settings.budgets)){
          const docs=new Map(run.documents.map(d=>[d.id,d])),before=rangesFromBlocks(blocks.filter(b=>docs.get(b.document_id).side==='A')),after=rangesFromBlocks(blocks.filter(b=>docs.get(b.document_id).side==='B'));
          const parentTasks=run.tasks.filter(t=>t.current&&[...t.before,...t.after].some(r=>blocks.some(b=>b.document_id===r.document_id&&b.id>=r.start_block_id&&b.id<=r.end_block_id))),roots=unique(parentTasks.flatMap(t=>t.lineage));
          if(!roots.length){const root=id('lineage');run.lineages[root]={repairs_used:0};roots.push(root);}
          run.tasks.push({id:id('task'),version:1,kind:'comparison',label:'Адресная проверка пропущенного содержания',signature:hash({before,after,audit:true}),input_hash:hash({before,after}),before,after,lineage:roots,dependencies:[...before,...after].map(r=>({document_id:r.document_id,extraction_version:r.extraction_version})),source_groups:[],plan_version:run.plan.version,current:true,status:'pending',result:null,result_version:0,diff:null,additional:null});
        }
        await this.drain(run,epoch,signal);
      }else run.limitations.push('Для адресной проверки оставшихся участков не хватило бюджета вызовов.');
    }
    await this.reconcile(run,epoch,signal);await this.synthesize(run,epoch,signal);
  }
}
