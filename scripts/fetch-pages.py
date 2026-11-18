# Выдержки со страниц первоисточников о поставщиках пробок для Украины (запуск в GitHub Actions — там открыт интернет).
import re, html, urllib.request, urllib.parse

UA = {"User-Agent": "Mozilla/5.0 (Macintosh; Intel Mac OS X 14_0) AppleWebKit/605.1.15 Safari/605.1.15"}

def get(url):
    raw = urllib.request.urlopen(urllib.request.Request(url, headers=UA), timeout=40).read().decode("utf-8", "ignore")
    t = re.sub(r"(?is)<(script|style)[^>]*>.*?</\1>", " ", raw)
    t = html.unescape(re.sub(r"<[^>]+>", "\n", t))
    return raw, [l.strip() for l in t.split("\n") if l.strip()]

def section(title):
    print("\n" + "=" * 24, title)

def around(lines, rx, before=3, after=8, limit=8):
    r = re.compile(rx, re.I)
    n = 0
    for i, l in enumerate(lines):
        if r.search(l):
            print("  > " + " | ".join(lines[max(0, i - before): i + after])[:900])
            n += 1
            if n >= limit:
                break
    if not n:
        print("  (нет совпадений с", rx, ")")

def safe(fn):
    try:
        fn()
    except Exception as e:
        print("  недоступно:", str(e)[:200])

# 1. HERE: ссылки «coverage» со страницы руководства Traffic API v7 и сами страницы покрытия
def here():
    base = "https://www.here.com/docs/bundle/traffic-api-developer-guide-v7/page/topics/coverage-information.html"
    raw, lines = get(base)
    links = sorted(set(re.findall(r'href="([^"]*coverage[^"]*)"', raw)))
    print("  ссылки:", links[:20])
    for href in links[:8]:
        url = urllib.parse.urljoin(base, href)
        section("HERE: " + url)
        def one():
            r2, l2 = get(url)
            print("  строк", len(l2), "| Ukraine в тексте:", bool(re.search(r"ukrain", r2, re.I)))
            around(l2, r"^ukraine$|ukrain", 4, 10, 4)
            around(l2, r"flow|incident", 1, 3, 3)
        safe(one)
section("HERE Traffic API v7: страницы покрытия")
safe(here)

# 2. Azure Maps: заголовок таблицы, строка Украины, сноска
def azure():
    raw, lines = get("https://learn.microsoft.com/en-us/azure/azure-maps/traffic-coverage")
    around(lines, r"^Country/Region$|Incidents|Flow", 2, 6, 3)
    around(lines, r"^Ukraine$", 8, 6, 2)
    around(lines, r"^1$|footnote|partial|limited", 1, 3, 6)
section("Azure Maps: покрытие трафика")
safe(azure)

# 3. Google Maps Platform: таблица покрытия (заголовки и строка Украины)
def gcov():
    raw, lines = get("https://developers.google.com/maps/coverage")
    i = next((k for k, l in enumerate(lines) if l == "Traffic Layer"), None)
    if i is not None:
        print("  заголовки:", " | ".join(lines[i - 6: i + 8]))
    for k, l in enumerate(lines):
        if l == "Ukraine":
            print("  Украина:", " | ".join(lines[k - 2: k + 12]))
    print("  символы: ⬤ — есть, — нет (по легенде страницы)")
    around(lines, r"legend|⬤ |indicates", 1, 3, 4)
section("Google Maps Platform: покрытие")
safe(gcov)

# 4. Google: условия Routes API и Maps JavaScript (не-Google карта, кэш, TTS)
def gterms():
    raw, lines = get("https://cloud.google.com/maps-platform/terms/maps-service-terms")
    for k, l in enumerate(lines):
        if re.match(r"^\d+\.\s*Routes API", l) or l in ("Routes API", "Roads API", "Maps JavaScript API"):
            print("  > " + " | ".join(lines[k: k + 14])[:1500])
section("Google: Service Specific Terms — Routes API")
safe(gterms)

# 5. Mapbox: покрытие трафика
def mapbox():
    for url in ["https://docs.mapbox.com/data/traffic/guides/", "https://www.mapbox.com/traffic-data", "https://docs.mapbox.com/data/tilesets/reference/mapbox-traffic-v1/", "https://www.mapbox.com/pricing"]:
        section("Mapbox: " + url)
        def one():
            raw, lines = get(url)
            print("  строк", len(lines), "| Ukraine в коде:", bool(re.search(r"ukrain", raw, re.I)))
            around(lines, r"ukrain|coverage|countries|traffic", 1, 4, 5)
        safe(one)
safe(mapbox)
