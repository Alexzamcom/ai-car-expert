import { createStore, uid } from '../store';
import { PEUGEOT_3008_2010 } from './peugeot3008';
import type { KbFact, FactStatus } from './types';
import { settingsStore } from '../state';

export * from './types';

/** Факты владельца: собственные заметки и подтверждения/исправления базовых фактов. */
export interface OwnerOverride {
  status?: FactStatus;
  text?: string;
  source?: string;
}

export const ownerFactsStore = createStore<KbFact[]>([], 'kb-owner-facts');
export const overridesStore = createStore<Record<string, OwnerOverride>>({}, 'kb-overrides');

export function baseFacts(): KbFact[] {
  const v = settingsStore.get().vehicle;
  const isPeugeot3008 = /peugeot|пежо/i.test(v.make) && /3008/.test(v.model);
  return isPeugeot3008 ? PEUGEOT_3008_2010 : [];
}

export function allFacts(): KbFact[] {
  const ov = overridesStore.get();
  return [...baseFacts().map((f) => ({ ...f, ...ov[f.id] })), ...ownerFactsStore.get()];
}

export function confirmFact(id: string, source = 'Владелец') {
  overridesStore.set((o) => ({ ...o, [id]: { ...o[id], status: 'owner', source } }));
}

export function resetFact(id: string) {
  overridesStore.set((o) => {
    const n = { ...o };
    delete n[id];
    return n;
  });
}

export function addOwnerFact(f: Omit<KbFact, 'id' | 'status'>) {
  ownerFactsStore.set((l) => [...l, { ...f, id: `own-${uid()}`, status: 'owner', source: f.source || 'Владелец' }]);
}

export function removeOwnerFact(id: string) {
  ownerFactsStore.set((l) => l.filter((f) => f.id !== id));
}

const norm = (s: string) => s.toLowerCase().replace(/ё/g, 'е');

/** Общие слова почти в каждом вопросе об автомобиле — почти не влияют на выбор факта. */
const GENERIC = ['двигател', 'мотор', 'машин', 'автомобил', 'авто', 'peugeot', 'пежо', '3008', 'мой', 'моего', 'какой', 'какое', 'нужн', 'заливать', 'работает'];
const isGeneric = (w: string) => GENERIC.some((g) => w.startsWith(g));

/** Поиск по базе знаний (теги, заголовок, текст). */
export function searchFacts(query: string, limit = 4): KbFact[] {
  const q = norm(query);
  const words = q.split(/[^a-zа-яіїєґ0-9/]+/i).filter((w) => w.length > 2);
  return allFacts()
    .map((f) => {
      const title = norm(f.title);
      const text = norm(f.text);
      let score = 0;
      for (const t of f.tags.map(norm)) if (q.includes(t)) score += isGeneric(t) ? 1 : 5;
      for (const w of words) {
        const stem = w.length > 5 ? w.slice(0, -2) : w;
        const k = isGeneric(stem) ? 0.2 : 1;
        if (title.includes(stem)) score += 3 * k;
        if (f.tags.some((t) => norm(t).includes(stem))) score += 2 * k;
        if (text.includes(stem)) score += 1 * k;
      }
      return { f, score };
    })
    .filter((x) => x.score >= 3)
    .sort((a, b) => b.score - a.score)
    .slice(0, limit)
    .map((x) => x.f);
}

/** Подсказки для ненавязчивого обучения. */
export function tips(): KbFact[] {
  return allFacts().filter((f) => f.tip);
}

export function tipOfTheDay(date = new Date()): KbFact | null {
  const list = tips();
  if (!list.length) return null;
  const day = Math.floor(date.getTime() / 86400000);
  return list[day % list.length];
}

/** Компактное представление базы для системного промпта помощника. */
export function factsForPrompt(): string {
  return allFacts()
    .map((f) => `- [${f.status}] ${f.title}: ${f.text}${f.source ? ` (источник: ${f.source})` : ''}`)
    .join('\n');
}
