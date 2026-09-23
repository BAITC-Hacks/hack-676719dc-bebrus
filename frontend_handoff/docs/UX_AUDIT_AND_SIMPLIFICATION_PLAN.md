# UX-аудит и умеренный план упрощения Hectra for editors

Дата проверки: 2026-08-19  
Принцип оценки: **Document first, complexity on demand.**  
Объект проверки: фактический runtime `Hectra_for_editors`; этот документ не предлагает менять document model, write authorization, branch graph или persistence.

## Implementation status — 2026-08-19

Статус: **первый UX simplification patch принят founder’ом и реализован**. Исходные findings ниже
сохраняются как before-state и обоснование решений; актуальное runtime-описание находится только в
`PROJECT_TECHNICAL_DOCUMENTATION(4).md`.

Реализовано:

- document-first словарь: `Revise request`, `Change section(s)`, `Change whole document`,
  `Reorder, add or remove sections`, а также краткое объяснение selection context против section boundary;
- staged review с Include/Exclude, безопасными defaults и единственным final action
  `Apply included changes`; Escape выполняет тот же discard flow;
- Map с явным contextual action bar, primary `Open branch`, secondary `Ask about snapshot` и
  отдельными текстовыми ролями `CURRENT`, `SELECTED`, `QUESTION SOURCE`;
- consequence-based labels для staged revert, structure draft, merge combination, sibling merge,
  ancestor collapse и version controls без изменения их callbacks;
- `Draft section with agent` только для new/empty sections, с `Describe this section`,
  `Use in draft` и `Discard suggestion`;
- dirty composer guard для branch/Map/workspace/New navigation;
- frozen-parent Send без confirm: instruction сохраняется, создаётся child branch, показывается
  `Continued in a new branch`;
- расширенный headless browser QA; `npm test` остаётся 127/127.

Зафиксированные founder decisions: главный продукт — Document; version semantics сохраняются;
Map primary action открывает branch document; structure agent обслуживает только new/empty sections;
frozen parent автоматически продолжает в новой branch; composer draft нельзя молча переносить;
state/engine/persistence/action-log contracts не меняются.

Deferred после patch: публичный History и изменение version semantics, общий overlay manager,
упрощение плотности structure rows, сокращение merge choice screens, обнаружимость hover-only
message actions и визуальная группировка diff/changelog/toast/version bar. Новые product features и
архитектурные изменения не входят в feature freeze.

## 1. Executive conclusion

Риск UX collapse уже высокий, хотя функционально продукт остаётся работоспособным и его safety-механики проходят тесты. Основную сложность создают три причины: несколько разных объектов под словом `Edit`, несколько несовместимых значений `Accept/Reject/Undo`, а также три параллельные идентичности ветки — active branch, selected Map node и temporary-chat source. Наиболее опасны не визуальный шум сам по себе, а ситуации, где нейтрально выглядящий control имеет необратимый или меняющий контекст результат: `Accept` удаляет альтернативные versions, version arrows меняют live state, `Merge with ancestor` может отказаться от siblings, а draft composer после branch switch теряет режим, но сохраняет текст. Нужен немедленный, но умеренный intervention: сначала переименовать действия, сократить число одновременно конкурирующих решений и сделать Map-навигацию явной. Полный редизайн не нужен; чистый документный экран и progressive disclosure уже дают подходящую основу. Первый patch следует ограничить presentation и тонкой UI-orchestration, не меняя state contracts. Нельзя ослаблять staged proposal, hard write scope, freshness check, atomic commit, leaf-only write rule, three-way merge и изоляцию temporary chat. Текущее техническое основание стабильно: 127/127 Node tests и актуальный headless browser QA проходят.

## 2. Current user mental model

### Фактически требуемая сегодня модель

Чтобы уверенно работать в текущем UI, пользователь должен одновременно понимать следующее:

1. Workspace содержит conversation, live document, versions и branch graph, но sidebar называет верхний объект workspace, стартовая кнопка — `New chat`, а верхний breadcrumb — workspace.
2. Ответ Hectra — не просто сообщение: последний assistant block является `Live document`, а предыдущие assistant blocks остаются историческими представлениями.
3. Редактировать можно предыдущий user prompt, весь live document, одну или несколько секций, structure draft или content одной секции внутри structure draft.
4. Выделенный текст — лишь подсказка модели, а write scope — целая секция или набор секций, пересечённых selection.
5. Model edit сначала создаёт proposal; proposal ещё не является version и не меняет документ.
6. После commit возникает ещё один уровень решения — version bar, где `Accept/Reject` уже означают не принятие proposal, а управление snapshots.
7. `Undo` после auto-apply, `Undo local action`, version `Reject` и History `Restore` имеют разные механические последствия.
8. Branch — отдельный track документа и разговора; писать можно только в leaf, а отправка из закрытого parent автоматически создаёт ещё одну branch.
9. В Map active branch, selected node и frozen temporary-chat source могут быть разными.
10. Sibling merge является three-way document merge, а `Merge with ancestor` — collapse границы с возможным архивированием альтернатив.
11. `Combine` внутри merge вызывает модель, но только готовит ещё одну suggestion, которую затем надо отдельно принять и позднее применить весь merge.
12. Temporary chat знает только frozen last block и специально не связан с обычным composer, document history и merge memory.

Эта модель архитектурно последовательна, но слишком велика для интерфейса, который внешне выглядит как обычный document chat.

### Целевая модель: не более четырёх понятий

| Понятие | Что пользователь должен понимать | Что скрывается как реализация |
| --- | --- | --- |
| **Document** | Это текущий текст, с которым он работает. Обычная инструкция продолжает работу над ним. | `uiMessages`, section ids, snapshots, chat history и current assistant index. |
| **Change** | Изменение документа бывает предложенным, применённым или ещё находящимся в локальном draft. | Scope classification, operations, structural invariants, proposal freshness и atomic materialization. |
| **Alternative** | Branch — альтернативное продолжение документа; Map помогает открыть или сравнить альтернативы. | Tracks, bases, leaf-only write rule, divergence и branch action sequence. |
| **Review** | Небезопасное изменение, merge или новая version требуют понятного решения перед завершением. | Разные engines и action-log types остаются разными, но не требуют от пользователя учить внутренние термины. |

Temporary chat в этой модели — не пятое понятие, а read-only вопрос об одной `Alternative`; structure tools — специализированный способ подготовить `Change`.

## 3. User-flow map

### 3.1 Inventory поверхностей

| ID | Поверхность | Как открывается | Доступные действия | Что меняет в state |
| --- | --- | --- | --- | --- |
| S01 | Sidebar | Постоянно на desktop; hamburger на узком viewport | New, открыть workspace/branch, branch menu, удалить workspace, Settings | New сбрасывает активную session; выбор загружает session/track; branch actions меняют metadata/state. |
| S02 | Workspace header | Постоянно | Branch chip, Map/Document, контекстный Merge, status | Branch switch меняет active track; Map — только view; Merge открывает plan UI. |
| S03 | Conversation + document view | Основная поверхность после create/load | User prompt actions, response `Branch`, `Document ⋯`, text selection, чтение changelog/diff | Большинство controls только входят в другой mode; delete/regenerate/branch уже меняют state. |
| S04 | Composer | Постоянно, кроме его визуального контекста | Attach, Send, Cancel; normal, section edit, whole-document edit, prompt rewrite, explore, frozen-parent continuation | Send маршрутизируется в chat/edit/regenerate/new branch; Cancel очищает input и edit context. |
| S05 | Floating selection toolbar | Выделить содержательный текст внутри live document | `Edit section(s)`, `Explore` | Сам toolbar ничего не пишет; Edit фиксирует UI focus, Explore сразу создаёт branch. |
| S06 | `Document ⋯` menu | Кнопка в header live assistant block | Edit whole document, Edit structure, Compare versions | Вход в edit/structure; Compare показывает version bar. |
| S07 | Branch menus | Branch chip, sidebar row `⋯`, Map node `⋯`, header Merge | Open, View in map, Rename, Preferred, Archive, Delete, sibling/ancestor merge, New branch | Switch/metadata/branch graph; меню само state не меняет. |
| S08 | Message hover actions | Hover/focus user bubble или assistant header | Revise user prompt, branch from message, delete prompt+response; assistant `Branch` | Prompt regeneration может переписать дальнейший conversation/document; branch fork фиксирует state выбранного message. |
| S09 | Staged edit review | Model proposal, который нельзя auto-apply | Per-operation Accept/Reject; Reject all; Accept selected; Accept all allowed | До batch commit — только decision view-state и pending proposal; commit создаёт одну version/action; full reject version не создаёт. |
| S10 | Global version bar | После edit/merge или `Compare versions` | Previous/next, `Accept`, `Reject` | Стрелки вызывают `restoreVersion()` и меняют current live snapshot; Accept оставляет одну version; Reject удаляет latest и возвращает previous. |
| S11 | Edit structure | `Document ⋯ → Edit structure` | Drag/up/down, Add before/after, Ask agent, Delete, local Undo, Cancel, Save | До Save — только local draft; Save строит manual proposal и атомарно коммитит одну version. |
| S12 | Map | Header `Map` или `View in map` | Pan, select source, double-click open, node menu, archived toggle, temporary-chat entry | Selection/pan — view-state; double click вызывает обычный branch switch. |
| S13 | Temporary chat drawer | Выбрать source в Map и `Open temporary chat` | Multi-turn Q&A, Retry, Reset, Close | Только in-memory temporary session; permanent state не меняется. |
| S14 | Merge review | Header/branch menu sibling merge | Quick merge, Review merge, conflict resolution, Keep/Use/Combine, Apply merge | Plan и decisions до Apply — view/plan state; Apply создаёт target version, action records и меняет branch statuses. |
| S15 | Confirm | Delete branch и collapse-with-ancestor | Confirm/Cancel | До confirm ничего; confirm вызывает соответствующую state operation. |
| S16 | Notices/toasts/onboarding | Автоматически по состоянию | First-edit `Got it`, frozen-parent explanation, status badge, stale/error text, five-second Undo | Обычно presentation; toast Undo создаёт обратный edit как новую version. |
| S17 | Internal History | Только `Ctrl+Alt+Shift+H` или console | Filter, View state, Restore this state | Preview read-only; Restore вызывает `restoreVersion()` и пишет append-only action. |
| S18 | Settings | Sidebar gear | Theme, API mode, Save | Theme применяется preview немедленно; Save пишет local/session storage. |

### 3.2 Lifecycle и сосуществование поверхностей

| Поверхность | Как закрывается | Escape | Branch/workspace switch | Reload | Что может быть видно одновременно |
| --- | --- | --- | --- | --- | --- |
| S01 Sidebar | Backdrop/hamburger на mobile; desktop постоянен | Закрывает mobile sidebar | Switch закрывает mobile sidebar | Восстанавливается layout, не open-state | Header, document/Map, composer. |
| S02 Header | Не закрывается | Закрывает только открытое menu через `HectraUI` | Перерисовывает active branch/status | Восстанавливается из persisted session | Практически со всеми немодальными surfaces. |
| S03 Document | Скрывается при Map | Selection исчезает, сам document нет | Полная перерисовка track | Committed content восстанавливается | Composer, version bar, toolbar, menus, notices. |
| S04 Composer | Cancel только в edit/rewrite mode; submit завершает текущий route | **Не отменяет edit mode** | Mode/focus очищаются, но набранный текст не очищается | Draft не сохраняется | Context chip, version bar, auto-Undo toast. |
| S05 Selection toolbar | Новый click/selection, action, resize, Escape | Да | Скрывается | Исчезает | Только document и composer. |
| S06/S07 Menus | Выбор, outside click, resize, Escape | Да | Новая render обычно удаляет relevance | Исчезают | Открыт только один `HectraUI` menu. |
| S08 Hover actions | Уход hover/focus | Не применимо | Исчезают с render | Исчезают | Document. |
| S09 Proposal review | `×`/Reject all или успешный commit | **Нет** | Modal не закрывается; state отклоняет commit как stale | Modal и pending proposal исчезают | Под ним могут оставаться version bar/document; другие entry points физически перекрыты. |
| S10 Version bar | Accept/Reject; new render/new chat скрывает | Нет | Скрывается при `renderAllMessages()` | Versions сохраняются, bar показывается только когда renderer решит | Composer, diff, changelog, toast. |
| S11 Structure | `×`/Cancel или успешный Save | **Нет** | Draft/modal не закрывается; Save столкнётся с freshness error | Unsaved draft исчезает | Agent subpanel внутри modal. |
| S12 Map | Header `Document`; double-click open также скрывает Map | Нет | Switch внутри Map обновляет active styling; document open скрывает | View-state исчезает | Sidebar, header, composer; drawer. |
| S13 Temporary drawer | Reset, Close, Document/Map close, workspace switch | **Нет** | Active branch может измениться, frozen source остаётся прежним | Полностью уничтожается | Map, header, sidebar, основной composer. |
| S14 Merge | `×`, backdrop, Cancel, Escape, successful Apply | Да | Plan/modal автоматически не закрываются | Unapplied plan/decisions исчезают | Underlay document/version bar; Combine proposal внутри modal. |
| S15 Confirm | Cancel/backdrop/confirm | Да = Cancel | Обычно недоступно из-за modal | Исчезает | Только затемнённый underlay. |
| S16 Notices | Timer/action/explicit close; frozen notice — сменой branch state | Onboarding — да; toast/notice — нет | Toast может стать stale; frozen notice обновляется | Ephemeral notices исчезают | Version bar и composer часто одновременно. |
| S17 History | `×`; preview banner — Return/Restore | Не закрывается | Preview принудительно завершается, panel остаётся и refresh | Закрыт по умолчанию | На desktop отдельная колонка; на узком viewport overlay. |
| S18 Settings | `×`, backdrop, Save, Escape | Да | Не связан с branch | Закрыт; сохранённые values возвращаются | Затемнённый underlay. |

State modules не обеспечивают общей mutual-exclusion policy для всех overlays. Например, New/branch switch явно уничтожают temporary chat, но не закрывают edit-review или merge plan; state safety предотвращает stale edit commit, однако пользователь остаётся в визуально устаревшем mode.

### 3.3 Метод подсчёта сложности

Клики ниже — минимальные pointer activations без набора текста; selection и drag отмечены отдельно. `Поверхности` — последовательно открываемые UI layers, а не DOM nodes. `Primary actions` — одновременно конкурирующие действия завершения/продолжения; рядом указано фактическое число buttons, если оно лучше показывает перегрузку. Числа — сравнительная карта, не универсальный UX-score.

| Сценарий | Клики/жесты | Поверхности | Max primary actions | Новые термины | Состояния, которые надо помнить |
| --- | ---: | ---: | ---: | ---: | ---: |
| A. Create + follow-up | 2 Send + 1 `Got it` | 2 | 1 | 3–4 | 2 |
| B. Scoped edit + Undo | 2 clicks + selection; 3 с Undo | 4 | 3 (`Undo`, version Accept, version Reject) | 6 | 4 |
| C. Unsafe review, 4 operations | 7 clicks + selection; 3 при рискованном bulk path | 3 | 2 commit-level; **12 buttons** в observed modal | 8–10 | 5 |
| D. Structure + agent + undo + save | 9–10 clicks + optional drag | 3 | 2; **22 buttons** baseline, около **30** после Add/agent panel | 9–11 | 5–6 |
| E. Оба fork path + switch | 5–7 clicks + 1–2 selections/hover | 4 | 2 | 7–9 | 5 |
| F. Map + temp chat + open branch | 7 activations, включая double click | 2 | 2 | 7 | 4 |
| G. Sibling merge + Combine + version decision | 8–10 | 4–5 screens/layers | 3 | 12–14 | 7 |

### A. Создание документа

- **Entry point:** чистый `New workspace`, welcome cards или пустой composer.
- **Текущие шаги:** instruction → Send → user bubble → assistant block с tag `Live document` → automatic edit onboarding → `Got it` → обычный follow-up через тот же composer.
- **Переход режима:** create request незаметно переключает model route, но UI остаётся тем же.
- **Тупик:** welcome обещает `Press Edit on a response`, хотя текущий явный control называется `Document ⋯`; локальный Edit появляется только после selection.
- **Неясность:** conversation и document находятся в одном вертикальном feed. `Live document` помогает, но newcomer ещё не знает, что только последний assistant block writable/live.
- **Recovery:** API error оставляет user bubble, из которого prompt можно редактировать; это действие скрыто в hover icons.

### B. Локальная правка

- **Entry point:** выделение текста в live document.
- **Текущие шаги:** selection → floating `Edit section` → composer chip `Editing: <title>` → instruction → auto-apply → toast `All scoped changes applied / Undo` и version bar `Accept/Reject`.
- **Переход режима:** выделяется текст, но frozen `targetSectionIds` включает всю пересечённую section. Это безопасно для engine, но не очевидно пользователю.
- **Тупик:** после пяти секунд исчезает единственный явно названный Undo; остаётся version bar с другими словами и другими state semantics.
- **Неясность:** auto-apply называется завершённым, но одновременно предлагается ещё раз Accept/Reject version.
- **Recovery:** Undo восстанавливает предыдущий snapshot новой version; version Reject удаляет latest snapshot; internal Restore недоступен через обычный UI.

### C. Review небезопасных изменений

- **Entry point:** section/whole-document edit, где proposal содержит out-of-scope, structural или invalid operations.
- **Текущие шаги:** model response → modal → per-card Accept/Reject → `Accept selected` или немедленный `Accept all allowed · grant approval` → one atomic commit.
- **Переход режима:** document не меняется до commit; это сильная сторона текущего flow.
- **Тупики:** `Reject` показан даже когда операция изначально не включена; Close `×` означает Reject all; Escape ничего не делает; invalid card всё равно показывает disabled button `Accept`.
- **Неясность:** `update + move`, `[#id]`, `Within selected scope` и `Needs approval` описывают engine, а не пользовательское намерение. Слово `allowed` конфликтует с подписью `need extra approval`.
- **Recovery:** full reject безопасен; invalid/stale subset оставляет document неизменным и показывает error; повтор запроса является единственным stale recovery.

### D. Ручное изменение структуры

- **Entry point:** `Document ⋯ → Edit structure`.
- **Текущие шаги:** выбрать per-row Add/Move/Delete или drag; Add автоматически открывает agent panel; instruction → Generate suggestion → Use suggestion → optional local Undo → Save changes.
- **Переход режима:** structure draft локален; agent suggestion ещё на один уровень глубже и также не применён, пока не нажаты и `Use suggestion`, и `Save changes`.
- **Тупики:** Escape не закрывает modal; у новой пустой section нет прямого content textarea; без понимания `Ask agent` пользователь может считать Add незавершённым.
- **Неясность:** `Ask agent` выглядит как обычный section edit, хотя он ограничен одной section в unsaved structure draft. `Use suggestion` не означает commit, `Undo local action` откатывает только последний draft command, `Cancel` уничтожает весь draft.
- **Recovery:** local Undo, Discard suggestion, Cancel whole draft, Save one atomic version. Browser run подтвердил 22 controls для трёх sections и около 30 после Add/agent panel.

### E. Ветвление

- **Entry points:** hover action на user/assistant message; selection → `Explore`; branch chip → `+ New branch`.
- **Текущие шаги:** fork автоматически именуется и открывается; parent получает `closed`; leaf продолжает принимать input; switch через chip/sidebar/Map.
- **Переход режима:** Explore одновременно создаёт branch и оставляет composer context `Exploring`; branch from message сразу переключает track.
- **Тупики:** user-message branch action является icon-only и появляется на hover; на touch он обнаружим хуже. Если пользователь начинает edit/rewrite, набирает текст и переключает branch, mode сбрасывается, но текст остаётся в composer уже другой ветки.
- **Неясность:** frozen parent notice объясняет правило хорошо, но Send автоматически создаёт новую branch без отдельного решения. `closed` на Map/card может выглядеть как недоступный для чтения, хотя закрыта только запись.
- **Recovery:** branch chip/sidebar возвращают на другой track; sibling merge/collapse могут снова сделать parent writable; ошибочно созданную leaf можно archive/delete при соблюдении graph rules.

### F. Map и temporary chat

- **Entry point:** header `Map`.
- **Текущие шаги:** `Ask a question (temporary chat)` → explicit source-pick placeholder → single click highlighted branch → `Open temporary chat` → Q&A → Close/Reset; double click node открывает branch document.
- **Переход режима:** Map заменяет document, но сохраняет sidebar, header и основной composer; drawer добавляет второй composer справа.
- **Тупики:** single click с keyboard Enter/Space только выбирает source; открыть document keyboard-путём из node нельзя без `⋯ → Open`. Double click остаётся главным прямым, но плохо обнаруживаемым путём.
- **Неясность:** active node, selected node и temp source отличаются только styling; легенды ролей нет. Map одновременно является graph, navigation, branch menu и temporary-chat launcher.
- **Recovery:** Close/Reset/Document уничтожают session; frozen source не меняется после active branch switch; unavailable node просто не становится source.

### G. Merge и версии

- **Entry point:** context-sensitive header `Merge` или branch menu.
- **Текущие шаги sibling merge:** выбрать `Merge with…` → Quick/Review merge → Resolve → Keep/Use/Combine → при Combine отдельно Accept/Reject AI combination → Apply merge → version Accept/Reject.
- **Текущие шаги ancestor:** `Merge with ancestor` → confirm, иногда с `give up the rest`; фактически это collapse, а не three-way comparison.
- **Переход режима:** choice, preview/review, conflict, nested model suggestion, applied diff/version — до пяти смысловых экранов.
- **Тупик:** `Restore this state` невозможно найти в публичном UI: History намеренно internal и открывается только chord/console. Поэтому обязательное сравнение Restore со staged Undo новичок выполнить не может.
- **Неясность:** `Quick merge` всё равно требует review; `Review merge` показывает action timeline, но не другой commit contract. `Accept` сначала принимает combined text, затем другой `Accept` удаляет другие versions.
- **Recovery:** Back/Cancel безопасны до Apply; unresolved plan не применяется; version Reject возвращает previous latest; append-only log остаётся, но обычный пользователь его не видит.

## 4. UX complexity findings

| ID | Проблема | Где возникает | Серьёзность | Частота | Причина | Зависимости |
| --- | --- | --- | --- | --- | --- | --- |
| UX-01 | Selected fragment выглядит write target, хотя scope — целая section | Selection → section edit → auto-apply | P0 | Высокая | UI показывает выделенный текст как начало действия, а frozen section ids объяснялись только one-time onboarding | `selectionUI`, `branchUI`, `app`; engine менять нельзя |
| UX-02 | Draft edit/rewrite text переживает branch switch, но mode и target очищаются | Composer + branch switch | P0 | Средняя | UI draft хранится отдельно от branch state; `renderAllMessages()` выходит из mode, не очищая textarea | `app`, `branchUI`; orchestration tests |
| UX-03 | `Accept all allowed` включает и немедленно коммитит out-of-scope/structural operations | Staged review | P0 | Средняя | `allowed` фактически значит только `not invalid`; дополнительное разрешение спрятано в suffix | `editReviewUI`; state authorization оставлять неизменным |
| UX-04 | `Accept/Reject` имеют три разных уровня последствий | Proposal, merge combination, version bar | P0 | Средняя | Одинаковый глагол используется для include, use suggestion и destructive version pruning | `editReviewUI`, `mergeUI`, `renderer`, version state |
| UX-05 | Version arrows выглядят как preview, но меняют live snapshot и пишут restore action | Version bar | P0 | Средняя | Presentation не показывает, что navigation является state mutation | `renderer`, `app`, `state.restoreVersion`, action log |
| UX-06 | `Merge with ancestor` звучит как обычный merge, но может archive siblings | Branch/header merge | P0 | Низкая, но высокая цена | Две разные graph operations объединены словом Merge; warning появляется поздно | `branchUI`, confirm, collapse state/action log |
| UX-07 | Frozen parent Send незаметно создаёт новую branch | Composer на non-leaf | P0 | Средняя при ветвлении | Just-in-time notice есть, но primary action всё ещё обычный Send | `branchUI.canWriteToBranch`, `app.continueInNewBranch` |
| UX-08 | Welcome предлагает несуществующий путь `Press Edit on a response` | Первый экран | P1 | Высокая для новичка | Runtime copy отстаёт от `Document ⋯` + selection toolbar | `app` welcome, `renderer` onboarding |
| UX-09 | Proposal review говорит языком engine | Staged review cards | P1 | Средняя | `operation`, `[#id]`, `update + move`, `scope`, `invalid` вынесены в primary reading path | `editReviewUI`; operations остаются внутренними |
| UX-10 | Review требует сначала выбрать Accept, затем выбрать способ commit; Reject изначально ничего не меняет | Staged review | P1 | Средняя | Decision model выражен как кнопки действий, хотя это selection before one batch commit | `editReviewUI` view-state/callbacks |
| UX-11 | Structure mode показывает 6 controls на каждую section | Edit structure | P1 | Средняя | Per-row permanence вместо contextual disclosure | `editReviewUI`, CSS; engine независим |
| UX-12 | `Ask agent` выглядит дублем обычного section edit | Edit structure | P1 | Средняя | Неочевидна граница: only-one-section, unsaved draft, Use then Save | `structureAssistant`, `editReviewUI`, `app` request route |
| UX-13 | Merge требует до трёх принятий одной логической правки | Combine → Apply merge → version Accept | P1 | Низкая/средняя | Каждый subsystem честно требует решение, но термины не показывают уровень | `mergeUI`, `state.applyMerge`, version bar |
| UX-14 | Escape/Cancel policy непоследовательна | Review, structure, Map drawer, merge, settings | P1 | Средняя | Каждый UI module реализует lifecycle локально; edit review вообще не слушает Escape | UI modules; stale guards частично смягчают |
| UX-15 | Proposal/structure modal не закрывается при branch/workspace transition | Advanced edit flows | P1 | Низкая | Нет общей surface coordinator policy | `branchUI`, `app.restoreSessionUI`, `editReviewUI` |
| UX-16 | Message-level fork/edit/delete скрыты на hover; user actions icon-only | Conversation | P1 | Средняя | Минимизация chrome уменьшила discoverability | `renderer`, CSS hover/focus/mobile rules |
| UX-17 | Restore существует, но не является product surface | Versions/History | P1 | Низкая, пока history internal | Документация честно называет History internal, обязательный novice flow — нет | `historyUI`, `workspaceHeader`, tests |
| UX-18 | Active, selected и source branch не имеют словесной легенды | Map/temp chat | P1 | Средняя | Три независимых state roles передаются цветом/class | `mapUI`, CSS; branch state не менять |
| UX-19 | Double click остаётся самым коротким способом открыть branch document | Map | P1 | Средняя | Hint есть, но double click плохо переносится и не имеет keyboard parity | `mapUI`; menu Open — обходной путь |
| UX-20 | Document и conversation визуально живут в одном feed | Create/follow-up/version | P1 | Высокая | Product model document-first, layout по происхождению chat-first | `renderer`, `workspace.html`, CSS; полный layout change не нужен сейчас |
| UX-21 | Map совмещает четыре задачи и два composer | Map + drawer | P2 | Средняя | Graph, navigation, branch actions и Q&A используют один canvas | `mapUI`, temp session; решается disclosure, не новой architecture |
| UX-22 | Исторические browser screenshots противоречат текущему runtime | Diagnostics | P2 | Низкая для пользователя, высокая для команды | AUXILIARY artifacts не маркированы на уровне filenames | diagnostics/docs, runtime не затрагивается |
| UX-23 | Changelog + diff + version bar + toast одновременно повторяют факт изменения | После edit/merge | P2 | Высокая | Несколько safety affordances добавлялись независимо | renderer/edit UI; удалять audit data нельзя |

Главный вывод по гипотезам: все десять исходных гипотез подтвердились полностью или частично. Гипотеза о `Ask agent` подтверждена как **perceived duplication**, но не как технический duplicate: обычный edit работает через model proposal над live base, а structure agent меняет только одну section в unsaved draft. Leaf-only rule сформулирован лучше большинства advanced flows, однако auto-branch на Send всё ещё требует слишком внимательного чтения notice.

## 5. Terminology collisions

| Термин | Где сейчас | Фактическое действие | Риск путаницы | Рекомендация |
| --- | --- | --- | --- | --- |
| Edit | Edit prompt, Edit section, Edit whole document, Edit structure | Regenerate conversation; staged model change; structural draft | Очень высокий | `Revise request`; `Change section(s)`; `Change whole document`; `Reorder, add or remove sections` |
| Accept | Proposal operation, Accept selected/all, AI combination, version bar | Include op; commit subset; choose combined text; prune all other versions | Критический | `Include`; `Apply included changes`; `Use combined text`; `Keep shown version and clear alternatives` |
| Reject | Proposal op/all, AI combination, version bar | Exclude; discard proposal; discard suggestion; drop latest version | Критический | `Exclude`; `Discard proposal`; `Discard combination`; `Discard latest version` |
| Apply | `Apply merge` | Commit resolved plan to target as a version | Низкий сам по себе | Сделать объект явным: `Merge into <target>`; `Apply` оставить только для final state mutation |
| Save | Structure, Settings | Atomic document commit; persistence настроек | Средний | Structure: `Apply structure changes`; Settings: `Save settings` |
| Restore | Internal History | Сделать historical snapshot current и записать action | Средний; действие скрыто | `Restore as current`; отдельно решить, должен ли History стать публичным |
| Undo | Auto toast, local structure | Обратный committed edit как новая version; pop одного local draft action | Высокий | `Revert applied change`; `Undo last draft action` |
| Cancel | Composer, structure, merge, confirm | Очистить input/mode; discard whole draft; close plan; decline confirm | Высокий | `Discard edit draft`; `Discard structure draft`; `Close merge`; `Cancel` оставить в confirm |
| Use suggestion | Structure agent | Записать suggestion только в unsaved draft | Высокий | `Use in draft` |
| Merge | Sibling three-way, ancestor collapse, header umbrella | Merge document deltas; collapse branch boundary | Критический | `Merge sibling changes`; `Collapse into parent` / `Continue as one branch` |
| Combine | Merge conflict | Попросить модель предложить combined text | Средний | `Draft combined text` |
| Branch | Header/sidebar/Map/fork | Alternative document/conversation track | Средний для новичка | Термин оставить, один раз объяснить как `alternative`; не переименовывать graph model |
| Source | Temporary chat и merge | Frozen reference block; branch, из которой берутся changes | Высокий | Temp: `Question context`; merge: `Merge from` |
| Selected | Text selection, target sections, Map node, accepted operations | Fragment; write scope; temp candidate; commit subset | Очень высокий | Всегда добавлять объект: `Selected text`, `Sections to change`, `Question source`, `Included changes` |
| Active | Branch chip/Map class | Track, чей document открыт и куда идёт обычный composer | Средний | В Map показывать text badge `Open document`; в header оставить `Current branch` |
| Scoped | Proposal status | Update внутри frozen targetSectionIds | Высокий как engineering jargon | `Inside selected sections` |
| Allowed | `Accept all allowed` | Всё, кроме invalid, включая needs-approval | Критический | Удалить термин; `Include all reviewable changes`, затем отдельный final Apply |
| Temporary | Chat label | In-memory, unsaved, frozen single-source Q&A | Низкий при текущем subtitle | Оставить, добавить короткое `Not saved` вместо внутреннего `last block only` в главном label; детали ниже |
| Review | Proposal, merge, versions | Три разных decision stages | Средний | Оставить как umbrella, но всегда называть объект: `Review proposed changes`, `Review merge`, `Review version` |

## 6. Dependency-risk map

### 6.1 Фактические цепочки ответственности

```text
Section edit
selection toolbar / Document menu
→ selectionUI.js / renderer.js / branchUI.js
→ app.js: enterEditMode → handleSend → doEdit
→ state.js: createEditRequestContext → createEditProposal → commitEditProposal
→ editEngine.js: proposal / authorization / materialize / validation
→ session persistence + DOCUMENT_EDIT_PROPOSED / DOCUMENT_EDIT_APPLIED

Structure edit
Document menu
→ branchUI.js → app.js: enterStructureMode
→ editReviewUI.js local draft
→ optional app.js requestStructureSectionSuggestion → structureAssistant.js
→ editEngine.js applyManualCommand / proposal
→ state.js commitEditProposal
→ one version + DOCUMENT_EDIT_APPLIED(origin=manual-structure)

Staged Undo
editReviewUI.js toast
→ app.js undoCommittedEdit
→ state.js undoLastEdit
→ editEngine.js reverse proposal + materialize
→ one new version + DOCUMENT_EDIT_APPLIED(origin=undo)

Branch switch
header/sidebar/Map menu or Map double click
→ branchUI.js switchTo
→ state.js switchBranch (save active track, load target track)
→ app.js renderAllMessages
→ session persistence + BRANCH_SWITCHED

Temporary chat
Map node/source picker
→ mapUI.js
→ state.js getBranchLastContentBlock (read-only clone)
→ temporaryChat.js in-memory session
→ app.js requestTemporaryChatAnswer / provider
→ no document/version/action-log persistence

Sibling merge
header/branch menu
→ branchUI.js → mergeUI.js
→ state.js planMerge / applyMerge
→ mergeEngine.js BASE/TARGET/SOURCE plan + materialization
→ target version + MERGE_* / BRANCH_MERGED + persisted tracks

Ancestor collapse
header/branch menu
→ branchUI.js confirm
→ state.js collapseIntoParent
→ branch graph/track rewrite under existing invariants
→ BRANCH_COLLAPSED + optional archived siblings

Version controls
renderer.js global bar
→ app.js delegated actions
→ state.js restoreVersion / acceptVersion / rejectVersion
→ live document + VERSION_* action + persistence on surrounding flow
```

### 6.2 Риск упрощений

| Категория | Что можно менять | Примеры из плана | Риск |
| --- | --- | --- | --- |
| Presentation-only | Visible copy, label hierarchy, badges, grouping, tooltips, progressive visibility | Welcome copy; `Inside selected sections`; Map role badges; `Use in draft` | Низкий, если `data-*` hooks и aria semantics сохранены |
| UI orchestration | Как view-state выбирает операции до единственного commit; lifecycle закрытия; явный existing action | Bulk include без немедленного commit; explicit `Open branch document`; discard composer draft on switch | Средний; нужны browser tests |
| State contract | Что является preview/current, как хранятся versions, что значит Undo/Restore/Reject | Сделать version arrows read-only; объединить rollback flows; менять auto-branch | Высокий; отложить |
| Engine/write boundary | Authorization, materialization subset, structural validation, merge planning | Любая попытка считать approval в renderer или bypass state | Неприемлемо для UX patch |
| Persistence/action log | Types, payloads, append-only order, branch tracks/bases | Менять Accept/Reject semantics, collapse, merge apply | Высокий; затронет audit guarantees и много tests |

### 6.3 Скрытая связанность, важная для будущих UI-изменений

- `renderer.js` создаёт и document entry point, и version bar, и historical assistant blocks; простая перестановка chrome затрагивает app callbacks.
- `branchUI.js` одновременно отвечает за sidebar, branch menus, document menu и composer context; изменение терминов в одном месте легко оставит другое значение старым.
- `app.js` маршрутизирует один textarea в chat, document edit и prompt rewrite через глобальные flags; draft не принадлежит branch track.
- `editReviewUI.js` обслуживает две разные state machines — model proposal и structure draft — внутри одного modal и общих callbacks.
- `HectraState.restoreVersion()` одновременно служит version navigation и explicit History Restore; presentation-only исправление не сделает navigation read-only.
- `mergeUI.plan` хранит mutable decisions вне canonical state до Apply, поэтому generic branch/workspace transitions должны явно закрывать или инвалидировать surface.
- Map selection является local view-state, active branch — canonical state, temporary source — frozen session state; их нельзя визуально объединить в один `selectedBranchId`.

## 7. Minimal simplification patch

Рекомендуемый первый patch: **4 изменения, 8 runtime-файлов максимум**, без новых сущностей и без изменения state/engine contracts. Ожидаемые runtime-файлы: `js/app.js`, `js/renderer.js`, `js/selectionUI.js`, `js/branchUI.js`, `js/editReviewUI.js`, `js/mapUI.js`, `js/mergeUI.js`, `css/workspace-branches.css`. `workspace.html`, `state.js`, `editEngine.js`, `mergeEngine.js`, persistence и action log не менять.

### Patch 1 — назвать объект каждого Edit

- **Before:** welcome говорит `Press Edit`; context chip в разных modes говорит `Editing`; menu содержит `Edit whole document` и `Edit structure`.
- **After:** welcome указывает фактические entry points; prompt action — `Revise request`; selection — `Change section(s)`; whole document — `Change whole document`; structure — `Reorder, add or remove sections`. Composer chip всегда называет объект и поясняет: selected text supplies context, whole section is the change boundary.
- **Файлы:** `js/app.js`, `js/renderer.js`, `js/selectionUI.js`, `js/branchUI.js`.
- **Не меняется:** request routing, frozen context, target ids, prompt regeneration, branch creation.
- **Риск:** низкий; возможны устаревшие aria labels/tooltips.
- **Тесты:** browser assertions для clean welcome, selection toolbar, three composer modes и frozen-parent notice; Node suite должна остаться 127/127.
- **Готово, когда:** newcomer может по одному visible noun отличить request, section, whole document и structure.

### Patch 2 — один final action в staged review

- **Before:** каждая card имеет Accept/Reject; footer одновременно предлагает Reject all, Accept selected и `Accept all allowed`, который сразу даёт approval и коммитит.
- **After:** card управляет inclusion (`Include` / `Exclude`); secondary bulk controls только меняют inclusion (`Include all reviewable`, `Exclude all`); единственный primary — `Apply included changes`. `Needs approval` становится `Outside selected sections` или `Changes document structure` с коротким explicit-permission text; invalid — `Cannot apply`.
- **Файлы:** `js/editReviewUI.js`, `css/workspace-branches.css`.
- **Не меняется:** operation authorization, invalid blocking, accepted ids, materialization, freshness, one atomic commit.
- **Риск:** средний: нужно сохранить decisions при re-render и не превратить bulk include в implicit commit.
- **Тесты:** browser QA для mixed proposal, invalid, zero included, bulk include, partial commit и Escape policy; существующие edit-engine tests неизменны.
- **Готово, когда:** любое применение proposal заканчивается ровно одной одинаково названной кнопкой, а дополнительное разрешение видно до неё.

### Patch 3 — явное различие Map source и navigation

- **Before:** single click выбирает Q&A source, double click открывает document; active/selected/source различаются в основном цветом.
- **After:** после single click contextual bar показывает `Question context: <branch>` и две кнопки: primary `Ask about snapshot`, secondary `Open branch document`; active node получает text badge `Open document`. Double click можно сохранить shortcut, но не единственный прямой путь.
- **Файлы:** `js/mapUI.js`, `css/workspace-branches.css`.
- **Не меняется:** `switchBranch()`, single-source rule, frozen last block, drawer lifecycle, context isolation.
- **Риск:** низкий/средний: не допустить switch по самому selection click и сохранить keyboard path.
- **Тесты:** browser QA: selection не меняет active branch; explicit Open меняет; temp source остаётся frozen; narrow layout не ломается.
- **Готово, когда:** без чтения bottom hint видно, какая branch открыта и что произойдёт с выбранной.

### Patch 4 — назвать уровень обратимости

- **Before:** `Undo`, `Undo local action`, proposal/merge/version `Accept/Reject`, `Use suggestion`.
- **After:** toast — `Revert applied change`; structure — `Undo last draft action`; agent — `Use in draft`; merge AI proposal — `Use combined text` / `Discard combination`; version controls получают точные consequences в labels/tooltips, не generic Accept/Reject.
- **Файлы:** `js/renderer.js`, `js/editReviewUI.js`, `js/mergeUI.js`.
- **Не меняется:** undo implementation, version pruning, merge plan/apply, action-log records.
- **Риск:** средний из-за необходимости честно назвать текущую нетривиальную version semantics; конкретная wording зависит от founder answer №2.
- **Тесты:** browser text/flow checks после auto-edit, structure suggestion, Combine и merge apply; manual verification screen reader/tooltip wording.
- **Готово, когда:** каждый control отвечает на вопрос «что именно изменится сейчас: draft, proposal, document или version history?».

### Общая проверка первого patch

- `npm test` остаётся **127/127**; новые Node tests нужны только если появится чистый helper, но UI-copy не оправдывает новый framework.
- `diagnostics/browser-qa.js` расширяется только для изменённых flows: no implicit bulk commit, explicit Map open, labels/lifecycle.
- Manual browser QA: clean first run; selected-fragment clarification; mixed unsafe review; structure agent; Map source/open; Combine → Apply → version controls; desktop и 600 px viewport.
- Никаких изменений `state.js`, engines, Markdown protocol, storage schema или action-log types в этом patch.

## 8. Deferred changes

Следующие идеи разумны, но их нельзя смешивать с первым patch:

1. **Разделить version preview и Restore.** Стрелки должны либо быть честно названы state-changing actions, либо работать через read-only preview до явного Restore. Это требует нового state/UI contract и action-log тестов.
2. **Решить публичный статус History.** Либо добавить конкретный entry point `Version history`, либо исключить Restore из product mental model. Нельзя просто вернуть старую кнопку без product decision.
3. **Привязать composer draft к branch/mode.** При switch предложить discard/keep for branch или хранить per-track draft; это orchestration/state design, а не copy fix.
4. **Упростить structure rows.** После telemetry/manual validation оставить один selected-row toolbar или contextual `More`, но не прятать Delete/Add без доступной альтернативы.
5. **Определить роль `Ask agent`.** Если это general section rewrite, объединить entry model с обычным Change section; если только scaffold new section, показывать прежде всего на empty/new rows.
6. **Сократить merge choice screens.** `Quick merge` может сразу открывать preview, а branch timeline стать secondary disclosure; требует отдельной проверяемой merge iteration.
7. **Переименовать ancestor collapse.** Меню и confirm должны говорить `Collapse into parent`/`Continue as one branch`; возможный archive siblings должен быть отдельным, очень явным решением.
8. **Нормализовать Escape и surface transitions.** Нужна маленькая cross-surface policy: discard confirmation для dirty local draft, close harmless plan, stale-safe proposal handling.
9. **Сделать message actions обнаружимыми.** После выбора продуктовой приоритетности можно оставить один visible `Branch`/`More`, а не три hover-only icons.
10. **Ослабить визуальное повторение commit result.** Changelog, diff, toast и version bar можно иерархически сгруппировать, но не удалять audit/recovery affordances до решения version semantics.

## 9. Features that should not be touched

- `editEngine.js` как единая реализация proposal preview и accepted-subset materialization.
- Frozen request context, включая copied `targetSectionIds`, `branchId` и deep `baseSnapshot`.
- State-layer write authorization: renderer не должен решать, что можно записать.
- Pending proposal без live mutation, freshness check и запрет silent rebase.
- Atomic one-version commit и structural invariants.
- Append-only action log и различие `DOCUMENT_EDIT_PROPOSED`/`DOCUMENT_EDIT_APPLIED`.
- Recoverable staged Undo как новая validated version, а не скрытое удаление истории.
- Manual structure через тот же edit engine.
- Leaf-only write rule, branch tracks/bases и запрет orphaning descendants.
- Three-way sibling merge и отдельная механика ancestor collapse на уровне state, даже если UI-термины надо развести.
- Temporary chat isolation: single source, frozen last block, no persistence, no ordinary composer/history/merge contamination.
- Markdown model protocol, provider layer, document section model и existing persistence schema.

Эти механики создают основную ценность и safety boundary. UX должен сделать их понятнее, но не переносить ответственность в renderer и не сокращать число технических проверок.

## 10. Questions for the founder

1. **Что является главным продуктом на первом экране: документ или разговор, который производит документ?** От этого зависит, достаточно ли исправить labels или нужно сильнее визуально отделить live document от conversation feed.
2. **Должен ли version `Accept` действительно удалять все альтернативные snapshots, и должен ли `Restore` быть доступен обычному пользователю?** Без ответа нельзя честно переименовать version controls или решить, является ли bar review либо history navigation.
3. **Какое действие должно быть primary при клике на Map node: открыть document или выбрать question context?** От ответа зависит, оставлять ли текущий single-click semantics или только добавить explicit Open.
4. **`Ask agent` в Edit structure — универсальный способ переписать section или средство заполнить новую/пустую section?** Это определяет, является ли он вторым entry point для одной функции или отдельным scaffold flow.
5. **Отправка из frozen parent должна автоматически создавать branch или сначала просить явное подтверждение?** Это решение меняет цену leaf-only rule для новичка и policy сохранения composer draft.

## Проверка соответствия и доказательная база

### Что было проверено

- Полностью прочитаны актуальные `workspace.html`, `css/workspace.css`, `css/workspace-branches.css` и runtime-модули, отвечающие за renderer, composer, selection, branches, staged edit, structure, Map, temporary chat, merge, versions, History и state boundary.
- Сверена `PROJECT_TECHNICAL_DOCUMENTATION(4).md`, включая staged pipeline, structure assistant, branch tracks, Map/temporary lifecycle, merge, persistence и заявленную test matrix.
- Запущен `node diagnostics/browser-qa.js`: все текущие checks прошли, включая staged commit/Undo, mixed review, structure agent, source picker, frozen temporary context и responsive drawer.
- Выполнен отдельный headless Chrome walkthrough чистого first-run и сценариев A–G с реальными DOM events и runtime state transitions. Фактические наблюдения: 12 buttons в mixed review; 22 buttons в structure modal для трёх sections; около 30 после Add/agent panel; auto-apply одновременно показывает Undo toast и version Accept/Reject; Escape не закрывает edit review; temporary drawer не переключает active branch.
- Отдельно пройден merge conflict: `Quick merge → Resolve → Combine → Accept → Apply merge → version Accept/Reject`; подтверждены разные sibling/ancestor menu actions.
- Запущен `npm test`: **127 tests, 127 passed, 0 failed**. Первый sandboxed запуск получил environment-only `EPERM` на `lstat C:\Users\user`; повтор вне filesystem sandbox прошёл полностью.

### Расхождения между источниками

1. **Runtime microcopy против runtime UI:** welcome всё ещё говорит `Press Edit on a response`, но фактический response control — `Document ⋯`, а section edit открывается selection toolbar. Это реальная текущая UX-ошибка.
2. **Исторические screenshots против актуального runtime:** `diagnostics/ui-states/*.png` показывают публичный `History` в header и более старую Map без current temporary-source bar. Текущий код и документация согласованно считают History internal, а Map single click использует для source selection. Документация предупреждает, что diagnostics artifacts AUXILIARY/исторические, но сами изображения не имеют явной stale-маркировки.
3. **Комментарий против кода:** комментарий в Map pointer flow всё ещё говорит, что plain click должен «open its branch»; фактически single click вызывает `_selectNode()`, а open выполняется double click или menu `Open`.
4. **Охват diagnostics против product flows:** актуальный `browser-qa.js` хорошо проверяет safety/isolation, но не проверяет first-run comprehension, prompt-edit draft при branch switch, sibling-versus-ancestor terminology, version arrow semantics и публичную обнаружимость Restore. Это не failure диагностики, а граница её назначения.
5. Существенных расхождений между техническим описанием staged write boundary, temporary-chat isolation, structure assistant и фактическим кодом не обнаружено; заявленные 127 tests и browser smoke подтверждены.

## Рекомендуемый порядок после founder answers

1. Зафиксировать словарь действий и четыре целевых понятия.
2. Реализовать четыре изменения minimal patch без state/engine edits.
3. Расширить browser QA только на изменённые paths и провести короткий moderated first-use walkthrough.
4. После получения evidence отдельно принять решение о versions/History; не смешивать его с terminology patch.
5. Только затем рассматривать structure-row disclosure и merge flow compression.
