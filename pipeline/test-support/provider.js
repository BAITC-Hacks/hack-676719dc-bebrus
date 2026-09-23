// Explicit test mode only. No semantic claims about the uploaded documents.
import { blockRef } from '../server/util.js';
export async function testProvider({role,data,run,execute}) {
  const limitation='Тестовый provider: смысловая корректность не проверялась.';
  if(role==='routing')return {version:1,groups:[],remainder:[],clarification:null,limitations:[limitation]};
  if(role==='extraction') {
    const feature=(value,refs)=>({value,basis:value===null?'unknown':'explicit',source_refs:refs});
    return {functions:data.context.filter(c=>c.assigned!==false&&c.block.text.trim()).map((c,i)=>({id:`test_${i}`,version:1,responsible:feature(null,[]),action:feature(c.block.text,[blockRef(c.block)]),object:feature(null,[]),scope:feature(null,[]),modality:feature(null,[]),conditions:feature(null,[]),deadlines:feature(null,[]),exceptions:feature(null,[]),source_refs:[blockRef(c.block)],uncertainty:[limitation]})),org_units:[],coverage:data.ranges.map(range=>({range,status:'considered',reason:limitation})),limitations:[limitation]};
  }
  if(role==='comparison'||role==='crosscheck') {
    const first=data.context[0]?.block;
    if(first)await execute('read_blocks',{document_id:first.document_id,extraction_version:first.extraction_version,start_block_id:first.id,count:1,include_context:true},'test-read');
    return {task_id:data.task_id,task_version:data.task_version,findings:(data.diff?.rows||[]).filter(r=>!['equal','normalized'].includes(r.kind)&&r.before_refs.length+r.after_refs.length).map((r,i)=>({id:`f${i}`,version:1,category:'insufficient_data',claim:'Тестовая карточка текстового различия',before_refs:r.before_refs,after_refs:r.after_refs,function_refs:[],explanation:'Карточка создана тестовым provider для проверки ссылок, версий и интерфейса.',significance:'unknown',significance_basis:limitation,uncertainty:[limitation],limitations:[limitation],action:'Заполнить системные промпты и выполнить live-анализ.',search_scope:{sides:[],document_ids:[],queries:[],limitations:[limitation]}})),function_links:[],org_links:[],coverage:[...data.before,...data.after].map(range=>({range,status:'considered',reason:limitation})),mapping_proposals:[],revision_response:null,limitations:[limitation]};
  }
  if(role==='judge')return {task_id:data.task_id,task_version:data.task_version,result_version:data.result_version,verdict:'passed',checked_ranges:[...(data.before||[]),...(data.after||[])],checked_finding_refs:data.result?.findings.map(f=>f.id)||data.findings?.map(f=>f.id)||[],issues:[],resolutions:[],limitations:[limitation]};
  if(role==='synthesis')return {registry_version:data.registry_version,overview:data.findings.length?[{text:'Тестовая сборка заключения завершена. Карточки ниже не являются результатом смыслового анализа.',finding_refs:[data.findings[0].id]}]:[],questions:[],recommendations:[],limitations:[limitation]};
  throw new Error(`Unknown test role ${role}`);
}
