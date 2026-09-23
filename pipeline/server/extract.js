import path from 'node:path';
import AdmZip from 'adm-zip';
import { XMLParser } from 'fast-xml-parser';
import ExcelJS from 'exceljs';
import { normalize, hash, AppError } from './util.js';
export const EXTRACTION_VERSION = 'parser-v1';
const ordered = new XMLParser({ ignoreAttributes:false, removeNSPrefix:true, preserveOrder:true, trimValues:false, processEntities:true });
const plain = new XMLParser({ ignoreAttributes:false, removeNSPrefix:true, trimValues:false });
const list = x => x === undefined ? [] : Array.isArray(x) ? x : [x];
const key = n => Object.keys(n).find(k=>k!==':@');
function all(nodes,name) { return (nodes||[]).flatMap(n=>[...(key(n)===name?[n]:[]),...all(Array.isArray(n[key(n)])?n[key(n)]:[],name)]); }
function textOf(nodes) {
  return (nodes||[]).map(n=>{ const k=key(n); if(k==='del') return ''; if(k==='#text') return String(n[k]); if(k==='tab') return '\t'; if(k==='br'||k==='cr') return '\n'; return Array.isArray(n[k])?textOf(n[k]):''; }).join('');
}
const attr = (node,name='val') => node?.[':@']?.[`@_${name}`];
function zipFile(buffer) {
  const zip = new AdmZip(buffer), entries = zip.getEntries();
  if (entries.length > 20000 || entries.reduce((n,e)=>n+e.header.size,0) > 200*1024*1024) throw new AppError('archive_limit','Распакованный файл превышает лимит 200 МБ / 20000 элементов.');
  return zip;
}
function docx(buffer) {
  const zip=zipFile(buffer), main=zip.getEntry('word/document.xml');
  if(!main) throw new Error('В DOCX отсутствует word/document.xml.');
  const xml=main.getData().toString('utf8'), tree=ordered.parse(xml), body=all(tree,'body')[0]?.body;
  if(!body) throw new Error('В DOCX отсутствует тело документа.');
  const blocks=[], warnings=[], nums={}, abstracts={}, counters={}, styles={};
  const nEntry=zip.getEntry('word/numbering.xml');
  if(nEntry) {
    const n=plain.parse(nEntry.getData().toString('utf8')).numbering;
    for(const a of list(n?.abstractNum)) abstracts[a['@_abstractNumId']]=Object.fromEntries(list(a.lvl).map(l=>[l['@_ilvl'],l]));
    for(const num of list(n?.num)) nums[num['@_numId']]={ abstract:num.abstractNumId?.['@_val'], overrides:Object.fromEntries(list(num.lvlOverride).map(l=>[l['@_ilvl'],l])) };
  }
  const sEntry=zip.getEntry('word/styles.xml');
  if(sEntry) for(const s of list(plain.parse(sEntry.getData().toString('utf8')).styles?.style)) styles[s['@_styleId']]=s;
  function number(p,style) {
    const numPr=all(p.p,'numPr')[0], inherited=styles[style]?.pPr?.numPr;
    const numId=attr(all(numPr?.numPr,'numId')[0]) ?? inherited?.numId?.['@_val'];
    const level=Number(attr(all(numPr?.numPr,'ilvl')[0]) ?? inherited?.ilvl?.['@_val'] ?? 0);
    if(numId===undefined || String(numId)==='0') return null;
    const n=nums[numId], lvl=n?.overrides[level]?.lvl || abstracts[n?.abstract]?.[level];
    if(!lvl) { warnings.push('Часть автоматической нумерации не восстановлена; numId/уровень сохранены.'); return {numId,level,label:null,status:'unresolved'}; }
    const count=counters[numId] ||= {};
    count[level]=(count[level] ?? Number(n.overrides[level]?.startOverride?.['@_val'] ?? lvl.start?.['@_val'] ?? 1)-1)+1;
    for(const l of Object.keys(count)) if(Number(l)>level) delete count[l];
    const fmt=lvl.numFmt?.['@_val'], pattern=String(lvl.lvlText?.['@_val'] ?? '');
    if(fmt==='bullet') return {numId,level,label:pattern,status:'restored'};
    if(fmt!=='decimal' || list(n.overrides[level]?.lvlRestart).length) { warnings.push('Нестандартная нумерация не восстановлена.'); return {numId,level,label:null,status:'unresolved'}; }
    if([...pattern.matchAll(/%(\d+)/g)].some(m=>count[Number(m[1])-1]===undefined)){warnings.push('Номер родительского уровня списка не установлен; составной номер не восстановлен.');return {numId,level,label:null,status:'unresolved'};}
    const label=pattern.replace(/%(\d+)/g,(_,i)=>String(count[Number(i)-1]));
    return {numId,level,label,status:'restored'};
  }
  function paragraph(p,coordinates) {
    const raw=textOf(p.p), style=attr(all(p.p,'pStyle')[0]);
    const outline=attr(all(p.p,'outlineLvl')[0]) ?? styles[style]?.pPr?.outlineLvl?.['@_val'];
    const styleName=styles[style]?.name?.['@_val'] || style || '';
    const matched=/heading\s*(\d)|заголовок\s*(\d)/i.exec(styleName);
    const level=outline!==undefined ? Number(outline)+1 : matched?Number(matched[1]||matched[2]):null;
    const numbering=number(p,style);
    if(raw.trim()) blocks.push({text:raw,type:level?'heading':numbering?'list':'paragraph',coordinates,heading_level:level,numbering});
    if(all(p.p,'drawing').length||all(p.p,'pict').length) { blocks.push({text:'',type:'image',coordinates,unavailable:true}); warnings.push('Изображение или оргсхема не прочитаны: OCR и анализ изображений отсутствуют.'); }
  }
  let pIndex=0,tableIndex=0;
  function walk(nodes,base={part:'body'}) {
    for(const n of nodes||[]) {
      const k=key(n);
      if(k==='p') paragraph(n,{...base,paragraph:++pIndex});
      else if(k==='tbl') {
        const table=++tableIndex; let row=0;
        for(const tr of n.tbl.filter(n=>n.tr)) { row++; let column=0;
          for(const tc of tr.tr.filter(n=>n.tc)) { column++; walk(tc.tc,{...base,table,row,column}); }
        }
      } else if(Array.isArray(n[k]) && !['sectPr','del'].includes(k)) walk(n[k],base);
    }
  }
  walk(body);
  if(/<(?:w:)?(?:ins|del)\b/.test(xml)) warnings.push('В DOCX есть отслеживаемые правки: прочитан текущий текст без удалённых фрагментов; история правок не анализируется.');
  for(const entry of zip.getEntries()) if(/^word\/(?:footnotes|endnotes|header\d+|footer\d+)\.xml$/.test(entry.entryName)) {
    const nodes=ordered.parse(entry.getData().toString('utf8'));
    for(const p of all(nodes,'p')) paragraph(p,{part:entry.entryName,paragraph:++pIndex});
    warnings.push('Сноски и колонтитулы извлечены отдельными блоками после основного текста; их визуальная привязка к страницам не восстановлена.');
  }
  return {blocks,warnings};
}
async function pdf(buffer) {
  const { getDocument, OPS }=await import('pdfjs-dist/legacy/build/pdf.mjs');
  const task=getDocument({data:new Uint8Array(buffer),useSystemFonts:true,isEvalSupported:false,verbosity:0});
  const doc=await task.promise, blocks=[], warnings=['PDF: порядок чтения восстановлен по текстовым элементам; структура таблиц не подтверждена.'];
  try {
    for(let page=1;page<=doc.numPages;page++) {
      const p=await doc.getPage(page), content=await p.getTextContent();
      const operators=await p.getOperatorList();
      if(operators.fnArray.some(op=>[OPS.paintImageXObject,OPS.paintInlineImageXObject,OPS.paintImageMaskXObject].includes(op))){warnings.push(`Страница ${page}: растровые изображения не прочитаны; OCR отсутствует.`);}
      const items=content.items.filter(i=>typeof i.str==='string'&&i.str.trim());
      if(!items.length) { blocks.push({text:'',type:'empty_page',unavailable:true,coordinates:{page}}); warnings.push(`Страница ${page}: нет извлекаемого текста; возможно изображение. OCR отсутствует.`); continue; }
      let line=[];
      function flush(){ if(!line.length)return; blocks.push({text:line.map(i=>i.str).join(' '),type:'pdf_line',coordinates:{page,items:line.map(i=>({x:i.transform[4],y:i.transform[5],width:i.width,height:i.height}))}});line=[]; }
      for(const item of items){if(line.length&&Math.abs(item.transform[5]-line.at(-1).transform[5])>3)flush();line.push(item);if(item.hasEOL)flush();} flush();
    }
  } finally {await doc.destroy();}
  return {blocks,warnings};
}
async function xlsx(buffer) {
  zipFile(buffer);
  const workbook=new ExcelJS.Workbook(); await workbook.xlsx.load(buffer);
  const blocks=[],warnings=[];
  for(const sheet of workbook.worksheets) {
    let header=null;
    sheet.eachRow({includeEmpty:false},row=>{
      const cells=[];
      row.eachCell({includeEmpty:false},cell=>{
        const v=cell.value, formula=v&&typeof v==='object'?(v.formula||v.sharedFormula||null):null;
        const value= formula ? (v.result??null) : v;
        const displayed=cell.text || (formula?`=${formula}`:'');
        cells.push({address:cell.address,column:cell.col,text:displayed,formula,value});
        if(formula && value===null)warnings.push('Есть формулы без сохранённого значения; формулы не вычислялись.');
      });
      if(!cells.length)return;
      blocks.push({text:cells.map(c=>`${c.address}: ${c.text}`).join('\t'),type:'spreadsheet_row',coordinates:{sheet:sheet.name,row:row.number,cells,hidden:!!row.hidden},table_header:header});
      if(header===null)header={row:row.number,text:blocks.at(-1).text,basis:'first_nonempty_row_candidate'};
    });
    if(!sheet.actualRowCount)warnings.push(`Лист «${sheet.name}»: нет доступных значений.`);
    if(sheet.getImages().length)warnings.push(`Лист «${sheet.name}»: изображения не прочитаны.`);
  }
  return {blocks,warnings};
}
export async function parseFile(buffer,name) {
  const extension=path.extname(name).toLowerCase();
  if(!['.docx','.pdf','.xlsx'].includes(extension)) return {blocks:[],warnings:['Поддерживаются DOCX, текстовый PDF, XLSX. Бинарные DOC/XLS и OCR не поддерживаются.'],status:'failed',parser_version:EXTRACTION_VERSION};
  try {
    const data=await ({'.docx':docx,'.pdf':pdf,'.xlsx':xlsx}[extension])(buffer);
    data.warnings=[...new Set(data.warnings)];
    if(!data.blocks.some(b=>b.text.trim()))data.warnings.push('Нет доступного текста для анализа.');
    return {...data,status:!data.blocks.some(b=>b.text.trim())?'failed':data.warnings.length?'partial':'ok',parser_version:EXTRACTION_VERSION};
  } catch(error) {return {blocks:[],status:'failed',warnings:[`Не удалось прочитать файл: ${error.message}`],parser_version:EXTRACTION_VERSION};}
}
export function materialize(parsed,documentId,version=1) {
  const headings=[], parents=new Map(); let intro=null;
  const blocks=parsed.blocks.map((b,index)=>({...b,id:`b${String(index+1).padStart(6,'0')}`,document_id:documentId,extraction_version:version,order:index,text:b.text,normalized:normalize(b.text),context:{heading_ids:[],parent_ids:[],intro_id:null,previous_ids:[]}}));
  for(let i=0;i<blocks.length;i++) {
    const b=blocks[i];
    if(b.heading_level) { while(headings.length&&headings.at(-1).level>=b.heading_level)headings.pop(); parents.clear(); intro=null; }
    const number=b.numbering?.label || /^\s*(\d+(?:\.\d+)+)[.)]?\s/.exec(b.text)?.[1];
    const depth=number&&/^\d/.test(number)?number.replace(/[.)]+$/,'').split('.').length:null;
    if(depth!==null)for(const k of parents.keys())if(k>=depth)parents.delete(k);
    b.context={heading_ids:headings.map(h=>h.id),parent_ids:[...parents.values()],intro_id:intro,previous_ids:blocks.slice(Math.max(0,i-2),i).map(x=>x.id)};
    if(b.heading_level)headings.push({id:b.id,level:b.heading_level});
    if(depth!==null)parents.set(depth,b.id);
    if(b.text.trim().endsWith(':'))intro=b.id;
    else if(!b.numbering && !/^[\s–—•-]/.test(b.text) && depth===null)intro=null;
  }
  return blocks;
}
export function contextBlocks(doc,block) {
  const ids=new Set([...block.context.heading_ids,...block.context.parent_ids,...block.context.previous_ids,block.context.intro_id].filter(Boolean));
  return doc.blocks.filter(b=>ids.has(b.id));
}
export function overview(doc,budget=3200) {
  let remaining=budget; const selected=[];
  for(const b of [...doc.blocks.slice(0,5),...doc.blocks.filter(b=>b.type==='heading'),...doc.blocks]) {
    if(selected.some(s=>s.id===b.id)||!b.text.trim())continue;
    if(b.text.length>remaining)continue;
    selected.push({id:b.id,text:b.text,numbering:b.numbering,context:b.context});remaining-=b.text.length;
  }
  selected.sort((a,b)=>a.id.localeCompare(b.id));
  return {id:doc.id,side:doc.side,name:doc.name,status:doc.status,extraction_version:doc.extraction_version,warnings:doc.warnings,block_count:doc.blocks.length,text_chars:doc.blocks.reduce((n,b)=>n+b.text.length,0),blocks:selected,omitted_blocks:doc.blocks.length-selected.length,overview_budget_chars:budget,token_estimate:Math.ceil((budget-remaining)/4),token_estimate_is_approximate:true};
}
export const extractionCacheKey=(buffer,name)=>hash({file:hash(buffer),extension:path.extname(name).toLowerCase(),parser:EXTRACTION_VERSION});
