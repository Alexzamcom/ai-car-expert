# Исследование для режима «Игровая 3D»: слои и источники стилей OpenFreeMap (запуск в GitHub Actions).
import json, urllib.request
UA = {"User-Agent": "Mozilla/5.0"}
def get(u):
    return urllib.request.urlopen(urllib.request.Request(u, headers=UA), timeout=40).read().decode("utf-8", "ignore")
for name in ["positron", "liberty", "bright"]:
    print("=" * 24, name)
    try:
        s = json.loads(get(f"https://tiles.openfreemap.org/styles/{name}"))
    except Exception as e:
        print("  недоступно:", e); continue
    print("  sources:", {k: {kk: v.get(kk) for kk in ("type", "url", "maxzoom", "minzoom")} for k, v in s["sources"].items()})
    print("  sprite:", s.get("sprite"), "| glyphs:", s.get("glyphs"), "| light:", s.get("light"), "| sky:", s.get("sky"))
    for l in s["layers"]:
        extra = ""
        if l["type"] in ("fill-extrusion",) or "building" in l["id"]:
            extra = json.dumps({"paint": l.get("paint"), "minzoom": l.get("minzoom"), "filter": l.get("filter")}, ensure_ascii=False)[:500]
        print(f"  {l['id']} | {l['type']} | {l.get('source-layer','')} {extra}")
# Метаданные векторного источника (поля слоя building, landcover, park)
try:
    tj = json.loads(get("https://tiles.openfreemap.org/planet"))
    print("=" * 24, "tilejson planet: maxzoom", tj.get("maxzoom"), "minzoom", tj.get("minzoom"))
    for vl in tj.get("vector_layers", []):
        if vl["id"] in ("building", "landcover", "park", "landuse", "transportation", "water", "poi"):
            print("  ", vl["id"], vl.get("minzoom"), vl.get("maxzoom"), list(vl.get("fields", {}).keys())[:20])
except Exception as e:
    print("tilejson недоступен:", e)
