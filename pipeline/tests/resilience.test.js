import test from 'node:test';
import assert from 'node:assert/strict';
import { harness } from '../test-support/helpers.js';
import { testProvider } from '../test-support/provider.js';
import { RoleClient } from '../server/provider.js';
import { parseFile } from '../server/extract.js';
import { Store } from '../server/store.js';
import { coverage } from '../server/coverage.js';
import { currentFindings } from '../server/registry.js';
import { blockRef } from '../server/util.js';
import { explicitPlan } from '../server/planning.js';
import { setTimeout as delay } from 'node:timers/promises';
function pdfBuffer(text){const stream=text?`BT /F1 12 Tf 30 180 Td (${text}) Tj ET`:'';const objects=['<< /Type /Catalog /Pages 2 0 R >>','<< /Type /Pages /Kids [3 0 R] /Count 1 >>','<< /Type /Page /Parent 2 0 R /MediaBox [0 0 300 220] /Resources << /Font << /F1 4 0 R >> >> /Contents 5 0 R >>','<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>',`<< /Length ${stream.length} >>\nstream\n${stream}\nendstream`];let result='%PDF-1.4\n',offsets=[0];objects.forEach((obj,i)=>{offsets.push(Buffer.byteLength(result));result+=`${i+1} 0 obj\n${obj}\nendobj\n`;});const start=Buffer.byteLength(result);result+=`xref\n0 6\n0000000000 65535 f \n${offsets.slice(1).map(n=>String(n).padStart(10,'0')+' 00000 n \n').join('')}trailer\n<< /Size 6 /Root 1 0 R >>\nstartxref\n${start}\n%%EOF`;return Buffer.from(result);}
test('text PDF has page coordinates; empty PDF page is unavailable, not successful text extraction',async()=>{const text=await parseFile(pdfBuffer('Audit quality'),'text.pdf');assert.equal(text.status,'partial');assert.equal(text.blocks[0].coordinates.page,1);assert.equal(text.blocks[0].text,'Audit quality');const empty=await parseFile(pdfBuffer(''),'scan.pdf');assert.equal(empty.status,'failed');assert.equal(empty.blocks[0].unavailable,true);});
test('cancellation persists and a late role result is discarded; saved work resumes',async()=>{
  let release,started;const ready=new Promise(resolve=>started=resolve),blocked=new Promise(resolve=>release=resolve);let block=true;
  const h=await harness({provider:async x=>{if(block&&x.role==='comparison'){started();await blocked;}return testProvider(x);}});await h.orchestrator.start(h.run);await ready;await h.orchestrator.cancel(h.run);release();await h.orchestrator.wait(h.run);assert.equal(h.run.state,'cancelled');assert.equal(h.run.findings.length,0);const count=h.run.extractions.length;block=false;await h.orchestrator.start(h.run);await h.orchestrator.wait(h.run);assert.equal(h.run.state,'completed_with_limits');assert.equal(h.run.extractions.length,count);
  h.run.state='running';await h.store.save(h.run);const reloaded=new Store(h.config.dataDir);await reloaded.init();assert.equal(reloaded.get(h.run.id).state,'interrupted');
});
test('independent extraction calls overlap but commit in document order',async()=>{
  let active=0,peak=0,started=0;
  const h=await harness({documents:[['A',['Первый пункт','Второй пункт','Третий пункт']],['B',['Четвёртый пункт','Пятый пункт','Шестой пункт']]],overrides:{budgets:{chunkBlocks:1}},provider:async x=>{
    if(x.role==='extraction') {const index=started++;active++;peak=Math.max(peak,active);await delay(index%2===0?20:5);active--;}
    return testProvider(x);
  }});
  h.run.state='running';h.run.epoch=1;
  const jobs=h.orchestrator.extractionJobs(h.run);
  await h.orchestrator.extractJobs(h.run,jobs,h.run.epoch,new AbortController().signal);
  assert.equal(peak,2);
  assert.equal(h.run.extractions.length,jobs.length);
  assert.deepEqual(h.run.extractions.map(e=>e.ranges[0].start_block_id),jobs.map(j=>j.ranges[0].start_block_id));
});
test('missing global search cannot receive a passed negative finding',async()=>{
  const h=await harness({provider:async x=>{const r=await testProvider(x);if(x.role==='comparison'&&r.findings.length)r.findings[0].category='potential_loss';return r;}});await h.orchestrator.start(h.run);await h.orchestrator.wait(h.run);assert.ok(h.run.judge_results.some(j=>j.issues.some(i=>i.error_type==='missing_global_search')));assert.ok(currentFindings(h.run).some(f=>f.judge_status==='needs_revision'));assert.equal(h.run.tasks.filter(t=>t.kind==='comparison').length,2);
});
test('omitted comparison coverage gets one bounded follow-up and remains partial when still omitted',async()=>{
  const h=await harness({provider:async x=>{const r=await testProvider(x);if(x.role==='comparison')r.coverage=[];return r;}});await h.orchestrator.start(h.run);await h.orchestrator.wait(h.run);assert.equal(h.run.state,'partial');assert.ok(h.run.coverage_audit_attempted);assert.equal(h.run.tasks.filter(t=>t.label==='Адресная проверка пропущенного содержания').length,1);assert.ok(coverage(h.run).counts.incomplete_comparison>0);assert.ok(h.run.report.limitations.some(t=>t.includes('Не завершено сравнение')));
});
test('synthesis refusal preserves structured registry and reports fallback',async()=>{
  const h=await harness({provider:async x=>{if(x.role==='synthesis')throw new Error('synthetic synthesis failure');return testProvider(x);}});await h.orchestrator.start(h.run);await h.orchestrator.wait(h.run);assert.equal(h.run.report.state,'structured_fallback');assert.ok(currentFindings(h.run).length>0);assert.ok(h.run.report.limitations.some(t=>t.includes('не собрано')));
});
test('global crosscheck finding receives judge and semantic repair',async()=>{
  let checks=0;const h=await harness({provider:async x=>{const r=await testProvider(x);if(x.role==='crosscheck'){checks++;const ref=blockRef(x.run.documents[1].blocks[0]);r.findings=[{id:'global',version:1,category:'potential_duplication',claim:'Синтетическое пересечение',before_refs:[],after_refs:[ref],function_refs:[],explanation:'Тест',significance:'unknown',significance_basis:'Тест',uncertainty:[],limitations:[],action:'Ручная проверка',search_scope:{sides:['B'],document_ids:[ref.document_id],queries:[],limitations:[]}}];}if(x.role==='judge'&&x.data.result?.findings.some(f=>f.claim==='Синтетическое пересечение')&&checks===1){r.verdict='needs_revision';r.issues=[{id:'fix',finding_refs:[x.data.result.findings[0].id],error_type:'scope',target:'crosscheck',evidence_refs:[blockRef(x.run.documents[1].blocks[0])],log_refs:[],alternative_causes:[],instruction:'Синтетическое замечание',acceptance_condition:'Синтетический критерий'}];}return r;}});await h.orchestrator.start(h.run);await h.orchestrator.wait(h.run);assert.equal(checks,2);assert.ok(currentFindings(h.run).some(f=>f.category==='potential_duplication'&&f.judge_status==='passed'));
});
test('429 retries preserve model and effort, respect bounded retry count and count actual requests',async()=>{
  const h=await harness();h.run.mode='live';h.config.apiKey='test-key';h.run.prompt_snapshot={texts:{common:'',routing:'TEST-SENTINEL'},hashes:{},missing:[]};h.run.prompt_hashes={};let requests=0;
  const client=new RoleClient(h.store,h.config,{transport:{create:async req=>{requests++;assert.equal(req.model,'gpt-6-luna');assert.equal(req.reasoning.effort,'medium');if(requests===1){const err=new Error('rate limit');err.status=429;err.headers=new Headers({'retry-after':'0'});throw err;}return {status:'completed',output:[],output_text:JSON.stringify({version:1,groups:[],remainder:[],clarification:null,limitations:[]})};}}});await client.call(h.run,'routing',{});assert.equal(requests,2);assert.equal(h.run.budgets.technical_retries,1);assert.equal(h.run.budgets.llm_calls,2);
});
test('provider retries a transport abort while the run itself is still active',async()=>{
  const h=await harness();h.run.mode='live';h.config.apiKey='test-key';h.run.prompt_snapshot={texts:{common:'',routing:'TEST-SENTINEL'},hashes:{},missing:[]};h.run.prompt_hashes={};let requests=0;
  const client=new RoleClient(h.store,h.config,{transport:{create:async()=>{requests++;if(requests===1){const error=new Error('Request was aborted.');error.name='APIUserAbortError';throw error;}return {status:'completed',output:[],output_text:JSON.stringify({version:1,groups:[],remainder:[],clarification:null,limitations:[]})};}}});
  await client.call(h.run,'routing',{});
  assert.equal(requests,2);
  assert.equal(h.run.budgets.technical_retries,1);
  assert.ok(h.run.logs.some(l=>l.type==='api_error'&&l.error_name==='APIUserAbortError'));
});
test('routing repair can pause for its first clarification and then resume the pending routing call',async()=>{
  let routes=0;const h=await harness({explicit_pair:false,provider:async x=>{
    if(x.role==='routing'){routes++;const p=explicitPlan(x.run);if(routes===2)p.clarification={question:'Подтвердить состав?',reason:'Тест routing repair',document_ids:x.run.documents.map(d=>d.id),on_skip:'Оставить осторожную пару'};return p;}
    const r=await testProvider(x);
    if(x.role==='judge'&&x.data.task_type==='local_judge'&&x.data.task_version===1&&routes===1){r.verdict='needs_revision';r.issues=[{id:'route',finding_refs:[],error_type:'group_scope',target:'routing',evidence_refs:[blockRef(x.run.documents[0].blocks[0])],log_refs:[],alternative_causes:[],instruction:'Тестовое замечание к составу группы',acceptance_condition:'Тестовый критерий'}];}return r;
  }});
  await h.orchestrator.start(h.run);await h.orchestrator.wait(h.run);assert.equal(h.run.state,'needs_clarification');await h.orchestrator.clarify(h.run,{skip:true});await h.orchestrator.wait(h.run);assert.equal(routes,3);assert.equal(h.run.pending_routing,null);assert.equal(h.run.state,'completed_with_limits',JSON.stringify(h.run.last_error));assert.ok(Object.values(h.run.lineages).some(l=>l.repairs_used===1));
});
test('contradiction arbitration uses one bounded judge revision and keeps unresolved findings',async()=>{
  let arbitration=0;const h=await harness({provider:async x=>{
    const r=await testProvider(x);if(x.role==='comparison'&&r.findings.length){const original=r.findings[0];r.findings.push({...structuredClone(original),id:'opposing',category:'preserved',claim:'Противоположная синтетическая находка'});}
    if(x.role==='judge'&&x.data.task_type==='reconciliation'){arbitration++;r.verdict='needs_revision';r.issues=[{id:'conflict',finding_refs:x.data.findings.map(f=>f.id),error_type:'contradiction',target:'uncertainty',evidence_refs:[],log_refs:[],alternative_causes:['Неполные основания'],instruction:'Синтетическое замечание',acceptance_condition:'Синтетический критерий'}];r.resolutions=[{finding_refs:x.data.findings.map(f=>f.id),disposition:'unresolved',reason:'Синтетический нерешённый вопрос',evidence_refs:[blockRef(x.run.documents[0].blocks[0])]}];}return r;
  }});await h.orchestrator.start(h.run);await h.orchestrator.wait(h.run);assert.equal(h.run.last_error,null,JSON.stringify(h.run.last_error));assert.equal(arbitration,2);assert.ok(currentFindings(h.run).some(f=>f.judge_status==='inconclusive'));assert.ok(h.run.report.limitations.some(l=>l.includes('Неразрешённое противоречие')));
});
