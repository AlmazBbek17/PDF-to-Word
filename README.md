# pdf-to-word-backend

Конвертирует PDF в .docx через Claude API (vision-разбор каждой страницы: текст, заголовки, таблицы, с пометкой неуверенных фрагментов).

## Как это работает

1. `POST /convert` принимает PDF (multipart, поле `file`) и опционально `pages` — список номеров страниц через запятую (`"1,3,5"`), если нужны не все.
2. Каждая страница рендерится в JPEG через `pdftoppm` (poppler-utils).
3. Каждая картинка отправляется в Claude (`messages.create` с vision) с промптом, который просит вернуть JSON-структуру блоков (заголовки/абзацы/таблицы), помечая неуверенные фрагменты `{{...}}`.
4. Результат собирается в .docx (`docx` npm-пакет) — неуверенные фрагменты подсвечиваются цветом прямо в документе.
5. Сервер отдаёт готовый .docx файл в ответе.

## Локальный запуск

```bash
cp .env.example .env
# впиши свой ANTHROPIC_API_KEY в .env

npm install
npm start
```

Сервер поднимется на `http://localhost:3000`. Проверка: `GET /health` → `{"ok":true}`.

**Системная зависимость:** нужен `poppler-utils` (даёт бинарник `pdftoppm`).
- Ubuntu/Debian: `sudo apt install poppler-utils`
- macOS: `brew install poppler`

## Пример запроса

```bash
curl -X POST http://localhost:3000/convert \
  -F "file=@/path/to/document.pdf" \
  -F "pages=1,2,3" \
  -o result.docx
```

## Деплой на Railway

1. Залей эту папку в свой GitHub-репозиторий:
   ```bash
   git init
   git add .
   git commit -m "pdf-to-word backend"
   git branch -M main
   git remote add origin https://github.com/<твой-юзернейм>/pdf-to-word-backend.git
   git push -u origin main
   ```
2. На [railway.app](https://railway.app) → New Project → Deploy from GitHub repo → выбери этот репозиторий.
3. Railway сам подхватит `nixpacks.toml` (ставит `poppler-utils`) и `railway.json` (команда старта `npm start`).
4. В настройках проекта → Variables добавь:
   - `ANTHROPIC_API_KEY` — твой ключ с [console.anthropic.com](https://console.anthropic.com)
   - (опционально) `ANTHROPIC_MODEL` — по умолчанию `claude-sonnet-5`
5. После деплоя Railway выдаст публичный URL вида `https://<project>.up.railway.app` — это и есть `API_BASE_URL` для расширения (см. `config.js` в папке расширения).

## Настройка авторизации и оплаты (Google + Dodo Payments)

Без этого блока сервер всё равно запустится (конвертация и превью работают без учёта записи), но `/convert` будет требовать авторизацию и вернёт 401 всем, у кого нет `DATABASE_URL`/`SESSION_JWT_SECRET`.

### 1. Postgres

На Railway: **New → Database → PostgreSQL** в том же проекте. Railway сам создаст `DATABASE_URL` и подставит его как переменную окружения в твой сервис (если сервисы в одном проекте — переменная подтянется автоматически через reference, либо скопируй строку подключения вручную в Variables).

Таблицы создаются автоматически при старте сервера (`initDb()` в `db.js`).

### 2. Google OAuth (для входа в один клик из расширения)

1. Зайди в [Google Cloud Console](https://console.cloud.google.com/apis/credentials) → создай проект (если ещё нет)
2. **Create Credentials → OAuth client ID → Application type: Chrome Extension**
3. В поле **Item ID** укажи ID своего расширения (виден в `chrome://extensions` после загрузки — он стабилен, пока не переустанавливаешь расширение с нуля)
4. Скопируй выданный **Client ID** (вида `xxxxx.apps.googleusercontent.com`)
5. Вставь его в **двух местах**:
   - `manifest.json` расширения → `oauth2.client_id`
   - `.env` бэкенда → `GOOGLE_CLIENT_ID`

### 3. Dodo Payments

1. В [дашборде Dodo](https://app.dodopayments.com) создай 3 подписочных продукта (Subscription), соответствующих тарифам ($5/50 стр, $10/120 стр, $15/200 стр)
2. Скопируй их `product_id` в переменные `DODO_PRODUCT_ID_5`, `DODO_PRODUCT_ID_10`, `DODO_PRODUCT_ID_15`
3. Возьми API-ключ (**Developer → API Keys**) → `DODO_PAYMENTS_API_KEY`
4. Настрой вебхук: **Developer → Webhooks → Add Webhook**, URL: `https://твой-бэкенд/webhooks/dodo`, включи события `subscription.active`, `subscription.renewed`, `subscription.plan_changed`, `subscription.cancelled`, `subscription.expired`, `subscription.failed`
5. Скопируй секрет вебхука → `DODO_WEBHOOK_SECRET`
6. `PUBLIC_BASE_URL` — публичный адрес твоего бэкенда (нужен, чтобы после оплаты Dodo знал, куда вернуть пользователя)

### Как это работает целиком

1. На бесплатном тарифе у нового юзера 10 страниц (разово, не сгорает и не обновляется помесячно — это стартовый лимит)
2. Как только `/convert` видит, что нужно больше страниц, чем осталось в лимите — возвращает `402`, расширение показывает пейвол
3. Юзер жмёт "Войти через Google" → `chrome.identity.getAuthToken` (использует уже залогиненный в браузере аккаунт, без формы логина) → токен уходит на бэкенд, тот проверяет его через Google и выдаёт свою сессионную JWT
4. Юзер выбирает тариф → бэкенд создаёт Dodo Checkout Session с его email, открывается новая вкладка с оплатой
5. После оплаты Dodo шлёт вебхук на бэкенд → бэкенд активирует тариф в базе (сбрасывает счётчик страниц, поднимает лимит)
6. Расширение параллельно опрашивает `/me` каждые несколько секунд, пока не увидит активный тариф — тогда показывает "подписка активна"

## Ограничения текущей версии (честно)

- Изображения со страницы (логотипы, фото) переносятся в .docx, но всегда после текста этой страницы — не в точную визуальную позицию.
- Каждая страница — отдельный вызов Claude API, то есть стоимость и время растут линейно с числом страниц. Для книг на сотни страниц обязательно используйте параметр `pages`, чтобы не гонять всё через API.
- Нет очереди/прогресса по SSE — это синхронный запрос, ответ приходит целиком, когда все страницы обработаны.
- Проверка лимита страниц происходит только в момент самого запроса `/convert` — если юзер выбрал больше страниц, чем осталось в лимите, он сначала увидит анимацию обработки и только потом пейвол.
- `chrome.identity.getAuthToken` требует, чтобы в Google Cloud Console был зарегистрирован OAuth-клиент с типом "Chrome Extension" и точным ID расширения — если ID меняется, придётся обновлять клиент.
- Нет UI для отмены подписки изнутри расширения — сейчас это делается через Dodo Customer Portal.
