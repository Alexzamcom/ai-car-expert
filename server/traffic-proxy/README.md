# Сервер пробок AI Car Expert (TomTom)

Отдельный Cloudflare Worker `ai-car-expert-traffic` между приложением и TomTom. Ключ TomTom хранится **только в секрете
Worker** (`TOMTOM_KEY`): не в приложении, не в браузере, не в GitHub. Другие Worker'ы аккаунта (ИИ-прокси, Yenota,
TVoy Hub) не затрагиваются. Только бесплатные тарифы TomTom и Cloudflare.

## Что делает владелец (только в браузере)

1. **Ключ TomTom (бесплатно, без банковской карты).** https://developer.tomtom.com/user/register → подтвердите почту →
   https://developer.tomtom.com/user/me/apps — ключ «My first API key» создаётся сам. Скопируйте его, никуда не
   отправляйте (понадобится в шаге 4). Платный тариф не включайте.
2. **Токен Cloudflare.** https://dash.cloudflare.com/profile/api-tokens → *Create Token* → шаблон **Edit Cloudflare Workers**
   → Account Resources: ваш аккаунт; Zone Resources: *All zones* → *Create Token* → скопируйте.
   Cloudflare не умеет ограничить токен одним Worker'ом: технически он даёт править все Worker'ы аккаунта. Workflow
   работает только с `ai-car-expert-traffic` и хранилищем `ai-car-expert-traffic-usage`; после развёртывания токен можно
   удалить на той же странице (*⋯ → Delete*) и создать заново, когда понадобится обновление.
3. **Токен — в секреты GitHub.** https://github.com/Alexzamcom/ai-car-expert/settings/secrets/actions/new →
   Name: `CLOUDFLARE_API_TOKEN`, Secret: токен из шага 2 → *Add secret*. После этого Claude запускает развёртывание.
4. **Ключ TomTom — в секрет Worker** (после развёртывания): https://dash.cloudflare.com → Workers & Pages →
   `ai-car-expert-traffic` → Settings → Variables and Secrets → *Add* → Type **Secret**, Name `TOMTOM_KEY`,
   Value — ключ из шага 1 → *Deploy*.

## Защита квоты

| Мера | Что даёт |
| --- | --- |
| Суточные потолки: тайлы 5000, маршруты 300, отрезки 500, происшествия 300 | ≈ 150 тыс. тайлов в месяц при бесплатных ~200 тыс.; дальше 429, платных запросов нет |
| Только Украина и соседи, тайлы z 6–16 | запросы по всему миру квоту не тратят |
| Только с адреса приложения (Origin) + 120 запросов в минуту с одного IP | защита от чужого использования |
| Кэш в памяти Worker и `Cache-Control` 1–2 мин | одинаковые тайлы и маршруты не запрашиваются повторно |
| Счётчики в KV, запись пачками | бесплатный KV — 1000 записей в сутки |
| `REQUIRE_KV=1` | без хранилища счётчиков к TomTom не обращаемся |
| TomTom ответил 403/429 | приложению — «лимит», а не «пробок нет» |

Точный расход — в кабинете TomTom (Dashboard → Usage). Счётчики Worker — `GET /usage`.

## Адреса

| Адрес | Доступ | Что |
| --- | --- | --- |
| `GET /health` | всем | настроен ли ключ и хранилище (без ключа в ответе) |
| `GET /usage` | всем | расход за сутки и потолки |
| `GET /diag` | всем, раз в 10 мин | проверка реальных данных: Павлоград, Днепр, трасса между ними, маршрут с пробками, происшествия, тайлы |
| `GET /tiles/{flow,incidents}/{z}/{x}/{y}.png` | приложение | растровые тайлы потока и происшествий (512 px) |
| `GET /flow?lat=&lon=` | приложение | скорость на отрезке, свободная скорость, достоверность, перекрытие |
| `GET /route?points=lat,lon;lat,lon[&alternatives=0..2]` | приложение | маршрут с пробками: время, задержка, без пробок, участки задержек |

Развёртывание и проверки — `.github/workflows/traffic-proxy.yml` (Actions → Traffic proxy (TomTom) → Run workflow:
`deploy`, `diag`, `usage`, `terms`).
