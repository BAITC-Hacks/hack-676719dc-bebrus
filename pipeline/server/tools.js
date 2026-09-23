import { toolSchemas, toolDescriptions } from '../shared/contracts.js';
import { validate, document, resolveRef } from './validate.js';
import { contextBlocks } from './extract.js';
import { normalize, blockRef, hash, check, AppError } from './util.js';
export const definitions=Object.entries(toolSchemas).map(([name,parameters])=>({type:'function',name,description:toolDescriptions[name],parameters,strict:true}));
export function toolsForRole(role) {return definitions.filter(t=>!['routing','extraction'].includes(role)||!['read_functions','read_task_results'].includes(t.name));}
function cursorOffset(cursor,signature) {
  if(!cursor)return 0;
  try{const v=JSON.parse(Buffer.from(cursor,'base64url').toString('utf8'));check(v.signature===signature&&Number.isInteger(v.offset)&&v.offset>=0,'Недействительный курсор.');return v.offset;}catch{throw new AppError('invalid_cursor','Недействительный курсор.');}
}
const nextCursor=(offset,signature)=>Buffer.from(JSON.stringify({offset,signature})).toString('base64url');
export function makeTools(run,store,callMeta) {
  const memo=new Map(), budgets=run.settings.budgets;
  const implementations={
    list_documents({side}) {return {documents:run.documents.filter(d=>!side||d.side===side).map(d=>({id:d.id,name:d.name,side:d.side,extraction_version:d.extraction_version,status:d.status,warnings:d.warnings,blocks:d.blocks.length,first_block_id:d.blocks[0]?.id||null,last_block_id:d.blocks.at(-1)?.id||null}))};},
    read_blocks({document_id,extraction_version,start_block_id,count,include_context}) {
      check(count>=1&&count<=100,'Можно прочитать от 1 до 100 блоков за вызов.');
      const doc=document(run,document_id,extraction_version),start=doc.blocks.findIndex(b=>b.id===start_block_id);check(start>=0,'Блок не найден.','invalid_reference');
      const selected=[],parents=new Map();let chars=0;
      for(const b of doc.blocks.slice(start,start+count)) {
        const ctx=include_context?contextBlocks(doc,b):[],newParents=ctx.filter(p=>!parents.has(p.id));
        const size=b.text.length+newParents.reduce((n,b)=>n+b.text.length,0);
        if(chars+size>budgets.toolTextChars){if(!selected.length)throw new AppError('block_context_limit','Один блок с контекстом превышает бюджет чтения. Увеличьте toolTextChars для нового запуска.');break;}
        selected.push(b);newParents.forEach(b=>parents.set(b.id,b));chars+=size;
      }
      const next=start+selected.length;
      return {document:{id:doc.id,name:doc.name,side:doc.side,extraction_version:doc.extraction_version,status:doc.status},blocks:selected,context:[...parents.values()],next_block_id:doc.blocks[next]?.id||null,truncated:next<Math.min(start+count,doc.blocks.length),available_after:doc.blocks.length-next};
    },
    search_documents({query,side,document_ids,cursor}) {
      check(query.trim().length>0&&query.length<=500,'Поисковый запрос должен содержать от 1 до 500 символов.');
      document_ids?.forEach(d=>document(run,d));
      const docs=run.documents.filter(d=>(!side||d.side===side)&&(!document_ids||document_ids.includes(d.id)));
      const signature=hash({query,side,document_ids,versions:docs.map(d=>[d.id,d.extraction_version])}),offset=cursorOffset(cursor,signature);
      const q=normalize(query),words=q.split(/[^\p{L}\p{N}]+/u).filter(Boolean);
      const hits=docs.flatMap(d=>d.blocks.map(b=>({d,b,score:b.normalized.includes(q)?2:words.filter(w=>b.normalized.includes(w)).length/Math.max(words.length,1)})).filter(h=>h.score>0)).sort((a,b)=>b.score-a.score||a.d.id.localeCompare(b.d.id)||a.b.order-b.b.order);
      const selected=hits.slice(offset,offset+budgets.searchPageSize);
      return {query,method:'literal_phrase_or_token_overlap',searched_document_ids:docs.map(d=>d.id),unavailable_document_ids:docs.filter(d=>d.status==='failed').map(d=>d.id),hits:selected.map(h=>({ref:blockRef(h.b),name:h.d.name,side:h.d.side,score:h.score,snippet:h.b.text.slice(0,1000),snippet_truncated:h.b.text.length>1000,context_refs:contextBlocks(h.d,h.b).map(blockRef)})),total:hits.length,truncated:offset+selected.length<hits.length,next_cursor:offset+selected.length<hits.length?nextCursor(offset+selected.length,signature):null,limitations:['Лексический поиск не устанавливает смысловое отсутствие функции.']};
    },
    read_functions({ids,side,cursor}) {
      const functions=run.functions.filter(f=>f.current&&(!side||f.side===side));
      ids?.forEach(fid=>check(functions.some(f=>f.id===fid),'Функция недоступна.','invalid_reference'));
      const filtered=functions.filter(f=>!ids||ids.includes(f.id)),sig=hash(filtered.map(f=>[f.id,f.version])),offset=cursorOffset(cursor,sig),items=filtered.slice(offset,offset+30);
      return {functions:items,total:filtered.length,next_cursor:offset+items.length<filtered.length?nextCursor(offset+items.length,sig):null,truncated:offset+items.length<filtered.length};
    },
    read_task_results({task_ids}) {
      check(task_ids.length<=8,'Можно прочитать до 8 результатов за один вызов.');
      return {tasks:task_ids.map(tid=>{const t=run.tasks.find(t=>t.id===tid&&t.current);check(t,'Задача недоступна.','invalid_reference');return {id:t.id,version:t.version,status:t.status,result:t.result||null,judge:run.judge_results.filter(j=>j.current&&j.task_id===tid)};})};
    }
  };
  return async function execute(name,args,callId) {
    const started=Date.now();let result,error=null,cached=false;
    try {
      check(toolsForRole(callMeta.role).some(t=>t.name===name),'Инструмент не разрешён для этой роли.');validate(name,args);
      const k=hash({name,args});if(memo.has(k)){result=memo.get(k);cached=true;}else{result=await implementations[name](args);memo.set(k,result);}
      if(JSON.stringify(result).length>run.settings.budgets.inputChars/2)throw new AppError('tool_result_limit','Результат инструмента превышает бюджет; уменьшите область запроса.');
    } catch(e) {error=e.code||'tool_error';result={error,message:e.message};}
    const returned=name==='read_blocks'&&!error?[...result.blocks,...result.context].map(blockRef):name==='search_documents'&&!error?result.hits.map(h=>h.ref):[];
    store.log(run,{type:'tool',...callMeta,name,call_id:callId,args,result,returned_refs:returned,error,cached,duration_ms:Date.now()-started});
    await store.save(run);return result;
  };
}
