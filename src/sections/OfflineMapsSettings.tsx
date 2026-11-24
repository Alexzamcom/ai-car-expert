import { useEffect, useRef, useState, type FormEvent } from 'react';
import { useStore } from '../lib/store';
import { areaBounds, deleteOfflineRegion, discardRegionalDownload, downloadNavigationPackage, downloadOfflineRegion, getOfflinePackage, initializeOfflineMaps, offlineRegions, regionalDownloadState, regionalStorageBytes, type OfflineRegion } from '../lib/offlineMaps';
import { searchSettlements, settlementPackage, type Settlement } from '../lib/geo/settlements';
import { verifyRegionIdentity, type OfflinePackage } from '../lib/offlinePackageFormat';
import { OfflineBoundsPreview } from '../components/OfflineBoundsPreview';

const fmtBytes = (n: number) => `${(n / 1_000_000).toLocaleString('ru', { maximumFractionDigits: 2 })} МБ`;
const RADII = [10, 25, 50, 100] as const;
type Radius = typeof RADII[number];

export function OfflineMapsSettings() {
  const regions = useStore(offlineRegions);
  const [query, setQuery] = useState('');
  const [choices, setChoices] = useState<Settlement[]>([]);
  const [selected, setSelected] = useState<Settlement>();
  const [radius, setRadius] = useState<Radius>(25);
  const [active, setActive] = useState(false);
  const [status, setStatus] = useState('');
  const [info, setInfo] = useState<{ url: string; manifest: OfflinePackage; saved: number }>();
  const [checking, setChecking] = useState(false);
  const [previewError, setPreviewError] = useState('');
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
      else setStatus('Операция остановлена. Проверенная часть загрузки сохранена.');
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

  useEffect(() => {
    setInfo(undefined);
    setPreviewError('');
    if (!selected) return;
    const url = settlementPackage(selected, radius);
    if (!url) {
      setPreviewError('Карта для этого населённого пункта и радиуса пока недоступна.');
      return;
    }
    const request = new AbortController();
    setChecking(true);
    void getOfflinePackage(url, request.signal).then(async (manifest) => {
      verifyRegionIdentity(manifest, selected.id, selected, radius);
      const { matching } = await regionalDownloadState(url, manifest);
      if (!request.signal.aborted) setInfo({ url, manifest, saved: matching?.bytes ?? 0 });
    }).catch((error) => {
      if (!request.signal.aborted) setPreviewError(error instanceof Error ? error.message : 'Не удалось получить параметры карты.');
    }).finally(() => { if (!request.signal.aborted) setChecking(false); });
    return () => { request.abort(); setChecking(false); };
  }, [selected, radius]);

  function download() {
    if (!selected || !info) return;
    void run(async (signal) => {
      try {
        await downloadNavigationPackage([selected.name, selected.address].filter(Boolean).join(' · '), selected, radius, info.url, info.manifest, setProgress, signal);
        setInfo({ ...info, saved: 0 });
      } finally {
        const { matching } = await regionalDownloadState(info.url, info.manifest).catch(() => ({ matching: undefined }));
        setInfo({ ...info, saved: matching?.bytes ?? 0 });
      }
      setStatus('Регион доступен без интернета.');
    });
  }

  function update(region: OfflineRegion) {
    void run(async (signal) => {
      if (region.packageUrl && region.radiusKm) {
        const manifest = await getOfflinePackage(region.packageUrl, signal);
        if (region.settlementId) verifyRegionIdentity(manifest, region.settlementId, region.center, region.radiusKm);
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
      <label className="field">Радиус региона <select disabled={active} value={radius} onChange={(e) => { setRadius(+e.target.value as Radius); setInfo(undefined); }}>
        {RADII.map((km) => <option key={km} value={km}>{km} км</option>)}
      </select></label>
      <OfflineBoundsPreview bounds={areaBounds(selected, radius)} />
      {checking && <p role="status">Получаем размер карты…</p>}
      {previewError && <p role="status">{previewError}</p>}
      {info && (() => {
        const total = info.manifest.assets.reduce((sum, asset) => sum + asset.bytes, 0);
        return <>
          <div>Загрузка · {fmtBytes(total - info.saved)}. Нужно свободного места · {fmtBytes(regionalStorageBytes(total - info.saved))}</div>
          <button className="btn btn-primary" disabled={active} onClick={download}>{info.saved ? 'Возобновить загрузку' : 'Скачать карту'}</button>
          {!!info.saved && <button className="btn" disabled={active} onClick={() => void run(async () => {
            await discardRegionalDownload(info.url);
            setInfo({ ...info, saved: 0 });
          })}>Удалить незавершённую загрузку</button>}
        </>;
      })()}
    </>}
    {active && <button className="btn" onClick={() => controller.current?.abort()}>Остановить</button>}
    {active && progress && <div>
      <progress aria-label="Загрузка карты" value={progress.done} max={progress.total} />
      <div>{progress.done} / {progress.total} · {fmtBytes(progress.bytes)}</div>
    </div>}
    {status && <div role="status">{status}</div>}
    {regions.map((region) => <div className="setting-row" key={region.id}>
      <div><strong>{region.name}</strong><small>{fmtBytes(region.bytes)} · {region.graph ? 'карта и маршруты' : 'только карта'} · {new Date(region.dataDate ?? region.updated).toLocaleDateString('ru')}</small></div>
      <div className="seg"><button className="btn" disabled={active} onClick={() => update(region)}>Обновить</button>
        <button className="btn" disabled={active} onClick={() => void run(() => deleteOfflineRegion(region))}>Удалить</button></div>
    </div>)}
    <p className="muted small">© <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a>. Для первой загрузки требуется интернет.</p>
  </section>;
}
