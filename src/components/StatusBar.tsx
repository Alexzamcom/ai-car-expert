import { useEffect, useState } from 'react';
import { Icon } from './Icon';
import { useStore } from '../lib/store';
import { settingsStore, vehicleName, openSection, toast } from '../lib/state';
import { geoStore } from '../lib/nav';
import { playerStore, togglePlay } from '../lib/player';

function useClock() {
  const [now, setNow] = useState(() => new Date());
  useEffect(() => {
    const t = setInterval(() => setNow(new Date()), 10000);
    return () => clearInterval(t);
  }, []);
  return now;
}

function useOnline() {
  const [online, setOnline] = useState(navigator.onLine);
  useEffect(() => {
    const on = () => setOnline(true);
    const off = () => setOnline(false);
    window.addEventListener('online', on);
    window.addEventListener('offline', off);
    return () => {
      window.removeEventListener('online', on);
      window.removeEventListener('offline', off);
    };
  }, []);
  return online;
}

export function StatusBar() {
  const now = useClock();
  const online = useOnline();
  const settings = useStore(settingsStore);
  const geo = useStore(geoStore);
  const player = useStore(playerStore);
  const name = vehicleName(settings.vehicle);

  return (
    <header className="statusbar">
      <button className="sb-vehicle" onClick={() => openSection('vehicle')}>
        <span className="sb-logo">
          <Icon name="spark" size="1.1em" stroke={2} />
        </span>
        <span className="sb-vehicle-text">
          <strong>{name || 'AI Car Expert'}</strong>
          <small>{name ? 'AI Car Expert' : 'Укажите автомобиль в настройках'}</small>
        </span>
      </button>

      <div className="sb-clock" aria-label="Время">
        <span className="sb-time">{now.toLocaleTimeString('ru-RU', { hour: '2-digit', minute: '2-digit' })}</span>
        <span className="sb-date">{now.toLocaleDateString('ru-RU', { weekday: 'short', day: 'numeric', month: 'long' })}</span>
      </div>

      <div className="sb-right">
        {player.current && (
          <button className="sb-chip sb-now" onClick={togglePlay} aria-label={player.playing ? 'Пауза' : 'Воспроизвести'}>
            <Icon name={player.playing ? 'pause' : 'play'} size="1em" filled stroke={0} />
            <span>{player.current.title}</span>
          </button>
        )}
        <button
          className="sb-chip sb-chip-muted"
          onClick={() => toast('Автомобиль не подключён. Интеграция с автомобилем и OBD-модуль — в разработке.', 'warn')}
        >
          <Icon name="plug" size="1.1em" />
          <span>Авто не подключено</span>
        </button>
        <span className={`sb-icon ${geo.status === 'watching' ? 'is-ok' : 'is-off'}`} title="GPS">
          <Icon name="gps" size="1.25em" />
        </span>
        <span className={`sb-icon ${online ? 'is-ok' : 'is-warn'}`} title={online ? 'Сеть доступна' : 'Нет сети'}>
          <Icon name={online ? 'wifi' : 'wifiOff'} size="1.25em" />
        </span>
        <button className="sb-icon-btn" onClick={() => openSection('settings')} aria-label="Настройки">
          <Icon name="gear" size="1.4em" />
        </button>
      </div>
    </header>
  );
}
