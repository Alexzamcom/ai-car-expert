import { useEffect, useRef, useState } from 'react';
import { useStore } from '../lib/store';
import { geoStore } from '../lib/nav';
import { deleteOfflineRegion, downloadOfflineRegion, initializeOfflineMaps, offlineRegions, type OfflineRegion } from '../lib/offlineMaps';

const bytes = (n: number) => `${(n / 1_000_000).toLocaleString('ru', { maximumFractionDigits: 2 })} МБ`;

export function OfflineMapsSettings() {
  const regions = useStore(offlineRegions);
  const geo = useStore(geoStore);
  const [name, setName] = useState('');
  const [coordinates, setCoordinates] = useState('');
  const [radius, setRadius] = useState(4);
  const [active, setActive] = useState(false);
  const [status, setStatus] = useState('');
  const [progress, setProgress] = useState<{ done: number; total: number; bytes: number }>();
  const controller = useRef<AbortController | null>(null);
  useEffect(() => {
    void initializeOfflineMaps().catch(() => setStatus('Локальное хранилище недоступно.'));
  }, []);

  async function download(existing?: OfflineRegion) {
    const [lat, lon] = coordinates.split(/[,;\s]+/).map(Number);
    if (!existing && (!name.trim() || !Number.isFinite(lat) || !Number.isFinite(lon))) {
      setStatus('Введите название и координаты центра широта, долгота.');
      return;
    }
    const center = existing?.center ?? { lat, lon };
    const oldRadius = existing ? Math.max(2, Math.min(10, (existing.bounds[3] - center.lat) * 111.2)) : radius;
    const request = new AbortController();
    controller.current = request;
    setActive(true);
    setProgress(undefined);
    setStatus('Получаем параметры OpenFreeMap…');
    try {
      await initializeOfflineMaps();
      await downloadOfflineRegion(existing?.name ?? name.trim(), center, oldRadius, setProgress, request.signal);
      setStatus('Регион доступен без интернета.');
    } catch (error) {
      setStatus(request.signal.aborted ? 'Загрузка отменена. Сохранённые области доступны.' : error instanceof Error ? error.message : 'Не удалось сохранить карту.');
    } finally {
      controller.current = null;
      setActive(false);
    }
  }
  function remove(region: OfflineRegion) {
    void deleteOfflineRegion(region).catch(() => setStatus('Не удалось удалить регион.'));
  }

  return <section className="card" aria-label="Офлайн-карты">
    <h3 className="section-title">Офлайн-карты</h3>
    <p>Скачайте небольшую область OpenFreeMap перед выездом. Без сети доступны дороги, подписи и ранее построенный маршрут.</p>
    <label className="field">Название региона <input className="input" value={name} maxLength={64} onChange={(e) => setName(e.target.value)} placeholder="Например, район поездки" /></label>
    <label className="field">Центр региона <input className="input" value={coordinates} onChange={(e) => setCoordinates(e.target.value)} placeholder="Широта, долгота" /></label>
    <button className="btn" disabled={active || geo.lat == null || geo.lon == null || (geo.accuracy ?? Infinity) > 50} onClick={() => {
      if (geo.lat != null && geo.lon != null) setCoordinates(`${geo.lat.toFixed(5)}, ${geo.lon.toFixed(5)}`);
    }}>Текущее местоположение</button>
    <label className="field">Радиус региона <select value={radius} onChange={(e) => setRadius(+e.target.value)}>
      {[2, 4, 7, 10].map((km) => <option key={km} value={km}>{km} км</option>)}
    </select></label>
    <button className="btn btn-primary" disabled={active} onClick={() => void download()}>Скачать регион</button>
    {active && <button className="btn" onClick={() => controller.current?.abort()}>Отменить загрузку</button>}
    {active && progress && <div>
      <progress aria-label="Загрузка карты" value={progress.done} max={progress.total} />
      <div>{progress.done} / {progress.total} · {bytes(progress.bytes)}</div>
    </div>}
    {status && <div role="status">{status}</div>}
    {regions.map((r) => <div className="setting-row" key={r.id}>
      <div><strong>{r.name}</strong><small>{bytes(r.bytes)} · {new Date(r.updated).toLocaleDateString('ru')}</small></div>
      <div className="seg"><button className="btn" disabled={active} onClick={() => void download(r)}>Обновить</button>
        <button className="btn" disabled={active} onClick={() => remove(r)}>Удалить</button></div>
    </div>)}
    <p className="muted small">OpenFreeMap · © OpenMapTiles · © <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a>. Поиск адресов и построение нового маршрута требуют интернета.</p>
  </section>;
}
