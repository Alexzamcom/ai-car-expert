import { createStore, uid } from './store';
import type { SectionId } from './sections';

/* ---------- Раскладка экрана (две панели, как у центрального дисплея) ---------- */

export interface LayoutState {
  primary: SectionId;
  secondary: SectionId | null;
  maximized: 'primary' | 'secondary' | null;
}

export const layoutStore = createStore<LayoutState>(
  { primary: 'navigation', secondary: 'vehicle', maximized: null },
  'layout',
);

/** Открыть раздел в основной (верхней) панели. */
export function openSection(id: SectionId) {
  layoutStore.set((s) => {
    if (s.primary === id) return { ...s, maximized: s.maximized === 'secondary' ? null : s.maximized };
    if (s.secondary === id) return { primary: id, secondary: s.primary, maximized: null };
    return { ...s, primary: id, maximized: s.maximized === 'secondary' ? null : s.maximized };
  });
}

export function swapPanes() {
  layoutStore.set((s) =>
    s.secondary ? { primary: s.secondary, secondary: s.primary, maximized: null } : s,
  );
}

export function toggleMaximize(pane: 'primary' | 'secondary') {
  layoutStore.set((s) => ({ ...s, maximized: s.maximized === pane ? null : pane }));
}

export function closeSecondary() {
  layoutStore.set((s) => ({ ...s, secondary: null, maximized: null }));
}

export function openInSecondary(id: SectionId) {
  layoutStore.set((s) =>
    s.primary === id ? s : { primary: s.primary, secondary: id, maximized: null },
  );
}

/* ---------- Настройки ---------- */

export interface VehicleProfile {
  make: string;
  model: string;
  year: string;
  vin: string;
  fuel: 'petrol' | 'diesel' | 'hybrid' | 'electric' | 'gas';
  odometerKm: number | null;
  odometerDate: string | null;
  serviceIntervalKm: number;
  serviceIntervalMonths: number;
}

export interface Settings {
  vehicle: VehicleProfile;
  aiEndpoint: string;
  aiToken: string;
  speechLang: string;
  speakReplies: boolean;
  textScale: 'normal' | 'large' | 'xlarge';
  keepAwake: boolean;
}

export const settingsStore = createStore<Settings>(
  {
    vehicle: {
      make: '',
      model: '',
      year: '',
      vin: '',
      fuel: 'petrol',
      odometerKm: null,
      odometerDate: null,
      serviceIntervalKm: 10000,
      serviceIntervalMonths: 12,
    },
    aiEndpoint: '',
    aiToken: '',
    speechLang: 'ru-RU',
    speakReplies: true,
    textScale: 'normal',
    keepAwake: true,
  },
  'settings',
);

export function vehicleName(v: VehicleProfile): string {
  const name = [v.make, v.model].filter(Boolean).join(' ').trim();
  return name ? `${name}${v.year ? ` · ${v.year}` : ''}` : '';
}

/* ---------- История обслуживания ---------- */

export type ServiceCategory = 'to' | 'oil' | 'brakes' | 'tires' | 'battery' | 'repair' | 'other';

export const SERVICE_CATEGORIES: Record<ServiceCategory, string> = {
  to: 'Плановое ТО',
  oil: 'Замена масла',
  brakes: 'Тормоза',
  tires: 'Шины',
  battery: 'Аккумулятор',
  repair: 'Ремонт',
  other: 'Другое',
};

export interface ServiceRecord {
  id: string;
  date: string; // YYYY-MM-DD
  odometerKm: number | null;
  category: ServiceCategory;
  title: string;
  cost: number | null;
  workshop: string;
  notes: string;
}

export const serviceStore = createStore<ServiceRecord[]>([], 'service');

export function upsertServiceRecord(rec: Omit<ServiceRecord, 'id'> & { id?: string }) {
  const record: ServiceRecord = { ...rec, id: rec.id ?? uid() };
  serviceStore.set((list) => {
    const rest = list.filter((r) => r.id !== record.id);
    return [...rest, record].sort((a, b) => b.date.localeCompare(a.date));
  });
  // Пробег из записи обновляет профиль, если он больше известного.
  if (record.odometerKm != null) {
    settingsStore.set((s) =>
      (s.vehicle.odometerKm ?? 0) < record.odometerKm!
        ? { ...s, vehicle: { ...s.vehicle, odometerKm: record.odometerKm, odometerDate: record.date } }
        : s,
    );
  }
}

export function deleteServiceRecord(id: string) {
  serviceStore.set((list) => list.filter((r) => r.id !== id));
}

/** Расчёт следующего планового ТО по последней записи «Плановое ТО». */
export function nextServiceEstimate(records: ServiceRecord[], v: VehicleProfile) {
  const lastTo = records.find((r) => r.category === 'to');
  if (!lastTo) return null;
  const due = new Date(lastTo.date);
  due.setMonth(due.getMonth() + v.serviceIntervalMonths);
  const dueKm = lastTo.odometerKm != null ? lastTo.odometerKm + v.serviceIntervalKm : null;
  const kmLeft = dueKm != null && v.odometerKm != null ? dueKm - v.odometerKm : null;
  const daysLeft = Math.round((due.getTime() - Date.now()) / 86400000);
  return { lastTo, dueDate: due, dueKm, kmLeft, daysLeft };
}

/* ---------- Уведомления (toast) ---------- */

export interface Toast {
  id: string;
  text: string;
  tone: 'info' | 'warn' | 'ok';
}

export const toastStore = createStore<Toast[]>([]);

export function toast(text: string, tone: Toast['tone'] = 'info') {
  const t = { id: uid(), text, tone };
  toastStore.set((l) => [...l.slice(-2), t]);
  setTimeout(() => toastStore.set((l) => l.filter((x) => x.id !== t.id)), 4200);
}
