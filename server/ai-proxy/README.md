# ИИ-прокси AI Car Expert (OpenAI и Grok)

Небольшой Cloudflare Worker между приложением и API провайдера. Ключи OpenAI и xAI хранятся **только здесь**
(в секретах Cloudflare), никогда — в приложении, браузере или репозитории.

Отдельный сервер, не VPS, не Yenota и не TVoy Hub. Бесплатного тарифа Cloudflare Workers достаточно.

## Подписка и API — разные вещи

- **ChatGPT Plus / Pro** не даёт доступа к API. API OpenAI оплачивается отдельно: https://platform.openai.com →
  Billing (пополнить баланс, задать лимит расходов) → API keys.
- **SuperGrok / X Premium** не даёт доступа к API xAI. API: https://console.x.ai.
- Использовать подписку вместо ключа API (cookies, неофициальные клиенты) нельзя — это нарушает условия сервисов.

## Подключение OpenAI (≈10 минут)

1. **Ключ OpenAI.** platform.openai.com → Settings → Billing: пополните баланс и задайте
   *Usage limits* (месячный лимит — главная защита бюджета). Затем API keys → *Create new secret key*.
   Лучше отдельный проект с ограниченными правами (только Chat Completions / Responses).
2. **Модель.** Проверьте на platform.openai.com/docs/models, какая небольшая быстрая модель с function calling
   доступна вашему аккаунту, и впишите её в `wrangler.toml` → `OPENAI_MODEL` (по умолчанию `gpt-5-mini`).
   Для моделей без рассуждения удалите строку `OPENAI_REASONING_EFFORT`.
3. **Развёртывание:**

   ```bash
   cd server/ai-proxy
   npx wrangler login
   npx wrangler secret put OPENAI_API_KEY   # вставить ключ OpenAI
   npx wrangler secret put ACCESS_TOKEN     # длинная случайная строка: openssl rand -hex 24
   # необязательно, Grok как альтернатива:
   npx wrangler secret put XAI_API_KEY
   npx wrangler deploy
   ```

   Wrangler выведет адрес `https://ai-car-expert-ai.<аккаунт>.workers.dev`.
4. **Приложение:** Настройки → «ИИ-помощник» → адрес `https://…workers.dev/chat`, токен — значение `ACCESS_TOKEN`
   → «Сохранить» → «Проверить связь» (покажет провайдера и модель). Там же: провайдер (OpenAI / Grok), режим,
   лимит запросов в сутки, месячный бюджет и цены за 1 млн токенов (с сайта провайдера) — для оценки расходов.

Если раньше был развёрнут `ai-car-expert-grok`, он продолжит работать как есть (только Grok). Новый воркер
разворачивается под именем `ai-car-expert-ai`; старый можно удалить в панели Cloudflare.

## Настройки (`wrangler.toml`)

| Переменная | Назначение |
| --- | --- |
| `ALLOWED_ORIGINS` | откуда разрешены запросы (GitHub Pages приложения) |
| `DEFAULT_PROVIDER` | `openai` или `grok`, если приложение не указало |
| `OPENAI_MODEL`, `OPENAI_REASONING_EFFORT` | модель OpenAI и уровень рассуждения (`minimal` — быстрее и дешевле) |
| `GROK_MODEL` | модель xAI |
| `MAX_TOKENS` | предел длины ответа (короткие ответы удобнее в машине и дешевле) |
| `RATE_LIMIT_PER_MIN` | запросов в минуту с одного IP |
| `DAILY_REQUEST_LIMIT` | запросов в сутки ко всем провайдерам; с привязкой KV `USAGE` — общий счётчик для всех экземпляров |

## Защита и расходы

- Ключи провайдеров — только секреты Worker; в ответы и сообщения об ошибках не попадают (проверено тестами).
- Запросы только с разрешённых Origin и с токеном приложения (сравнение за постоянное время). Токен приложения
  хранится на устройстве; если он утёк — смените `ACCESS_TOKEN` (`wrangler secret put`), ключ OpenAI менять не нужно.
- Модель, длину ответа и лимиты задаёт сервер, а не клиент. Тело запроса проверяется: роли, размеры, имена инструментов.
- Три уровня ограничения расходов: лимит в кабинете OpenAI/xAI → суточный лимит сервера → суточный лимит и месячный
  бюджет в приложении. Простые команды вообще не доходят до сервера.

Тесты: `npm test` в корне репозитория (`tests/unit/ai-proxy.test.ts`).
