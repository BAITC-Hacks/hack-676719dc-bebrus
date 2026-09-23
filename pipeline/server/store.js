import fs from 'node:fs/promises';
import path from 'node:path';
import { id, now, hash, check } from './util.js';
import { publicConfig } from './config.js';
import { CONTRACT_VERSION, TEMPLATE_VERSION } from '../shared/contracts.js';
import { validate } from './validate.js';
export class Store {
  constructor(dir) {this.dir=dir;this.runs=new Map();this.queues=new Map();}
  async init() {
    await fs.mkdir(path.join(this.dir,'runs'),{recursive:true});await fs.mkdir(path.join(this.dir,'cache'),{recursive:true});
    for(const folder of await fs.readdir(path.join(this.dir,'runs'))) {
      try {
        const run=JSON.parse(await fs.readFile(path.join(this.dir,'runs',folder,'run.json'),'utf8'));
        validate('Run',run);
        if(run.state==='running') {run.state='interrupted';run.epoch++;for(const t of run.tasks)if(t.status==='running')t.status='pending';}
        this.runs.set(run.id,run);await this.save(run);
      } catch(error) { console.error(`Не удалось открыть сохранённый запуск ${folder}: ${error.code||'invalid_json'}`); }
    }
  }
  folder(run) {check(/^run_[a-f\d-]+$/.test(run.id),'Неверный ID запуска.');return path.join(this.dir,'runs',run.id);}
  get(runId) { const run=this.runs.get(runId);check(run,'Запуск не найден.','not_found');return run; }
  async create(config,{mode='live',explicit_pair=false,name='Новое сравнение',owner_id=null}={}) {
    check(mode==='live'||(mode==='test'&&config.testMode),'Тестовый provider доступен только при HECTRA_TEST_MODE=1.');
    const run={id:id('run'),owner_id,name:String(name).slice(0,200),version:1,epoch:0,created_at:now(),updated_at:now(),state:'draft',stage:null,current_task:null,
      mode,explicit_pair,settings:publicConfig(config),budgets:{llm_calls:0,technical_retries:0},schema_version:CONTRACT_VERSION,template_version:TEMPLATE_VERSION,
      documents:[],plan:null,plan_history:[],tasks:[],functions:[],org_units:[],extractions:[],findings:[],judge_results:[],reviews:[],clarifications:[],logs:[],lineages:{},
      limitations:mode==='test'?['ТЕСТОВЫЙ ПРОГОН: ответы синтетического provider проверяют программный маршрут, а не качество анализа документов.']:[],errors:[],registry_version:0,report:null,report_history:[],prompt_hashes:null,prompt_snapshot:null,reconcile_key:null};
    this.runs.set(run.id,run); await this.save(run);return run;
  }
  async save(run) {
    validate('Run',run);
    run.updated_at=now(); const serialized=JSON.stringify(run),folder=this.folder(run);
    const next=(this.queues.get(run.id)||Promise.resolve()).catch(()=>{}).then(async()=>{await fs.mkdir(folder,{recursive:true});const tmp=path.join(folder,`run.${id('write')}.tmp`);await fs.writeFile(tmp,serialized,'utf8');await fs.rename(tmp,path.join(folder,'run.json'));});
    this.queues.set(run.id,next);await next;
  }
  async saveOriginal(run,docId,buffer) {const dir=path.join(this.folder(run),'originals');await fs.mkdir(dir,{recursive:true});await fs.writeFile(path.join(dir,docId),buffer,{flag:'wx'});}
  originalPath(run,doc) {return path.join(this.folder(run),'originals',doc.id);}
  async cacheGet(key) {try{return JSON.parse(await fs.readFile(path.join(this.dir,'cache',`${hash(key)}.json`),'utf8'));}catch{return null;}}
  async cachePut(key,value) {const file=path.join(this.dir,'cache',`${hash(key)}.json`),tmp=`${file}.${id('tmp')}.tmp`;await fs.writeFile(tmp,JSON.stringify(value),'utf8');await fs.rename(tmp,file);}
  log(run,event) {const log={id:id('log'),at:now(),...event};run.logs.push(log);return log;}
}
