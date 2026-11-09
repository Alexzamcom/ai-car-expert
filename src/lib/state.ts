import { createStore, uid } from './store';
import { isPanel, type SectionId, type PanelId, type PageId } from './sections';

/* ---------- Раскладка экрана ----------
   Главный экран «Вождение»: карта всегда на экране + нижняя (в горизонтали — боковая)
   панель с вкладками. Остальные разделы открываются полноэкранными страницами поверх. */

export interface LayoutState {
  panel: PanelId;
  panelMode: 'collapsed' | 'normal' | 'expanded';
  order: 'map-first' | 'panel-first';
  page: PageId | null;
}

// На телефоне по умолчанию панель свёрнута — главное место у карты.
const narrow = typeof window !== 'undefined' && Math.min(window.innerWidth, window.innerHeight) < 600;

export const layoutStore = createStore<LayoutState>(
  { panel: 'media', panelMode: narrow ? 'collapsed' : 'normal', order: 'map-first', page: null },
  'layout-v2',
);

export function openSection(id: SectionId) {
  layoutStore.set((s) => {
    if (id === 'navigation') return { ...s, page: null, panelMode: s.panelMode === 'expanded' ? 'normal' : s.panelMode };
    if (isPanel(id)) return { ...s, page: null, panel: id, panelMode: s.panelMode === 'collapsed' ? 'normal' : s.panelMode };
    return { ...s, page: id };
  });
}

export function closePage() {
  layoutStore.set((s) => ({ ...s, page: null }));
}

export function setPanelMode(mode: LayoutState['panelMode']) {
  layoutStore.set((s) => ({ ...s, panelMode: mode }));
}

export function swapOrder() {
  layoutStore.set((s) => ({ ...s, order: s.order === 'map-first' ? 'panel-first' : 'map-first' }));
}

/* ---------- Настройки ---------- */

export interface VehicleProfile {
  make: string;
  model: string;
  year: string;
  engine: string;
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
  /** Голосовые подсказки навигации. */
  speakNavigation: boolean;
  /** Ненавязчивые подсказки о функциях автомобиля. */
  featureTips: boolean;
  /** После ответа помощник снова слушает (без нажатия кнопки). */
  conversationMode: boolean;
  /** Выбранный голос синтеза речи (voiceURI), пусто — автоматически. */
  voiceURI: string;
  textScale: 'normal' | 'large' | 'xlarge';
  keepAwake: boolean;
  /** Оформление: день, ночь или автоматически (по солнцу либо по теме устройства). */
  theme: 'auto' | 'day' | 'night';
}

export const settingsStore = createStore<Settings>(
  {
    vehicle: {
      // Первый тестовый автомобиль. Владелец может изменить в настройках.
      make: 'Peugeot',
      model: '3008',
      year: '2010',
      engine: '1.6 THP (бензин, турбо)',
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
    speakNavigation: true,
    featureTips: true,
    conversationMode: false,
    voiceURI: '',
    textScale: 'normal',
    keepAwake: true,
    theme: 'auto',
  },
  'settings',
);

// Миграция: в первой версии профиль был пустым — заполняем данными тестового автомобиля.
if (!settingsStore.get().vehicle.make) {
  settingsStore.set((s) => ({ ...s, vehicle: { ...s.vehicle, make: 'Peugeot', model: '3008', year: s.vehicle.year || '2010', engine: s.vehicle.engine || '1.6 THP (бензин, турбо)' } }));
}

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
