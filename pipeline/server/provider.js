import OpenAI from 'openai';
import { setTimeout as delay } from 'node:timers/promises';
import { roleSchemas, TEMPLATE_VERSION } from '../shared/contracts.js';
import { instructions } from './prompts.js';
import { toolsForRole, makeTools } from './tools.js';
import { validate, validateRefs } from './validate.js';
import { hash, id, AppError, check } from './util.js';
export function safeError(error,apiKey='') {
  let message=String(error.message||error);
  if(apiKey)message=message.split(apiKey).join('[ключ скрыт]');
  return message.replace(/sk-[A-Za-z0-9_-]+/g,'[ключ скрыт]').slice(0,1500);
}
export class RoleClient {
  constructor(store,config,{transport=null,testProvider=null}={}) {Object.assign(this,{store,config,transport,testProvider});}
  async call(run,role,data,{signal,guard=()=>true,validateOutput=()=>{}}={}) {
    const snapshot=run.prompt_snapshot,b=run.settings.budgets;
    if(run.mode!=='test') {
      check(snapshot?.texts[role]?.trim(),'Системные промпты ещё не заполнены.','prompts_not_configured');
      check(this.config.apiKey,'Вставьте API-ключ в server-config.local.cjs или OPENAI_API_KEY.','key_not_configured');
    } else check(this.config.testMode&&this.testProvider,'Тестовый provider не включён.');
    const model=run.settings.modelByRole[role]||run.settings.model,effort=run.settings.effortByRole[role];
    const cacheKey=hash({run:run.id,role,mode:run.mode,model,effort,prompts:run.prompt_hashes,template:TEMPLATE_VERSION,data,documents:run.documents.map(d=>[d.id,d.file_hash,d.extraction_version]),clarifications:run.clarifications});
    const cached=await this.store.cacheGet(`role:${cacheKey}`);
    if(cached) {check(guard(),'Ответ устарел.','stale_response');validate(role,cached.result);validateRefs(run,cached.result);validateOutput(cached.result);this.store.log(run,{type:'role_cache',role,model,effort,cache_key:cacheKey,source_call:cached.call_id,input_versions:data.versions||null});return structuredClone(cached.result);}
    const call_id=id('call'),meta={role,model,effort,role_call_id:call_id,task_id:data.task_id||null,task_version:data.task_version||null},start=Date.now(),execute=makeTools(run,this.store,meta);
    const userData={template_version:TEMPLATE_VERSION,...data};
    let input=[{role:'user',content:JSON.stringify(userData)}],result;
    const sdk=this.transport|| (run.mode==='live'?new OpenAI({apiKey:this.config.apiKey,maxRetries:0,timeout:b.timeoutMs}).responses:null);
    try {
      if(run.mode==='test') {
        check(JSON.stringify(userData).length<=b.inputChars,'Исчерпан бюджет входного контекста.','context_budget');
        this.consume(run);await this.store.save(run);
        result=await this.testProvider({role,data:userData,run,execute,signal});
        validate(role,result);
      } else {
        for(let round=0;round<=b.toolRounds;round++) {
          check(!signal?.aborted&&guard(),'Вызов отменён или его входы устарели.','stale_response');
          const instructionText=instructions(snapshot,role);
          check(JSON.stringify(input).length+instructionText.length<=b.inputChars,'Исчерпан бюджет входного контекста. Уменьшите задачу или увеличьте inputChars.','context_budget');
          const request={model,reasoning:{effort},instructions:instructionText,input,tools:toolsForRole(role),parallel_tool_calls:false,store:false,include:['reasoning.encrypted_content'],max_output_tokens:b.outputTokens,text:{format:{type:'json_schema',name:`hectra_${role}`,strict:true,schema:roleSchemas[role]}}};
          let response;
          for(let attempt=0;attempt<=b.transientRetries;attempt++) {
            this.consume(run);await this.store.save(run);
            try {response=await sdk.create(request,{signal:AbortSignal.any([...(signal?[signal]:[]),AbortSignal.timeout(b.timeoutMs)])});break;}
            catch(e) {
              const retryable=e.status===429||e.status>=500||['APIConnectionError','APIConnectionTimeoutError'].includes(e.name);
              this.store.log(run,{type:'api_error',...meta,round,attempt,status:e.status||null,error:safeError(e,this.config.apiKey)});
              if(!retryable||attempt===b.transientRetries||signal?.aborted)throw new AppError('api_error',safeError(e,this.config.apiKey),502);
              run.budgets.technical_retries++;
              const header=e.headers?.get?.('retry-after'),seconds=header?Number(header):NaN;
              const wait=header?(Number.isFinite(seconds)?seconds*1000:Math.max(0,Date.parse(header)-Date.now())):1000*2**attempt;
              if(wait>b.timeoutMs)throw new AppError('retry_after_limit','Провайдер просит ожидать дольше бюджета запроса. Повторите запуск позже.',429);
              await delay(Math.max(0,wait),undefined,{signal});
            }
          }
          check(guard(),'Ответ на устаревшие входы не принят.','stale_response');
          this.store.log(run,{type:'api_response',...meta,round,response_id:response.id,status:response.status,usage:response.usage||null});
          if(response.status==='incomplete')throw new AppError('incomplete_response',`Неполный ответ: ${response.incomplete_details?.reason||'причина не указана'}`,502);
          if(response.status!=='completed')throw new AppError('response_failed',`Ответ не завершён: ${response.status}`,502);
          if(response.output?.some(i=>i.type==='message'&&i.content?.some(c=>c.type==='refusal')))throw new AppError('model_refusal','Модель отказалась выполнять запрос.',422);
          const calls=(response.output||[]).filter(i=>i.type==='function_call');
          if(calls.length) {
            check(round<b.toolRounds,'Исчерпан бюджет раундов инструментов.','tool_budget');
            input.push(...response.output); // Includes opaque reasoning items for this role only; never persisted or rendered.
            for(const call of calls) {
              let output;
              try {output=await execute(call.name,JSON.parse(call.arguments),call.call_id);}catch{output={error:'invalid_arguments',message:'Аргументы инструмента должны быть JSON.'};}
              input.push({type:'function_call_output',call_id:call.call_id,output:JSON.stringify(output)});
            }
            continue;
          }
          const text=response.output_text??(response.output||[]).filter(i=>i.type==='message').flatMap(i=>i.content||[]).filter(c=>c.type==='output_text').map(c=>c.text).join('');
          try{result=JSON.parse(text);}catch{throw new AppError('invalid_structure','Ответ модели не является JSON.',422);}
          validate(role,result);break;
        }
      }
      check(guard()&&!signal?.aborted,'Ответ на устаревшие входы не принят.','stale_response');
      validateRefs(run,result);
      validateOutput(result);
      this.store.log(run,{type:'role_complete',...meta,input_versions:data.versions||null,cache_key:cacheKey,prompt_hashes:{common:run.prompt_hashes?.common,[role]:run.prompt_hashes?.[role]},duration_ms:Date.now()-start});
      await this.store.cachePut(`role:${cacheKey}`,{result,call_id});await this.store.save(run);return result;
    } catch(e) {
      this.store.log(run,{type:'role_error',...meta,code:e.code||'role_error',error:safeError(e,this.config.apiKey),duration_ms:Date.now()-start});await this.store.save(run);throw e;
    }
  }
  consume(run) {if(run.budgets.llm_calls>=run.settings.budgets.llmCalls)throw new AppError('llm_budget','Исчерпан общий бюджет LLM-вызовов. Доступен частичный реестр.');run.budgets.llm_calls++;}
}
