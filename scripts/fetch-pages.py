# Выдержки со страниц первоисточников о поставщиках пробок для Украины (запуск в GitHub Actions — там открыт интернет).
import re, html, urllib.request

UA = {"User-Agent": "Mozilla/5.0 (Macintosh; Intel Mac OS X 14_0) AppleWebKit/605.1.15 Safari/605.1.15"}

def raw(url):
    return urllib.request.urlopen(urllib.request.Request(url, headers=UA), timeout=40).read().decode("utf-8", "ignore")

def clean(s):
    s = re.sub(r"(?is)<(script|style)[^>]*>.*?</\1>", " ", s)
    return re.sub(r"\s+", " ", html.unescape(re.sub(r"<[^>]+>", " ", s))).strip()

def section(t):
    print("\n" + "=" * 24, t)

def rows(r, country):
    """Строки HTML-таблиц, где есть страна: заголовок таблицы и ячейки строки."""
    for tbl in re.findall(r"(?is)<table.*?</table>", r):
        trs = re.findall(r"(?is)<tr.*?</tr>", tbl)
        head = [clean(c) for c in re.findall(r"(?is)<t[hd][^>]*>(.*?)</t[hd]>", trs[0])] if trs else []
        for tr in trs:
            cells = re.findall(r"(?is)<t[hd][^>]*>(.*?)</t[hd]>", tr)
            vals = [clean(c) or ("✓" if re.search(r"check|✓|icon", c, re.I) else "∅") for c in cells]
            if any(v.lower() == country.lower() for v in vals):
                print("  заголовок:", head)
                print("  строка:   ", vals)

def safe(t, fn):
    section(t)
    try:
        fn()
    except Exception as e:
        print("  недоступно:", str(e)[:200])

def azure():
    r = raw("https://learn.microsoft.com/en-us/azure/azure-maps/traffic-coverage")
    rows(r, "Ukraine")
    rows(r, "Poland")
    t = clean(r)
    for m in re.finditer(r"(?i)(¹|\b1\b)[^.]{0,20}(only|partial|limited|not|incident|flow)[^.]{0,200}\.", t):
        print("  сноска:", m.group(0)[:300])
    i = t.find("Ukraine")
    print("  текст рядом:", t[max(0, i - 200): i + 200])
safe("Azure Maps: таблица покрытия трафика", azure)

def google():
    r = raw("https://developers.google.com/maps/coverage")
    rows(r, "Ukraine")
    rows(r, "Poland")
safe("Google Maps Platform: таблица покрытия", google)

def here():
    for path in ["traffic-coverage-information", "traffic-here-traffic-api-v7-coverage-information"]:
        url = "https://docs.here.com/traffic-api/docs/" + path
        print("  --", url)
        try:
            r = raw(url)
        except Exception as e:
            print("   недоступно:", str(e)[:120])
            continue
        print("   Ukraine в коде страницы:", bool(re.search(r"ukrain", r, re.I)), "| Poland:", bool(re.search(r"poland", r, re.I)))
        rows(r, "Ukraine")
        rows(r, "Poland")
        t = clean(r)
        for k in ["Ukraine", "Poland"]:
            i = t.find(k)
            if i >= 0:
                print("   текст рядом", k, ":", t[max(0, i - 150): i + 250])
safe("HERE Traffic API v7: покрытие", here)

def mapbox():
    for url in ["https://docs.mapbox.com/data/traffic/guides/index.md", "https://docs.mapbox.com/data/traffic/guides/traffic-data/index.md", "https://docs.mapbox.com/llms.txt"]:
        print("  --", url)
        try:
            r = raw(url)
        except Exception as e:
            print("   недоступно:", str(e)[:120])
            continue
        print("   Ukraine:", bool(re.search(r"ukrain", r, re.I)))
        for m in re.finditer(r"(?im)^.*(coverage|countr|traffic data).*$", r):
            print("   ", m.group(0)[:300])
            break
    r = raw("https://www.mapbox.com/legal/product-terms")
    t = clean(r)
    for m in re.finditer(r"(?i)[^.]{0,250}(non-Mapbox|Mapbox map|other map)[^.]{0,250}\.", t):
        print("  условия:", m.group(0)[:500])
safe("Mapbox: покрытие и условия", mapbox)
