import { useEffect, useRef, useState, type FormEvent } from 'react';
import { useStore } from '../lib/store';
import { areaBounds, deleteOfflineRegion, downloadNavigationPackage, downloadOfflineRegion, getOfflinePackage, initializeOfflineMaps, offlineRegions, type OfflineRegion } from '../lib/offlineMaps';
import { searchSettlements } from '../lib/geo/settlements';
import type { Place } from '../lib/geo/geocode';
import type { OfflinePackage } from '../lib/offlinePackageFormat';
import { OfflineBoundsPreview } from '../components/OfflineBoundsPreview';

const fmtBytes = (n: number) => `${(n / 1_000_000).toLocaleString('ru', { maximumFractionDigits: 2 })} МБ`;
const RADII = [10, 25, 50, 100];
const PROVIDER_KEY = 'ace:offline-package-provider';
const defaultProvider = () => {
  try { return localStorage.getItem(PROVIDER_KEY) ?? import.meta.env.VITE_OFFLINE_PACKAGE_PROVIDER ?? ''; }
  catch { return ''; }
};

export function OfflineMapsSettings() {
  const regions = useStore(offlineRegions);
  const [query, setQuery] = useState('');
  const [choices, setChoices] = useState<Place[]>([]);
  const [selected, setSelected] = useState<Place>();
  const [radius, setRadius] = useState(10);
  const [provider, setProvider] = useState(defaultProvider);
  const [active, setActive] = useState(false);
  const [status, setStatus] = useState('');
  const [info, setInfo] = useState<{ url: string; manifest: OfflinePackage }>();
  const [progress, setProgress] = useState<{ done: number; total: number; bytes: number }>();
  const controller = useRef<AbortController | null>(null);
  useEffect(() => {
    void initializeOfflineMaps().catch(() => setStatus('Локальное хранилище недоступно.'));
    return () => controller.current?.abort();
  }, []);

  async function run(action: (signal: AbortSignal) => Promise<void>) {
    const request = new AbortController();
    controller.current = request;
    setActive(true);
    setStatus('');
    setProgress(undefined);
    try { await action(request.signal); }
    catch (error) {
      if (!request.signal.aborted) setStatus(error instanceof Error ? error.message : 'Операция не удалась.');
      else setStatus('Операция отменена. Сохранённые области доступны.');
    } finally {
      controller.current = null;
      setActive(false);
    }
  }

  function find(event: FormEvent) {
    event.preventDefault();
    setSelected(undefined);
    setInfo(undefined);
    setChoices([]);
    void run(async (signal) => {
      const matches = await searchSettlements(query, signal);
      setChoices(matches);
      if (!matches.length) setStatus('Населённый пункт не найден.');
    });
  }

  function inspect() {
    if (!selected || !provider.trim()) {
      setStatus('Укажите HTTPS-адрес поставщика пакетов в разделе «Источник пакетов».');
      return;
    }
    void run(async (signal) => {
      const base = new URL(provider.trim().replace(/\/?$/, '/'));
      if (base.protocol !== 'https:' || base.username || base.password || base.search || base.hash) throw new Error('Укажите базовый HTTPS-адрес поставщика.');
      localStorage.setItem(PROVIDER_KEY, base.href);
      const url = new URL(`${encodeURIComponent(selected.id)}/${radius}/manifest.json`, base).href;
      const manifest = await getOfflinePackage(url, signal);
      setInfo({ url, manifest });
    });
  }

  function download() {
    if (!selected || !info) return;
    void run(async (signal) => {
      await downloadNavigationPackage([selected.name, selected.address].filter(Boolean).join(' · '), selected, radius, info.url, info.manifest, setProgress, signal);
      setStatus('Регион доступен без интернета.');
    });
  }

  function update(region: OfflineRegion) {
    void run(async (signal) => {
      if (region.packageUrl && region.radiusKm) {
        const manifest = await getOfflinePackage(region.packageUrl, signal);
        const name = region.name.replace(/ · \d+ км$/, '');
        await downloadNavigationPackage(name, region.center, region.radiusKm, region.packageUrl, manifest, setProgress, signal);
      } else {
        const oldRadius = Math.max(2, Math.min(10, (region.bounds[3] - region.center.lat) * 111.2));
        await downloadOfflineRegion(region.name, region.center, oldRadius, setProgress, signal);
      }
      setStatus('Регион обновлён.');
    });
  }

  return <section className="card" aria-label="Офлайн-карты">
    <h3 className="section-title">Офлайн-карты</h3>
    <form onSubmit={find}>
      <label className="field">Город или село <input className="input" value={query} maxLength={100} onChange={(event) => setQuery(event.target.value)} placeholder="Например, Павлоград" /></label>
      <button className="btn" disabled={active || query.trim().length < 2}>Найти населённый пункт</button>
    </form>
    {choices.map((place) => <button className="btn" key={place.id} disabled={active} aria-pressed={selected?.id === place.id}
      onClick={() => { setSelected(place); setInfo(undefined); }}>{[place.name, place.address].filter(Boolean).join(' · ')}</button>)}
    {selected && <>
      <label className="field">Радиус региона <select disabled={active} value={radius} onChange={(e) => { setRadius(+e.target.value); setInfo(undefined); }}>
        {RADII.map((km) => <option key={km} value={km}>{km} км</option>)}
      </select></label>
      <OfflineBoundsPreview bounds={areaBounds(selected, radius)} />
      <button className="btn" disabled={active} onClick={inspect}>Проверить пакет</button>
      {info && <>
        <div>Карта, дорожный граф и адреса · {fmtBytes(info.manifest.assets.reduce((sum, asset) => sum + asset.bytes, 0))}</div>
        <button className="btn btn-primary" disabled={active} onClick={download}>Скачать регион</button>
      </>}
    </>}
    <details>
      <summary>Источник пакетов</summary>
      <label className="field">HTTPS-адрес поставщика <input className="input" type="url" value={provider} disabled={active}
        onChange={(event) => { setProvider(event.target.value); setInfo(undefined); }} /></label>
    </details>
    {active && <button className="btn" onClick={() => controller.current?.abort()}>Отменить</button>}
    {active && progress && <div>
      <progress aria-label="Загрузка карты" value={progress.done} max={progress.total} />
      <div>{progress.done} / {progress.total} · {fmtBytes(progress.bytes)}</div>
    </div>}
    {status && <div role="status">{status}</div>}
    {regions.map((region) => <div className="setting-row" key={region.id}>
      <div><strong>{region.name}</strong><small>{fmtBytes(region.bytes)} · {region.graph ? 'карта и маршруты' : 'только карта'} · {new Date(region.updated).toLocaleDateString('ru')}</small></div>
      <div className="seg"><button className="btn" disabled={active} onClick={() => update(region)}>Обновить</button>
        <button className="btn" disabled={active} onClick={() => void run(() => deleteOfflineRegion(region))}>Удалить</button></div>
    </div>)}
    <p className="muted small">© <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a>. Для первой загрузки требуется интернет.</p>
  </section>;
}
