# Выдержки со страниц первоисточников (запуск в GitHub Actions). Mapbox: страны с пробками, лимиты, условия.
import re, html, urllib.request

UA = {"User-Agent": "Mozilla/5.0 (Macintosh; Intel Mac OS X 14_0) AppleWebKit/605.1.15 Safari/605.1.15"}
def raw(url):
    return urllib.request.urlopen(urllib.request.Request(url, headers=UA), timeout=40).read().decode("utf-8", "ignore")
def clean(s):
    s = re.sub(r"(?is)<(script|style|nav|header|footer)[^>]*>.*?</\1>", " ", s)
    return re.sub(r"\s+", " ", html.unescape(re.sub(r"<[^>]+>", " ", s))).strip()
def show(url, rx, width=300, limit=10, is_md=False):
    print("\n" + "=" * 24, url)
    try:
        r = raw(url)
    except Exception as e:
        print("  недоступно:", str(e)[:160]); return ""
    t = r if is_md else clean(r)
    print("  символов:", len(t))
    n = 0
    for m in re.finditer(rx, t, re.I):
        s = max(0, m.start() - width)
        print("  >", t[s: m.end() + width].replace("\n", " ")[: 2 * width + 80]); n += 1
        if n >= limit: break
    if not n: print("  (нет совпадений)")
    return r

# Ссылка на страницу с перечнем стран (из описания профиля driving-traffic)
md = raw("https://docs.mapbox.com/api/navigation/directions.md")
links = sorted(set(re.findall(r"\((https://docs\.mapbox\.com/help/[^)]*traffic[^)]*)\)", md)))
print("ссылки на страницы трафика:", links)
for m in re.finditer(r"(?i)ukrain", md):
    print("  Украина в directions.md:", md[max(0, m.start() - 400): m.end() + 200].replace("\n", " "))
for u in links + ["https://docs.mapbox.com/help/glossary/traffic-data.md", "https://docs.mapbox.com/help/getting-started/traffic.md"]:
    show(u, r"ukrain|countries|coverage|europe|poland", 250, 12, is_md=u.endswith(".md"))
# Бесплатные лимиты
show("https://docs.mapbox.com/api/navigation/directions.md", r"free tier|pricing|billed|requests per minute|rate limit", 200, 8, True)
show("https://www.mapbox.com/pricing", r"Directions API|Vector Tiles API|Map loads for Web|Up to [0-9,]+ Free|free requests", 250, 20)
# Условия использования API с картой не от Mapbox
for u in ["https://www.mapbox.com/legal/tos", "https://www.mapbox.com/legal/service-terms", "https://www.mapbox.com/legal/product-terms", "https://www.mapbox.com/legal/supplemental-terms"]:
    show(u, r"(?<![\w-])(non-Mapbox map|other than a Mapbox map|with a Mapbox map|in conjunction with|on a map|Directions API|Traffic|cach)", 300, 10)
