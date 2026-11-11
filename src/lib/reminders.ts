/* Сервисные напоминания: «напомни заменить масло через 5000 км», «проверить шины 1 декабря».
   Хранятся на устройстве; срок — дата и/или пробег. */
import { createStore, uid } from './store';
import { settingsStore } from './state';

export interface Reminder {
  id: string;
  text: string;
  dueDate: string | null; // YYYY-MM-DD
  dueKm: number | null;
  created: string;
  done: boolean;
}

export const remindersStore = createStore<Reminder[]>([], 'reminders');

export function addReminder(r: { text: string; dueDate?: string | null; dueKm?: number | null }): Reminder {
  const rem: Reminder = {
    id: uid(),
    text: r.text.trim(),
    dueDate: r.dueDate || null,
    dueKm: r.dueKm ?? null,
    created: new Date().toISOString().slice(0, 10),
    done: false,
  };
  remindersStore.set((l) => [...l, rem]);
  return rem;
}

export function completeReminder(id: string) {
  remindersStore.set((l) => l.map((r) => (r.id === id ? { ...r, done: true } : r)));
}

export function deleteReminder(id: string) {
  remindersStore.set((l) => l.filter((r) => r.id !== id));
}

/** Наступил ли срок: дата прошла или пробег достигнут (если пробег известен). */
export function isDue(r: Reminder, now = new Date(), odometerKm = settingsStore.get().vehicle.odometerKm) {
  if (r.done) return false;
  if (r.dueDate && r.dueDate <= now.toISOString().slice(0, 10)) return true;
  if (r.dueKm != null && odometerKm != null && odometerKm >= r.dueKm) return true;
  return false;
}

export function activeReminders(now = new Date()) {
  return remindersStore
    .get()
    .filter((r) => !r.done)
    .sort((a, b) => Number(isDue(b, now)) - Number(isDue(a, now)) || (a.dueDate ?? '9999').localeCompare(b.dueDate ?? '9999'));
}

export function reminderLabel(r: Reminder) {
  const when = [r.dueDate ? new Date(r.dueDate).toLocaleDateString('ru-RU') : '', r.dueKm != null ? `${r.dueKm.toLocaleString('ru-RU')} км` : '']
    .filter(Boolean)
    .join(' или ');
  return when ? `${r.text} — ${when}` : r.text;
}
