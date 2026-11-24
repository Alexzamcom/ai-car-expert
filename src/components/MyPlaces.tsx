/* «Мои места»: список с кнопкой «+ Добавить место», маршрут в одно касание, изменение и удаление,
   редактор места (название, тип, точка — по GPS, из поиска адресов или с карты), экспорт и импорт. */
import { useEffect, useRef, useState } from 'react';
import { createStore, useStore } from '../lib/store';
import { geoStore, navLang, searchPlaces } from '../lib/nav';
import { reverseGeocode, type Place } from '../lib/geo/geocode';
import { toast } from '../lib/state';
import { fmtDistance, haversine } from '../lib/routing';
import { PLACE_TYPES, placesStore, savePlace, removePlace, storageStore, exportPlaces, importPlaces, type MyPlace, type PlaceType } from '../lib/places';
import { Icon } from './Icon';
import { PlaceMapPicker } from './PlaceMapPicker';

type Draft = Partial<MyPlace> & { lat?: number; lon?: number };
/** Открытый редактор: null — закрыт. */
export const placeEditorStore = createStore<{ draft: Draft } | null>(null);
export const openPlaceEditor = (draft: Draft = {}) => placeEditorStore.set({ draft });

const typeOf = (t: PlaceType) => PLACE_TYPES.find((x) => x.id === t) ?? PLACE_TYPES[4];

/** Блок «Мои места» в панели поиска. */
export function MyPlacesSection({ onRoute }: { onRoute: (p: Place) => void }) {
  const places = useStore(placesStore);
  const storage = useStore(storageStore);
  const geo = useStore(geoStore);
  const lang = navLang();
  const file = useRef<HTMLInputElement>(null);
  // Сначала Дом и Работа, затем остальные по названию.
  const order: Record<PlaceType, number> = { home: 0, work: 1, garage: 2, service: 3, custom: 4 };
  const list = [...places].sort((a, b) => order[a.placeType] - order[b.placeType] || a.label.localeCompare(b.label, 'ru'));
  const here = geo.lat != null && geo.lon != null ? { lat: geo.lat, lon: geo.lon } : null;

  const doExport = () => {
    const blob = new Blob([exportPlaces()], { type: 'application/json' });
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = 'ai-car-expert-places.json';
    a.click();
    setTimeout(() => URL.revokeObjectURL(a.href), 2000);
  };
  const doImport = async (f: File | undefined) => {
    if (!f) return;
    try {
      const r = importPlaces(await f.text());
      toast(r.added ? `Добавлено мест: ${r.added}${r.skipped ? `, уже были: ${r.skipped}` : ''}` : 'Новых мест в файле нет', 'ok');
    } catch (e) {
      toast(e instanceof Error ? e.message : 'Не удалось загрузить файл', 'warn');
    }
  };

  return (
    <div className="my-places" aria-label="Мои места">
      <div className="my-places-head">
        <div className="list-head">Мои места</div>
        <button className="btn btn-primary my-places-add" onClick={() => openPlaceEditor({})}>
          <Icon name="plus" /> Добавить место
        </button>
      </div>
      {storage.restored > 0 && <div className="list-note small my-places-note">Места восстановлены из резервной копии на устройстве ({storage.restored}).</div>}
      {list.map((p) => {
        const t = typeOf(p.placeType);
        const d = here ? haversine(here, p) : null;
        return (
          <div key={p.id} className="place-row my-place" data-type={p.placeType}>
            <button className="my-place-go" onClick={() => onRoute({ ...p, name: p.label })} aria-label={`Маршрут: ${p.label}`}>
              <Icon name={t.icon} size="1.5rem" />
              <span>
                <strong>{p.label}</strong>
                <small>{p.address || `${p.lat.toFixed(5)}, ${p.lon.toFixed(5)}`}</small>
              </span>
              {d != null && <small className="place-dist">{fmtDistance(d, lang)}</small>}
            </button>
            <button className="icon-btn" onClick={() => openPlaceEditor(p)} aria-label={`Изменить: ${p.label}`}>
              <Icon name="edit" />
            </button>
          </div>
        );
      })}
      {!list.length && <div className="list-note">Сохраните дом, работу, гараж, СТО или любое место — маршрут к нему строится одним касанием или голосом («едем домой», «едем в гараж»).</div>}
      <div className="my-places-foot">
        <small className="muted">
          {storage.persisted
            ? 'Места хранятся на этом устройстве в постоянном хранилище браузера.'
            : 'Места хранятся только на этом устройстве, в данных браузера. Очистка данных сайта их удалит; на iPhone и iPad приложение со значка на экране «Домой» и Safari хранят места раздельно. Сохраните копию в файл.'}
        </small>
        {list.length > 0 && (
          <button className="link-btn" onClick={doExport}>
            <Icon name="download" size="1em" /> Сохранить копию
          </button>
        )}
        <button className="link-btn" onClick={() => file.current?.click()}>
          <Icon name="upload" size="1em" /> Загрузить из файла
        </button>
        <input ref={file} type="file" accept="application/json,.json" hidden onChange={(e) => void doImport(e.target.files?.[0]).finally(() => (e.target.value = ''))} />
      </div>
    </div>
  );
}

/** Редактор места: создание и изменение. */
export function PlaceEditor() {
  const open = useStore(placeEditorStore);
  if (!open) return null;
  return <PlaceEditorSheet key={open.draft.id ?? 'new'} draft={open.draft} />;
}

function PlaceEditorSheet({ draft }: { draft: Draft }) {
  const editing = !!draft.id && placesStore.get().some((p) => p.id === draft.id);
  const [label, setLabel] = useState(draft.label ?? (draft.placeType ? typeOf(draft.placeType).label : draft.name ?? ''));
  const [type, setType] = useState<PlaceType>(draft.placeType ?? 'custom');
  const [point, setPoint] = useState<Place | null>(draft.lat != null && draft.lon != null ? { id: draft.id ?? '', name: draft.name ?? '', address: draft.address ?? '', lat: draft.lat, lon: draft.lon } : null);
  const [q, setQ] = useState('');
  const [found, setFound] = useState<Place[] | null>(null);
  const [busy, setBusy] = useState(false);
  const [mapChoosing, setMapChoosing] = useState(false);
  const [confirmDel, setConfirmDel] = useState(false);
  const geo = useStore(geoStore);
  const close = () => placeEditorStore.set(null);
  const labelTouched = useRef(!!draft.label);

  // Тип «Дом/Работа/Гараж/СТО» подставляет название, пока пользователь не ввёл своё.
  const pickType = (t: PlaceType) => {
    setType(t);
    if (!labelTouched.current) setLabel(t === 'custom' ? (point?.name ?? '') : typeOf(t).label);
  };

  const fromGps = async () => {
    if (geo.lat == null || geo.lon == null) return toast('Нет текущего местоположения: включите геолокацию', 'warn');
    const pt = { lat: geo.lat, lon: geo.lon };
    setPoint({ id: '', name: 'Текущее местоположение', address: '', ...pt });
    setBusy(true);
    try {
      const r = await reverseGeocode(pt, { lang: navLang() });
      if (r) setPoint({ ...r, lat: pt.lat, lon: pt.lon });
    } catch {
      /* без адреса — остаются координаты */
    } finally {
      setBusy(false);
    }
  };
  const search = async () => {
    if (!q.trim()) return;
    setBusy(true);
    try {
      const here = geo.lat != null && geo.lon != null ? { lat: geo.lat, lon: geo.lon } : undefined;
      setFound(await searchPlaces(q.trim(), here));
    } catch {
      setFound([]);
    } finally {
      setBusy(false);
    }
  };
  const save = (chosen = point) => {
    if (!chosen) return toast('Выберите точку: по GPS, поиском адреса или на карте', 'warn');
    const name = label.trim() || chosen.name || typeOf(type).label;
    const p = savePlace({ ...draft, ...chosen, id: editing ? draft.id : undefined, kind: chosen.kind, placeType: type, label: name, savedAt: editing ? draft.savedAt : undefined });
    if (p) toast(`Сохранено: «${p.label}»`, 'ok');
    close();
  };

  useEffect(() => {
    if (mapChoosing) return;
    const k = (e: KeyboardEvent) => e.key === 'Escape' && close();
    addEventListener('keydown', k);
    return () => removeEventListener('keydown', k);
  }, [mapChoosing]);

  if (mapChoosing) return <PlaceMapPicker
    start={point ?? (geo.lat != null && geo.lon != null ? { lat: geo.lat, lon: geo.lon } : null)}
    cancel={() => setMapChoosing(false)}
    confirm={(coords) => save({ ...coords, id: '', address: '', name: label.trim() || typeOf(type).label })}
  />;

  return (
    <div className="cg-sheet-backdrop place-editor-backdrop" role="dialog" aria-modal="true" aria-label={editing ? 'Изменить место' : 'Новое место'} onClick={close}>
      <div className="cg-sheet place-editor" onClick={(e) => e.stopPropagation()}>
        <h2>{editing ? 'Изменить место' : 'Новое место'}</h2>
        <label className="field">
          <span>Название</span>
          <input
            className="input"
            value={label}
            maxLength={60}
            placeholder="Например, «Дача» или «Шиномонтаж»"
            aria-label="Название места"
            onChange={(e) => {
              labelTouched.current = true;
              setLabel(e.target.value);
            }}
          />
        </label>
        <div className="seg" role="radiogroup" aria-label="Тип места">
          {PLACE_TYPES.map((t) => (
            <button key={t.id} type="button" role="radio" aria-checked={type === t.id} className={`chip ${type === t.id ? 'is-active' : ''}`} onClick={() => pickType(t.id)}>
              <Icon name={t.icon} size="1em" /> {t.label}
            </button>
          ))}
        </div>
        <div className="place-editor-point">
          <strong>Точка</strong>
          <div className="muted small" data-testid="place-point">
            {point ? `${point.address || point.name || ''}${point.address || point.name ? ' · ' : ''}${point.lat.toFixed(5)}, ${point.lon.toFixed(5)}` : 'Не выбрана'}
            {busy && ' · …'}
          </div>
          <div className="place-editor-src">
            <button className="btn" onClick={() => void fromGps()}>
              <Icon name="locate" /> Текущее местоположение
            </button>
            <button className="btn" onClick={() => setMapChoosing(true)}>
              <Icon name="map" /> Указать на карте
            </button>
          </div>
          <form
            className="place-editor-search"
            onSubmit={(e) => {
              e.preventDefault();
              void search();
            }}
          >
            <input className="input" value={q} onChange={(e) => setQ(e.target.value)} placeholder="Найти адрес" aria-label="Найти адрес для места" enterKeyHint="search" />
            <button className="btn" type="submit" aria-label="Искать адрес">
              <Icon name="search" />
            </button>
          </form>
          {found && (
            <div className="place-editor-found">
              {!found.length && <div className="list-note small">Ничего не найдено</div>}
              {found.slice(0, 5).map((f) => (
                <button
                  key={f.id + f.lat}
                  className="place-row"
                  onClick={() => {
                    setPoint(f);
                    setFound(null);
                    if (!labelTouched.current && type === 'custom') setLabel(f.name);
                  }}
                >
                  <Icon name="gps" size="1.3rem" />
                  <span>
                    <strong>{f.name}</strong>
                    <small>{f.address}</small>
                  </span>
                </button>
              ))}
            </div>
          )}
        </div>
        <div className="cg-actions place-editor-actions">
          {editing &&
            (confirmDel ? (
              <button
                className="btn btn-danger"
                onClick={() => {
                  removePlace(draft.id!);
                  toast(`Удалено: «${draft.label}»`, 'info');
                  close();
                }}
              >
                <Icon name="trash" /> Точно удалить
              </button>
            ) : (
              <button className="btn" onClick={() => setConfirmDel(true)} aria-label="Удалить место">
                <Icon name="trash" /> Удалить
              </button>
            ))}
          <span className="spacer" />
          <button className="btn" onClick={close}>
            Отмена
          </button>
          <button className="btn btn-primary" onClick={() => save()} disabled={!point}>
            <Icon name="check" /> Сохранить
          </button>
        </div>
      </div>
    </div>
  );
}
