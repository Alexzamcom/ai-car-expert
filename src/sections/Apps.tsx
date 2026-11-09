import { Icon } from '../components/Icon';
import { APPS, GROUPS, isWebLink, type AppLink } from '../lib/apps';
import { markLeaving } from '../lib/chatgpt';

export function Apps() {
  const groups = Object.keys(GROUPS) as AppLink['group'][];
  return (
    <div className="section apps">
      {groups.map((g) => (
        <div key={g} className="app-group">
          <h3 className="section-title">{GROUPS[g]}</h3>
          <div className="app-grid">
            {APPS.filter((a) => a.group === g).map((a) => (
              <a
                key={a.id}
                className="app-tile"
                href={a.href}
                {...(isWebLink(a) ? { target: '_blank', rel: 'noopener noreferrer' } : {})}
                onClick={a.id === 'chatgpt' ? markLeaving : undefined}
              >
                <span className="app-icon">
                  <Icon name={a.icon} size="1.8rem" />
                </span>
                <span className="app-name">{a.name}</span>
              </a>
            ))}
          </div>
        </div>
      ))}
      <p className="muted small">
        Кнопка открывает приложение, если оно установлено. Вернуться можно жестом переключения приложений
        или с экрана «Домой». Встроенная карта и радио при этом не останавливают маршрут.
      </p>
    </div>
  );
}
