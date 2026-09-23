import test from 'node:test';
import assert from 'node:assert/strict';
import { harness } from '../test-support/helpers.js';
import { testProvider } from '../test-support/provider.js';
import { coverage } from '../server/coverage.js';
import { fullRange, applyPlan, explicitPlan, consumeRepair, repairAvailable } from '../server/planning.js';
import { Store } from '../server/store.js';
import { RoleClient } from '../server/provider.js';
import { Orchestrator } from '../server/orchestrator.js';
import { registry, reviewFinding, currentFindings } from '../server/registry.js';
import { exportHtml } from '../server/export.js';
import { blockRef } from '../server/util.js';
import { reextract } from '../server/service.js';
const group=(id,before,after)=>({id,label:id,before:before.map(fullRange),after:after.map(fullRange),relation:before.length===1&&after.length===1?'1:1':before.length===1?'1:N':'N:1',method:'semantic',rationale:'Синтетический тест',evidence_refs:[],uncertainty:[]});
test('full DOCX pipeline runs extraction, comparison, judge, full B check and synthesis',async()=>{
  const h=await harness();await h.orchestrator.start(h.run);await h.orchestrator.wait(h.run);assert.equal(h.run.last_error,null,JSON.stringify(h.run.last_error));assert.equal(h.run.state,'completed_with_limits');const roles=new Set(h.run.logs.filter(l=>l.type==='role_complete').map(l=>l.role));for(const r of ['extraction','comparison','judge','crosscheck','synthesis'])assert.ok(roles.has(r),r);assert.equal(coverage(h.run).counts.unchecked,0);assert.equal(h.run.functions.filter(f=>f.current&&f.side==='B').length,3);assert.ok(h.run.report);assert.ok(h.run.judge_results.every(j=>j.current));
  const calls=h.run.budgets.llm_calls;await h.orchestrator.start(h.run);await h.orchestrator.wait(h.run);assert.equal(h.run.budgets.llm_calls,calls,'unchanged completed run reuses cached synthesis');
});
test('1:N and shared B document: unique coverage, no repeated function extraction',async()=>{
  const h=await harness({explicit_pair:false,documents:[['A',['Проверять качество.']],['A',['Сохранять документы.']],['B',['Проверять качество.']],['B',['Сохранять документы.']]],provider:async x=>x.role==='routing'?{version:1,groups:[group('split',[x.run.documents[0]],[x.run.documents[2],x.run.documents[3]]),group('shared',[x.run.documents[1]],[x.run.documents[3]])],remainder:[],clarification:null,limitations:[]}:testProvider(x)});
  await h.orchestrator.start(h.run);await h.orchestrator.wait(h.run);assert.equal(h.run.state,'completed_with_limits',JSON.stringify(h.run.last_error));assert.equal(coverage(h.run).counts.total,4);assert.equal(coverage(h.run).counts.assigned,4);assert.equal(h.run.extractions.filter(e=>e.current).length,4);assert.equal(h.run.functions.filter(f=>f.current&&f.side==='B').length,2);
});
test('clarification survives restart; skip resumes without repeated question or parsing',async()=>{
  let routes=0;const provider=async x=>{if(x.role==='routing'){routes++;return {version:1,groups:[],remainder:[],clarification:{question:'Какой документ относится к группе?',reason:'Тест неоднозначности',document_ids:x.run.documents.map(d=>d.id),on_skip:'Исследовать остатки'},limitations:[]};}return testProvider(x);};
  const h=await harness({explicit_pair:false,provider});await h.orchestrator.start(h.run);await h.orchestrator.wait(h.run);assert.equal(h.run.state,'needs_clarification');const original=h.run.documents.map(d=>[d.file_hash,d.extraction_version]);
  const store=new Store(h.config.dataDir);await store.init();const saved=store.get(h.run.id),orchestrator=new Orchestrator(store,new RoleClient(store,h.config,{testProvider:provider}),h.config);await orchestrator.clarify(saved,{skip:true});await orchestrator.wait(saved);assert.equal(saved.state,'completed_with_limits',JSON.stringify(saved.last_error));assert.equal(routes,2);assert.equal(saved.clarifications.length,1);assert.equal(saved.clarifications[0].status,'skipped');assert.deepEqual(saved.documents.map(d=>[d.file_hash,d.extraction_version]),original);
});
test('search finds transfer outside original group and creates validated mapping without full preparation',async()=>{
  let extended=false;const h=await harness({explicit_pair:false,documents:[['A',['Проверять документы.']],['B',['Хранить отчёты.']],['B',['Проверять документы.']]],provider:async x=>{
    if(x.role==='routing')return {version:1,groups:[group('initial',[x.run.documents[0]],[x.run.documents[1]])],remainder:[],clarification:null,limitations:[]};
    const result=await testProvider(x);
    if(x.role==='comparison'&&!extended){const hits=await x.execute('search_documents',{query:'Проверять документы',side:'B',document_ids:null,cursor:null},'search-transfer');assert.ok(hits.hits.some(h=>h.ref.document_id===x.run.documents[2].id));const d=x.run.documents[2];await x.execute('read_blocks',{document_id:d.id,extraction_version:1,start_block_id:d.blocks[0].id,count:1,include_context:true},'read-transfer');result.mapping_proposals=[group('transfer',[x.run.documents[0]],[d])];extended=true;}return result;
  }});await h.orchestrator.start(h.run);await h.orchestrator.wait(h.run);assert.equal(h.run.state,'completed_with_limits',JSON.stringify(h.run.last_error));assert.ok(h.run.plan.groups.some(g=>g.id.startsWith('mapping_')));assert.equal(h.run.extractions.filter(e=>e.current).length,3);assert.ok(h.run.logs.some(l=>l.name==='search_documents'&&l.result.hits.length));
});
test('one semantic repair per lineage, repeated judge issue retained and previous findings stale',async()=>{
  let comparisonCalls=0;const h=await harness({provider:async x=>{const result=await testProvider(x);if(x.role==='comparison'){comparisonCalls++;if(comparisonCalls===2)assert.equal(x.data.additional.type,'judge_revision');}if(x.role==='judge'&&x.data.task_type==='local_judge'&&x.data.result.findings.length){result.verdict='needs_revision';result.issues=[{id:'issue',finding_refs:[x.data.result.findings[0].id],error_type:'interpretation',target:'comparison',evidence_refs:[blockRef(x.run.documents[0].blocks[0])],log_refs:[],alternative_causes:[],instruction:'Замечание из синтетического judge',acceptance_condition:'Синтетический критерий'}];}return result;}});
  await h.orchestrator.start(h.run);await h.orchestrator.wait(h.run);assert.equal(comparisonCalls,2);assert.equal(h.run.state,'completed_with_limits',JSON.stringify(h.run.last_error));assert.ok(h.run.tasks.some(t=>t.version===1&&!t.current));assert.ok(h.run.tasks.some(t=>t.version===2&&t.current));assert.ok(Object.values(h.run.lineages).some(l=>l.repairs_used===1));assert.ok(currentFindings(h.run).some(f=>f.judge_status==='needs_revision'));
});
test('routing edit invalidates only affected dependencies and inherits repair budgets',async()=>{
  const h=await harness({documents:[['A',['Функция первая.']],['A',['Функция вторая.']],['B',['Функция первая.']],['B',['Функция вторая.']],['B',['Дополнение.']]],explicit_pair:false});
  const [a1,a2,b1,b2,b3]=h.run.documents;applyPlan(h.run,{version:1,groups:[group('one',[a1],[b1]),group('two',[a2],[b2])],remainder:[],clarification:null,limitations:[]});const one=h.run.tasks.find(t=>t.source_groups.includes('one')),two=h.run.tasks.find(t=>t.source_groups.includes('two'));consumeRepair(h.run,one);const plan=structuredClone(h.run.plan);plan.groups.find(g=>g.id==='one').after.push(fullRange(b3));plan.groups.find(g=>g.id==='one').relation='1:N';applyPlan(h.run,plan,{parentTask:one});assert.ok(two.current);assert.equal(two.version,1);assert.equal(one.current,false);const child=h.run.tasks.find(t=>t.current&&t.source_groups.includes('one'));assert.equal(repairAvailable(h.run,child),false);
});
test('empty comparison findings still go through local judge; unchanged and added B are extracted',async()=>{
  const h=await harness({provider:async x=>{const result=await testProvider(x);if(x.role==='comparison')result.findings=[];return result;}});await h.orchestrator.start(h.run);await h.orchestrator.wait(h.run);assert.ok(h.run.judge_results.some(j=>j.checked_finding_refs.length===0&&j.checked_ranges.length>0));assert.equal(h.run.functions.filter(f=>f.side==='B').length,3);
});
test('wrong reference or old result version never becomes successful analysis',async()=>{
  for(const kind of ['reference','version']){const h=await harness({provider:async x=>{const r=await testProvider(x);if(x.role==='comparison'){if(kind==='version')r.task_version=100;else r.findings[0].before_refs[0].block_id='missing';}return r;}});await h.orchestrator.start(h.run);await h.orchestrator.wait(h.run);assert.equal(h.run.state,'partial');assert.equal(h.run.report,null);assert.ok(['invalid_reference','stale_response'].includes(h.run.last_error.code));}
});
test('manual wording edit creates a version, clears judge status, stales report; export escapes HTML and includes evidence',async()=>{
  const h=await harness();await h.orchestrator.start(h.run);await h.orchestrator.wait(h.run);const f=currentFindings(h.run)[0];reviewFinding(h.run,f.id,{version:f.version,decision:'edited',text:'<script>alert(1)</script> Изменённый тезис'});const edited=currentFindings(h.run).find(x=>x.id===f.id);assert.equal(edited.judge_status,'unreviewed');assert.equal(edited.version,2);assert.equal(h.run.report.stale,true);const html=exportHtml(h.run);assert.ok(!html.includes('<script>'));assert.ok(html.includes('&lt;script&gt;'));assert.ok(html.includes(h.run.documents[0].name));assert.ok(html.includes('Версия извлечения'));assert.ok(html.includes('ТЕСТОВЫЙ ПРОГОН'));assert.ok(html.includes('не гарантирует смысловую полноту'));
});
test('re-extraction versions original text, invalidates dependent records and keeps source history',async()=>{
  const h=await harness();await h.orchestrator.start(h.run);await h.orchestrator.wait(h.run);const doc=h.run.documents[0],old=doc.blocks[0].text;await reextract(h.store,h.run,doc);assert.equal(doc.extraction_version,2);assert.equal(doc.history[0].blocks[0].text,old);assert.ok(!h.run.functions.some(f=>f.current&&f.source_refs.some(r=>r.document_id===doc.id&&r.extraction_version===1)));assert.ok(h.run.report.stale);
});
test('finite call budget returns partial result and cannot loop',async()=>{const h=await harness({overrides:{budgets:{llmCalls:2}}});await h.orchestrator.start(h.run);await h.orchestrator.wait(h.run);assert.equal(h.run.state,'partial');assert.equal(h.run.last_error.code,'llm_budget');assert.equal(h.run.budgets.llm_calls,2);});
