import { useRef, useState } from 'react';
import { Icon } from '../components/Icon';
import { useStore } from '../lib/store';
import {
  playerStore,
  stationsStore,
  playStation,
  togglePlay,
  next,
  prev,
  stop,
  setVolume,
  addStation,
  removeStation,
  playFiles,
  playTrack,
} from '../lib/player';
import { toast } from '../lib/state';

type Tab = 'radio' | 'files' | 'apps';

const APPS = [
  { name: 'Apple Музыка', href: 'music://' },
  { name: 'Яндекс Музыка', href: 'yandexmusic://' },
  { name: 'Spotify', href: 'spotify://' },
  { name: 'Подкасты', href: 'podcasts://' },
];

export function Media() {
  const player = useStore(playerStore);
  const stations = useStore(stationsStore);
  const [tab, setTab] = useState<Tab>('radio');
  const [adding, setAdding] = useState(false);
  const [newName, setNewName] = useState('');
  const [newUrl, setNewUrl] = useState('');
  const fileRef = useRef<HTMLInputElement>(null);
  const cur = player.current;

  return (
    <div className="section media">
      <div className="now-playing card">
        <div className={`np-art ${player.playing ? 'is-playing' : ''}`}>
          <Icon name={cur?.kind === 'file' ? 'music' : 'radio'} size="3rem" />
          <div className="eq">
            <span />
            <span />
            <span />
            <span />
          </div>
        </div>
        <div className="np-info">
          <div className="eyebrow">{player.loading ? 'Подключение…' : player.playing ? 'Сейчас играет' : cur ? 'Пауза' : 'Ничего не играет'}</div>
          <div className="np-title">{cur?.title ?? 'Выберите станцию или файл'}</div>
          <div className="muted">{cur?.subtitle ?? 'Интернет-радио и музыка с iPad'}</div>
          {player.error && <div className="text-warn np-error">{player.error}</div>}
        </div>
        <div className="np-controls">
          <button className="btn-round" onClick={prev} disabled={player.queue.length < 2} aria-label="Предыдущий">
            <Icon name="prev" size="1.7rem" />
          </button>
          <button className="btn-round btn-round-xl btn-primary" onClick={togglePlay} aria-label={player.playing ? 'Пауза' : 'Играть'}>
            <Icon name={player.playing ? 'pause' : 'play'} size="2.4rem" filled stroke={0} />
          </button>
          <button className="btn-round" onClick={next} disabled={player.queue.length < 2} aria-label="Следующий">
            <Icon name="next" size="1.7rem" />
          </button>
          <button className="btn-round" onClick={stop} disabled={!cur} aria-label="Стоп">
            <Icon name="stop" size="1.5rem" />
          </button>
        </div>
        <label className="np-volume">
          <Icon name="speaker" />
          <input type="range" min={0} max={1} step={0.05} value={player.volume} onChange={(e) => setVolume(Number(e.target.value))} aria-label="Громкость" />
        </label>
      </div>

      <div className="tabs" role="tablist">
        {(
          [
            ['radio', 'Радио', 'radio'],
            ['files', 'Файлы', 'folder'],
            ['apps', 'Приложения', 'external'],
          ] as const
        ).map(([id, label, icon]) => (
          <button key={id} role="tab" aria-selected={tab === id} className={`tab ${tab === id ? 'is-active' : ''}`} onClick={() => setTab(id)}>
            <Icon name={icon} /> {label}
          </button>
        ))}
      </div>

      {tab === 'radio' && (
        <>
          <div className="station-grid">
            {stations.map((s) => (
              <div key={s.id} className={`station ${cur?.id === s.id ? 'is-current' : ''}`}>
                <button className="station-main" onClick={() => playStation(s)}>
                  <Icon name={cur?.id === s.id && player.playing ? 'pause' : 'radio'} size="1.8rem" />
                  <span>
                    <strong>{s.name}</strong>
                    <small>{s.genre ?? 'Своя станция'}</small>
                  </span>
                </button>
                {s.custom && (
                  <button className="icon-btn" onClick={() => removeStation(s.id)} aria-label="Удалить станцию">
                    <Icon name="trash" />
                  </button>
                )}
              </div>
            ))}
            <button className="station station-add" onClick={() => setAdding((a) => !a)}>
              <Icon name="plus" size="1.8rem" /> Добавить станцию
            </button>
          </div>
          {adding && (
            <form
              className="form-row card"
              onSubmit={(e) => {
                e.preventDefault();
                if (!/^https:\/\//.test(newUrl)) {
                  toast('Укажите ссылку на поток, начинающуюся с https://', 'warn');
                  return;
                }
                addStation(newName.trim() || 'Моя станция', newUrl.trim());
                setNewName('');
                setNewUrl('');
                setAdding(false);
              }}
            >
              <input className="input" placeholder="Название" value={newName} onChange={(e) => setNewName(e.target.value)} />
              <input className="input" placeholder="https://… ссылка на поток" value={newUrl} onChange={(e) => setNewUrl(e.target.value)} inputMode="url" />
              <button className="btn btn-primary" type="submit">
                Сохранить
              </button>
            </form>
          )}
        </>
      )}

      {tab === 'files' && (
        <div className="card files-card">
          <p>Выберите аудиофайлы из «Файлов» iPad. Список действует до перезапуска приложения.</p>
          <input
            ref={fileRef}
            type="file"
            accept="audio/*"
            multiple
            hidden
            onChange={(e) => e.target.files && playFiles(e.target.files)}
          />
          <button className="btn btn-primary btn-lg" onClick={() => fileRef.current?.click()}>
            <Icon name="folder" /> Выбрать файлы
          </button>
          {player.queue.some((t) => t.kind === 'file') && (
            <div className="track-list">
              {player.queue
                .filter((t) => t.kind === 'file')
                .map((t) => (
                  <button key={t.id} className={`place-row ${cur?.id === t.id ? 'is-current' : ''}`} onClick={() => playTrack(t)}>
                    <Icon name="music" size="1.5rem" />
                    <span>
                      <strong>{t.title}</strong>
                    </span>
                  </button>
                ))}
            </div>
          )}
        </div>
      )}

      {tab === 'apps' && (
        <div className="card">
          <p className="muted">
            Управлять воспроизведением сторонних приложений из веб-приложения нельзя. Кнопки ниже откроют
            приложение, если оно установлено; вернуться можно жестом переключения приложений.
          </p>
          <div className="quick-actions">
            {APPS.map((a) => (
              <a key={a.name} className="btn btn-lg" href={a.href}>
                <Icon name="external" /> {a.name}
              </a>
            ))}
          </div>
        </div>
      )}
    </div>
  );
}
