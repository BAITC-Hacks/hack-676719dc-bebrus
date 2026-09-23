# Hectra for editors — техническая документация

Актуально на 2026-08-19. Область документа — только текущая директория `Hectra_for_editors`.
Источник истины — фактический код, разметка и воспроизводимые тесты этой директории.

Статусы в документе:

- **IMPLEMENTED** — существует в runtime и подтверждается кодом;
- **AUXILIARY** — относится к локальным фильмам, диагностике или инструментам, но не входит в product runtime;
- **NOT IMPLEMENTED** — явно обозначенная граница текущей реализации.

Контрольное состояние на дату актуализации:

- Node.js `v20.19.0`;
- `npm test`: **127/127 passed**;
- `node --check`: **41/41** JS-источников продукта, тестов и film tooling;
- `diagnostics/browser-qa.js` проходит в headless Chrome;
- пригодной Git-истории нет: `.git` существует, но пуст, поэтому соответствие проверяется по рабочему дереву.

---

## 1. Назначение и продуктовая модель

Hectra for editors — локальный одностраничный workspace, где ответ модели представлен не только
лентой сообщений, а живым Markdown-документом из адресуемых секций. Пользователь может создавать
документ, редактировать выбранные секции, менять структуру, хранить версии, исследовать разные
направления в ветках и объединять их.

Поверх документной модели работает branch graph:

- активная ветка является live-состоянием документа и разговора;
- неактивные ветки хранят собственные треки;
- append-only action log фиксирует постоянные действия workspace;
- Map показывает реальные branch nodes;
- sibling merge использует BASE/TARGET/SOURCE;
- merge с предком схлопывает границу между последовательными отрезками работы.

Базовый UI-принцип — **Document first, complexity on demand**. Целевая пользовательская модель
состоит из четырёх понятий: **Document** (основной продукт), **Change** (изменение документа),
**Alternative** (branch как альтернативное продолжение) и **Review** (проверка небезопасных
изменений). Conversation/composer является способом давать инструкции документу, а не отдельным
главным продуктом. В обычном document view возле
каждой секции нет постоянных структурных кнопок. Контролы появляются через выделение, меню,
review modal или специальный режим `Reorder, add or remove sections`.

Канонический visible словарь первого UX patch:

| Объект действия | Visible label |
| --- | --- |
| предыдущий user prompt | `Revise request` / `Revising request` |
| одна section | `Change section` / `Changing section: <title>` |
| несколько sections | `Change sections` / `Changing N sections` |
| весь document | `Change whole document` / `Changing whole document` |
| structure draft | `Reorder, add or remove sections` |
| model proposal membership | `Include` / `Exclude` |
| final proposal commit | `Apply included changes` |
| staged reverse commit | `Revert applied change` |
| sibling document merge | `Merge alternatives` |
| ancestor collapse/adopt | `Continue as one branch` |

Welcome и first-edit explanation прямо сообщают: selected text помогает сформулировать request,
но авторизованной write boundary является вся затронутая section (или явно выбранный набор
sections). Normal composer использует `Tell Hectra what to write or change…`.

## 2. Технологический стек и состав директории

### 2.1 Runtime

- `workspace.html` — основной product UI;
- `index.html` — стартовая страница;
- vanilla JavaScript через обычные `<script>`, без bundler и UI framework;
- `css/workspace.css` и `css/workspace-branches.css`;
- `server.js` — `node:http` static server и proxy к OpenAI-compatible xAI endpoint;
- Markdown document protocol сохраняется текстовым и не заменён JSON-протоколом;
- локальное состояние хранится через Web Storage abstraction;
- автоматические тесты используют встроенный `node:test`.

Порядок загрузки скриптов существенен: чистые data-модули загружаются раньше `state.js`, а UI —
после state и renderer. В частности, `actionLog.js`, `mergeEngine.js` и `editEngine.js` доступны до
`state.js`; `structureAssistant.js` загружается до `app.js`; `temporaryChat.js` — до `mapUI.js`;
`editReviewUI.js` — до `app.js`.

### 2.2 Каталоги

| Путь | Назначение |
| --- | --- |
| `js/` | 21 runtime-модуль продукта и demo-модуль |
| `css/` | базовые стили workspace и стили branch/edit/map UI |
| `tests/` | 11 файлов Node regression tests |
| `diagnostics/` | воспроизводимый browser smoke и исторические QA-артефакты |
| `films/` | сценарии, монтажи, Remotion/CDP-инструменты и записи продукта |
| `server.js` | static server, API proxy, token accounting |
| `workspace.html` | основная разметка приложения |
| `package.json` | команды запуска, тестов и film rendering |

`films/` и большая часть `diagnostics/` — **AUXILIARY**: они находятся в этой директории и могут
встраивать настоящий workspace, но их реконструированные сцены и изображения не являются
доказательством наличия соответствующей runtime-функции.

## 3. Модули JavaScript

| Файл | Ответственность |
| --- | --- |
| `js/config.js` | endpoints, model routing и system prompts |
| `js/security.js` | лимиты, sanitization, safe URL/data URL и storage abstraction |
| `js/actionLog.js` | action records, валидация журнала и `computeDocumentDelta()` |
| `js/mergeEngine.js` | чистый three-way merge planner/materializer |
| `js/editEngine.js` | чистый staged edit engine и structural invariants |
| `js/structureAssistant.js` | чистая сборка и валидация per-section AI suggestion для structure draft |
| `js/state.js` | каноническое live-состояние, версии, branches, persistence и write boundary |
| `js/mdParser.js` | Markdown response/patch → sections, DELETE и duplicate ids |
| `js/marked-fallback.js` | fallback Markdown renderer при недоступности CDN |
| `js/renderer.js` | сообщения, секции, diff, changelog и version bar |
| `js/uiKit.js` | popover, confirm и UI helpers |
| `js/branchUI.js` | sidebar, branch/document menus и composer context |
| `js/selectionUI.js` | DOM selection → ordered section ids → floating toolbar |
| `js/historyUI.js` | внутренний read/restore UI для content history |
| `js/mapUI.js` | branch Map, source selection и temporary-chat drawer |
| `js/mergeUI.js` | sibling merge preview, resolution, Combine и apply |
| `js/editReviewUI.js` | proposal review, batch decisions, structure draft и Undo toast |
| `js/temporaryChat.js` | изолированная in-memory single-branch Q&A session |
| `js/workspaceHeader.js` | верхняя панель workspace/branch, Map и Merge |
| `js/app.js` | DOM events, model calls, attachments и orchestration пользовательских потоков |
| `js/film-demo.js` | query-guarded deterministic states для локальной съёмки |

Архитектурная граница: UI-модули могут хранить только view-state. Канонические branch/document
данные находятся в `HectraState`; чистые engines не обращаются к DOM, API или storage.

## 4. Каноническая документная модель

### 4.1 Live document

```js
documentSections: Map<sectionId, section>
sectionOrder: string[]

section = {
  id,
  title,
  content,
  position
}
```

`position` используется входным patch-протоколом и имеет форму
`null | { type: "before" | "after" | "start" | "end", ref }`. После materialization порядок
канонически хранится в `sectionOrder`, а committed sections получают `position: null`.

Snapshot:

```js
{
  sections: [{ id, title, content, position }],
  order: [sectionId],
  changelogs: []
}
```

Инварианты:

- section id непустой и уникальный;
- `order` не содержит повторов;
- множество ids в `sections` и `order` совпадает;
- у insert/move должен быть разрешимый position marker;
- anchor должен существовать в materialized subset;
- section не может ссылаться на себя;
- невалидная комбинация не мутирует live state частично.

### 4.2 Markdown-протокол модели

```md
## Title [#id]
Content

## Title [#id] @after existing_id
## Title [#id] @before existing_id
## Title [#id] @start
## Title [#id] @end
## [#id] DELETE
```

`parseMdResponse(raw)` возвращает `{ sections, deletedIds, duplicateIds }`. Явные duplicate ids
не переименовываются молча: parser сохраняет их так, чтобы edit engine классифицировал proposal
как `invalid`. Ответ без section headings заворачивается в fallback-section `response`.

Section id — общая структурная единица edit scope, document delta, provenance и merge.

### 4.3 Conversation и UI state

`HectraState` разделяет:

- `chatHistory` — model-facing conversation;
- `uiMessages` — сообщения, attachments, versions, changelogs и display state;
- `documentSections` / `sectionOrder` — текущий документ активной ветки;
- `actions` — append-only workspace log.

Assistant entry в основном `chatHistory` синхронизируется с текущим Markdown snapshot документа,
а не остаётся raw provider output. `_normalizeChatHistoryForModel()` удаляет устаревшие встроенные
changelog-блоки из legacy sessions.

## 5. Workspace, branches и tracks

### 5.1 Workspace и session

- `workspaceId` определяет область action sequence и workspace action log;
- `sessionId` (`sess_<timestamp>`) определяет запись, показываемую в sidebar как workspace;
- новый chat сбрасывает branch/document session, но не переиспользует workspace `actionSeq`;
- верхняя панель показывает workspace, активную branch, Map и доступные Merge actions.

### 5.2 Branch data

```js
Branch {
  id,
  name,
  parentBranchId,
  forkActionSeq,
  forkSectionId,
  forkSectionIds,
  forkMessageIndex,
  createdAtMs,
  status,
  priority,
  mergedIntoBranchId,
  mergedAtMs,
  deletedAtMs
}
```

`status`: `open | merged | archived | deleted`.

Runtime использует подмену track:

- активная ветка и есть live `chatHistory`, `uiMessages`, document map/order;
- `branchTracks[branchId]` содержит состояния неактивных веток;
- `branchBases[branchId]` содержит frozen BASE в точке fork;
- `branchNotes[branchId]` содержит одноразовую заметку о результате sibling merge.

`switchBranch()` сохраняет live track текущей ветки и разворачивает только существующий target
track. Он не создаёт отсутствующее состояние. Deleted branch открыть нельзя.

`createBranch()` поддерживает fork от текущей головы, от конкретного message index и от выбранных
section ids. Fork от сообщения сохраняет то состояние документа/version, которое пользователь
видел в этой точке.

Навигация, уничтожающая composer context, проходит через `guardComposerNavigation()` в `app.js`.
Draft считается dirty при непустом textarea или attachment; сюда естественно входят введённые
инструкции section/whole-document change и загруженный текст при `Revise request`. Guard вызывают
branch switch, Map `Open branch`, workspace/session switch, создание обычной новой alternative и
`New`. `Stay here` сохраняет branch, mode, текст и attachments; подтверждение очищает textarea,
attachments, section focus и request-revision mode, затем выполняет исходный переход. Per-branch
draft persistence не добавлена.

### 5.3 Write rule для branch graph

Писать можно только в leaf node. Как только от branch появился живой ребёнок, документ этой branch
становится BASE для descendants и `canWriteToBranch()` возвращает `has-branches`. `handleSend()`
проверяет это до очистки composer и переносит новую инструкцию в свежую branch. Notice заранее
говорит `This branch already has alternatives. Sending will continue in a new branch.` Этот путь
вызывает существующий `createBranch()` с navigation-guard bypass, потому что введённая инструкция
не отбрасывается, а отправляется в созданную child branch; после перехода показывается
`Continued in a new branch`.

`getChildBranches()` считает только `open` children; merged, archived и deleted children не держат
узел закрытым. После схлопывания descendants узел снова может стать writable.

### 5.4 Delete и archive

- root/main удалить нельзя;
- branch с живыми или архивными descendants удалить нельзя без отдельного reparent-механизма;
- `deleteBranch()` выполняет soft delete, сохраняет track/base/log и пишет `BRANCH_DELETED`;
- удаление активной ветки сначала переводит UI на допустимого предка;
- `archiveBranch()` и отказ от альтернатив при collapse используют `archived`, а не физическое удаление;
- UI восстановления archived/deleted branches отсутствует.

## 6. Append-only action log

```js
ActionRecord {
  actionSeq,
  workspaceId,
  type,
  createdAtMs,
  parentActionSeq,
  branchId,
  sessionId,
  payload,
  schemaVersion
}
```

`actionSeq` — общий для workspace signed 32-bit INTEGER `1..2147483647`. Он монотонен,
не переиспользуется и не вычисляется отдельно на branch/session. `parentActionSeq` хранит
причинность явно и не равен автоматически `actionSeq - 1`.

Типы:

- conversation: `USER_MESSAGE`, `AI_MESSAGE`, `USER_MESSAGE_EDITED`,
  `MESSAGE_PAIR_DELETED`, `ASSISTANT_MESSAGE_DISCARDED`;
- document: `DOCUMENT_CREATED`, `DOCUMENT_EDIT_PROPOSED`, `DOCUMENT_EDIT_APPLIED`;
- versions: `VERSION_ACCEPTED`, `VERSION_REJECTED`, `VERSION_RESTORED`;
- branches: `BRANCH_CREATED`, `BRANCH_SWITCHED`, `BRANCH_RENAMED`,
  `BRANCH_DISCARDED`, `BRANCH_DELETED`, `BRANCH_COLLAPSED`;
- merge: `MERGE_STARTED`, `MERGE_CONFLICT`, `MERGE_COMPLETED`, `BRANCH_MERGED`.

Action log и content History — разные представления. `CONTENT_ACTION_TYPES` включает только
реальные изменения document state: `DOCUMENT_CREATED`, `DOCUMENT_EDIT_APPLIED`,
`VERSION_RESTORED`, `VERSION_REJECTED`, `MESSAGE_PAIR_DELETED`,
`ASSISTANT_MESSAGE_DISCARDED`, `MERGE_COMPLETED`.

`DOCUMENT_EDIT_PROPOSED` не является content action: proposal может быть полностью отклонён и не
обязан иметь последующий `DOCUMENT_EDIT_APPLIED`. Append-only означает, что restore, reject,
delete, collapse и merge добавляют записи, не переписывая старые.

`normalizeLog()` изолирует некорректные records (`invalid_action`, `duplicate_action_seq`,
`workspace_mismatch`, `log_out_of_order`) без уничтожения документа. Диагностика доступна через
`HectraDebug.history()`, `.actions()`, `.branch()` и `.issues()`.

## 7. Section-scoped staged edit pipeline

### 7.1 Frozen request context

При отправке edit-запроса `HectraState.createEditRequestContext()` создаёт deep-cloned и
deep-frozen context до model call:

```js
{
  requestId,
  branchId,
  targetMessageIndex,
  targetSectionIds,
  selectedText,
  baseSnapshot,
  capturedAtMs
}
```

Для section edit ids копируются из `HectraBranchUI.sectionFocus`; для whole-document edit — из
текущего `sectionOrder`. Prompt и authorization используют frozen context. Последующая смена DOM
selection, UI focus или active branch не переписывает уже отправленный scope.

Selection flow:

1. `selectionUI.js` находит все `.ai-section`, пересечённые непустым DOM Range;
2. ids дедуплицируются в document order;
3. `Change section(s)` записывает ids и selected fragment в `sectionFocus`;
4. `scopeInstructionToSection()` добавляет section ids/titles и до 240 символов fragment в user instruction;
5. `doEdit()` отправляет `EDIT_SYSTEM_PROMPT`, последние пять conversation pairs и новую instruction.

### 7.2 Pure edit engine

`js/editEngine.js` не обращается к DOM, `HectraState`, model provider или storage. Он:

1. получает frozen base, parsed Markdown и context;
2. нормализует proposal в одну review operation на section;
3. строит candidate только на копии base;
4. вычисляет delta через `computeDocumentDelta()`;
5. проверяет ids, order, anchors и комбинационные зависимости;
6. materializes явно принятое subset.

Preview и commit используют один lower-level путь `applyOperations()` / `applyOne()`. Commit не
имеет альтернативной DOM-side или state-side логики применения операций.

Операция содержит `operationId`, `sectionId`, `kinds`, `before`, `after`, placement,
`positionBefore`, `positionAfter`, `authorization`, `decision` и `reason`. Update + move одной
section остаются одной комбинированной operation.

### 7.3 Authorization

| Предложение модели | Authorization |
| --- | --- |
| Content update section из frozen `targetSectionIds` | `scoped` |
| Content update вне frozen scope | `requires-approval` |
| Insert | `requires-approval` |
| Delete | `requires-approval` |
| Move/reorder | `requires-approval` |
| Duplicate id, missing target, invalid/self/broken anchor, невозможный порядок | `invalid` |

`invalid` нельзя materialize даже при прямой попытке передать operation id. Для
`requires-approval` `materializeProposal()` требует `explicitApproval: true`. Renderer только
показывает статус; hard write boundary находится в `HectraState.commitEditProposal()`.

### 7.4 Proposal lifecycle и atomic commit

Model flow:

1. `doEdit()` получает raw response;
2. `parseMdResponse()` создаёт parsed patch;
3. `HectraState.createEditProposal()` вызывает engine;
4. state сохраняет `pendingEditProposal` только в памяти;
5. создаётся `DOCUMENT_EDIT_PROPOSED` на frozen `branchId`;
6. live document, `chatHistory`, `uiMessages`, versions и assistant snapshot не меняются;
7. safe proposal auto-applies, остальные открывают review.

Перед commit state:

1. требует `proposal.status === "pending"`;
2. сравнивает active `branchId` с frozen branch;
3. сравнивает current snapshot с base через `computeDocumentDelta()`;
4. materializes полный accepted subset;
5. валидирует итоговые structural invariants;
6. только затем одним mutation block заменяет map/order, синхронизирует assistant history и
   добавляет ровно одну version.

Stale proposal получает `status: "stale"`; silent rebase отсутствует. Невалидный subset не
оставляет частичного результата. Пустой/full-reject subset удаляет pending proposal без version,
`DOCUMENT_EDIT_APPLIED` и `VERSION_REJECTED`.

Успешный commit пишет `DOCUMENT_EDIT_APPLIED.payload` с request id, initial scope, origin,
решениями по всем операциям, version indices и фактической structured delta. Для model proposal
`parentActionSeq` указывает на соответствующий `DOCUMENT_EDIT_PROPOSED`.

### 7.5 Review UI

`editReviewUI.js` показывает по одной карточке на affected section. Карточки управляют только
включением операции в будущий batch и сами не выполняют commit:

- operation kinds и section;
- Before/After, где применимо;
- scoped update: `Within selected sections`, включён по умолчанию;
- out-of-scope update: `Outside selected sections`, исключён по умолчанию;
- insert/delete/move: `Changes document structure`, исключён по умолчанию;
- invalid: `Cannot apply` и конкретная причина, без доступного Include;
- per-operation controls: `Include` и `Exclude`.

Secondary batch controls — `Include all reviewable`, `Exclude all` и `Discard proposal`.
`Include all reviewable` не включает invalid и не делает implicit commit. Единственный final
primary action — `Apply included changes`; он disabled для пустого subset. Inclusion операции с
`requires-approval` передаёт её id в существующий commit boundary как explicit approval; renderer
не расширяет write scope самостоятельно. Version создаётся один раз на весь included subset.
Escape использует тот же discard flow и не применяет proposal; pending animation frame открытия
отменяется, чтобы review не мог визуально открыться повторно после быстрого Escape.

### 7.6 Auto-apply и Undo

`canAutoApply()` возвращает true только когда каждая operation:

- valid;
- имеет `authorization === "scoped"`;
- является только `update`;
- принадлежит frozen target ids;
- не содержит insert/delete/move.

State всё равно проверяет freshness перед записью. После commit UI показывает примерно на пять
секунд toast `All scoped changes applied`, countdown и кнопку `Revert applied change`.

Undo хранит один последний in-memory token `{ beforeSnapshot, afterSnapshot, branchId, scope }`.
`undoLastEdit()` убеждается, что branch и post-commit snapshot не изменились, строит reverse
proposal тем же engine и сохраняет восстановление как новую version с `origin: "undo"`. История
и прежние versions не уничтожаются.

### 7.7 Compatibility wrapper

`HectraState.applyEdit()` оставлен для legacy internal callers и regression tests. Он сам проходит
context → proposal → validated commit. Новый model edit flow в `app.js` напрямую его не вызывает.

## 8. Manual structure change

Точка входа: `Document … → Reorder, add or remove sections`. Обычный document view остаётся чистым.

В structure modal доступны:

- drag-and-drop;
- Move up / Move down как доступная click/keyboard альтернатива;
- Add before / Add after;
- `Draft section with agent` только для новой или фактически пустой section;
- Delete;
- `Undo last draft action`;
- `Apply structure changes`;
- Cancel.

UI держит только working snapshot и local undo stack. Каждая команда проходит через
`HectraEditEngine.applyManualCommand()`. `Apply structure changes` строит normalized proposal между frozen
base и draft через `createProposalFromCandidate()` и делает один atomic commit с
`origin: "manual-structure"`.

Сами add/delete/move не вызывают модель; `Draft section with agent` — отдельный опциональный model call внутри
unsaved draft. Новая section получает локально уникальный id,
заголовок `New section` и пустое content. После Add before/after автоматически открывается
мини-панель инструкции, поэтому можно сразу написать, например: «Сделай новую секцию выводом».

Per-section agent flow:

1. действие показывается только у новой или section с пустым `content`; заполненная существующая
   section переписывается после сохранения структуры через обычный `Change section`;
2. пользователь задаёт инструкцию в панели `Describe this section`;
3. `structureAssistant.js` собирает request из target id, инструкции и полного unsaved draft;
4. edit model обязан вернуть ровно одну полную section с тем же id, без DELETE/position/других sections;
5. UI показывает отдельный preview `Agent suggestion · not used yet`;
6. `Use in draft` применяет content/title только к local draft через `applyManualCommand(update)`;
7. `Discard suggestion` закрывает preview без draft mutation;
8. окончательная запись происходит только при общем `Apply structure changes` тем же atomic batch.

Discard/Close не меняют draft; Cancel не меняет live document. Late response после закрытия
панели игнорируется по локальному request id. Промежуточный agent transcript и suggestion не
пишутся в action log или storage. Прямого ручного textarea-редактора полного content в modal нет.

## 9. Map и temporary single-branch chat

### 9.1 Map

Map показывает branch nodes, а не messages. Topology поступает из `getBranchTree()`. Merged nodes
не видимы; archived отображаются только при `Show archived`; deleted не являются доступным source.
Карта поддерживает pan мышью, wheel/keyboard navigation, recenter и ограничение области. Zoom нет.

Map остаётся картой alternatives и навигацией; temporary Q&A является вторичным read-only
действием. Роли active document, selected node и frozen question source не объединены:

- без selection виден mini-placeholder `Select a highlighted branch…`, а доступные nodes получают
  selection highlight;
- single click или Enter/Space только выбирает node и не переключает active branch;
- contextual action bar показывает `Selected branch: <name>`, primary `Open branch` и secondary
  `Ask about snapshot`;
- active node имеет текстовый badge `CURRENT`, selected node — `SELECTED`, source открытого drawer —
  `QUESTION SOURCE`; роли могут одновременно относиться к разным nodes;
- `Open branch` вызывает обычный guard + `switchBranch()` flow; для active node control показывает
  `Currently open` и disabled;
- `Ask about snapshot` disabled с пояснением `No document snapshot available`, если last block нет;
- Q&A фиксирует выбранный node как frozen source, не переключая active branch;
- double click оставлен только shortcut для открытия document, но не является единственным путём;
- source уже открытой temporary session не меняется при последующем Map selection.

### 9.2 Read-only last block helper

`HectraState.getBranchLastContentBlock(branchId)`:

- для active branch читает live `uiMessages`;
- для inactive branch читает только существующий `branchTracks[branchId]`;
- не вызывает `switchBranch()` и не создаёт track;
- отклоняет missing, deleted и merged branch;
- идёт с конца к последнему meaningful assistant document block;
- берёт current visible version (`versions[currentVersionIndex]`, fallback — `displaySections`);
- возвращает detached deep clone `{ type, messageIndex, sections, order, markdown }`.

Предыдущие messages, полный `chatHistory`, parent/sibling tracks и `branchNotes` не включаются.

### 9.3 Temporary session

`temporaryChat.js` создаёт ровно одну in-memory session:

```js
{
  sessionId,
  sourceBranchId,
  sourceBranchName,
  sourceBlock,
  capturedAtMs,
  messages: [],
  status,
  error
}
```

`sourceBlock` deep-frozen при открытии. Изменение source branch после capture не меняет контекст
уже открытой session.

Каждый model request содержит:

1. отдельный `TEMPORARY_CHAT_SYSTEM_PROMPT`;
2. тот же frozen source block;
3. до пяти завершённых temporary Q&A pairs;
4. новый вопрос.

Ответ — свободный Q&A text. Он не проходит через `parseMdResponse()`, edit engine или version flow.
В случае error вопрос остаётся в session и доступен `Retry`. Late response после закрытия
игнорируется по `sessionId`.

### 9.4 Isolation и lifecycle

Temporary chat не меняет и не попадает в:

- `documentSections` / `sectionOrder`;
- основной `chatHistory` и document `uiMessages`;
- versions;
- branch tracks, bases или notes;
- merge context;
- edit `targetSectionIds` и write authorization;
- session/workspace serialization;
- permanent action log.

Session уничтожается при Reset, Close, скрытии Map, New chat, workspace/session switch и reload.
На desktop drawer занимает правую полосу и плавно сужает `map-stage`; до 760 px используется
responsive overlay.

## 10. Versions, diff и внутренний History

Assistant message хранит:

```js
{
  versions: [snapshot],
  currentVersionIndex,
  changelogs,
  modelChangelogs,
  displaySections
}
```

`computeDocumentDelta(before, after)` возвращает changed/inserted/deleted/moved sections,
`orderBefore`, `orderAfter`, `touchedSectionIds` и `hasChanges`. Это общий источник для edit audit,
version diff, divergence и merge planning.

Существуют `restoreVersion()`, `acceptVersion()` и `rejectVersion()`. Staged Undo является
отдельным безопасным reverse commit и не вызывает `acceptVersion()`.

Visible labels описывают фактические side effects, не меняя version semantics:

- previous/next arrows: `Switch document to previous version` / `Switch document to next version`;
  оба вызывают `restoreVersion()` и меняют live document, а не read-only preview;
- `Keep this version only` вызывает прежний `acceptVersion()` и удаляет остальные snapshots;
- `Discard latest version` вызывает прежний `rejectVersion()`, удаляет последний snapshot и
  восстанавливает предыдущий document state.

History — внутренний инструмент, а не основной product surface. Входы:

- `Ctrl + Alt + Shift + H`;
- `HectraHistoryUI.open()` из console, опционально с branch/section filter.

В обычных меню и top bar кнопки History нет; это закреплено тестом. Панель показывает только
`CONTENT_ACTION_TYPES`, умеет фильтровать по branch/section, preview snapshot и restore доступного
state через append-only `VERSION_RESTORED`.

## 11. Merge architecture

### 11.1 Sibling merge

Sibling leaves с общим parent имеют общую BASE и могут пройти настоящий three-way merge:

- **BASE** — `branchBases[sourceId]`;
- **TARGET** — текущее состояние surviving sibling;
- **SOURCE** — состояние вливаемой sibling branch.

`planMerge()` использует чистый `mergeEngine.js`; `analyzeMerge()` является сводкой того же плана.
Классификация обрабатывает one-sided/identical changes, разные sections, replace conflicts,
insert/delete и order conflicts. Пока конфликт не решён, `plan.canApply === false` и result не
строится.

Пользовательская sibling-операция называется `Merge alternatives`. `Combine` — единственный model
call внутри merge UI. Модель получает ORIGINAL/CURRENT/BRANCH одной section и
`MERGE_COMBINE_SYSTEM_PROMPT`. Результат — только reviewable suggestion; `Use combined text`
выбирает его для merge plan, `Discard combination` отбрасывает, а единственный финальный commit
по-прежнему называется `Apply merge`.

`applyMerge()`:

1. проверяет plan/result и отсутствие descendants у source;
2. переключается на target без отдельного switch action;
3. пишет `MERGE_STARTED` и при необходимости `MERGE_CONFLICT`;
4. создаёт новую document version target;
5. пишет `MERGE_COMPLETED` и `BRANCH_MERGED`;
6. помечает source как `merged`;
7. оставляет в `branchNotes[target]` одноразовое объяснение того, что пришло из sibling.

`withMergeContext()` забирает note через `takeBranchNotes()` только для следующей обычной
instruction. Note не вставляется в `chatHistory`, чтобы не ломать message index alignment.

### 11.2 Continue as one branch

`collapseIntoParent()` не делает three-way comparison: child track является продолжением frozen
parent track. Parent забирает child conversation/document, имя объединяется через `&`, descendants
child переподключаются к survivor, child получает `merged`, а log — `BRANCH_COLLAPSED`.

Если у parent есть другие living children, требуется явный `adopt: true`; отданные alternatives
архивируются целыми subtrees. UI называет операцию `Continue as one branch` и перед подтверждением
показывает точное число других alternatives, которые будут архивированы. Операция доступна только
leaf branch; state behavior `collapseIntoParent()` не менялся.

### 11.3 Граница merge context

Полное объединение sibling chat histories **NOT IMPLEMENTED**. Sibling merge переносит document
state и одноразовую branch note, но не переписку source. Автоматического parent/sibling context
merge и memory manager нет. Temporary Map chat также не расширяет merge context.

## 12. Model pipeline, server и context

### 12.1 Client routing

| Request | Model | `reasoning_effort` для `grok-4.3` |
| --- | --- | --- |
| `chat` | `MODELS.DEFAULT` / `grok-4.3` | `low` |
| `create` | `MODELS.EDIT` / `grok-4.3` | `low` |
| `edit` | `MODELS.EDIT` / `grok-4.3` | `none` |
| `regenerate` | `MODELS.EDIT` / `grok-4.3` | `low` |
| merge Combine | edit route | `none` |
| `temporary-chat` | `MODELS.DEFAULT` / `grok-4.3` | `low` |
| `title` | `MODELS.TITLE` / `grok-4-1-fast-non-reasoning` | не передаётся |

`temporary-chat` — отдельный client pipeline и conversation id. В proxy mode текущий server
нормализует неизвестный для whitelist `request_type: "temporary-chat"` в `chat` только для
server-side accounting; сами messages остаются temporary payload.

Основной edit ограничивает историю последними пятью conversation pairs. Temporary chat отдельно
ограничивает свою drawer history пятью completed pairs. Изображения прошлых turns заменяются
placeholder в `sanitizeHistoryForApi()`, reasoning tags удаляются `stripReasoning()`.

### 12.2 API modes и server

Settings поддерживает:

- `direct`: browser → provider, default mode;
- `proxy`: browser → `POST /api/chat` → provider.

Выбор хранится в `sessionStorage` как `hectra_api_mode`. В direct mode provider credential
доступен клиентскому JavaScript. В proxy mode server читает `.env`/environment variables.

`server.js`:

- использует `node:http`, без Express в runtime;
- обслуживает static files с path normalization и security headers;
- слушает `127.0.0.1`, default `PORT=3000`;
- принимает body до `MAX_BODY_BYTES=64 MiB`;
- проксирует OpenAI-compatible chat completions;
- валидирует API key format, messages, reasoning effort и conversation id;
- использует client-supplied non-empty model, иначе `LLM_MODEL` fallback;
- ведёт token totals и печатает request/session reports;
- при `REVOLAB_ALLOW_FRAMING=1` ослабляет frame headers для локального film render.

Manifests содержат `express`, `cors`, `ai` и `@ai-sdk/xai`, хотя product server их не импортирует.
React/Remotion dependencies используются film tooling, а не workspace runtime.

## 13. Attachments и token accounting

Поддерживаются:

- изображения с проверкой type/size, data URL и preview;
- PDF с извлечением текста через PDF.js и page markers;
- text/code files с fenced block и filename.

В persisted UI message для изображения хранится безопасный preview, а не обязательная полная
provider payload. Branch fork копирует attachments вместе с track. Отправка attachment может
передавать пользовательские данные внешнему provider.

Token accounting работает на server и в direct browser path. Учитываются input, visible output,
reasoning, cached/media details и отдельная корзина title requests. В proxy mode temporary chat
попадает в нормализованную `chat` category текущего server.

## 14. Persistence

Storage default — `sessionStorage`. `localStorage` используется только если вручную задан
`HectraConfig.STORAGE_MODE === "local"`; в текущем `config.js` такого поля нет. Если сам Web
Storage недоступен, `security.js` использует in-memory fallback.

| Key | Содержимое |
| --- | --- |
| `hectra_sessions` | index `{ id, title, updatedAt, branchCount }` |
| `hectra_session_<id>` | messages, live document, versions, branches, tracks, bases, notes |
| `hectra_workspace_id` | active workspace id |
| `hectra_workspace_<id>` | action log, `lastActionSeq`, branch ids и truncation marker |

Намеренно не сериализуются:

- `pendingEditProposal`;
- `editUndo`;
- temporary chat session/messages;
- unsaved structure draft;
- view-only selection/modal state.

Session limit — 4 MiB, workspace log limit — 2 MiB. Реализация сравнивает
`JSON.stringify(...).length`, то есть UTF-16 code units, а не реальный byte size. При превышении
workspace limit старые persisted actions усекаются с сохранением `lastActionSeq` и
`truncatedBeforeSeq`; session автоматически не урезается. Browser quota общая, поэтому фактический
предел может наступить раньше.

Legacy session без branch data загружается как `main`; session без action log не реконструирует
старую историю автоматически.

## 15. Security boundary и известные риски

Реализованы sanitization, safe URL/data URL checks, body/session limits, path normalization,
security headers, API-key format validation и loopback-only server.

Текущий workspace **не production-ready**. При проверке 2026-08-19 подтверждено:

1. `js/config.js` содержит непустой client-side provider credential, а default API mode — direct.
   Credential необходимо считать раскрытым браузеру, отозвать/ротировать и удалить из client code
   до публикации.
2. В корне существует `.env`, исключённый `.gitignore`, но `serveStatic()` не запрещает dotfiles.
   Запрос к `/.env` способен получить существующий файл. Loopback-only уменьшает сетевую
   экспозицию, но не создаёт secret boundary.
3. `REVOLAB_ALLOW_FRAMING=1` должен использоваться только локальным film render process.
4. Нет auth, authorization, rate limiting, server-side user storage или multiuser isolation.
5. CDN dependencies не имеют Subresource Integrity; attachments могут содержать чувствительные
   данные; автоматического security regression suite нет.

## 16. Product film и diagnostics

### 16.1 Films — AUXILIARY

`films/` содержит:

- `New/` — текущий локальный монтаж;
- `Old/` — предыдущий snapshot;
- `legacy/` — superseded монтажи;
- `remotion/` — Remotion composition;
- `tools/` — `render-remotion.js`, `render-video.js`, `render-eye.js`;
- `recordings/` — результаты рендера;
- сценарии и cut sheets.

`js/film-demo.js` активируется только через `?film_demo=state|edit|history|workflow` и создаёт
детерминированные состояния настоящего workspace. Без query parameter модуль ничего не делает.

Команды:

```powershell
npm run render
npm run render:virtual
npm run render:eye
```

Film scenes, явно реконструирующие future/research UI, не входят в runtime Hectra for editors.

### 16.2 Diagnostics — AUXILIARY

`diagnostics/` содержит screenshots, logs и browser profiles исторических прогонов. Они могут быть
объёмными и не являются source fixtures. Актуальный воспроизводимый smoke —
`diagnostics/browser-qa.js`; он поднимает локальный server, управляет headless Chrome через CDP и
закрывает дочерние процессы после проверки.

## 17. Tests и воспроизводимая проверка

### 17.1 Node suite

```powershell
npm test
```

Результат на 2026-08-19: **127 tests, 127 passed, 0 failed**.

| Файл | Покрытие |
| --- | --- |
| `tests/action-log.test.js` | sequence, parent/branch, deltas, persistence и повреждённые logs |
| `tests/branches.test.js` | branch isolation, switching, divergence, tree и reload |
| `tests/branch-actions.test.js` | fork from message/sections, delete rules и soft delete |
| `tests/branch-structure.test.js` | frozen nodes, sibling/collapse availability, archive/adopt и reload |
| `tests/merge.test.js` | BASE/TARGET/SOURCE, insert/delete/order, conflicts, Combine и apply |
| `tests/history-scope.test.js` | content action set и отсутствие History entry point |
| `tests/section-order.test.js` | position markers, move semantics и diff order |
| `tests/overlay-hidden.test.js` | `[hidden]` overlays не перехватывают UI |
| `tests/edit-pipeline.test.js` | staging, authorization, invalid/subset atomicity, stale, auto, Undo и manual structure |
| `tests/structure-assistant.test.js` | single-section request boundary, response validation и draft-only engine update |
| `tests/temporary-chat.test.js` | single source, last block, frozen context, isolation, lifecycle и Retry |

### 17.2 Syntax checks

Минимальный набор:

```powershell
node --check server.js
node --check js/editEngine.js
node --check js/editReviewUI.js
node --check js/structureAssistant.js
node --check js/temporaryChat.js
node --check js/state.js
node --check js/app.js
node --check js/mapUI.js
node --check diagnostics/browser-qa.js
```

### 17.3 Browser QA

```powershell
node diagnostics/browser-qa.js
```

Проверяется реальная `workspace.html`:

- staged scoped commit и восстановимый Undo;
- document-first welcome, prompt/section/multi-section/whole-document/structure labels и
  selection-boundary helper;
- scoped inclusion по умолчанию, out-of-scope/structural exclusion, explicit approval, invalid без
  Include, отсутствие implicit commit и один `Apply included changes`;
- model structural review с Exclude одной operation и единичным commit остальных;
- Escape discard без proposal mutation или визуального повторного открытия;
- manual add/per-section agent preview/Use in draft/move/delete/draft Undo/Apply одним batch;
- отсутствие `Draft section with agent` у существующей заполненной section и наличие у new/empty;
- Map placeholder, явные `Open branch` / `Ask about snapshot` и текстовые роли CURRENT/SELECTED/
  QUESTION SOURCE;
- temporary chat по inactive branch без active switch;
- два последовательных temporary questions только по frozen last block;
- отсутствие permanent state mutation;
- Close/reopen с пустой history;
- desktop drawer освобождает место справа;
- narrow viewport использует overlay;
- честные staged revert, version и merge-combination labels;
- dirty composer guard для branch, Map, workspace и New navigation;
- frozen-parent Send без confirm, с сохранённой instruction и auto-created child;
- uncaught browser exceptions отсутствуют.

Model call в browser smoke подменён локальным stub, поэтому проверяются payload, isolation,
lifecycle, interaction и layout, а не доступность внешнего provider.

## 18. Запуск

```powershell
npm ci
npm start
```

- landing: `http://127.0.0.1:3000/`;
- workspace: `http://127.0.0.1:3000/workspace.html`.

Для proxy mode нужно сначала устранить риск статической раздачи `.env`, заполнить server-side
credential и выбрать `Settings → API mode → Proxy`. До публикации direct credential должен быть
удалён и ротирован.

## 19. Известные ограничения и технический долг

1. Нет server-side revision ids или distributed CAS; edit freshness локальная и snapshot-based.
2. Pending proposal, последний Undo token, structure draft и temporary chat живут только до reload.
3. Хранится один последний staged Undo token, а не произвольный undo stack.
4. Manual structure modal не имеет прямого full-content textarea; agent draft доступен только для
   new/empty section, а заполненная section меняется последующим обычным `Change section`.
5. Markdown parser tolerant, но не заменяет formal JSON schema; malformed operations становятся invalid.
6. `applyEdit()` остаётся compatibility wrapper для внутренних callers.
7. Full sibling chat-history/context merge не реализован; переносится document и одноразовая note.
8. Temporary chat поддерживает ровно одну branch и один frozen last block.
9. Нет split node, arbitrary graph reparent или restore UI для archived/deleted branches.
10. Ветки и attachments умножают размер browser session record.
11. Map не имеет zoom.
12. History view/restore ограничен snapshots, доступными в active track.
13. Default persistence живёт в пределах browser tab/session.
14. Нет database, accounts, collaboration или synchronization между tabs/devices.
15. Direct credential и static `.env` serving остаются блокирующими security debt.
16. `package.json` не фиксирует `engines` и содержит неиспользуемые product-runtime dependencies.
17. Общий `uiKit.confirm()` не имеет generation token для 140-мс close timeout: искусственно
    быстрые последовательные confirm менее чем за один transition могут конфликтовать. Общий
    overlay manager и нормализация всех modal lifecycle оставлены deferred; proposal review имеет
    локальную защиту pending animation frame для обязательного Escape flow.

## 20. Краткий журнал архитектурных изменений

### 2026-08-19

- добавлен pure `editEngine.js`;
- model edit переведён на frozen context → proposal → review/auto → atomic commit;
- hard write authorization перенесён в engine/state;
- добавлены per-operation и batch decisions, invalid state и stale protection;
- добавлены scoped-only auto-apply, recoverable Undo и manual structure draft;
- `DOCUMENT_EDIT_PROPOSED` больше не предполагает обязательный apply;
- добавлен single-source temporary Map chat по frozen last assistant document block;
- Map получил явный selection placeholder и temporary source flow по eligible snapshots;
- structure draft получил per-section agent instruction → preview → draft-only apply flow;
- suite расширена до 127 tests и добавлен воспроизводимый headless browser QA;
- две технические документации объединены в этот единственный editor-scoped документ.
- завершён первый UX simplification patch без изменений state/engine/persistence contracts;
- введён document-first словарь `Revise request` / `Change section(s)` / `Change whole document` /
  `Reorder, add or remove sections`;
- proposal review переведён на Include/Exclude и один финальный `Apply included changes`;
- Map разделяет `CURRENT`, `SELECTED` и `QUESTION SOURCE`, а `Open branch` является primary action;
- structure agent ограничен new/empty sections и использует `Use in draft`;
- добавлен dirty composer navigation guard; frozen parent продолжает работу в новой branch без
  discard confirm;
- version и merge controls получили consequence-based labels без изменения callbacks;
- browser QA расширен на UX patch, desktop и 600 px; `npm test` остаётся 127/127.

### 2026-07-22 — 2026-07-26

- добавлены workspace action log, branches, Map, selection-based flows и merge;
- branch graph переведён на leaf-only write rule;
- sibling merge и collapse into ancestor разделены;
- добавлены soft delete/archive, branch notes и internal History;
- постоянные section controls удалены из обычного document view.

## 21. Текущее состояние

Локальный прототип функционально реализует sectioned document, staged edits, explicit structural
review, versions/diff, append-only action log, isolated branches, sibling merge, collapse, Map и
temporary read-only Q&A по одной frozen branch. Structure draft поддерживает явную AI-подсказку
для title/content новой/пустой section без ранней мутации live document. Первый UX simplification
patch завершён; product входит в feature freeze с сохранёнными staged write boundary, branch,
merge, version и temporary-chat contracts.

Ближайшие технические приоритеты перед любым внешним развёртыванием — ротация client credential,
запрет статической раздачи dotfiles, безопасный proxy default и security regression tests. После
этого основные архитектурные долги — server-side persistence/identity, объём branch tracks,
отсутствие graph split/restore UI и отсутствие полноценного context merge.
