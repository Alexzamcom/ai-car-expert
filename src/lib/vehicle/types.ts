/* Границы интеграции с автомобилем и будущими модулями (OBD-II, охранный модуль).
   Сейчас ни один адаптер не подключён. Модель разрешений заложена заранее:
   - read: чтение данных (OBD PID, статус охраны) — безопасно, без влияния на автомобиль;
   - notify: события от модуля (тревога, низкий заряд АКБ) — только уведомление;
   - command: команды автомобилю. ЗАПРЕЩЕНЫ до отдельной технической проверки
     безопасности; даже после неё — только явное подтверждение водителя, никогда от ИИ. */

export type Permission = 'read' | 'notify' | 'command';

export interface ModuleInfo {
  id: string;
  name: string;
  kind: 'obd' | 'security' | 'can-gateway';
  status: 'not-connected' | 'connecting' | 'connected' | 'error' | 'planned';
  /** Разрешения, которые модуль запрашивает, и что разрешил владелец. */
  requested: Permission[];
  granted: Permission[];
  note: string;
}

/** Действия, которые ИИ-помощнику запрещено инициировать при любой интеграции. */
export const AI_FORBIDDEN: Permission[] = ['command'];

export function canAiUse(m: ModuleInfo, p: Permission): boolean {
  return !AI_FORBIDDEN.includes(p) && m.status === 'connected' && m.granted.includes(p);
}

export const MODULES: ModuleInfo[] = [
  {
    id: 'obd',
    name: 'OBD-II адаптер (ELM327)',
    kind: 'obd',
    status: 'planned',
    requested: ['read'],
    granted: [],
    note: 'Чтение кодов ошибок и параметров. Safari не поддерживает Web Bluetooth/Web Serial — нужен Wi-Fi адаптер с локальным мостом или нативная обёртка.',
  },
  {
    id: 'security',
    name: 'Модуль охраны и мониторинга',
    kind: 'security',
    status: 'planned',
    requested: ['read', 'notify'],
    granted: [],
    note: 'Отдельный этап. Только статус охраны и уведомления; дистанционные команды не предусмотрены.',
  },
];
