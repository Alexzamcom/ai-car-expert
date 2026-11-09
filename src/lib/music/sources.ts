/* Музыкальные источники. Расширяемый список: встроенные (играют внутри приложения),
   внешние (открываются как отдельное приложение) и запланированные. */
import { createStore } from '../store';

export type MusicSourceId = 'radio' | 'youtube-music' | 'spotify' | 'apple-music';

export interface MusicSource {
  id: MusicSourceId;
  name: string;
  /** builtin — играет AI Car Expert; external — отдельное приложение; planned — будет позже. */
  kind: 'builtin' | 'external' | 'planned';
  url?: string;
  /** Может ли AI Car Expert управлять воспроизведением этого источника. */
  controllable: boolean;
  note: string;
}

export const MUSIC_SOURCES: MusicSource[] = [
  { id: 'radio', name: 'Интернет-радио', kind: 'builtin', controllable: true, note: 'Играет внутри AI Car Expert: станции, поиск, пауза, переключение.' },
  {
    id: 'youtube-music',
    name: 'YouTube Music',
    kind: 'external',
    url: 'https://music.youtube.com/',
    controllable: false,
    note: 'Открывается в приложении YouTube Music или на сайте с вашей учётной записью. Треки и управление — там.',
  },
  { id: 'spotify', name: 'Spotify', kind: 'planned', url: 'https://open.spotify.com/', controllable: false, note: 'Будущая интеграция.' },
  { id: 'apple-music', name: 'Apple Music', kind: 'planned', url: 'https://music.apple.com/', controllable: false, note: 'Будущая интеграция.' },
];

export const sourceById = (id: MusicSourceId) => MUSIC_SOURCES.find((s) => s.id === id)!;

/** Какой источник сейчас «главный»: что играет или что открывали последним. */
export const musicStore = createStore<{ active: 'radio' | 'youtube-music' }>({ active: 'radio' }, 'music-source');

export function setActiveSource(id: 'radio' | 'youtube-music') {
  if (musicStore.get().active !== id) musicStore.set({ active: id });
}
