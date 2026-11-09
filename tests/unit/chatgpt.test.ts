import { describe, it, expect, vi, afterEach } from 'vitest';
import { CHATGPT_URL, shortcutUrl, platform, returnHint, markLeaving, onReturn } from '../../src/lib/chatgpt';
import { APPS, findApp, isWebLink } from '../../src/lib/apps';
import { parseCommand } from '../../src/lib/voiceCommands';
import { runTool } from '../../src/lib/tools';
import { toastStore } from '../../src/lib/state';

afterEach(() => {
  vi.unstubAllGlobals();
  vi.useRealTimers();
});

function memoryStorage() {
  const m = new Map<string, string>();
  return { getItem: (k: string) => m.get(k) ?? null, setItem: (k: string, v: string) => void m.set(k, v), removeItem: (k: string) => void m.delete(k) };
}

describe('ChatGPT по подписке', () => {
  it('официальный адрес, без API', () => {
    expect(CHATGPT_URL).toBe('https://chatgpt.com/');
    const app = findApp('chatgpt')!;
    expect(app.href).toBe(CHATGPT_URL);
    expect(isWebLink(app)).toBe(true);
    expect(APPS[0].id).toBe('chatgpt');
  });

  it('быстрая команда для голосового режима', () => {
    expect(shortcutUrl('')).toBeNull();
    expect(shortcutUrl(' ChatGPT голос ')).toBe('shortcuts://run-shortcut?name=ChatGPT%20%D0%B3%D0%BE%D0%BB%D0%BE%D1%81');
  });

  it('платформа и подсказка о возврате', () => {
    expect(platform('Mozilla/5.0 (iPad; CPU OS 18_0 like Mac OS X)', 5)).toBe('ios');
    expect(platform('Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7)', 5)).toBe('ios'); // iPadOS в режиме «как Mac»
    expect(platform('Mozilla/5.0 (Linux; Android 14; Pixel 7)', 5)).toBe('android');
    expect(returnHint('ios', true).join(' ')).toContain('Split View');
    expect(returnHint('ios', false).join(' ')).not.toContain('Split View');
    expect(returnHint('android')[0]).toContain('Назад');
  });

  it('голосовые команды ru/uk', () => {
    for (const t of ['открой ChatGPT', 'чат джи пи ти', 'Відкрий чат GPT']) {
      const c = parseCommand(t);
      expect(c.kind === 'tool' && c.name).toBe('open_app');
      expect(c.kind === 'tool' && c.args).toEqual({ app: 'chatgpt' });
    }
  });

  it('инструмент open_app открывает chatgpt.com в новом окне, не уводя приложение', async () => {
    const open = vi.fn(() => null);
    vi.stubGlobal('window', { open, location: { href: 'https://alexzamcom.github.io/ai-car-expert/' } });
    vi.stubGlobal('sessionStorage', memoryStorage());
    const r = await runTool('open_app', { app: 'chatgpt' });
    expect(r.ok).toBe(true);
    expect(open).toHaveBeenCalledWith('https://chatgpt.com/', '_blank', 'noopener');
  });

  it('при возвращении — подтверждение, что всё на месте', () => {
    vi.useFakeTimers();
    vi.stubGlobal('sessionStorage', memoryStorage());
    markLeaving();
    vi.advanceTimersByTime(5000);
    expect(onReturn()).toBe(true);
    expect(toastStore.get().at(-1)?.text).toContain('С возвращением');
    expect(onReturn()).toBe(false); // второй раз — без повторного сообщения
  });

  it('мгновенное «возвращение» (переход не состоялся) — без сообщения', () => {
    vi.stubGlobal('sessionStorage', memoryStorage());
    markLeaving();
    expect(onReturn()).toBe(false);
  });
});
