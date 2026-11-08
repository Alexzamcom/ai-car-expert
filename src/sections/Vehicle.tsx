import { Icon, type IconName } from '../components/Icon';
import { CarIllustration } from '../components/CarIllustration';
import { useStore } from '../lib/store';
import { settingsStore, serviceStore, vehicleName, nextServiceEstimate, openSection, toast, SERVICE_CATEGORIES } from '../lib/state';
import { geoStore } from '../lib/nav';

const SYSTEMS: { icon: IconName; title: string }[] = [
  { icon: 'fan', title: 'Климат' },
  { icon: 'lock', title: 'Замки' },
  { icon: 'door', title: 'Двери' },
  { icon: 'window', title: 'Окна' },
  { icon: 'light', title: 'Освещение' },
  { icon: 'trunk', title: 'Багажник' },
];

const fmtKm = (n: number | null | undefined) => (n == null ? '—' : `${n.toLocaleString('ru-RU')} км`);

export function Vehicle() {
  const settings = useStore(settingsStore);
  const records = useStore(serviceStore);
  const geo = useStore(geoStore);
  const v = settings.vehicle;
  const name = vehicleName(v);
  const next = nextServiceEstimate(records, v);
  const last = records[0];

  return (
    <div className="section vehicle">
      <div className="vehicle-hero card">
        <div className="vehicle-hero-text">
          <div className="eyebrow">Мой автомобиль</div>
          <h2 className="display">{name || 'Автомобиль не указан'}</h2>
          {v.vin && <div className="muted mono">VIN {v.vin}</div>}
          {!name && (
            <button className="btn btn-primary" onClick={() => openSection('settings')}>
              <Icon name="edit" /> Указать автомобиль
            </button>
          )}
        </div>
        <CarIllustration />
      </div>

      <div className="notice notice-warn">
        <Icon name="plug" size="1.8rem" />
        <div>
          <strong>Автомобиль не подключён</strong>
          <p>
            Состояние систем автомобиля недоступно. Пробег и сроки ТО рассчитываются по вашим записям.
            Подключение через OBD-II — в разработке.
          </p>
        </div>
      </div>

      <div className="tiles">
        <div className="tile">
          <div className="tile-label">
            <Icon name="gauge" /> Пробег
          </div>
          <div className="tile-value">{fmtKm(v.odometerKm)}</div>
          <div className="tile-sub">{v.odometerDate ? `по записи от ${new Date(v.odometerDate).toLocaleDateString('ru-RU')}` : 'вводится вручную'}</div>
        </div>
        <button className="tile tile-btn" onClick={() => openSection('service')}>
          <div className="tile-label">
            <Icon name="calendar" /> Следующее ТО
          </div>
          {next ? (
            <>
              <div className={`tile-value ${next.daysLeft < 0 || (next.kmLeft ?? 1) < 0 ? 'text-danger' : next.daysLeft < 30 || (next.kmLeft ?? 99999) < 1000 ? 'text-warn' : ''}`}>
                {next.kmLeft != null ? fmtKm(Math.max(next.kmLeft, 0)) : next.dueDate.toLocaleDateString('ru-RU')}
              </div>
              <div className="tile-sub">
                {next.daysLeft < 0 ? 'просрочено' : `до ${next.dueDate.toLocaleDateString('ru-RU')}`}
                {next.dueKm != null && ` · ${fmtKm(next.dueKm)}`}
              </div>
            </>
          ) : (
            <>
              <div className="tile-value muted">—</div>
              <div className="tile-sub">добавьте запись о плановом ТО</div>
            </>
          )}
        </button>
        <button className="tile tile-btn" onClick={() => openSection('service')}>
          <div className="tile-label">
            <Icon name="wrench" /> Последнее обслуживание
          </div>
          <div className="tile-value tile-value-sm">{last ? last.title || SERVICE_CATEGORIES[last.category] : '—'}</div>
          <div className="tile-sub">{last ? new Date(last.date).toLocaleDateString('ru-RU') : 'записей пока нет'}</div>
        </button>
        <div className="tile">
          <div className="tile-label">
            <Icon name="navigate" /> Скорость по GPS
          </div>
          <div className="tile-value">{geo.speedKmh != null ? `${Math.round(geo.speedKmh)} км/ч` : '—'}</div>
          <div className="tile-sub">данные iPad, не автомобиля</div>
        </div>
      </div>

      <h3 className="section-title">Системы автомобиля</h3>
      <div className="systems">
        {SYSTEMS.map((s) => (
          <button
            key={s.title}
            className="system-tile"
            aria-disabled="true"
            onClick={() => toast(`${s.title}: управление появится после подключения к автомобилю.`, 'warn')}
          >
            <Icon name={s.icon} size="2.2rem" />
            <span className="system-name">{s.title}</span>
            <span className="badge badge-off">
              <Icon name="lock" size="0.9em" /> Нет интеграции
            </span>
          </button>
        ))}
      </div>

      <h3 className="section-title">Быстрые действия</h3>
      <div className="quick-actions">
        <button className="btn btn-lg" onClick={() => openSection('assistant')}>
          <Icon name="spark" /> Спросить AI
        </button>
        <button className="btn btn-lg" onClick={() => openSection('service')}>
          <Icon name="plus" /> Запись ТО
        </button>
        <button className="btn btn-lg" onClick={() => openSection('diagnostics')}>
          <Icon name="gauge" /> Код ошибки
        </button>
        <button className="btn btn-lg" onClick={() => openSection('manual')}>
          <Icon name="book" /> Руководство
        </button>
      </div>
    </div>
  );
}
