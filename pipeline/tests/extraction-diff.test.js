import test from 'node:test';
import assert from 'node:assert/strict';
import ExcelJS from 'exceljs';
import { docxBuffer, harness } from '../test-support/helpers.js';
import { parseFile, materialize, contextBlocks, overview } from '../server/extract.js';
import { buildDiff } from '../server/diff.js';
import { resolveRef } from '../server/validate.js';
test('DOCX preserves order, table coordinates, automatic numbering and unmodified text',async()=>{
  const data=await parseFile(docxBuffer(['  Первый текст  ','Второй текст'],{numbering:true,table:true}),'test.docx');assert.equal(data.status,'ok');assert.equal(data.blocks[0].text,'  Первый текст  ');assert.equal(data.blocks[0].numbering.label,'1.');assert.equal(data.blocks[1].numbering.label,'2.');assert.equal(data.blocks[2].coordinates.row,1);assert.equal(data.blocks[3].coordinates.column,2);
});
test('prohibition survives in parent context after several list items',async()=>{
  const data=await parseFile(docxBuffer(['5.8. Работники не имеют права:','5.8.1. Проводить платежи.','5.8.2. Выдавать разрешения.','5.8.3. Подписывать документы.']),'a.docx'),blocks=materialize(data,'d');assert.ok(contextBlocks({blocks},blocks[3]).some(b=>b.text.includes('не имеют права')));assert.equal(blocks[3].text,'5.8.3. Подписывать документы.');
});
test('unreadable, binary and image-only sources never count as extracted',async()=>{
  assert.equal((await parseFile(Buffer.from('invalid'),'broken.docx')).status,'failed');assert.equal((await parseFile(Buffer.from('binary'),'old.doc')).status,'failed');const image=await parseFile(docxBuffer([],{image:true}),'image.docx');assert.equal(image.status,'failed');assert.ok(image.warnings.some(w=>w.includes('OCR')));
});
test('XLSX retains sheet/row coordinates, formula, cached result and header separately',async()=>{
  const w=new ExcelJS.Workbook(),s=w.addWorksheet('Функции');s.addRow(['Ответственный','Сумма']);s.addRow(['Отдел',{formula:'2+3',result:5}]);s.addRow(['Другое',{formula:'10+1'}]);const p=await parseFile(Buffer.from(await w.xlsx.writeBuffer()),'test.xlsx');assert.equal(p.blocks[1].coordinates.sheet,'Функции');assert.equal(p.blocks[1].coordinates.cells[1].formula,'2+3');assert.equal(p.blocks[1].coordinates.cells[1].value,5);assert.equal(p.blocks[1].table_header.row,1);assert.equal(p.status,'partial');
});
test('presentation IDs align independent sources and retain modality word diff',async()=>{
  const {run}=await harness({documents:[['A',['Анализ осуществляется ежегодно.']],['B',['Анализ может осуществляться ежегодно.']]]});const diff=buildDiff(run,run.documents[0].blocks,run.documents[1].blocks);assert.equal(diff.rows.length,1);assert.equal(diff.rows[0].kind,'modified');assert.ok(diff.rows[0].word_diff.some(p=>p.kind==='added'&&p.text.includes('может')));assert.notEqual(diff.rows[0].before_refs[0].document_id,diff.rows[0].after_refs[0].document_id);assert.equal(diff.snapshots.before[0].id,diff.snapshots.after[0].id);
});
test('equal text with different parent responsibility is flagged for semantic review',async()=>{
  const {run}=await harness({documents:[['A',['1. Ответственный отдел А:','1.1. Проверять документы.']],['B',['1. Ответственный отдел Б:','1.1. Проверять документы.']]]});const diff=buildDiff(run,...run.documents.map(d=>d.blocks));assert.equal(diff.rows.find(r=>r.before_text.includes('Проверять')).kind,'context_changed');
});
test('overview marks omissions, block sources validate version and offsets',async()=>{
  const {run}=await harness();const d=run.documents[0],o=overview(d,20);assert.ok(o.omitted_blocks>0);assert.ok(o.token_estimate_is_approximate);assert.throws(()=>resolveRef(run,{document_id:d.id,extraction_version:99,block_id:d.blocks[0].id}),/версия/);assert.throws(()=>resolveRef(run,{document_id:d.id,extraction_version:1,block_id:d.blocks[0].id,char_start:0,char_end:99999}),/диапазон/);
});
