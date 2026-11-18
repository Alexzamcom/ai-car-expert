# Выдержки со страниц первоисточников (запуск в GitHub Actions). Mapbox: раздел Traffic Coverage целиком.
import re, urllib.request
UA = {"User-Agent": "Mozilla/5.0 (Macintosh; Intel Mac OS X 14_0) AppleWebKit/605.1.15 Safari/605.1.15"}
t = urllib.request.urlopen(urllib.request.Request("https://docs.mapbox.com/help/dive-deeper/directions.md", headers=UA), timeout=40).read().decode("utf-8", "ignore")
i = t.find("#### Traffic Coverage")
sec = t[i: t.find("\n### ", i + 10) if t.find("\n### ", i + 10) > 0 else len(t)]
# Заголовки и вводные фразы списков — полностью; сами списки — число стран и есть ли Украина
parts = re.split(r"\n(?=[^\n-][^\n]*:\s*\n|#{3,5} )", sec)
for p in parts:
    lines = p.strip().split("\n")
    head = [l for l in lines if not l.strip().startswith("-")]
    items = [l.strip()[1:].strip() for l in lines if l.strip().startswith("-")]
    print("ЗАГОЛОВОК:", " / ".join(head)[:600])
    print("  стран в списке:", len(items), "| Украина:", "Ukraine" in items, "| Польша:", "Poland" in items, "| Россия:", "Russian Federation" in items)
print("\nСЫРОЙ РАЗДЕЛ (начало):\n", sec[:1500])
