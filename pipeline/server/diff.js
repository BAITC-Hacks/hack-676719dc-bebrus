import vm from 'node:vm';
import fs from 'node:fs';
import path from 'node:path';
import { diffArrays } from 'diff';
import { ROOT } from './config.js';
import { normalize, hash, blockRef } from './util.js';
import { contextBlocks } from './extract.js';
const realm=vm.createContext({});
vm.runInContext(fs.readFileSync(path.join(ROOT,'change_rendering_handoff/js/actionLog.js'),'utf8'),realm);
export const hectraDelta=(before,after)=>JSON.parse(JSON.stringify(realm.HectraActionLog.computeDocumentDelta(before,after)));
const words=s=>new Set(normalize(s).split(/[^\p{L}\p{N}]+/u).filter(Boolean));
function similarity(a,b){const x=words(a),y=words(b);let intersection=0;for(const w of x)if(y.has(w))intersection++;return x.size+y.size?2*intersection/(x.size+y.size):0;}
function context(run,b){const d=run.documents.find(d=>d.id===b.document_id);return contextBlocks(d,b).filter(x=>b.context.heading_ids.includes(x.id)||b.context.parent_ids.includes(x.id)||b.context.intro_id===x.id).map(x=>normalize(x.text)).join('\n');}
export function buildDiff(run,before,after) {
  const used=new Set(),pairs=new Map();
  // Stable presentation IDs link source IDs; original block IDs are never rewritten.
  for(let i=0;i<before.length;i++) {const a=before[i];const j=after.findIndex((b,j)=>!used.has(j)&&normalize(a.text)===normalize(b.text)&&a.text.trim());if(j>=0){pairs.set(i,{j,score:1});used.add(j);}}
  const candidates=[];
  for(let i=0;i<before.length;i++)if(!pairs.has(i))for(let j=0;j<after.length;j++)if(!used.has(j)){const score=similarity(before[i].text,after[j].text);if(score>=0.48)candidates.push({i,j,score});}
  candidates.sort((a,b)=>b.score-a.score||Math.abs(a.i-a.j)-Math.abs(b.i-b.j));
  for(const c of candidates)if(!pairs.has(c.i)&&!used.has(c.j)){pairs.set(c.i,c);used.add(c.j);}
  const rows=[];
  function row(a,b,i,j) {
    const same=a&&b&&a.text===b.text, normalized=a&&b&&normalize(a.text)===normalize(b.text);
    const contextChanged=!!(a&&b&&context(run,a)!==context(run,b));
    const moved=normalized&&Math.abs(i-j)>2;
    const kind=!a?'added':!b?'removed':contextChanged&&normalized?'context_changed':moved?'moved':same?'equal':normalized?'normalized':'modified';
    const r={id:`row_${hash([a?blockRef(a):null,b?blockRef(b):null]).slice(0,20)}`,before_refs:a?[blockRef(a)]:[],after_refs:b?[blockRef(b)]:[],before_text:a?.text||'',after_text:b?.text||'',kind,context_changed:contextChanged,alignment_method:normalized?'normalized_text':a&&b?'text_similarity_candidate':'unmatched',word_diff:null};
    if(a&&b&&a.text.length+b.text.length<=6000&&!same){const tokenize=s=>s.match(/[\p{L}\p{N}_]+|\s+|[^\s\p{L}\p{N}_]/gu)||[];r.word_diff=diffArrays(tokenize(a.text),tokenize(b.text)).map(p=>({text:p.value.join(''),kind:p.added?'added':p.removed?'removed':'equal'}));}
    rows.push(r);
  }
  before.forEach((a,i)=>{const pair=pairs.get(i);row(a,pair?after[pair.j]:null,i,pair?.j);});
  after.forEach((b,j)=>{if(!used.has(j))row(null,b,null,j);});
  const snapshots={before:rows.filter(r=>r.before_refs.length).map(r=>({id:r.id,title:'',content:r.before_text,position:null})),after:rows.filter(r=>r.after_refs.length).map(r=>({id:r.id,title:'',content:r.after_text,position:null}))};
  return {rows,delta:hectraDelta(snapshots.before,snapshots.after),snapshots};
}
