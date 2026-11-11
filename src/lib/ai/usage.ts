/* Учёт обращений к платному ИИ на этом устройстве: запросы за сутки и месяц, токены, оценка стоимости.
   Сервер (server/ai-proxy) дополнительно ограничивает запросы в минуту и в сутки — это защита бюджета,
   даже если приложение на другом устройстве настроено иначе. */
import { createStore } from '../store';
import { settingsStore, type AiProvider } from '../state';

export interface Usage {
  day: string; // YYYY-MM-DD
  dayRequests: number;
  month: string; // YYYY-MM
  monthRequests: number;
  monthTokensIn: number;
  monthTokensOut: number;
  monthCostUsd: number;
  /** Были запросы с неизвестной ценой — стоимость тогда нижняя оценка. */
  costUnknown: boolean;
}

const dayKey = (d: Date) => d.toISOString().slice(0, 10);

const empty = (d = new Date()): Usage => ({
  day: dayKey(d),
  dayRequests: 0,
  month: dayKey(d).slice(0, 7),
  monthRequests: 0,
  monthTokensIn: 0,
  monthTokensOut: 0,
  monthCostUsd: 0,
  costUnknown: false,
});

export const usageStore = createStore<Usage>(empty(), 'ai-usage');

/** Счётчики с учётом смены суток и месяца. */
export function currentUsage(now = new Date()): Usage {
  const u = usageStore.get();
  const d = dayKey(now);
  if (u.month !== d.slice(0, 7)) return empty(now);
  if (u.day !== d) return { ...u, day: d, dayRequests: 0 };
  return u;
}

/** Стоимость по ценам из настроек; null — цены не заданы. */
export function estimateCost(provider: AiProvider, tokensIn: number, tokensOut: number): number | null {
  const p = settingsStore.get().aiPrices?.[provider];
  if (!p || (!p.inUsd && !p.outUsd)) return null;
  return (tokensIn * p.inUsd + tokensOut * p.outUsd) / 1e6;
}

/** Записать один запрос к облаку. Без usage от сервера — грубая оценка по длине (≈4 символа на токен). */
export function recordUsage(
  provider: AiProvider,
  usage: { prompt_tokens?: number; completion_tokens?: number } | undefined,
  approxChars = 0,
  now = new Date(),
) {
  const tin = usage?.prompt_tokens || Math.ceil(approxChars / 4);
  const tout = usage?.completion_tokens ?? 0;
  const cost = estimateCost(provider, tin, tout);
  const u = currentUsage(now);
  usageStore.set({
    ...u,
    dayRequests: u.dayRequests + 1,
    monthRequests: u.monthRequests + 1,
    monthTokensIn: u.monthTokensIn + tin,
    monthTokensOut: u.monthTokensOut + tout,
    monthCostUsd: u.monthCostUsd + (cost ?? 0),
    costUnknown: u.costUnknown || cost == null,
  });
}

export function resetUsage() {
  usageStore.set(empty());
}

export type CloudBlock = 'not-configured' | 'local-mode' | 'offline' | 'daily-limit' | 'budget';

/** Можно ли сейчас обратиться к облаку; если нет — почему. */
export function cloudBlock(now = new Date()): CloudBlock | null {
  const s = settingsStore.get();
  if (!s.aiEndpoint) return 'not-configured';
  if (s.aiMode === 'local') return 'local-mode';
  if (typeof navigator !== 'undefined' && navigator.onLine === false) return 'offline';
  const u = currentUsage(now);
  if (s.aiDailyLimit > 0 && u.dayRequests >= s.aiDailyLimit) return 'daily-limit';
  if (s.aiMonthlyBudgetUsd > 0 && u.monthCostUsd >= s.aiMonthlyBudgetUsd) return 'budget';
  return null;
}

export function fmtUsd(v: number) {
  return v > 0 && v < 0.01 ? '< $0.01' : `$${v.toFixed(2)}`;
}

export const PROVIDER_LABEL: Record<AiProvider, string> = { openai: 'OpenAI', grok: 'Grok' };
