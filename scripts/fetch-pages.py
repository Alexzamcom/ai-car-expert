# Выдержки со страниц первоисточников (запуск в GitHub Actions). Mapbox: перечень стран с пробками.
import re, urllib.request
UA = {"User-Agent": "Mozilla/5.0 (Macintosh; Intel Mac OS X 14_0) AppleWebKit/605.1.15 Safari/605.1.15"}
for url in ["https://docs.mapbox.com/help/getting-started/directions.md", "https://docs.mapbox.com/help/getting-started/directions/index.md"]:
    print("=" * 24, url)
    try:
        t = urllib.request.urlopen(urllib.request.Request(url, headers=UA), timeout=40).read().decode("utf-8", "ignore")
    except Exception as e:
        print("  недоступно:", str(e)[:150]); continue
    i = t.lower().find("traffic data")
    print("  символов:", len(t), "| Ukraine:", bool(re.search(r"ukrain", t, re.I)))
    # Раздел «Traffic data» целиком (до следующего заголовка того же уровня)
    m = re.search(r"(?is)\n#+ *Traffic data.*?(?=\n## )", t)
    print(m.group(0)[:6000] if m else t[max(0, i - 200): i + 4000])
    for k in ["Ukraine", "Poland", "Romania", "Moldova"]:
        for mm in re.finditer(k, t):
            print("  —", k, ":", t[max(0, mm.start() - 150): mm.end() + 150].replace("\n", " "))
            break
