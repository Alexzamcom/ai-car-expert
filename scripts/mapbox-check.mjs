// Проверка реальных данных Mapbox о пробках в Украине (Павлоград, Днепр, трасса между ними). ~10 запросов,
// в пределах бесплатных лимитов (Directions API — 100 тыс. в месяц, Tilequery/Vector Tiles — бесплатный уровень).
// Токен — только из секрета MAPBOX_TOKEN (GitHub Actions), в вывод не попадает.
//
//   MAPBOX_TOKEN=... node scripts/mapbox-check.mjs
const TOKEN = process.env.MAPBOX_TOKEN;
if (!TOKEN) {
  console.log('::error::Нет секрета MAPBOX_TOKEN (GitHub → Settings → Secrets and variables → Actions).');
  process.exit(1);
}
const hide = (s) => String(s).replaceAll(TOKEN, '***');
const P = {
  pavlogradCenter: [35.8708, 48.5318],
  pavlogradWest: [35.8268, 48.5146],
  pavlogradEast: [35.9020, 48.5262],
  dniproCenter: [35.0459, 48.4668],
  dniproLeftBank: [35.1036, 48.4810],
  dniproSouth: [35.0647, 48.4413],
};

async function get(url) {
  const u = `${url}${url.includes('?') ? '&' : '?'}access_token=${TOKEN}`;
  const r = await fetch(u);
  const body = await r.text();
  return { status: r.status, body };
}

/** Распределение загруженности по участкам маршрута: unknown — нет данных о скорости. */
function congestionStats(route) {
  const c = (route.legs || []).flatMap((l) => l.annotation?.congestion || []);
  const out = { total: c.length };
  for (const k of c) out[k] = (out[k] || 0) + 1;
  out.known = c.filter((k) => k !== 'unknown').length;
  return out;
}

async function directions(name, a, b) {
  const coords = `${a.join(',')};${b.join(',')}`;
  const res = {};
  for (const profile of ['driving', 'driving-traffic']) {
    const extra = profile === 'driving-traffic' ? '&annotations=congestion,speed,duration&overview=full&alternatives=true' : '&overview=false';
    const r = await get(`https://api.mapbox.com/directions/v5/mapbox/${profile}/${coords}?geometries=geojson${extra}`);
    if (r.status !== 200) {
      res[profile] = { status: r.status, error: hide(r.body).slice(0, 200) };
      continue;
    }
    const d = JSON.parse(r.body);
    res[profile] = (d.routes || []).map((rt) => ({
      km: +(rt.distance / 1000).toFixed(1),
      min: +(rt.duration / 60).toFixed(1),
      typicalMin: rt.duration_typical != null ? +(rt.duration_typical / 60).toFixed(1) : null,
      ...(profile === 'driving-traffic' ? { congestion: congestionStats(rt) } : {}),
    }));
  }
  return { name, ...res };
}

async function tilequery(name, p) {
  const r = await get(`https://api.mapbox.com/v4/mapbox.mapbox-traffic-v1/tilequery/${p.join(',')}.json?radius=400&limit=50&dedupe=true`);
  if (r.status !== 200) return { name, status: r.status, error: hide(r.body).slice(0, 200) };
  const f = JSON.parse(r.body).features || [];
  const by = {};
  for (const x of f) by[x.properties?.congestion ?? '—'] = (by[x.properties?.congestion ?? '—'] || 0) + 1;
  return { name, features: f.length, congestion: by, classes: [...new Set(f.map((x) => x.properties?.class))].slice(0, 8) };
}

const out = { at: new Date().toISOString(), routes: [], points: [] };
out.routes.push(await directions('Павлоград → Днепр (трасса)', P.pavlogradCenter, P.dniproCenter));
out.routes.push(await directions('Днепр: центр → левый берег (мосты)', P.dniproCenter, P.dniproLeftBank));
out.routes.push(await directions('Павлоград: запад → восток', P.pavlogradWest, P.pavlogradEast));
out.points.push(await tilequery('Днепр, проспект Яворницкого', P.dniproCenter));
out.points.push(await tilequery('Днепр, Набережная', P.dniproSouth));
out.points.push(await tilequery('Павлоград, центр', P.pavlogradCenter));
console.log(JSON.stringify(out, null, 2));

// Вывод: есть ли живые данные (участки с известной загруженностью или объекты в тайлах пробок).
const known = out.routes.flatMap((r) => (Array.isArray(r['driving-traffic']) ? r['driving-traffic'] : [])).reduce((a, r) => a + (r.congestion?.known || 0), 0);
const total = out.routes.flatMap((r) => (Array.isArray(r['driving-traffic']) ? r['driving-traffic'] : [])).reduce((a, r) => a + (r.congestion?.total || 0), 0);
const tileFeatures = out.points.reduce((a, p) => a + (p.features || 0), 0);
console.log(`\nИТОГ: участков маршрутов с известной загруженностью ${known} из ${total}; объектов в тайлах пробок рядом с точками: ${tileFeatures}.`);
