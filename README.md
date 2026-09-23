# Silvius

Веб-оболочка для анализа организационной структуры до и после реорганизации. Сейчас работают регистрация, вход, серверные сессии и закрытое рабочее пространство. Загрузка документов и запуск отдельного ИИ-агента пока представлены в интерфейсе как прототип: файлы не отправляются на сервер и результаты не сохраняются.

## Quick start for reviewers

1. Install **Node.js 24 LTS (version 24.14.0 or newer within the 24.x line)**, which includes npm.
2. Download and extract the repository, or clone it.
3. Open a terminal in the directory containing `package.json`.
4. Run `npm ci`, then `npm start`.
5. Open **http://localhost:3000**.
6. Choose **Регистрация** and register with your own email and password.

Google credentials and a `.env` file are **not required** for this workflow. Google login is optional and disabled in installations without credentials; reviewers do not need Google login to use the application. Credentials in the developer's `.env` are not included in the repository. SQLite data is stored locally in `data/silvius.sqlite` and survives application restarts. No Docker or separate database installation is needed.

## Запуск для жюри

Установите **Node.js 24 LTS, версия 24.14.0 или новее в рамках ветки 24**, вместе с npm. Дополнительные базы данных, Docker, компиляторы и глобальные npm-пакеты не нужны. Из корня репозитория выполните:

```text
npm ci
npm start
```

Откройте **http://localhost:3000**. Создайте свой аккаунт на вкладке «Регистрация», затем можно выйти и снова войти. Публичного демонстрационного аккаунта нет. Сервер слушает только `localhost`.

При первом старте автоматически создаются каталог `data/`, файл `data/silvius.sqlite`, таблицы и локальный случайный секрет сессий `data/session-secret`. При повторном старте миграции применяются без удаления пользователей и сессий. Эти файлы, а также SQLite WAL/SHM, `.env`, `uploads/` и `node_modules/` исключены из Git. Для остановки сервера нажмите **Ctrl+C**. Последующий запуск: `npm start`.

Чтобы **явно удалить все локальные аккаунты и сессии**, сначала остановите сервер, затем выполните `npm run reset:local`. Команда также удаляет локальные загрузки, если они появятся в будущих версиях. После `npm start` база создастся заново.

## Проверки

```text
npm test
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

- **При регистрации появляется `NetworkError`** — проверьте адресную строку: страница должна быть открыта по `http://localhost:3000/auth.html`, а не через `file://` или отдельный статический сервер. Запустите `npm start` из корня репозитория.
- **`node:sqlite` не найден / неподходящая версия Node.js** — установите Node.js 24 LTS версии 24.14.0+ и повторите `npm ci`.
- **Порт 3000 занят** — остановите другую программу или задайте `PORT` в `.env`; при изменении порта обновите `APP_URL` и Google callback, если используете Google.
- **Google-кнопка недоступна** — это ожидаемо без Google credentials; обычный email-вход работает.
- **Google сообщает `redirect_uri_mismatch`** — сравните URL в Google Cloud и `.env` посимвольно.
- **Нет доступа к npm registry** — для первого `npm ci` нужен интернет; после установки зависимостей обычный локальный вход интернет не требует.

Фронтенд находится в `frontend_silvius/`, Express API — в `server/`, интеграционные тесты — в `tests/`. Внутренняя логика ИИ-агента в этом репозитории не реализована.
