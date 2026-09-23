import express from 'express';
import multer from 'multer';
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { ROOT, loadConfig } from './config.js';
import { Store } from './store.js';
import { RoleClient, safeError } from './provider.js';
import { Orchestrator } from './orchestrator.js';
import { addDocument, publicRun, reextract } from './service.js';
import { document, resolveRef } from './validate.js';
import { applyPlan, staleReport } from './planning.js';
import { reviewFinding } from './registry.js';
import { contextBlocks } from './extract.js';
import { exportHtml, coordinate } from './export.js';
import { buildDiff } from './diff.js';
import { check, hash } from './util.js';
export async function createApplication(options={}) {
  const config=options.config||loadConfig(),store=options.store||new Store(config.dataDir);await store.init();
  const testProvider=config.testMode?(options.testProvider||(await import('../test-support/provider.js')).testProvider):null;
  const client=new RoleClient(store,config,{transport:options.transport,testProvider}),orchestrator=new Orchestrator(store,client,config),app=express();
  app.disable('x-powered-by');
  app.use((req,res,next)=>{
    res.set({'X-Content-Type-Options':'nosniff','Referrer-Policy':'no-referrer','Cache-Control':'no-store','Content-Security-Policy':"default-src 'self'; script-src 'self'; style-src 'self'; img-src 'self' data:; connect-src 'self'; base-uri 'none'; frame-ancestors 'none'; object-src 'none'"});
    const origin=req.get('origin');if(!['GET','HEAD'].includes(req.method)&&origin&&origin!==`${req.protocol}://${req.get('host')}`)return res.status(403).json({error:'origin',message:'Запрос с другого сайта отклонён.'});next();
  });
  app.use(express.json({limit:'4mb'}));
  const upload=multer({storage:multer.memoryStorage(),limits:{fileSize:config.limits.fileBytes,files:1,fields:4}});
  const withRun=(req,res,next)=>{try{req.run=store.get(req.params.id);if(options.requireOwner)check(req.run.owner_id===req.user?.id,'Запуск не найден.','not_found');next();}catch(e){next(e);}};
  const idle=run=>check(!orchestrator.active.has(run.id),'Сначала остановите выполняющийся запуск.','already_running');
  const locks=new Set();
  async function mutate(run,work){check(!locks.has(run.id),'Операция записи уже выполняется.');locks.add(run.id);try{return await work();}finally{locks.delete(run.id);}}
  app.get('/api/config',async(req,res)=>{const prompts=await (await import('./prompts.js')).loadPrompts();res.json({model:config.model,effortByRole:config.effortByRole,key_ready:!!config.apiKey,key_error:config.keyError||null,missing_roles:prompts.missing,test_mode_available:config.testMode,limits:config.limits});});
  app.get('/api/runs',(req,res)=>res.json([...store.runs.values()].filter(r=>!options.requireOwner||r.owner_id===req.user?.id).map(r=>publicRun(r,{detail:false})).reverse()));
  app.post('/api/runs',async(req,res)=>res.status(201).json(publicRun(await store.create(config,{...req.body,...(options.requireOwner?{owner_id:req.user.id}:{})}))));
  app.get('/api/runs/:id',withRun,(req,res)=>res.json(publicRun(req.run)));
  app.get('/api/runs/:id/preflight',withRun,async(req,res)=>res.json(await orchestrator.preflight(req.run)));
  app.post('/api/runs/:id/options',withRun,async(req,res)=>{idle(req.run);check(!req.run.plan&&!req.run.prompt_snapshot,'Настройки начатого запуска зафиксированы.');if('explicit_pair'in req.body){check(typeof req.body.explicit_pair==='boolean','Неверная настройка пары.');req.run.explicit_pair=req.body.explicit_pair;}if('mode'in req.body){check(req.body.mode==='live'||(req.body.mode==='test'&&config.testMode),'Тестовый режим не включён.');req.run.mode=req.body.mode;if(req.body.mode==='test')req.run.limitations.push('ТЕСТОВЫЙ ПРОГОН: качество смыслового анализа не проверяется.');}await store.save(req.run);res.json(publicRun(req.run));});
  app.post('/api/runs/:id/documents',withRun,upload.single('file'),async(req,res)=>{check(req.file,'Файл не передан.');idle(req.run);const doc=await mutate(req.run,()=>addDocument(store,req.run,{name:req.body.name||Buffer.from(req.file.originalname,'latin1').toString('utf8'),side:req.body.side,buffer:req.file.buffer}));res.status(201).json({id:doc.id,status:doc.status,warnings:doc.warnings});});
  app.delete('/api/runs/:id/documents/:doc',withRun,async(req,res)=>{idle(req.run);check(!req.run.plan&&!req.run.prompt_snapshot,'Состав начатого запуска зафиксирован.');document(req.run,req.params.doc);req.run.documents=req.run.documents.filter(d=>d.id!==req.params.doc);req.run.version++;staleReport(req.run);await store.save(req.run);res.json({ok:true});});
  app.post('/api/runs/:id/start',withRun,async(req,res)=>{check(!locks.has(req.run.id),'Дождитесь завершения загрузки.');res.json(publicRun(await orchestrator.start(req.run)));});
  app.post('/api/runs/:id/cancel',withRun,async(req,res)=>{await orchestrator.cancel(req.run);res.json(publicRun(req.run));});
  app.post('/api/runs/:id/clarification',withRun,async(req,res)=>res.json(publicRun(await orchestrator.clarify(req.run,req.body))));
  app.put('/api/runs/:id/plan',withRun,async(req,res)=>{idle(req.run);check(req.body.version===req.run.plan?.version,'Карта устарела.','stale_response');applyPlan(req.run,req.body);req.run.epoch++;await store.save(req.run);res.json(publicRun(req.run));});
  app.post('/api/runs/:id/documents/:doc/reextract',withRun,async(req,res)=>{idle(req.run);await reextract(store,req.run,document(req.run,req.params.doc));res.json(publicRun(req.run));});
  app.post('/api/runs/:id/findings/:finding/review',withRun,async(req,res)=>{idle(req.run);reviewFinding(req.run,req.params.finding,req.body);await store.save(req.run);res.json(publicRun(req.run));});
  app.post('/api/runs/:id/synthesize',withRun,async(req,res)=>{check(req.run.plan,'Сначала выполните анализ.');res.json(publicRun(await orchestrator.start(req.run,{synthesisOnly:true})));});
  app.get('/api/runs/:id/sources/:doc',withRun,(req,res)=>{
    const doc=document(req.run,req.params.doc),version=Number(req.query.version||doc.extraction_version),saved=version===doc.extraction_version?doc:doc.history.find(h=>h.extraction_version===version);check(saved,'Версия источника не найдена.');
    const start=req.query.block?saved.blocks.findIndex(b=>b.id===req.query.block):Number(req.query.offset||0);check(start>=0&&Number.isInteger(start),'Блок не найден.');const count=Math.min(100,Math.max(1,Number(req.query.count||30)));check(Number.isInteger(count),'Неверное число блоков.');
    const blocks=saved.blocks.slice(start,start+count),context=blocks.length?contextBlocks({...doc,blocks:saved.blocks},blocks[0]):[];
    res.json({document:{id:doc.id,name:doc.name,side:doc.side,status:saved.status,warnings:saved.warnings,extraction_version:version},blocks:blocks.map(b=>({...b,coordinate:coordinate(b)})),context:context.map(b=>({...b,coordinate:coordinate(b)})),next_offset:start+blocks.length<saved.blocks.length?start+blocks.length:null,total:saved.blocks.length});
  });
  app.get('/api/runs/:id/originals/:doc',withRun,(req,res)=>{const doc=document(req.run,req.params.doc);res.download(store.originalPath(req.run,doc),doc.name);});
  app.get('/api/runs/:id/diff',withRun,(req,res)=>{
    const before=document(req.run,String(req.query.before)),after=document(req.run,String(req.query.after));check(before.side==='A'&&after.side==='B','Выберите документ A и документ Б.');res.json(buildDiff(req.run,before.blocks,after.blocks));
  });
  app.get('/api/runs/:id/tasks/:task/diff',withRun,(req,res)=>{const task=req.run.tasks.find(t=>t.id===req.params.task&&t.current);check(task,'Задача не найдена.');res.json(task.diff||{rows:[]});});
  app.get('/api/runs/:id/logs',withRun,(req,res)=>res.json(req.run.logs));
  app.get('/api/runs/:id/export.html',withRun,(req,res)=>{res.set('Content-Security-Policy',"default-src 'none'; style-src 'unsafe-inline'; base-uri 'none'");res.attachment('hectra-report.html').type('html').send(exportHtml(req.run));});
  // Local material catalogue lists document resources. Nothing is assigned to a pool until explicitly selected.
  async function materials() {const entries=await fs.readdir(ROOT,{withFileTypes:true});return entries.filter(f=>f.isFile()&&/\.(docx|pdf|xlsx)$/i.test(f.name)).map(f=>({id:hash(f.name).slice(0,20),name:f.name}));}
  if(!options.requireOwner){
    app.get('/api/materials',async(req,res)=>res.json(await materials()));
    app.post('/api/runs/:id/materials',withRun,async(req,res)=>{idle(req.run);const material=(await materials()).find(f=>f.id===req.body.material_id);check(material,'Материал не найден.');const buffer=await fs.readFile(path.join(ROOT,material.name));await mutate(req.run,()=>addDocument(store,req.run,{name:material.name,side:req.body.side,buffer}));res.json(publicRun(req.run));});
  }
  app.use((req,res)=>res.status(404).json({error:'not_found',message:'Маршрут не найден.'}));
  app.use((err,req,res,next)=>res.status(err.status|| (err.code==='LIMIT_FILE_SIZE'?413:400)).json({error:err.code||'request_error',message:safeError(err,config.apiKey),details:err.code==='invalid_structure'?err.details:null}));
  return {app,store,orchestrator,config};
}
if(process.argv[1]&&path.resolve(process.argv[1])===fileURLToPath(import.meta.url)) {
  const {app}=await createApplication();const port=Number(process.env.PORT||3000);app.listen(port,'127.0.0.1',()=>console.log(`Hectra: http://127.0.0.1:${port}`));
}
