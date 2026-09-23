// Single schema source for the API, orchestrator and UI. No agent instructions.
export const CONTRACT_VERSION = '1.0.0';
export const TEMPLATE_VERSION = 'task-data-v1';
const str = { type:'string' }, integer = { type:'integer' }, bool = { type:'boolean' };
const en = (...values) => ({ type:'string', enum:values });
const arr = items => ({ type:'array', items });
const obj = properties => ({ type:'object', properties, required:Object.keys(properties), additionalProperties:false });
const nullable = schema => ({ anyOf:[schema, { type:'null' }] });
export const sourceRef = obj({ document_id:str, extraction_version:integer, block_id:str, char_start:nullable(integer), char_end:nullable(integer) });
export const rangeSchema = obj({ document_id:str, extraction_version:integer, start_block_id:str, end_block_id:str });
const refs = arr(sourceRef), ranges = arr(rangeSchema);
const feature = obj({ value:nullable(str), basis:en('explicit','context','unknown'), source_refs:refs });
export const functionSchema = obj({
  id:str, version:integer, responsible:feature, action:feature, object:feature,
  scope:feature, modality:feature, conditions:feature, deadlines:feature,
  exceptions:feature, source_refs:refs, uncertainty:arr(str)
});
export const orgUnitSchema = obj({ id:str, version:integer, name:feature, parent:feature, source_refs:refs, uncertainty:arr(str) });
export const groupSchema = obj({ id:str, label:str, before:ranges, after:ranges,
  relation:en('1:1','1:N','N:1','N:M','remainder'), method:en('explicit_pair','exact','text_similarity','semantic','unmatched'),
  rationale:str, evidence_refs:refs, uncertainty:arr(str)
});
export const routingSchema = obj({ version:integer, groups:arr(groupSchema),
  remainder:arr(obj({ range:rangeSchema, status:en('reviewed_unmatched','unreviewed','unavailable','not_applicable'), reason:str })),
  clarification:nullable(obj({ question:str, reason:str, document_ids:arr(str), on_skip:str })), limitations:arr(str)
});
const scopeRecord = obj({ range:rangeSchema, status:en('considered','not_applicable','unreviewed'), reason:str });
export const categories = ['preserved','transfer','split_merge','authority','scope','modality','deadline','org_change','potential_loss','new_function','potential_duplication','potential_conflict','insufficient_data'];
export const findingSchema = obj({ id:str, version:integer, category:en(...categories), claim:str,
  before_refs:refs, after_refs:refs, function_refs:arr(str), explanation:str,
  significance:en('high','medium','low','unknown'), significance_basis:str,
  uncertainty:arr(str), limitations:arr(str), action:str,
  search_scope:obj({ sides:arr(en('A','B')), document_ids:arr(str), queries:arr(str), limitations:arr(str) })
});
export const comparisonSchema = obj({ task_id:str, task_version:integer, findings:arr(findingSchema),
  function_links:arr(obj({ before_ids:arr(str), after_ids:arr(str), relation:str, evidence_refs:refs, uncertainty:arr(str) })),
  org_links:arr(obj({ before_ids:arr(str), after_ids:arr(str), relation:str, evidence_refs:refs, uncertainty:arr(str) })),
  coverage:arr(scopeRecord), mapping_proposals:arr(groupSchema), revision_response:nullable(str), limitations:arr(str)
});
export const extractionSchema = obj({ functions:arr(functionSchema), org_units:arr(orgUnitSchema), coverage:arr(scopeRecord), limitations:arr(str) });
const issueSchema = obj({ id:str, finding_refs:arr(str), error_type:str,
  target:en('preparation','routing','comparison','crosscheck','uncertainty'),
  evidence_refs:refs, log_refs:arr(str), alternative_causes:arr(str),
  instruction:str, acceptance_condition:str
});
export const judgeSchema = obj({ task_id:str, task_version:integer, result_version:integer,
  verdict:en('passed','needs_revision','inconclusive'), checked_ranges:ranges,
  checked_finding_refs:arr(str), limitations:arr(str), issues:arr(issueSchema),
  resolutions:arr(obj({ finding_refs:arr(str), disposition:en('duplicate','contradiction','compatible','unresolved'), reason:str, evidence_refs:refs }))
});
export const reportSchema = obj({ registry_version:integer,
  overview:arr(obj({ text:str, finding_refs:arr(str) })),
  questions:arr(obj({ text:str, finding_refs:arr(str) })),
  recommendations:arr(obj({ text:str, finding_refs:arr(str) })), limitations:arr(str)
});
export const roleSchemas = { routing:routingSchema, extraction:extractionSchema, comparison:comparisonSchema, crosscheck:comparisonSchema, judge:judgeSchema, synthesis:reportSchema };
export const toolSchemas = {
  list_documents:obj({ side:nullable(en('A','B')) }),
  read_blocks:obj({ document_id:str, extraction_version:integer, start_block_id:str, count:integer, include_context:bool }),
  search_documents:obj({ query:str, side:nullable(en('A','B')), document_ids:nullable(arr(str)), cursor:nullable(str) }),
  read_functions:obj({ ids:nullable(arr(str)), side:nullable(en('A','B')), cursor:nullable(str) }),
  read_task_results:obj({ task_ids:arr(str) })
};
export const toolDescriptions = {
  list_documents:'Каталог документов текущего запуска и качество извлечения.',
  read_blocks:'Блоки сохранённой версии документа, исходный контекст и указатель продолжения.',
  search_documents:'Лексический поиск в текущем запуске. Возвращает ссылки, способ поиска и ограничение выдачи.',
  read_functions:'Актуальные структурированные записи функций текущего запуска с источниками.',
  read_task_results:'Актуальные результаты выбранных задач текущего запуска.'
};
// Storage entities extend the same payload contracts with independent state fields.
export const entityFields = {
  Run:['id','version','documents','settings','budgets','state','limitations','prompt_hashes'],
  Document:['id','side','name','type','file_hash','extraction_version','status','warnings'],
  Block:['id','document_id','extraction_version','order','type','text','normalized','coordinates','context'],
  ComparisonTask:['id','lineage','version','input_hash','before','after','status','dependencies'],
  HumanReview:['id','finding_id','finding_version','decision','text','author','created_at'],
  Clarification:['id','question','answer','status','plan_version','author','created_at']
};
const stored=(properties,required=Object.keys(properties))=>({type:'object',properties,required,additionalProperties:true});
const sourcePayload=schema=>({...schema,additionalProperties:true});
export const blockSchema=stored({id:str,document_id:str,extraction_version:integer,order:integer,type:str,text:str,normalized:str,coordinates:{type:'object'},context:obj({heading_ids:arr(str),parent_ids:arr(str),intro_id:nullable(str),previous_ids:arr(str)})});
export const documentSchema=stored({id:str,side:en('A','B'),name:str,type:str,file_hash:str,extraction_version:integer,parser_version:str,status:en('ok','partial','failed'),warnings:arr(str),blocks:arr(blockSchema),history:arr({type:'object'})});
export const taskSchema=stored({id:str,kind:en('comparison','crosscheck','reconcile'),lineage:arr(str),version:integer,before:ranges,after:ranges,status:en('pending','running','comparing_done','done','stale'),current:bool,dependencies:arr({type:'object'}),result_version:integer});
export const reviewSchema=stored({id:str,finding_id:str,finding_version:integer,decision:en('confirmed','rejected','edited','commented'),text:str,author:str,created_at:str});
export const clarificationSchema=stored({id:str,question:str,reason:str,document_ids:arr(str),on_skip:str,answer:nullable(str),status:en('pending','answered','skipped'),plan_version:integer,author:nullable(str),created_at:str});
export const runSchema=stored({id:str,version:integer,epoch:integer,mode:en('live','test'),name:str,state:en('draft','prompts_not_configured','key_not_configured','running','needs_clarification','cancelled','interrupted','partial','completed','completed_with_limits'),settings:{type:'object'},budgets:{type:'object'},documents:arr(documentSchema),tasks:arr(taskSchema),functions:arr(sourcePayload(functionSchema)),org_units:arr(sourcePayload(orgUnitSchema)),findings:arr(sourcePayload(findingSchema)),judge_results:arr(sourcePayload(judgeSchema)),reviews:arr(reviewSchema),clarifications:arr(clarificationSchema),report:nullable(sourcePayload(reportSchema)),limitations:arr(str),registry_version:integer,prompt_hashes:nullable({type:'object'}),logs:arr({type:'object'})});
export const labels = {
  coverage:{total:'Всего блоков',extracted:'Извлечён текст',overview:'Включено в обзор',tool_read:'Прочитано инструментом',assigned:'Назначено задачам',function_extracted:'Обработано извлечением функций',compared:'Учтено сравнением',judge_checked:'Область проверки judge',comparison_judge_checked:'Локальная проверка сравнения',crosscheck_checked:'Общая проверка реестра Б',not_applicable:'Неприменимо с основанием',unavailable:'Недоступен текст',unchecked:'Не проверено judge',incomplete_comparison:'Не завершено сравнение и его проверка',incomplete_B_extraction:'Не завершено извлечение функций Б'},
  states:{ draft:'Загрузка документов', prompts_not_configured:'Системные промпты ещё не заполнены', key_not_configured:'Не настроен API-ключ', running:'Выполняется', needs_clarification:'Ожидается пояснение', cancelled:'Остановлено', interrupted:'Прервано перезапуском сервера', partial:'Обработка не завершена', completed:'Завершено', completed_with_limits:'Завершено с ограничениями' },
  stages:{ routing:'Карта соответствий', extraction:'Извлечение функций', comparison:'Сравнение', judge:'Проверка выводов', crosscheck:'Общая проверка', reconcile:'Сверка реестра', synthesis:'Заключение' },
  categories:{ preserved:'Сохранение', transfer:'Перенос', split_merge:'Разделение / объединение', authority:'Полномочия', scope:'Область ответственности', modality:'Обязательность / запрет', deadline:'Сроки', org_change:'Структура подразделений', potential_loss:'Возможная потеря', new_function:'Новая функция', potential_duplication:'Возможное дублирование', potential_conflict:'Возможный конфликт', insufficient_data:'Недостаточно данных' },
  verdicts:{ unreviewed:'Не проверено', passed:'Проверено в указанной области', needs_revision:'Требует исправления', inconclusive:'Недостаточно оснований' },
  changes:{ equal:'Буквальное совпадение', normalized:'Совпадение после нормализации', modified:'Изменено', added:'Добавлено', removed:'Удалено', moved:'Кандидат на перемещение', context_changed:'Изменился контекст' }
};
