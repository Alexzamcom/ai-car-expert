import { describe, it, expect, vi, afterEach } from 'vitest';
import { launchPlan, YTM_URL, YTM_APP_SCHEME, openYouTubeMusic, ytmFallbackStore } from '../../src/lib/music/youtube';
import { MUSIC_SOURCES, musicStore, setActiveSource } from '../../src/lib/music/sources';
import { takeReturn, markLeaving, lastHandoffStore } from '../../src/lib/handoff';
import { parseCommand } from '../../src/lib/voiceCommands';
import { runTool } from '../../src/lib/tools';
import { findApp } from '../../src/lib/apps';
import { settingsStore } from '../../src/lib/state';
import { readNavSession } from '../../src/lib/nav';

function memoryStorage() {
  const m = new Map<string, string>();
  return { getItem: (k: string) => m.get(k) ?? null, setItem: (k: string, v: string) => void m.set(k, v), removeItem: (k: string) => void m.delete(k) };
}

afterEach(() => {
  vi.unstubAllGlobals();
  vi.useRealTimers();
  ytmFallbackStore.set(false);
  setActiveSource('radio');
});

describe('YouTube Music: способ открытия', () => {
  it('официальный адрес и схема приложения', () => {
    expect(YTM_URL).toBe('https://music.youtube.com/');
    expect(YTM_APP_SCHEME).toBe('youtubemusic://');
    expect(findApp('youtubemusic')?.href).toBe('https://music.youtube.com/');
  });
  it('iPad/iPhone: сначала приложение, запасной вариант — сайт', () => {
    expect(launchPlan('ios', 'app')).toEqual({ kind: 'scheme', url: 'youtubemusic://', fallback: 'https://music.youtube.com/' });
    expect(launchPlan('ios', 'browser')).toEqual({ kind: 'link', url: 'https://music.youtube.com/' });
  });
  it('Android и компьютер: https-ссылка (приложение откроется само, если установлено)', () => {
    expect(launchPlan('android', 'app')).toEqual({ kind: 'link', url: 'https://music.youtube.com/' });
    expect(launchPlan('other', 'app')).toEqual({ kind: 'link', url: 'https://music.youtube.com/' });
  });
});

describe('источники музыки', () => {
  it('радио встроенное, YouTube Music внешний и неуправляемый, Spotify и Apple Music — в планах', () => {
    const by = Object.fromEntries(MUSIC_SOURCES.map((s) => [s.id, s]));
    expect(by.radio).toMatchObject({ kind: 'builtin', controllable: true });
    expect(by['youtube-music']).toMatchObject({ kind: 'external', controllable: false, url: 'https://music.youtube.com/' });
    expect(by.spotify.kind).toBe('planned');
    expect(by['apple-music'].kind).toBe('planned');
  });
});

describe('голосовые команды', () => {
  const cmd = (s: string) => {
    const c = parseCommand(s);
    return c.kind === 'tool' ? [c.name, c.args] : ['ask'];
  };
  it('YouTube Music ru/uk', () => {
    for (const t of ['Открой YouTube Music', 'Включи Ютуб Музыку', 'Відкрий YouTube Music', 'увімкни ютуб музику', 'открой ютуб мьюзик']) {
      expect(cmd(t), t).toEqual(['open_music_service', { service: 'youtube-music' }]);
    }
  });
  it('назад к карте ru/uk', () => {
    for (const t of ['Вернись к карте', 'вернуться на карту', 'покажи карту', 'Повернись до карти', 'до мапи']) {
      expect(cmd(t), t).toEqual(['open_section', { section: 'navigation' }]);
    }
  });
  it('радио и «включи музыку» не перепутаны с YouTube Music', () => {
    expect(cmd('включи радио')).toEqual(['play_radio', { station: '' }]);
    expect(cmd('включи музыку')).toEqual(['play_music', {}]);
  });
  it('выбор трека голосом не обещается — уходит помощнику как вопрос', () => {
    expect(cmd('включи в ютуб музыке песню Кино Группа крови')[0]).toBe('open_music_service');
    const r = parseCommand('поставь трек Группа крови');
    expect(r.kind).toBe('ask');
  });
});

describe('открытие без нажатия (голос/Grok)', () => {
  function stubBrowser(ua: string) {
    const loc = { href: 'https://alexzamcom.github.io/ai-car-expert/' };
    const open = vi.fn(() => null);
    const doc = { visibilityState: 'visible', addEventListener: vi.fn(), removeEventListener: vi.fn() };
    vi.stubGlobal('navigator', { userAgent: ua, maxTouchPoints: 5 });
    vi.stubGlobal('window', { location: loc, open, addEventListener: vi.fn(), removeEventListener: vi.fn() });
    vi.stubGlobal('document', doc);
    vi.stubGlobal('sessionStorage', memoryStorage());
    return { loc, open };
  }
  it('iPad: пробует приложение, а если страница осталась на экране — предлагает сайт', async () => {
    vi.useFakeTimers();
    const { loc, open } = stubBrowser('Mozilla/5.0 (iPad; CPU OS 18_0 like Mac OS X)');
    settingsStore.set((s) => ({ ...s, ytmOpenMode: 'app' }));
    const r = await runTool('open_music_service', { service: 'youtube-music' });
    expect(r.text).toContain('Треки выбираются в самом приложении');
    expect(loc.href).toBe('youtubemusic://');
    expect(open).not.toHaveBeenCalled();
    expect(musicStore.get().active).toBe('youtube-music');
    vi.advanceTimersByTime(1700);
    expect(ytmFallbackStore.get()).toBe(true);
  });
  it('Android: новое окно с https://music.youtube.com/, приложение не уходит со своей страницы', () => {
    const { loc, open } = stubBrowser('Mozilla/5.0 (Linux; Android 14; Pixel 7)');
    openYouTubeMusic();
    expect(open).toHaveBeenCalledWith('https://music.youtube.com/', '_blank', 'noopener');
    expect(loc.href).toBe('https://alexzamcom.github.io/ai-car-expert/');
  });
});

describe('переход и возвращение', () => {
  it('запоминается приложение и время; мгновенный «возврат» не считается', () => {
    vi.useFakeTimers();
    vi.stubGlobal('sessionStorage', memoryStorage());
    markLeaving('youtube-music');
    expect(lastHandoffStore.get()?.app).toBe('youtube-music');
    expect(takeReturn()).toBeNull();
    markLeaving('youtube-music');
    vi.advanceTimersByTime(4000);
    expect(takeReturn()?.app).toBe('youtube-music');
  });
  it('сохранённый маршрут действует 6 часов', () => {
    const store = memoryStorage();
    vi.stubGlobal('localStorage', store);
    const dest = { id: '1', name: 'Театр', address: '', lat: 55.78, lon: 37.62 };
    store.setItem('ace:nav-session', JSON.stringify({ dest, via: null, guiding: true, at: 1_000_000 }));
    expect(readNavSession(1_000_000 + 3600_000)?.guiding).toBe(true);
    expect(readNavSession(1_000_000 + 7 * 3600_000)).toBeNull();
  });
});
