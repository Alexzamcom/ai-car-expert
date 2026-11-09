import { createStore, uid } from './store';

/* Единый аудиоплеер: продолжает играть при переключении разделов. */

export interface Station {
  id: string;
  name: string;
  url: string;
  genre?: string;
  custom?: boolean;
}

export interface Track {
  id: string;
  title: string;
  subtitle: string;
  url: string;
  kind: 'radio' | 'file';
}

// MP3-потоки: воспроизводятся в Safari/iPadOS и во всех браузерах.
export const DEFAULT_STATIONS: Station[] = [
  { id: 'rp-main', name: 'Radio Paradise', genre: 'Эклектика', url: 'https://stream.radioparadise.com/mp3-128' },
  { id: 'soma-groove', name: 'SomaFM Groove Salad', genre: 'Эмбиент', url: 'https://ice1.somafm.com/groovesalad-128-mp3' },
  { id: 'soma-indie', name: 'SomaFM Indie Pop Rocks', genre: 'Инди', url: 'https://ice1.somafm.com/indiepop-128-mp3' },
  { id: 'soma-agent', name: 'SomaFM Secret Agent', genre: 'Лаунж', url: 'https://ice1.somafm.com/secretagent-128-mp3' },
];

export const stationsStore = createStore<Station[]>(DEFAULT_STATIONS, 'stations-v2');

/** Последняя станция и громкость — для восстановления после перезапуска. */
export const lastPlayedStore = createStore<{ station: Station | null; volume: number }>({ station: null, volume: 0.9 }, 'player-last');

/** На iOS/iPadOS громкость элемента audio задаётся только кнопками устройства. */
export const volumeControllable = (() => {
  if (typeof navigator === 'undefined') return true;
  const ios = /iPad|iPhone|iPod/.test(navigator.userAgent) || (/Macintosh/.test(navigator.userAgent) && navigator.maxTouchPoints > 1);
  return !ios;
})();

export interface PlayerState {
  current: Track | null;
  queue: Track[];
  playing: boolean;
  loading: boolean;
  error: string | null;
  volume: number;
}

export const playerStore = createStore<PlayerState>({
  current: null,
  queue: [],
  playing: false,
  loading: false,
  error: null,
  volume: 0.9,
});

const audio = typeof Audio !== 'undefined' ? new Audio() : null;
if (audio) {
  audio.preload = 'none';
  const patch = (p: Partial<PlayerState>) => playerStore.set((s) => ({ ...s, ...p }));
  audio.addEventListener('playing', () => patch({ playing: true, loading: false, error: null }));
  audio.addEventListener('pause', () => patch({ playing: false, loading: false }));
  audio.addEventListener('waiting', () => patch({ loading: true }));
  audio.addEventListener('error', () => patch({ playing: false, loading: false, error: 'Не удалось воспроизвести поток. Проверьте подключение к интернету.' }));
  audio.addEventListener('ended', () => next());
}

function updateMediaSession(t: Track) {
  if (!('mediaSession' in navigator)) return;
  navigator.mediaSession.metadata = new MediaMetadata({
    title: t.title,
    artist: t.subtitle,
    album: 'AI Car Expert',
    artwork: [{ src: './icons/icon-512.png', sizes: '512x512', type: 'image/png' }],
  });
  navigator.mediaSession.setActionHandler('play', () => resume());
  navigator.mediaSession.setActionHandler('pause', () => pause());
  navigator.mediaSession.setActionHandler('nexttrack', () => next());
  navigator.mediaSession.setActionHandler('previoustrack', () => prev());
}

export function playTrack(track: Track, queue?: Track[]) {
  if (!audio) return;
  playerStore.set((s) => ({ ...s, current: track, queue: queue ?? s.queue, loading: true, error: null }));
  audio.src = track.url;
  audio.volume = playerStore.get().volume;
  audio.play().catch(() => playerStore.set((s) => ({ ...s, loading: false, playing: false })));
  updateMediaSession(track);
}

export function stationTrack(st: Station): Track {
  return { id: st.id, title: st.name, subtitle: st.genre ? `Радио · ${st.genre}` : 'Интернет-радио', url: st.url, kind: 'radio' };
}

export function playStation(st: Station, queue?: Station[]) {
  const list = queue ?? stationsStore.get();
  const inList = list.some((x) => x.id === st.id);
  playTrack(stationTrack(st), (inList ? list : [st, ...list]).map(stationTrack));
  lastPlayedStore.set((l) => ({ ...l, station: st }));
}

/** Показываем последнюю станцию после перезапуска (автозапуск звука браузер не разрешит). */
export function restorePlayer() {
  const { station, volume } = lastPlayedStore.get();
  playerStore.set((s) => ({
    ...s,
    volume,
    current: s.current ?? (station ? stationTrack(station) : null),
    queue: s.queue.length ? s.queue : stationsStore.get().map(stationTrack),
  }));
}

/** Найти станцию по названию: сначала в своих, потом в каталоге Radio Browser. */
export async function playByQuery(query: string): Promise<{ ok: boolean; text: string }> {
  const q = query.trim().toLowerCase();
  if (!q) {
    resume();
    return { ok: true, text: 'Включаю радио.' };
  }
  const own = stationsStore.get().find((s) => s.name.toLowerCase().includes(q));
  if (own) {
    playStation(own);
    return { ok: true, text: `Включаю ${own.name}.` };
  }
  try {
    const found = await searchStations({ name: query });
    if (!found.length) return { ok: false, text: `Станция «${query}» не найдена.` };
    playStation(found[0], found);
    return { ok: true, text: `Включаю ${found[0].name}.` };
  } catch {
    return { ok: false, text: 'Каталог радиостанций недоступен.' };
  }
}

/* ---------- Каталог Radio Browser (radio-browser.info) ---------- */

interface RbStation {
  stationuuid: string;
  name: string;
  url_resolved: string;
  codec: string;
  bitrate: number;
  countrycode: string;
  tags: string;
  hls: number;
  lastcheckok: number;
}

const RB_HOSTS = ['https://de1.api.radio-browser.info', 'https://de2.api.radio-browser.info', 'https://fi1.api.radio-browser.info'];

/** Только потоки, которые реально воспроизведёт страница по HTTPS (без смешанного контента). */
export function filterPlayable(list: RbStation[]): Station[] {
  const seen = new Set<string>();
  return list
    .filter((r) => r.lastcheckok === 1 && r.url_resolved.startsWith('https://') && /^(MP3|AAC|AAC\+)$/i.test(r.codec || 'MP3'))
    .filter((r) => {
      const key = r.name.trim().toLowerCase();
      if (seen.has(key)) return false;
      seen.add(key);
      return true;
    })
    .map((r) => ({
      id: `rb-${r.stationuuid}`,
      name: r.name.trim(),
      url: r.url_resolved,
      genre: [r.countrycode, r.tags.split(',')[0], r.bitrate ? `${r.bitrate} кбит/с` : ''].filter(Boolean).join(' · '),
    }));
}

export async function searchStations(params: { name?: string; countrycode?: string; tag?: string }, signal?: AbortSignal): Promise<Station[]> {
  const qs = new URLSearchParams({ hidebroken: 'true', order: 'clickcount', reverse: 'true', limit: '40', is_https: 'true' });
  if (params.name) qs.set('name', params.name);
  if (params.countrycode) qs.set('countrycode', params.countrycode);
  if (params.tag) qs.set('tag', params.tag);
  let lastErr: unknown;
  for (const host of RB_HOSTS) {
    try {
      const res = await fetch(`${host}/json/stations/search?${qs}`, { signal });
      if (!res.ok) throw new Error(String(res.status));
      return filterPlayable((await res.json()) as RbStation[]);
    } catch (e) {
      if ((e as Error).name === 'AbortError') throw e;
      lastErr = e;
    }
  }
  throw lastErr instanceof Error ? lastErr : new Error('Каталог недоступен');
}

export function isSaved(id: string) {
  return stationsStore.get().some((s) => s.id === id);
}

export function saveStation(st: Station) {
  if (!isSaved(st.id)) stationsStore.set((l) => [...l, { ...st, custom: true }]);
}

export function pause() {
  audio?.pause();
}

export function resume() {
  const { current } = playerStore.get();
  if (!audio) return;
  if (!current) {
    const first = stationsStore.get()[0];
    if (first) playStation(first);
    return;
  }
  if (current.kind === 'radio') {
    // Для потока — переподключаемся, чтобы не проигрывать устаревший буфер.
    audio.src = current.url;
  }
  audio.play().catch(() => {});
}

export function togglePlay() {
  if (playerStore.get().playing) pause();
  else resume();
}

function step(dir: 1 | -1) {
  const { current, queue } = playerStore.get();
  if (!queue.length) return;
  const i = current ? queue.findIndex((t) => t.id === current.id) : -1;
  const n = queue[(i + dir + queue.length) % queue.length];
  playTrack(n);
}

export const next = () => step(1);
export const prev = () => step(-1);

export function stop() {
  if (!audio) return;
  audio.pause();
  audio.removeAttribute('src');
  audio.load();
  playerStore.set((s) => ({ ...s, current: null, playing: false, loading: false }));
}

export function setVolume(v: number) {
  if (audio) audio.volume = v;
  playerStore.set((s) => ({ ...s, volume: v }));
  lastPlayedStore.set((l) => ({ ...l, volume: v }));
}

export function addStation(name: string, url: string) {
  stationsStore.set((l) => [...l, { id: uid(), name, url, custom: true }]);
}

export function removeStation(id: string) {
  stationsStore.set((l) => l.filter((s) => s.id !== id));
}

/** Локальные файлы — живут до перезапуска приложения. */
export function playFiles(files: FileList) {
  const tracks: Track[] = Array.from(files).map((f) => ({
    id: uid(),
    title: f.name.replace(/\.[^.]+$/, ''),
    subtitle: 'Файл на iPad',
    url: URL.createObjectURL(f),
    kind: 'file',
  }));
  if (tracks.length) playTrack(tracks[0], tracks);
}
