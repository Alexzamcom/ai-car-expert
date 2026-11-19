/* «Мои места» — сохранённые места пользователя: Дом, Работа, Гараж, СТО и любые свои.
   Единственный источник — список placesStore (ключ ace:places). Прежние ключи «Дом/Работа» (ace:saved-places)
   и «Избранное» (ace:favorites) переносятся в него один раз и дальше поддерживаются как зеркало
   (их читают голосовые команды и старые версии приложения). Ничего не перезаписывается при обновлении.

   Где хранится: только на этом устройстве, в данных браузера (localStorage) + резервная копия в IndexedDB
   (восстанавливает места, если localStorage очищен отдельно). Приложение просит у браузера «постоянное»
   хранилище; если браузер отказал — честно предупреждаем, что очистка данных сайта удалит места. */
import { createStore, uid } from './store';
import type { Place } from './geo/geocode';

export type PlaceType = 'home' | 'work' | 'garage' | 'service' | 'custom';

export const PLACE_TYPES: { id: PlaceType; label: string; icon: 'home' | 'flag' | 'car' | 'wrench' | 'star' }[] = [
  { id: 'home', label: 'Дом', icon: 'home' },
  { id: 'work', label: 'Работа', icon: 'flag' },
  { id: 'garage', label: 'Гараж', icon: 'car' },
  { id: 'service', label: 'СТО', icon: 'wrench' },
  { id: 'custom', label: 'Другое', icon: 'star' },
];

export interface MyPlace extends Place {
  /** Тип места (у «Дом» и «Работа» — не больше одного каждого). */
  placeType: PlaceType;
  /** Название, которое дал пользователь («Дом», «Гараж у тёщи»…). */
  label: string;
  savedAt: number;
}

const KEY = 'places';
const LS_KEY = 'ace:' + KEY;
const OLD_SAVED = 'ace:saved-places';
const OLD_FAV = 'ace:favorites';

const finite = (v: unknown): v is number => typeof v === 'number' && Number.isFinite(v);

/** Проверка и нормализация записи (повреждённые записи отбрасываются, а не ломают список). */
export function cleanPlace(x: unknown): MyPlace | null {
  if (!x || typeof x !== 'object') return null;
  const p = x as Partial<MyPlace>;
  if (!finite(p.lat) || !finite(p.lon) || Math.abs(p.lat) > 90 || Math.abs(p.lon) > 180) return null;
  const placeType: PlaceType = PLACE_TYPES.some((t) => t.id === p.placeType) ? (p.placeType as PlaceType) : 'custom';
  const name = typeof p.name === 'string' && p.name.trim() ? p.name.trim() : `${p.lat.toFixed(5)}, ${p.lon.toFixed(5)}`;
  const label = typeof p.label === 'string' && p.label.trim() ? p.label.trim().slice(0, 60) : name;
  return {
    id: typeof p.id === 'string' && p.id ? p.id : uid(),
    name,
    address: typeof p.address === 'string' ? p.address : '',
    lat: p.lat,
    lon: p.lon,
    ...(typeof p.kind === 'string' ? { kind: p.kind } : {}),
    placeType,
    label,
    savedAt: finite(p.savedAt) ? p.savedAt : Date.now(),
  };
}

export function cleanList(x: unknown): MyPlace[] {
  if (!Array.isArray(x)) return [];
  const out: MyPlace[] = [];
  const ids = new Set<string>();
  for (const it of x) {
    const p = cleanPlace(it);
    if (!p || ids.has(p.id)) continue;
    ids.add(p.id);
    out.push(p);
  }
  return out;
}

const read = (k: string): unknown => {
  try {
    const raw = localStorage.getItem(k);
    return raw == null ? undefined : JSON.parse(raw);
  } catch {
    return undefined;
  }
};

const same = (a: { lat: number; lon: number }, b: { lat: number; lon: number }) => Math.abs(a.lat - b.lat) < 1e-5 && Math.abs(a.lon - b.lon) < 1e-5;

/**
 * Перенос из прежних ключей: «Дом», «Работа» и «Избранное» → «Мои места».
 * Вызывается, только если списка «Мои места» ещё нет: существующий список никогда не перезаписывается.
 */
export function migrateOld(saved: unknown, favorites: unknown, now = Date.now()): MyPlace[] {
  const out: MyPlace[] = [];
  const s = (saved && typeof saved === 'object' ? saved : {}) as { home?: Place | null; work?: Place | null };
  for (const [t, label] of [['home', 'Дом'], ['work', 'Работа']] as const) {
    const p = cleanPlace(s[t] ? { ...s[t], placeType: t, label, savedAt: now } : null);
    if (p) out.push({ ...p, id: `${t}:${p.lat},${p.lon}` });
  }
  for (const f of cleanList(Array.isArray(favorites) ? favorites.map((x) => ({ ...(x as object), savedAt: now })) : [])) {
    if (!out.some((p) => same(p, f))) out.push({ ...f, placeType: 'custom' });
  }
  return out;
}

function initial(): MyPlace[] {
  const cur = read(LS_KEY);
  if (cur !== undefined) return cleanList(cur);
  return migrateOld(read(OLD_SAVED), read(OLD_FAV));
}

export const placesStore = createStore<MyPlace[]>([], KEY);
// Хранилище создано с пустым значением по умолчанию — загружаем сами (с переносом и проверкой записей).
placesStore.set(initial());

/* ---------- Изменение ---------- */

/**
 * Сохранить место (новое или изменённое — по id). «Дом» и «Работа» единственные: прежний дом не удаляется,
 * а становится обычным местом с пометкой — данные пользователя не теряются.
 */
export function savePlace(input: Partial<MyPlace> & { lat: number; lon: number }): MyPlace | null {
  const p = cleanPlace({ ...input, id: input.id ?? uid(), savedAt: input.savedAt ?? Date.now() });
  if (!p) return null;
  placesStore.set((list) => {
    let next = list.map((x) => (x.id === p.id ? p : x));
    if (!list.some((x) => x.id === p.id)) next = [...next, p];
    if (p.placeType === 'home' || p.placeType === 'work') {
      const word = p.placeType === 'home' ? 'Дом' : 'Работа';
      next = next.map((x) => (x.id !== p.id && x.placeType === p.placeType ? { ...x, placeType: 'custom', label: x.label === word ? `${word} (прежний)` : x.label } : x));
    }
    return next;
  });
  void requestPersistence();
  return p;
}

export function removePlace(id: string) {
  placesStore.set((list) => list.filter((x) => x.id !== id));
}

export const placeOfType = (t: PlaceType, list = placesStore.get()) => list.find((p) => p.placeType === t) ?? null;
export const findSaved = (pt: { lat: number; lon: number }, list = placesStore.get()) => list.find((p) => same(p, pt)) ?? null;

/* ---------- Постоянное хранилище, резервная копия, экспорт ---------- */

export const storageStore = createStore<{ persisted: boolean | null; restored: number }>({ persisted: null, restored: 0 });

/** Просим браузер не удалять данные сайта при нехватке места (Android/Chrome — для установленного PWA, Safari 17+). */
export async function requestPersistence() {
  try {
    const st = navigator.storage;
    if (!st?.persisted) return;
    let ok = await st.persisted();
    if (!ok && st.persist) ok = await st.persist();
    storageStore.set((s) => ({ ...s, persisted: ok }));
  } catch {
    storageStore.set((s) => ({ ...s, persisted: false }));
  }
}

const IDB = 'ace-backup';
function idb(): Promise<IDBDatabase | null> {
  return new Promise((res) => {
    try {
      if (typeof indexedDB === 'undefined') return res(null);
      const r = indexedDB.open(IDB, 1);
      r.onupgradeneeded = () => r.result.createObjectStore('kv');
      r.onsuccess = () => res(r.result);
      r.onerror = () => res(null);
    } catch {
      res(null);
    }
  });
}
async function idbPut(v: unknown) {
  const db = await idb();
  if (!db) return;
  try {
    db.transaction('kv', 'readwrite').objectStore('kv').put(v, KEY);
  } catch {
    /* резервная копия недоступна — основное хранилище остаётся */
  }
}
async function idbGet(): Promise<unknown> {
  const db = await idb();
  if (!db) return undefined;
  return new Promise((res) => {
    try {
      const r = db.transaction('kv', 'readonly').objectStore('kv').get(KEY);
      r.onsuccess = () => res(r.result);
      r.onerror = () => res(undefined);
    } catch {
      res(undefined);
    }
  });
}

/**
 * При запуске: если в localStorage мест нет, а в резервной копии есть — восстанавливаем (localStorage мог быть
 * очищен отдельно). Затем держим копию в актуальном состоянии.
 */
export async function startPlacesBackup() {
  if (!placesStore.get().length) {
    const b = cleanList(await idbGet());
    if (b.length && !placesStore.get().length) {
      placesStore.set(b);
      storageStore.set((s) => ({ ...s, restored: b.length }));
    }
  }
  void idbPut(placesStore.get());
  placesStore.subscribe(() => void idbPut(placesStore.get()));
  if (placesStore.get().length) void requestPersistence();
  else
    try {
      const ok = await navigator.storage?.persisted?.();
      storageStore.set((s) => ({ ...s, persisted: ok ?? null }));
    } catch {
      /* нет API */
    }
}

/** Файл с местами для переноса или резервной копии. */
export function exportPlaces(list = placesStore.get()): string {
  return JSON.stringify({ app: 'ai-car-expert', type: 'places', version: 1, places: list }, null, 1);
}

/** Загрузка из файла: места добавляются к существующим (без дублей по координатам), ничего не удаляется. */
export function importPlaces(text: string): { added: number; skipped: number } {
  let data: unknown;
  try {
    data = JSON.parse(text);
  } catch {
    throw new Error('Файл не похож на список мест AI Car Expert');
  }
  const raw = Array.isArray(data) ? data : (data as { places?: unknown })?.places;
  if (!Array.isArray(raw)) throw new Error('В файле нет списка мест');
  const incoming = cleanList(raw);
  let added = 0;
  placesStore.set((list) => {
    const next = [...list];
    for (const p of incoming) {
      if (next.some((x) => same(x, p))) continue;
      const clash = (p.placeType === 'home' || p.placeType === 'work') && next.some((x) => x.placeType === p.placeType);
      next.push({ ...p, id: next.some((x) => x.id === p.id) ? uid() : p.id, placeType: clash ? 'custom' : p.placeType });
      added++;
    }
    return next;
  });
  return { added, skipped: incoming.length - added };
}
