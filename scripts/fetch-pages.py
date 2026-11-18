# Выдержки со страниц первоисточников (покрытие, цены, условия) — запускается в GitHub Actions (там открыт интернет).
# Формат: URL и регулярное выражение; печатается контекст вокруг совпадений и число совпадений.
import re, html, sys, urllib.request

PAGES = [
    # HERE: покрытие live traffic
    ("https://www.here.com/docs/bundle/traffic-api-developer-guide-v7/page/topics/coverage-information.html", r"ukrain|coverage|countr"),
    ("https://docs.here.com/traffic-api/docs/coverage-information", r"ukrain|coverage|countr"),
    ("https://docs.here.com/traffic-api/docs/traffic-coverage", r"ukrain|coverage|countr"),
    ("https://docs.here.com/traffic-api/docs/real-time-traffic-here-traffic-api-v7-concepts", r"ukrain|coverage|countr|70"),
    ("https://www.here.com/platform/traffic-solutions/real-time-traffic-information", r"ukrain|countr"),
    ("https://www.here.com/docs/bundle/here-map-content-coverage/page/README.html", r"ukrain|traffic"),
    # Azure Maps (Microsoft) — покрытие трафика
    ("https://learn.microsoft.com/en-us/azure/azure-maps/traffic-coverage", r"^ukraine$|ukrain|footnote|\*"),
    # Mapbox — покрытие трафика
    ("https://docs.mapbox.com/data/tilesets/reference/mapbox-traffic-v1/", r"ukrain|coverage|countr"),
    ("https://docs.mapbox.com/help/glossary/traffic-data/", r"ukrain|coverage|countr"),
    ("https://docs.mapbox.com/api/navigation/directions/", r"driving-traffic|ukrain|coverage"),
    # Google Maps Platform — условия (не-Google карта), цены, покрытие
    ("https://cloud.google.com/maps-platform/terms", r"non-google|google map|in conjunction|cach"),
    ("https://cloud.google.com/maps-platform/terms/maps-service-terms", r"non-google|google map|routes|traffic"),
    ("https://developers.google.com/maps/billing-and-pricing/pricing", r"routes|traffic|compute route|free|cap"),
    ("https://developers.google.com/maps/documentation/routes/traffic_on_polylines", r"speedreading|traffic_jam|slow|billed|pro"),
    ("https://developers.google.com/maps/coverage", r"ukrain|traffic"),
    # Visicom
    ("https://api.visicom.ua/uk/posts/logisticsapis", r"заван|трафік|пробк|реальн"),
    ("https://api.visicom.ua/uk/products/data-api", r"трафік|пробк|traffic"),
    # NAPSPAN (национальные точки доступа)
    ("https://napspan.com/", r"ukrain|україн|live|traffic"),
]

def text(url):
    req = urllib.request.Request(url, headers={"User-Agent": "Mozilla/5.0 (Macintosh; Intel Mac OS X 14_0) AppleWebKit/605.1.15 Safari/605.1.15"})
    raw = urllib.request.urlopen(req, timeout=40).read().decode("utf-8", "ignore")
    t = re.sub(r"(?is)<(script|style)[^>]*>.*?</\1>", " ", raw)
    t = html.unescape(re.sub(r"<[^>]+>", "\n", t))
    return raw, [l.strip() for l in t.split("\n") if l.strip()]

for url, rx in PAGES:
    print("=" * 20, url)
    try:
        raw, lines = text(url)
    except Exception as e:
        print("недоступно:", str(e)[:200])
        continue
    r = re.compile(rx, re.I)
    hits = [i for i, l in enumerate(lines) if r.search(l)]
    print(f"строк {len(lines)}, совпадений {len(hits)}")
    shown = set()
    for i in hits[:40]:
        if i in shown:
            continue
        shown.update(range(i - 2, i + 4))
        print(" | ".join(lines[max(0, i - 2): i + 4])[:700])
    if len(lines) < 40:
        print("(мало текста — страница рендерится скриптом; совпадений в коде страницы:", len(r.findall(raw)), ")")
