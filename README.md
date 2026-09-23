# Silvius

Веб-оболочка для анализа организационной структуры до и после реорганизации. Сейчас работают регистрация, вход, серверные сессии и закрытое рабочее пространство. Загрузка документов и запуск отдельного ИИ-агента пока представлены в интерфейсе как прототип: файлы не отправляются на сервер и результаты не сохраняются.

## Быстрый запуск для жюри — Windows PowerShell

**Шаг 1. Скачайте проект.** Откройте [репозиторий Silvius на GitHub](https://github.com/BAITC-Hacks/hack-676719dc-bebrus) в браузере. При необходимости войдите в GitHub. Нажмите зелёную кнопку **Code**, затем **Download ZIP**. Дождитесь загрузки файла в папку **Загрузки / Downloads**. Если GitHub показывает 404, попросите организаторов предоставить доступ к репозиторию. Не открывайте `index.html` двойным щелчком: регистрация работает только через запущенный сервер.

**Шаг 2. Откройте PowerShell.** Нажмите клавиши **Win + R**, напечатайте `powershell` и нажмите **Enter**. Появится окно с текстом и мигающим курсором. Не нужно запускать его от имени администратора.

**Шаг 3. Скопируйте весь блок ниже, вставьте в PowerShell клавишами Ctrl + V и нажмите Enter.** Он распакует последний скачанный ZIP проекта в `SilviusDemo` внутри вашей домашней папки, загрузит Node.js **24.14.0** с [официального сайта](https://nodejs.org/en/blog/release/v24.14.0), проверит файл, установит зависимости и запустит сервер. Первое скачивание требует интернета и может занять несколько минут. В конце должно появиться `Silvius доступен: http://localhost:3000`. После этого окно PowerShell перестанет показывать приглашение для новой команды — это нормально: сервер работает. Оставьте окно открытым, пока пользуетесь сайтом.

```powershell
$ErrorActionPreference = 'Stop'
$zip = Get-ChildItem -Path (Join-Path $HOME 'Downloads\hack-676719dc-bebrus-*.zip') -ErrorAction SilentlyContinue | Sort-Object LastWriteTime -Descending | Select-Object -First 1
if (-not $zip) { throw 'ZIP проекта не найден в Downloads. Сначала нажмите Code → Download ZIP на GitHub.' }
$projectRoot = Join-Path $HOME 'SilviusDemo'
Expand-Archive -LiteralPath $zip.FullName -DestinationPath $projectRoot -Force
Set-Location (Join-Path $projectRoot 'hack-676719dc-bebrus-main')
if (-not (Test-Path '.\package.json')) { throw 'Файл package.json не найден. Проверьте, что скачали ветку main проекта Silvius.' }

$version = 'v24.14.0'
$arch = if ([System.Runtime.InteropServices.RuntimeInformation]::OSArchitecture.ToString() -eq 'Arm64') { 'arm64' } else { 'x64' }
$tools = Join-Path $HOME 'SilviusTools'
$nodeFolder = Join-Path $tools "node-$version-win-$arch"
if (-not (Test-Path (Join-Path $nodeFolder 'node.exe'))) {
    New-Item -ItemType Directory -Path $tools -Force | Out-Null
    $nodeZip = Join-Path $tools "node-$version-win-$arch.zip"
    $ProgressPreference = 'SilentlyContinue'
    Invoke-WebRequest -UseBasicParsing -Uri "https://nodejs.org/dist/$version/node-$version-win-$arch.zip" -OutFile $nodeZip
    $expectedHash = if ($arch -eq 'arm64') { '88d36e8109736a2fa9bdc596f2cf507a3c52c69cdf96e54f8acd473ec14be853' } else { '313fa40c0d7b18575821de8cb17483031fe07d95de5994f6f435f3b345f85c66' }
    if ((Get-FileHash -LiteralPath $nodeZip -Algorithm SHA256).Hash.ToLowerInvariant() -ne $expectedHash) { throw 'Файл Node.js повреждён. Скачайте его ещё раз.' }
    Expand-Archive -LiteralPath $nodeZip -DestinationPath $tools -Force
}
$env:Path = "$nodeFolder;$env:Path"
node --version
npm.cmd ci
npm.cmd start
```

**Шаг 4. Откройте сайт.** В браузере введите в адресную строку **http://localhost:3000** и нажмите Enter. Нажмите **Регистрация**, введите своё имя, email и пароль не короче 10 символов. После регистрации можно нажать «Выйти» и проверить вход с теми же данными. Общего тестового аккаунта нет.

Google-аккаунт, `.env`, Docker и отдельная база данных **не нужны**. Кнопка Google без настроек отключена; для проверки приложения пользуйтесь email и паролем. Секреты из `.env` разработчика не входят в репозиторий. При первом запуске SQLite и таблицы создаются автоматически в `data/silvius.sqlite`; аккаунты и сессии сохраняются после закрытия и повторного запуска сервера.

### Как запустить снова

Остановите сервер клавишами **Ctrl + C**. В следующий раз откройте PowerShell тем же способом и вставьте этот короткий блок; повторно скачивать ZIP и выполнять `npm ci` не нужно:

```powershell
$arch = if ([System.Runtime.InteropServices.RuntimeInformation]::OSArchitecture.ToString() -eq 'Arm64') { 'arm64' } else { 'x64' }
$nodeFolder = Join-Path $HOME "SilviusTools\node-v24.14.0-win-$arch"
$env:Path = "$nodeFolder;$env:Path"
Set-Location (Join-Path $HOME 'SilviusDemo\hack-676719dc-bebrus-main')
npm.cmd start
```

Чтобы **удалить все локальные аккаунты и сессии**, сначала остановите сервер, затем в папке проекта выполните `npm.cmd run reset:local`. Эта команда также удаляет локальные загрузки, если они появятся в будущих версиях. Следующий запуск создаст пустую базу.

## Проверки

```powershell
npm.cmd test
```

Интеграционные тесты работают на отдельной временной SQLite-базе и не трогают `data/silvius.sqlite`. Они проверяют регистрацию, нормализацию email, вход и выход, CSRF, закрытый доступ, сохранение сессии при перезапуске, миграции, запуск без Google и отклонение неверного OAuth state.

## Необязательная настройка Google

Локальная регистрация и вход работают без Google Cloud и без `.env`. Кнопка «Продолжить с Google» видна на вкладках входа и регистрации, но отключена, пока отсутствуют оба параметра `GOOGLE_CLIENT_ID` и `GOOGLE_CLIENT_SECRET`. Под ней отображается сообщение: “Google sign-in is not configured for this installation. Use email and password.” Публичный `GET /api/auth/config` сообщает только `googleEnabled`; `true` означает наличие настроек, а не проверку доступности Google или корректности ключей. Прямой запрос к Google-маршрутам без настроек возвращает HTTP 503 с кодом `GOOGLE_AUTH_NOT_CONFIGURED`.

Для включения Google-входа:

1. Создайте в Google Cloud OAuth client типа **Web application** и настройте consent screen. Если приложение в режиме Testing, добавьте нужные тестовые аккаунты.
2. В **Authorized redirect URIs** укажите в точности `http://localhost:3000/api/auth/google/callback`. В **Authorized JavaScript origins** укажите `http://localhost:3000`.
3. Создайте файл `.env` в корне по образцу `.env.example` и заполните `GOOGLE_CLIENT_ID` и `GOOGLE_CLIENT_SECRET`. `APP_URL` и `GOOGLE_REDIRECT_URI` для порта 3000 уже имеют значения по умолчанию.
4. Перезапустите `npm start`.

Запрашиваются только `openid email profile`. Сервер не сохраняет Google access/refresh tokens. Аккаунты с одинаковым email не объединяются автоматически: при конфликте войдите первоначальным способом. Привязка аккаунтов пока не реализована. При смене порта измените также `APP_URL`, `GOOGLE_REDIRECT_URI` и redirect URI в Google Cloud.

## Конфигурация и безопасность

Необязательные переменные перечислены в `.env.example`. Значения по умолчанию для `localhost` предназначены для локальной проверки. В production используйте HTTPS, задайте `NODE_ENV=production`, `APP_URL` с `https://` и случайный `SESSION_SECRET` длиной не менее 32 символов. Секреты не размещайте в репозитории. Сессии хранятся в SQLite, браузер получает только HttpOnly cookie. Изменяющие запросы требуют CSRF-токен. Пароли хешируются через `crypto.scrypt` с индивидуальной солью. API рабочей области и хранение сравнений ещё не реализованы; поэтому доступ к данным разных пользователей проверяется на следующем этапе вместе с этими маршрутами.

## Если запуск не удался

- **При регистрации появляется `NetworkError`** — проверьте адресную строку: страница должна быть открыта по `http://localhost:3000/auth.html`, а не через `file://` или отдельный статический сервер. Окно PowerShell с запущенным `npm.cmd start` должно оставаться открытым.
- **ZIP проекта не найден** — проверьте, что браузер скачал архив в папку `Downloads` вашего пользователя. Если он попал в другую папку, переместите его в `Downloads` и повторите основной блок команд.
- **`node:sqlite` не найден / неподходящая версия Node.js** — повторите основной блок команд: он ставит Node.js 24.14.0 в `SilviusTools` и выбирает его для текущего окна PowerShell.
- **Порт 3000 занят** — закройте другое окно Silvius или программу, использующую порт 3000, и повторите `npm.cmd start`. Если меняете `PORT` в `.env`, обновите также `APP_URL` и Google callback при использовании Google.
- **Google-кнопка недоступна** — это ожидаемо без Google credentials; обычный email-вход работает.
- **Google сообщает `redirect_uri_mismatch`** — сравните URL в Google Cloud и `.env` посимвольно.
- **Нет доступа к npm registry** — для первого `npm.cmd ci` нужен интернет; после установки зависимостей обычный локальный вход интернет не требует.

Фронтенд находится в `frontend_silvius/`, Express API — в `server/`, интеграционные тесты — в `tests/`. Внутренняя логика ИИ-агента в этом репозитории не реализована.
