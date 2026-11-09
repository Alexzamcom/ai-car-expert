import { describe, it, expect, afterEach } from 'vitest';
import fs from 'node:fs';
import { runTool, TOOLS } from '../../src/lib/tools';
import { setActiveSource } from '../../src/lib/music/sources';
import { playerStore } from '../../src/lib/player';
import { parseCommand } from '../../src/lib/voiceCommands';
import { ytmControlHint, controlWays } from '../../src/lib/music/youtube';

afterEach(() => {
  setActiveSource('radio');
  playerStore.set((s) => ({ ...s, playing: false }));
});

describe('управление воспроизведением при активном YouTube Music', () => {
  for (const action of ['play', 'pause', 'next', 'previous']) {
    it(`«${action}» не трогает радио и честно объясняет, как управлять YouTube Music`, async () => {
      setActiveSource('youtube-music');
      const before = playerStore.get();
      const r = await runTool('media_control', { action });
      expect(r.ok).toBe(false);
      expect(r.text).toBe(ytmControlHint());
      expect(r.text).toContain('Siri');
      expect(r.text).toContain('Пункт управления');
      expect(playerStore.get().playing).toBe(before.playing);
    });
  }
  it('голосовые «пауза», «следующая», «играй» ведут к этой команде', () => {
    for (const t of ['пауза', 'следующая', 'играй', 'назад']) {
      const c = parseCommand(t);
      expect(c.kind === 'tool' && c.name, t).toBe('media_control');
    }
  });
  it('когда активно радио, команды по-прежнему управляют радио', async () => {
    setActiveSource('radio');
    const r = await runTool('media_control', { action: 'pause' });
    expect(r.ok).toBe(true);
  });
  it('описание инструмента для Grok не обещает управление YouTube Music', () => {
    const d = TOOLS.find((t) => t.function.name === 'media_control')!.function.description;
    expect(d).toContain('YouTube Music этим не управляется');
  });
});

describe('подсказки по платформе', () => {
  it('iPad/iPhone: Пункт управления и Siri; Android: шторка и Google Ассистент; везде — руль', () => {
    const ios = controlWays('ios').map((w) => w.title);
    const android = controlWays('android').map((w) => w.title);
    expect(ios).toEqual(['Пункт управления', 'Siri', 'Кнопки на руле или магнитоле']);
    expect(android).toEqual(['Шторка уведомлений', 'Google Ассистент', 'Кнопки на руле или магнитоле']);
    expect(ytmControlHint('android')).not.toContain('Siri');
    expect(ytmControlHint('ios')).toContain('Siri');
  });
});

describe('нет фиктивных кнопок', () => {
  it('в панели YouTube Music нет кнопок «пауза / вперёд / назад»', () => {
    const src = fs.readFileSync('src/components/YouTubeMusic.tsx', 'utf8');
    expect(src).not.toMatch(/aria-label="(Пауза|Следующ|Предыдущ|Играть)/);
    expect(src).not.toMatch(/name="(pause|next|prev)"/);
  });
  it('исследование задокументировано: подтверждённое и гипотезы', () => {
    const doc = fs.readFileSync('docs/MEDIA-CONTROL.md', 'utf8');
    expect(doc).toContain('## Подтверждено');
    expect(doc).toContain('## Гипотезы');
  });
});
