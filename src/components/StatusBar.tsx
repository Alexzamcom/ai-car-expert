import { useEffect, useState } from 'react';
import { Icon } from './Icon';
import { useStore } from '../lib/store';
import { settingsStore, vehicleName, openSection, toast } from '../lib/state';
import { geoStore, navStore, navLang } from '../lib/nav';
import { fmtDistance } from '../lib/routing';
import { playerStore, togglePlay } from '../lib/player';
import { isRemoteConfigured, blockNote } from '../lib/assistant';
import { cloudBlock, PROVIDER_LABEL } from '../lib/ai/usage';
import { musicStore } from '../lib/music/sources';
import { YouTubeMusicLink } from './YouTubeMusic';
import { themeStore, cycleThemeMode, THEME_MODE_LABEL, type ThemeMode } from '../lib/theme';

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
  const nav = useStore(navStore);
  const player = useStore(playerStore);
  const music = useStore(musicStore);
  const theme = useStore(themeStore);
  const name = vehicleName(settings.vehicle);
  const routeLeft = nav.route && nav.progress ? nav.route.duration * (nav.progress.remainingM / Math.max(1, nav.route.distance)) : null;

  return (
    <header className="statusbar">
      <button className="sb-vehicle" onClick={() => openSection('vehicle')} aria-label="Мой автомобиль">
        <span className="sb-logo">
          <Icon name="spark" size="1.1em" stroke={2} />
        </span>
        <span className="sb-vehicle-text">
          <strong>{name || 'AI Car Expert'}</strong>
          <small>{settings.vehicle.engine || 'AI Car Expert'}</small>
        </span>
      </button>

      <div className="sb-clock" aria-label="Время">
        <span className="sb-time">{now.toLocaleTimeString('ru-RU', { hour: '2-digit', minute: '2-digit' })}</span>
        <span className="sb-date">{now.toLocaleDateString('ru-RU', { weekday: 'short', day: 'numeric', month: 'long' })}</span>
      </div>

      <div className="sb-right">
        {nav.status === 'guiding' && nav.progress && routeLeft != null && (
          <button className="sb-chip sb-route" onClick={() => openSection('navigation')}>
            <Icon name="flag" size="1em" />
            <span>
              {new Date(Date.now() + routeLeft * 1000).toLocaleTimeString('ru-RU', { hour: '2-digit', minute: '2-digit' })} · {fmtDistance(nav.progress.remainingM, navLang())}
            </span>
          </button>
        )}
        {music.active === 'youtube-music' && !player.playing ? (
          <YouTubeMusicLink className="sb-chip sb-now sb-ytm" label="YouTube Music — открыть">
            <Icon name="play" size="1em" filled stroke={0} />
            <span>YouTube Music</span>
          </YouTubeMusicLink>
        ) : player.current && (
          <button className="sb-chip sb-now" onClick={togglePlay} aria-label={player.playing ? 'Пауза' : 'Воспроизвести'}>
            <Icon name={player.playing ? 'pause' : 'play'} size="1em" filled stroke={0} />
            <span>{player.current.title}</span>
          </button>
        )}
        <button
          className={`sb-icon ${isRemoteConfigured() ? 'is-ok' : 'is-off'}`}
          onClick={() => {
            const b = cloudBlock();
            toast(b ? `${blockNote(b)} — помощник выполняет команды и отвечает из встроенной базы. Настройки → ИИ-помощник.` : `${PROVIDER_LABEL[settingsStore.get().aiProvider]} подключён через ваш сервер. Простые команды выполняются на устройстве.`, 'info');
          }}
          aria-label="Состояние ИИ"
        >
          <Icon name="spark" size="1.25em" />
        </button>
        <button
          className={`sb-icon ${geo.status === 'watching' ? 'is-ok' : geo.status === 'denied' ? 'is-warn' : 'is-off'}`}
          onClick={() => toast(geo.status === 'watching' ? `GPS: точность ±${Math.round(geo.accuracy ?? 0)} м` : 'Геопозиция недоступна', 'info')}
          aria-label="GPS"
        >
          <Icon name="gps" size="1.25em" />
        </button>
        <span className={`sb-icon ${online ? 'is-ok' : 'is-warn'}`} title={online ? 'Сеть доступна' : 'Нет сети'} aria-label={online ? 'Сеть доступна' : 'Нет сети'}>
          <Icon name={online ? 'wifi' : 'wifiOff'} size="1.25em" />
        </span>
        <button
          className={`sb-icon-btn sb-theme ${theme.mode === 'auto' ? 'is-auto' : ''}`}
          onClick={() => {
            const m: ThemeMode = cycleThemeMode();
            toast(`Тема: ${THEME_MODE_LABEL[m]}`, 'info');
          }}
          aria-label={`Тема: ${THEME_MODE_LABEL[theme.mode]}. Переключить`}
          title={`Тема: ${THEME_MODE_LABEL[theme.mode]}`}
        >
          <Icon name={theme.mode === 'auto' ? 'autoTheme' : theme.active === 'day' ? 'sun' : 'moon'} size="1.35em" />
          {theme.mode === 'auto' && <span className="sb-theme-badge">A</span>}
        </button>
        <button className="sb-icon-btn" onClick={() => openSection('settings')} aria-label="Настройки">
          <Icon name="gear" size="1.35em" />
        </button>
      </div>
    </header>
  );
}
