import { Icon } from './Icon';
import { useStore } from '../lib/store';
import { YTM_URL, currentPlan, onYouTubeMusicClick, ytmFallbackStore, controlWays } from '../lib/music/youtube';
import { lastHandoffStore, markLeaving } from '../lib/handoff';
import { musicStore, setActiveSource } from '../lib/music/sources';
import { playerStore, resume } from '../lib/player';
import { returnHint } from '../lib/chatgpt';
import { openSection } from '../lib/state';

const link = { href: YTM_URL, target: '_blank', rel: 'noopener noreferrer' } as const;
const time = (ms: number) => new Date(ms).toLocaleTimeString('ru-RU', { hour: '2-digit', minute: '2-digit' });

/** Кнопка/плитка открытия YouTube Music. Ссылка ведёт на официальный адрес; на iPad сначала пробуем приложение. */
export function YouTubeMusicLink({ className, children, label = 'Открыть YouTube Music' }: { className: string; children: React.ReactNode; label?: string }) {
  return (
    <a className={className} {...link} onClick={onYouTubeMusicClick} aria-label={label}>
      {children}
    </a>
  );
}

/** Содержимое источника «YouTube Music» в разделе «Музыка». */
export function YouTubeMusicPanel() {
  const music = useStore(musicStore);
  const last = useStore(lastHandoffStore);
  const player = useStore(playerStore);
  const plan = currentPlan();
  const opened = last?.app === 'youtube-music' ? last.at : null;

  return (
    <div className="ytm">
      <YouTubeMusicLink className="ytm-open">
        <span className="ytm-logo">
          <Icon name="play" size="1.6rem" filled stroke={0} />
        </span>
        <span className="ytm-open-text">
          <strong>Открыть YouTube Music</strong>
          <small>{plan.kind === 'scheme' ? 'Приложение YouTube Music; если не откроется — сайт' : 'Приложение YouTube Music или сайт music.youtube.com'}</small>
        </span>
        <Icon name="external" />
      </YouTubeMusicLink>

      <div className="ytm-status" role="status">
        {music.active === 'youtube-music' && opened ? (
          <>
            <strong>YouTube Music открывали в {time(opened)}</strong>
            <span>
              Музыка играет в самом приложении YouTube Music. AI Car Expert не видит, что там играет, и не управляет им —
              используйте YouTube Music или кнопки на руле автомобиля.
            </span>
          </>
        ) : (
          <span>Используется ваша учётная запись и подписка YouTube Music. Ключи API не нужны.</span>
        )}
        <span className="ytm-radio-state">
          <Icon name="radio" size="1.1em" /> Интернет-радио:{' '}
          {player.playing ? 'играет' : player.current ? `на паузе (${player.current.title})` : 'выключено'}
        </span>
      </div>

      <section className="ytm-control" aria-label="Управление YouTube Music в машине">
        <h3 className="section-title">Пауза и переключение треков</h3>
        <p className="muted small">
          Система не позволяет веб-приложению управлять другим приложением, поэтому здесь нет кнопок «пауза» и
          «следующий трек» для YouTube Music. Работают системные способы — без перехода в YouTube Music:
        </p>
        <ul className="ytm-ways">
          {controlWays().map((w) => (
            <li key={w.title}>
              <Icon name={w.icon} size="1.6rem" />
              <span>
                <strong>{w.title}</strong>
                <small>{w.text}</small>
              </span>
            </li>
          ))}
        </ul>
      </section>

      <div className="ytm-actions">
        {music.active === 'youtube-music' && player.current && !player.playing && (
          <button
            className="btn btn-lg"
            onClick={() => {
              setActiveSource('radio');
              resume();
            }}
          >
            <Icon name="radio" /> Вернуться к радио
          </button>
        )}
        <button className="btn btn-lg" onClick={() => openSection('navigation')}>
          <Icon name="map" /> К карте
        </button>
      </div>

      <details className="ytm-help">
        <summary>Как вернуться в AI Car Expert</summary>
        <ul>
          {returnHint().map((h) => (
            <li key={h}>{h}</li>
          ))}
        </ul>
        <p className="muted small">
          Карта, маршрут и ведение сохраняются. Голосом можно открыть YouTube Music, но выбор треков — только в самом приложении.
        </p>
      </details>
    </div>
  );
}

/** Приложение не открылось — предложить сайт (нажатие пользователя открывает новое окно надёжно). */
export function YouTubeMusicFallback() {
  const show = useStore(ytmFallbackStore);
  if (!show) return null;
  const close = () => ytmFallbackStore.set(false);
  return (
    <div className="cg-sheet-backdrop" role="dialog" aria-label="YouTube Music" onClick={close}>
      <div className="cg-sheet" onClick={(e) => e.stopPropagation()}>
        <div className="cg-sheet-head">
          <span className="ytm-logo">
            <Icon name="play" size="1.6rem" filled stroke={0} />
          </span>
          <div>
            <h2>Приложение YouTube Music не открылось</h2>
            <p className="muted">Возможно, оно не установлено. Откройте YouTube Music на сайте — со своей учётной записью.</p>
          </div>
        </div>
        <div className="cg-actions">
          <a
            className="btn btn-primary btn-lg"
            {...link}
            onClick={() => {
              markLeaving('youtube-music');
              close();
            }}
          >
            <Icon name="external" /> Открыть в браузере
          </a>
          <button className="btn btn-lg" onClick={close}>
            Отмена
          </button>
        </div>
        <p className="muted small">Чтобы всегда открывать сайт сразу: Настройки → Музыка.</p>
      </div>
    </div>
  );
}
