# Выдержки со страниц первоисточников (запуск в GitHub Actions). Mapbox: перечень стран с пробками.
import re, urllib.request, html
UA = {"User-Agent": "Mozilla/5.0 (Macintosh; Intel Mac OS X 14_0) AppleWebKit/605.1.15 Safari/605.1.15"}
def get(u):
    return urllib.request.urlopen(urllib.request.Request(u, headers=UA), timeout=40).read().decode("utf-8", "ignore")
idx = get("https://docs.mapbox.com/help/llms.txt")
cands = sorted(set(u for u in re.findall(r"\((https://docs\.mapbox\.com/help/[^)]+)\)", idx) if re.search(r"direction|traffic", u, re.I)))
print("кандидаты:", cands)
for u in cands + ["https://docs.mapbox.com/help/getting-started/directions/"]:
    print("=" * 24, u)
    try:
        r = get(u)
    except Exception as e:
        print("  недоступно:", str(e)[:120]); continue
    t = html.unescape(re.sub(r"<[^>]+>", " ", r)).replace("\\n", "\n")
    print("  символов:", len(r), "| Ukraine:", "Ukraine" in r, "| Poland:", "Poland" in r)
    i = t.find("raffic data")
    if i >= 0:
        print(re.sub(r"[ \t]+", " ", t[i - 100: i + 3500]))
    for k in ["Ukraine", "Poland"]:
        j = t.find(k)
        if j >= 0:
            print("  —", k, ":", re.sub(r"\s+", " ", t[max(0, j - 300): j + 200]))
