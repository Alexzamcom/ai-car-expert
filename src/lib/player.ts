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

export const DEFAULT_STATIONS: Station[] = [
  { id: 'rp-main', name: 'Radio Paradise', genre: 'Эклектика', url: 'https://stream.radioparadise.com/aac-128' },
  { id: 'rp-mellow', name: 'Radio Paradise Mellow', genre: 'Спокойная', url: 'https://stream.radioparadise.com/mellow-128' },
  { id: 'soma-groove', name: 'SomaFM Groove Salad', genre: 'Эмбиент', url: 'https://ice1.somafm.com/groovesalad-128-mp3' },
  { id: 'soma-indie', name: 'SomaFM Indie Pop Rocks', genre: 'Инди', url: 'https://ice1.somafm.com/indiepop-128-mp3' },
];

export const stationsStore = createStore<Station[]>(DEFAULT_STATIONS, 'stations');

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

export function playStation(st: Station) {
  playTrack(stationTrack(st), stationsStore.get().map(stationTrack));
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
