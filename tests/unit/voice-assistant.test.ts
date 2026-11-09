import { describe, it, expect } from 'vitest';
import { parseCommand } from '../../src/lib/voiceCommands';
import { isVehicleControlRequest } from '../../src/lib/vehicleGuard';
import { parseServerReply, answerLocally, systemPrompt } from '../../src/lib/assistant';
import { nextTripState } from '../../src/lib/trip';
import { decodeDtc } from '../../src/lib/dtc';
import { searchFacts, tipOfTheDay } from '../../src/lib/knowledge';
import { canAiUse, MODULES } from '../../src/lib/vehicle/types';

const tool = (t: string) => {
  const c = parseCommand(t);
  return c.kind === 'tool' ? [c.name, c.args] : ['ask'];
};

describe('голосовые команды', () => {
  it('маршрут (ru/uk)', () => {
    expect(tool('Маршрут до Красной площади')).toEqual(['navigate_to', { destination: 'красной площади' }]);
    expect(tool('проложи маршрут в аэропорт Шереметьево')).toEqual(['navigate_to', { destination: 'аэропорт шереметьево' }]);
    expect(tool('Їдемо до Львова')).toEqual(['navigate_to', { destination: 'львова' }]);
  });
  it('объекты по пути', () => {
    expect(tool('найди заправку')).toEqual(['find_along_route', { category: 'fuel' }]);
    expect(tool('где поесть по пути')).toEqual(['find_along_route', { category: 'food' }]);
    expect(tool('знайди заправку')).toEqual(['find_along_route', { category: 'fuel' }]);
  });
  it('музыка', () => {
    expect(tool('пауза')).toEqual(['media_control', { action: 'pause' }]);
    expect(tool('следующая')).toEqual(['media_control', { action: 'next' }]);
    expect(tool('включи радио')).toEqual(['play_radio', { station: '' }]);
    expect(tool('увімкни радіо джаз')).toEqual(['play_radio', { station: 'джаз' }]);
  });
  it('разделы и голос', () => {
    expect(tool('открой настройки')).toEqual(['open_section', { section: 'settings' }]);
    expect(tool('відкрий налаштування')).toEqual(['open_section', { section: 'settings' }]);
    expect(tool('выключи голос')).toEqual(['set_voice_replies', { enabled: false }]);
  });
  it('вопросы и управление автомобилем уходят помощнику', () => {
    expect(tool('как работает круиз-контроль')).toEqual(['ask']);
    expect(tool('включи кондиционер')).toEqual(['ask']);
    expect(isVehicleControlRequest('включи кондиционер')).toBe(true);
    expect(isVehicleControlRequest('увімкни кондиціонер')).toBe(true);
    expect(isVehicleControlRequest('как работает кондиционер')).toBe(false);
  });
});

describe('помощник', () => {
  it('разбирает ответ Chat Completions с вызовом инструмента', () => {
    const m = parseServerReply({ choices: [{ message: { role: 'assistant', content: null, tool_calls: [{ id: '1', function: { name: 'navigate_to', arguments: '{"destination":"Москва"}' } }] } }] });
    expect(m.tool_calls?.[0].function.name).toBe('navigate_to');
  });
  it('поддерживает упрощённый формат { reply }', () => {
    expect(parseServerReply({ reply: 'Привет' }).content).toBe('Привет');
    expect(() => parseServerReply({ foo: 1 })).toThrow();
  });
  it('офлайн: отказ в управлении климатом', () => {
    expect(answerLocally('включи кондиционер').text).toContain('не могу');
  });
  it('офлайн: факт о Peugeot с пометкой о достоверности', () => {
    const a = answerLocally('какое масло заливать в двигатель');
    expect(a.text).toContain('Моторное масло');
    expect(a.text).toContain('проверить');
  });
  it('системный промпт содержит автомобиль и правила достоверности', () => {
    const p = systemPrompt();
    expect(p).toContain('Peugeot 3008');
    expect(p).toContain('typical');
    expect(p).toContain('НЕ можешь');
  });
});

describe('база знаний', () => {
  it('находит AUTO климат-контроля', () => {
    expect(searchFacts('что делает кнопка auto на климате')[0].id).toBe('clim-auto');
  });
  it('совет дня существует', () => {
    expect(tipOfTheDay(new Date('2026-11-09'))?.tip).toBeTruthy();
  });
});

describe('поездка', () => {
  it('считает пройденное расстояние и отсекает скачки GPS', () => {
    let s = nextTripState({ startedAt: null, lastAt: null, distanceM: 0, movingS: 0, maxKmh: 0, last: null }, { lat: 55.75, lon: 37.6 }, 10, 0, 0);
    s = nextTripState(s, { lat: 55.751, lon: 37.6 }, 10, 40, 10_000);
    expect(s.distanceM).toBeGreaterThan(100);
    expect(s.distanceM).toBeLessThan(120);
    const jump = nextTripState(s, { lat: 56.5, lon: 37.6 }, 10, 40, 12_000);
    expect(jump.distanceM).toBe(s.distanceM);
  });
});

describe('разное', () => {
  it('DTC', () => {
    expect(decodeDtc('P0420').description).toContain('каталитического');
    expect(decodeDtc('X123').valid).toBe(false);
  });
  it('ИИ не может использовать команды модулей', () => {
    const m = { ...MODULES[1], status: 'connected' as const, granted: ['read', 'notify', 'command'] as const };
    expect(canAiUse({ ...m, granted: [...m.granted] }, 'command')).toBe(false);
    expect(canAiUse({ ...m, granted: [...m.granted] }, 'read')).toBe(true);
  });
});
