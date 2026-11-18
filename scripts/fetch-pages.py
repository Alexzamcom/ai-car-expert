# Выдержки со страниц первоисточников (запуск в GitHub Actions — там открыт интернет). Сейчас: Mapbox — пробки в Украине.
import re, html, urllib.request, urllib.parse

UA = {"User-Agent": "Mozilla/5.0 (Macintosh; Intel Mac OS X 14_0) AppleWebKit/605.1.15 Safari/605.1.15"}

def raw(url):
    return urllib.request.urlopen(urllib.request.Request(url, headers=UA), timeout=40).read().decode("utf-8", "ignore")

def clean(s):
    s = re.sub(r"(?is)<(script|style)[^>]*>.*?</\1>", " ", s)
    return re.sub(r"\s+", " ", html.unescape(re.sub(r"<[^>]+>", " ", s))).strip()

def show(url, rx, width=350, limit=12):
    print("\n" + "=" * 24, url)
    try:
        r = raw(url)
    except Exception as e:
        print("  недоступно:", str(e)[:160])
        return ""
    t = clean(r) if "<html" in r[:2000].lower() or "<!doctype" in r[:200].lower() else r
    print("  символов:", len(t), "| Ukraine:", bool(re.search(r"ukrain", t, re.I)))
    n = 0
    for m in re.finditer(rx, t, re.I):
        s = max(0, m.start() - width)
        print("  >", t[s: m.end() + width].replace("\n", " ")[: 2 * width + 60])
        n += 1
        if n >= limit:
            break
    return r

# Индекс документации о пробках Mapbox и все страницы из него
idx = show("https://docs.mapbox.com/data/traffic/llms.txt", r"coverage|countr|live|typical", 120, 40)
for u in sorted(set(re.findall(r"\((https://docs\.mapbox\.com/data/traffic/[^)]+)\)", idx or ""))):
    show(u, r"ukrain|coverage|countr|update|live traffic|freshness|licen|pric", 250, 8)

# Маршруты с пробками (профиль driving-traffic)
show("https://docs.mapbox.com/api/navigation/directions/", r"driving-traffic|traffic coverage|ukrain|congestion", 250, 10)
show("https://docs.mapbox.com/api/navigation/directions.md", r"driving-traffic|congestion|ukrain", 250, 8)
# Плитки пробок mapbox-traffic-v1
show("https://docs.mapbox.com/data/tilesets/reference/mapbox-traffic-v1.md", r"congestion|coverage|update|countr|ukrain", 250, 8)
# Цены и бесплатные лимиты
show("https://www.mapbox.com/pricing", r"free|directions|vector tiles api|map loads|traffic", 200, 25)
# Условия: использование данных Mapbox с картой не от Mapbox
show("https://www.mapbox.com/legal/tos", r"non-mapbox|other map|third-party map|mapbox map|cach|store", 300, 15)
show("https://www.mapbox.com/legal/product-terms", r"non-mapbox|other map|third-party map|mapbox map|traffic|directions", 300, 15)
