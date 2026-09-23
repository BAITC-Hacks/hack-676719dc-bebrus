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
  const h=await configured(),requests=[],output=explicitPlan(h.run),doc=h.run.documents[0];const transport={create:async req=>{requests.push(structuredClone(req));if(requests.length===1)return {id:'r1',status:'completed',output:[{type:'reasoning',id:'opaque',encrypted_content:'opaque-not-for-ui'},{type:'function_call',name:'read_blocks',call_id:'call-123',arguments:JSON.stringify({document_id:doc.id,extraction_version:1,start_block_id:doc.blocks[0].id,count:1,include_context:true})}]};return {id:'r2',status:'completed',output:[],output_text:JSON.stringify(output),usage:{input_tokens:12,output_tokens:20}};}};
  const client=new RoleClient(h.store,h.config,{transport});await client.call(h.run,'routing',{task_type:'routing',versions:{run:1}});assert.equal(requests[0].instructions,'SENTINEL_routing');assert.equal(requests[0].reasoning.effort,'high');assert.equal(requests[0].model,'gpt-6-luna');assert.equal(requests[0].text.format.type,'json_schema');assert.ok(requests[1].input.some(i=>i.type==='reasoning'));assert.ok(requests[1].input.some(i=>i.type==='function_call_output'&&i.call_id==='call-123'));assert.equal(h.run.prompt_hashes.routing,hash('SENTINEL_routing'));assert.ok(!JSON.stringify(h.run.logs).includes('opaque-not-for-ui'));
  await fs.writeFile(path.join(h.dir,'routing.txt'),'CHANGED');assert.equal(instructions(h.run.prompt_snapshot,'routing'),'SENTINEL_routing');assert.notEqual((await loadPrompts(h.dir)).hashes.routing,h.run.prompt_hashes.routing);await client.call(h.run,'routing',{task_type:'routing',versions:{run:1}});assert.equal(requests.length,2);assert.ok(h.run.logs.some(l=>l.type==='role_cache'));
});
test('refusal, incomplete, invalid JSON and invalid schema are distinct non-success states',async()=>{
  for(const [response,code]of [[{status:'completed',output:[{type:'message',content:[{type:'refusal',refusal:'no'}]}]},'model_refusal'],[{status:'incomplete',output:[],incomplete_details:{reason:'max_output_tokens'}},'incomplete_response'],[{status:'completed',output:[],output_text:'not json'},'invalid_structure'],[{status:'completed',output:[],output_text:'{}'},'invalid_structure']]){const h=await configured(),client=new RoleClient(h.store,h.config,{transport:{create:async()=>response}});await assert.rejects(client.call(h.run,'routing',{case:code}),e=>e.code===code);assert.ok(!h.run.logs.some(l=>l.type==='role_complete'));}
});
test('model access errors do not retry or downgrade; xhigh remains xhigh; key is redacted',async()=>{
  const h=await configured();let count=0;const client=new RoleClient(h.store,h.config,{transport:{create:async req=>{count++;assert.equal(req.reasoning.effort,'xhigh');const e=new Error('model unavailable test-key-not-a-secret');e.status=403;throw e;}}});await assert.rejects(client.call(h.run,'judge',{}),/model unavailable/);assert.equal(count,1);assert.ok(!JSON.stringify(h.run.logs).includes(h.config.apiKey));
});
test('late model response cannot overwrite changed task',async()=>{
  const h=await configured();let valid=true;const client=new RoleClient(h.store,h.config,{transport:{create:async()=>{valid=false;return {status:'completed',output:[],output_text:JSON.stringify(explicitPlan(h.run))};}}});await assert.rejects(client.call(h.run,'routing',{}, {guard:()=>valid}),e=>e.code==='stale_response');
});
