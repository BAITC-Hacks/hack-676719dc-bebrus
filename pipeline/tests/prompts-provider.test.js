import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import { ROOT } from '../server/config.js';
import { ROLES, loadPrompts, instructions } from '../server/prompts.js';
import { RoleClient } from '../server/provider.js';
import { harness, tempDir } from '../test-support/helpers.js';
import { hash } from '../server/util.js';
import { explicitPlan } from '../server/planning.js';
import { checkJudge } from '../server/registry.js';
import { loadConfig } from '../server/config.js';
test('URL in the hardcoded API key slot is rejected before a model request',()=>{
  const config=loadConfig({apiKey:'https://example.invalid/not-an-api-key'});
  assert.equal(config.apiKey,'');
  assert.match(config.keyError,/Вместо API-ключа указана ссылка/);
});
test('all seven supplied system prompts load and live mode requires a key',async()=>{
  for(const role of ['common',...ROLES])assert.ok((await fs.readFile(path.join(ROOT,'prompts/system',`${role}.txt`))).length>0);
  const {run,orchestrator,config}=await harness();run.mode='live';config.apiKey='';const ready=await orchestrator.preflight(run);assert.equal(ready.state,'key_not_configured');assert.deepEqual(ready.missing_roles,[]);await orchestrator.start(run);assert.equal(run.budgets.llm_calls,0);assert.equal(run.state,'key_not_configured');
});
async function configured(){const h=await harness();h.run.mode='live';h.config.apiKey='test-key-not-a-secret';const dir=await tempDir('prompts');for(const role of ['common',...ROLES])await fs.writeFile(path.join(dir,`${role}.txt`),role==='common'?'':'SENTINEL_'+role);h.run.prompt_snapshot=await loadPrompts(dir);h.run.prompt_hashes=h.run.prompt_snapshot.hashes;return {...h,dir};}
test('prompt snapshots and Responses current role/tool context/call_id',async()=>{
  const h=await configured(),requests=[],output=explicitPlan(h.run),doc=h.run.documents[0];const transport={create:async req=>{requests.push(structuredClone(req));if(requests.length===1)return {id:'r1',status:'completed',output:[{type:'reasoning',id:'opaque',encrypted_content:'opaque-not-for-ui'},{type:'function_call',name:'read_blocks',call_id:'call-123',arguments:JSON.stringify({document_id:doc.id,extraction_version:1,start_block_id:doc.blocks[0].id,count:1,include_context:true})}]};return {id:'r2',status:'completed',service_tier:'fast',output:[],output_text:JSON.stringify(output),usage:{input_tokens:12,output_tokens:20}};}};
  const client=new RoleClient(h.store,h.config,{transport});await client.call(h.run,'routing',{task_type:'routing',versions:{run:1}});assert.equal(requests[0].instructions,'SENTINEL_routing');assert.equal(requests[0].reasoning.effort,'medium');assert.equal(requests[0].model,'gpt-6-luna');assert.equal(requests[0].service_tier,'fast');assert.equal(requests[1].service_tier,'fast');assert.equal(requests[0].text.format.type,'json_schema');assert.ok(requests[1].input.some(i=>i.type==='reasoning'));assert.ok(requests[1].input.some(i=>i.type==='function_call_output'&&i.call_id==='call-123'));assert.equal(h.run.prompt_hashes.routing,hash('SENTINEL_routing'));assert.ok(h.run.logs.some(l=>l.type==='api_response'&&l.service_tier_requested==='fast'&&l.service_tier_used==='fast'));assert.ok(!JSON.stringify(h.run.logs).includes('opaque-not-for-ui'));
  await fs.writeFile(path.join(h.dir,'routing.txt'),'CHANGED');assert.equal(instructions(h.run.prompt_snapshot,'routing'),'SENTINEL_routing');assert.notEqual((await loadPrompts(h.dir)).hashes.routing,h.run.prompt_hashes.routing);await client.call(h.run,'routing',{task_type:'routing',versions:{run:1}});assert.equal(requests.length,2);assert.ok(h.run.logs.some(l=>l.type==='role_cache'));
});
test('refusal, incomplete, invalid JSON and invalid schema are distinct non-success states',async()=>{
  for(const [response,code]of [[{status:'completed',output:[{type:'message',content:[{type:'refusal',refusal:'no'}]}]},'model_refusal'],[{status:'incomplete',output:[],incomplete_details:{reason:'max_output_tokens'}},'incomplete_response'],[{status:'completed',output:[],output_text:'not json'},'invalid_structure'],[{status:'completed',output:[],output_text:'{}'},'invalid_structure']]){const h=await configured(),client=new RoleClient(h.store,h.config,{transport:{create:async()=>response}});await assert.rejects(client.call(h.run,'routing',{case:code}),e=>e.code===code);assert.ok(!h.run.logs.some(l=>l.type==='role_complete'));}
});
test('model access errors do not retry or downgrade; high remains high; key is redacted',async()=>{
  const h=await configured();let count=0;const client=new RoleClient(h.store,h.config,{transport:{create:async req=>{count++;assert.equal(req.reasoning.effort,'high');const e=new Error('model unavailable test-key-not-a-secret');e.status=403;throw e;}}});await assert.rejects(client.call(h.run,'judge',{}),/model unavailable/);assert.equal(count,1);assert.ok(!JSON.stringify(h.run.logs).includes(h.config.apiKey));
});
test('large extraction requests have room to finish without changing other role limits',async()=>{
  const h=await configured();let limit;
  const client=new RoleClient(h.store,h.config,{transport:{create:async req=>{limit=req.max_output_tokens;const e=new Error('stop after request inspection');e.status=403;throw e;}}});
  await assert.rejects(client.call(h.run,'extraction',{}),/stop after request inspection/);
  assert.equal(limit,32000);
});
test('max-output truncation gets one bounded retry with a larger limit',async()=>{
  const h=await configured(),limits=[];
  const client=new RoleClient(h.store,h.config,{transport:{create:async req=>{limits.push(req.max_output_tokens);return limits.length===1?{id:'truncated',status:'incomplete',incomplete_details:{reason:'max_output_tokens'},output:[]}:{id:'complete',status:'completed',output:[],output_text:JSON.stringify(explicitPlan(h.run))};}}});
  await client.call(h.run,'routing',{});
  assert.deepEqual(limits,[18000,36000]);
  assert.ok(h.run.logs.some(l=>l.type==='role_retry'&&l.reason==='max_output_tokens'));
});
test('late model response cannot overwrite changed task',async()=>{
  const h=await configured();let valid=true;const client=new RoleClient(h.store,h.config,{transport:{create:async()=>{valid=false;return {status:'completed',output:[],output_text:JSON.stringify(explicitPlan(h.run))};}}});await assert.rejects(client.call(h.run,'routing',{}, {guard:()=>valid}),e=>e.code==='stale_response');
});
test('judge corrects an out-of-scope coverage claim without crediting the outside block',async()=>{
  const h=await configured(),doc=h.run.documents[0];
  const allowed={document_id:doc.id,extraction_version:doc.extraction_version,start_block_id:doc.blocks[0].id,end_block_id:doc.blocks[0].id};
  const outside={...allowed,start_block_id:doc.blocks[1].id,end_block_id:doc.blocks[1].id};
  const task={id:'task_scope',version:1,result_version:1,before:[allowed],after:[],result:{findings:[]}};
  const data={task_id:task.id,task_version:task.version,result_version:task.result_version,before:task.before,after:task.after,judge_scope:{allowed_checked_ranges:[allowed]}};
  const makeJudge=range=>({task_id:task.id,task_version:task.version,result_version:task.result_version,verdict:'passed',checked_ranges:[range],checked_finding_refs:[],issues:[],resolutions:[],limitations:[]});
  const requests=[];const client=new RoleClient(h.store,h.config,{transport:{create:async req=>{requests.push(structuredClone(req));return {id:`response_${requests.length}`,status:'completed',output:[],output_text:JSON.stringify(makeJudge(requests.length===1?outside:allowed))};}}});
  const result=await client.call(h.run,'judge',data,{validateOutput:value=>checkJudge(h.run,task,value)});
  assert.deepEqual(result.checked_ranges,[allowed]);assert.equal(requests.length,2);
  assert.ok(requests[1].input.some(item=>item.role==='user'&&item.content.includes('Ответ отклонён')));
  assert.equal(h.run.logs.filter(log=>log.type==='role_validation_retry').length,1);
});
test('judge exhausts scope corrections as inconclusive and leaves coverage uncredited',async()=>{
  const h=await configured(),doc=h.run.documents[0];
  const allowed={document_id:doc.id,extraction_version:doc.extraction_version,start_block_id:doc.blocks[0].id,end_block_id:doc.blocks[0].id};
  const outside={...allowed,start_block_id:doc.blocks[1].id,end_block_id:doc.blocks[1].id};
  const task={id:'task_scope_fallback',version:1,result_version:1,before:[allowed],after:[],result:{findings:[]}};
  const bad={task_id:task.id,task_version:task.version,result_version:task.result_version,verdict:'passed',checked_ranges:[outside],checked_finding_refs:[],issues:[],resolutions:[],limitations:[]};
  let calls=0;const client=new RoleClient(h.store,h.config,{transport:{create:async()=>{calls++;return {id:`response_${calls}`,status:'completed',output:[],output_text:JSON.stringify(bad)};}}});
  const result=await client.call(h.run,'judge',{task_id:task.id,task_version:task.version,result_version:1,judge_scope:{allowed_checked_ranges:[allowed]}},{validateOutput:value=>checkJudge(h.run,task,value)});
  assert.equal(calls,2);assert.equal(result.verdict,'inconclusive');assert.deepEqual(result.checked_ranges,[]);
  assert.ok(h.run.logs.some(log=>log.type==='role_fallback'&&log.reason==='judge_invalid_output'));
});
test('judge repairs an unknown finding reference using the allowed IDs',async()=>{
  const h=await configured(),doc=h.run.documents[0];
  const allowed={document_id:doc.id,extraction_version:doc.extraction_version,start_block_id:doc.blocks[0].id,end_block_id:doc.blocks[0].id};
  const task={id:'task_finding_scope',version:1,result_version:1,before:[allowed],after:[],result:{findings:[{id:'finding_known'}]}};
  const data={task_id:task.id,task_version:task.version,result_version:1,judge_scope:{allowed_checked_ranges:[allowed],allowed_finding_ids:['finding_known']}};
  let calls=0;const client=new RoleClient(h.store,h.config,{transport:{create:async()=>{calls++;return {id:`response_${calls}`,status:'completed',output:[],output_text:JSON.stringify({task_id:task.id,task_version:task.version,result_version:1,verdict:'passed',checked_ranges:[allowed],checked_finding_refs:[calls===1?'finding_unknown':'finding_known'],issues:[],resolutions:[],limitations:[]})};}}});
  const result=await client.call(h.run,'judge',data,{validateOutput:value=>checkJudge(h.run,task,value)});
  assert.equal(calls,2);assert.deepEqual(result.checked_finding_refs,['finding_known']);
  assert.ok(h.run.logs.some(log=>log.type==='role_validation_retry'&&log.validation_code==='invalid_reference'));
});
