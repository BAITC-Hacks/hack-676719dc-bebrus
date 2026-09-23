import fs from 'node:fs/promises';
import { parseFile, materialize } from '../server/extract.js';
for (const name of (await fs.readdir('.')).filter(n=>n.endsWith('.docx'))) {
  const p=await parseFile(await fs.readFile(name),name), blocks=materialize(p,'inspect');
  console.log(JSON.stringify({name,status:p.status,blocks:blocks.length,chars:blocks.reduce((n,b)=>n+b.text.length,0),warnings:p.warnings},null,2));
  const selected=name.startsWith('Hack')?blocks:blocks.filter(b=>/^(3\.4|5\.4\.4|5\.3\.3|9\.15|9\.37|5\.6\.2|4\.4|5\.9|5\.10|5\.11|5\.8)(\D|$)/.test(b.numbering?.label || b.text.trim()));
  console.log(selected.map(b=>`${b.id} ${b.numbering?.label||''} ${b.text}`).join('\n'));
}
