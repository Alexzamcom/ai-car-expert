import { Icon } from '../components/Icon';
import { useStore } from '../lib/store';
import { tripStore, resetTrip } from '../lib/trip';
import { geoStore, navStore, navLang } from '../lib/nav';
import { fmtDistance, fmtDuration } from '../lib/routing';
import { settingsStore, serviceStore, nextServiceEstimate, openSection } from '../lib/state';
import { tipOfTheDay, overridesStore, ownerFactsStore, STATUS_LABEL } from '../lib/knowledge';
import { speak } from '../lib/speech';

export function Trip() {
  const trip = useStore(tripStore);
  const geo = useStore(geoStore);
  const nav = useStore(navStore);
  const settings = useStore(settingsStore);
  const records = useStore(serviceStore);
  useStore(overridesStore);
  useStore(ownerFactsStore);
  const lang = navLang();
  const avg = trip.movingS > 60 ? (trip.distanceM / 1000) / (trip.movingS / 3600) : null;
  const next = nextServiceEstimate(records, settings.vehicle);
  const tip = settings.featureTips ? tipOfTheDay() : null;

  return (
    <div className="section trip">
      <div className="trip-stats">
        <div className="stat">
          <small>Скорость (GPS)</small>
          <strong>{geo.speedKmh != null ? Math.round(geo.speedKmh) : '—'}</strong>
          <span>км/ч</span>
        </div>
        <div className="stat">
          <small>Пройдено</small>
          <strong>{(trip.distanceM / 1000).toFixed(1).replace('.', ',')}</strong>
          <span>км</span>
        </div>
        <div className="stat">
          <small>В движении</small>
          <strong>{trip.movingS ? fmtDuration(trip.movingS, lang) : '—'}</strong>
        </div>
        <div className="stat">
          <small>Средняя</small>
          <strong>{avg ? Math.round(avg) : '—'}</strong>
          <span>км/ч</span>
        </div>
        <div className="stat">
          <small>Максимальная</small>
          <strong>{trip.maxKmh ? Math.round(trip.maxKmh) : '—'}</strong>
          <span>км/ч</span>
        </div>
        <div className="stat">
          <small>Начало поездки</small>
          <strong>{trip.startedAt ? new Date(trip.startedAt).toLocaleTimeString('ru-RU', { hour: '2-digit', minute: '2-digit' }) : '—'}</strong>
        </div>
      </div>

      <div className="trip-row">
        {nav.route && nav.progress ? (
          <div className="info-card">
            <Icon name="route" />
            <div>
              <strong>{nav.dest?.name}</strong>
              <small>
                осталось {fmtDistance(nav.progress.remainingM, lang)} · {fmtDuration(nav.route.duration * (nav.progress.remainingM / Math.max(1, nav.route.distance)), lang)}
              </small>
            </div>
          </div>
        ) : (
          <button className="info-card" onClick={() => document.getElementById('map-search')?.focus()}>
            <Icon name="route" />
            <div>
              <strong>Маршрут не задан</strong>
              <small>Скажите «Маршрут до …» или введите адрес на карте</small>
            </div>
          </button>
        )}
        <button className="info-card" onClick={() => openSection('service')}>
          <Icon name="wrench" />
          <div>
            <strong>Следующее ТО</strong>
            <small>
              {next
                ? `${next.dueDate.toLocaleDateString('ru-RU')}${next.kmLeft != null ? ` · осталось ${Math.max(0, next.kmLeft).toLocaleString('ru-RU')} км` : ''}`
                : 'Добавьте запись о последнем ТО'}
            </small>
          </div>
        </button>
      </div>

      {tip && (
        <div className="tip-card">
          <div className="tip-head">
            <Icon name="spark" />
            <strong>Совет для вашего {settings.vehicle.make} {settings.vehicle.model}</strong>
            <span className="spacer" />
            <button className="icon-btn" onClick={() => speak(tip.tip!, settings.speechLang)} aria-label="Прочитать совет">
              <Icon name="speaker" />
            </button>
          </div>
          <p>{tip.tip}</p>
          <small className="muted">{STATUS_LABEL[tip.status]}</small>
        </div>
      )}

      <div className="toolbar">
        <button className="btn" onClick={resetTrip}>
          <Icon name="trash" /> Сбросить поездку
        </button>
        <span className="muted small">Данные GPS устройства, не автомобиля.</span>
      </div>
    </div>
  );
}
