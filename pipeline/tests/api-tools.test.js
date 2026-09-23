import test from 'node:test';
import assert from 'node:assert/strict';
import { createApplication } from '../server/index.js';
import { loadConfig } from '../server/config.js';
import { tempDir, harness, docxBuffer } from '../test-support/helpers.js';
import { makeTools } from '../server/tools.js';
import { coverage } from '../server/coverage.js';
test('API entry point, private files, controlled sources, status polling and explicit test gate',async()=>{
  const serverApp=await createApplication({config:loadConfig({dataDir:await tempDir('api'),testMode:false,apiKey:'private-server-key'})}),server=serverApp.app.listen(0,'127.0.0.1');await new Promise(resolve=>server.once('listening',resolve));const base=`http://127.0.0.1:${server.address().port}`;
  try {
    assert.equal((await fetch(base)).status,404);
    for(const secret of ['/server-config.local.cjs','/.env','/data/runs','/server/index.js','/prompts/system/routing.txt','/change_rendering_handoff/js/config.js'])assert.equal((await fetch(base+secret)).status,404);
    const config=await (await fetch(base+'/api/config')).json();assert.ok(!JSON.stringify(config).includes('private-server-key'));
    const denied=await fetch(base+'/api/runs',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({mode:'test'})});assert.equal(denied.status,400);
    const r=await (await fetch(base+'/api/runs',{method:'POST',headers:{'Content-Type':'application/json'},body:'{}'})).json();
    for(const side of ['A','B']){const data=new FormData();data.set('side',side);data.set('name',side+'.docx');data.set('file',new Blob([docxBuffer(['1. Исходный текст.'])]),side+'.docx');assert.equal((await fetch(`${base}/api/runs/${r.id}/documents`,{method:'POST',body:data})).status,201);}
    const before=serverApp.store.get(r.id).budgets.llm_calls;await fetch(`${base}/api/runs/${r.id}`);await fetch(`${base}/api/runs/${r.id}/preflight`);assert.equal(serverApp.store.get(r.id).budgets.llm_calls,before);
    const preflight=await (await fetch(`${base}/api/runs/${r.id}/preflight`)).json();assert.equal(preflight.state,'ready');assert.ok(!JSON.stringify(preflight).includes('private-server-key'));
    const detail=await (await fetch(`${base}/api/runs/${r.id}`)).json();
    const source=await (await fetch(`${base}/api/runs/${r.id}/sources/${detail.documents[0].id}`)).json();assert.equal(source.blocks[0].text,'1. Исходный текст.');assert.equal((await fetch(`${base}/api/runs/${r.id}/originals/${detail.documents[0].id}`)).status,200);assert.equal((await fetch(`${base}/api/runs/${r.id}/sources/unknown`)).status,400);
    assert.equal((await fetch(`${base}/api/runs/${r.id}/cancel`,{method:'POST',headers:{Origin:'https://unrelated.invalid'}})).status,403);
  }finally{server.closeAllConnections();await new Promise(resolve=>server.close(resolve));}
});
test('tools enforce run scope, include context, report paging and count reads separately from searches',async()=>{
  const h=await harness({documents:[['A',['Отдел не имеет права:','Подписывать документы.']],['B',['Подписывать документы.','Хранить документы.','Проверять документы.']]],overrides:{budgets:{searchPageSize:1}}}),execute=makeTools(h.run,h.store,{role:'comparison',task_id:'scope',task_version:1});
  const search=await execute('search_documents',{query:'документы',side:'B',document_ids:null,cursor:null},'1');assert.equal(search.hits.length,1);assert.equal(search.truncated,true);assert.ok(search.next_cursor);assert.equal(coverage(h.run).counts.tool_read,0);
  const second=await execute('search_documents',{query:'документы',side:'B',document_ids:null,cursor:search.next_cursor},'2');assert.notEqual(search.hits[0].ref.block_id,second.hits[0].ref.block_id);
  const doc=h.run.documents[0],read=await execute('read_blocks',{document_id:doc.id,extraction_version:1,start_block_id:doc.blocks[1].id,count:1,include_context:true},'3');assert.ok(read.context.some(b=>b.text.includes('не имеет права')));assert.equal(coverage(h.run).counts.tool_read,2);
  assert.equal((await execute('read_blocks',{document_id:'another-run',extraction_version:1,start_block_id:'b1',count:1,include_context:true},'4')).error,'invalid_reference');
  assert.ok((await execute('delete_files',{},'5')).error);
});
