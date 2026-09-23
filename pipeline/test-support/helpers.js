import fs from 'node:fs/promises';
import path from 'node:path';
import AdmZip from 'adm-zip';
import { Store } from '../server/store.js';
import { loadConfig, ROOT } from '../server/config.js';
import { RoleClient } from '../server/provider.js';
import { Orchestrator } from '../server/orchestrator.js';
import { addDocument } from '../server/service.js';
import { testProvider } from './provider.js';
export async function tempDir(prefix='test') {const dir=path.join(ROOT,'test-results');await fs.mkdir(dir,{recursive:true});return fs.mkdtemp(path.join(dir,`${prefix}-`));}
export function docxBuffer(paragraphs,{numbering=false,image=false,table=false}={}) {
  const zip=new AdmZip(),escape=s=>s.replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;');
  const p=s=>`<w:p>${numbering?'<w:pPr><w:numPr><w:ilvl w:val="0"/><w:numId w:val="1"/></w:numPr></w:pPr>':''}<w:r><w:t xml:space="preserve">${escape(s)}</w:t></w:r></w:p>`;
  zip.addFile('word/document.xml',Buffer.from(`<w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:body>${paragraphs.map(p).join('')}${table?'<w:tbl><w:tr><w:tc><w:p><w:r><w:t>Ячейка 1</w:t></w:r></w:p></w:tc><w:tc><w:p><w:r><w:t>Ячейка 2</w:t></w:r></w:p></w:tc></w:tr></w:tbl>':''}${image?'<w:p><w:r><w:drawing/></w:r></w:p>':''}</w:body></w:document>`));
  if(numbering)zip.addFile('word/numbering.xml',Buffer.from('<w:numbering xmlns:w="x"><w:abstractNum w:abstractNumId="0"><w:lvl w:ilvl="0"><w:start w:val="1"/><w:numFmt w:val="decimal"/><w:lvlText w:val="%1."/></w:lvl></w:abstractNum><w:num w:numId="1"><w:abstractNumId w:val="0"/></w:num></w:numbering>'));
  return zip.toBuffer();
}
export async function harness({provider=testProvider,documents=[['A',['1. Подразделение обязано:','1.1. Проверять качество отчётов.']],['B',['1. Подразделение вправе:','1.1. Проверять качество отчётов.','1.2. Хранить результаты.']]],explicit_pair=true,overrides={}}={}) {
  const config=loadConfig({testMode:true,dataDir:await tempDir(),...overrides}),store=new Store(config.dataDir);await store.init();const run=await store.create(config,{mode:'test',explicit_pair});
  for(const [i,[side,text]]of documents.entries())await addDocument(store,run,{side,name:`Документ ${i+1}.docx`,buffer:docxBuffer(text)});
  const client=new RoleClient(store,config,{testProvider:provider}),orchestrator=new Orchestrator(store,client,config);return {config,store,run,client,orchestrator};
}
