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
  searchStations,
  saveStation,
  volumeControllable,
  type Station,
} from '../lib/player';
import { toast, settingsStore } from '../lib/state';
import { MUSIC_SOURCES, musicStore } from '../lib/music/sources';
import { YouTubeMusicPanel } from '../components/YouTubeMusic';

type Tab = 'mine' | 'find' | 'files';

const PRESETS: { label: string; params: { countrycode?: string; tag?: string } }[] = [
  { label: 'Россия', params: { countrycode: 'RU' } },
  { label: 'Украина', params: { countrycode: 'UA' } },
  { label: 'Рок', params: { tag: 'rock' } },
  { label: 'Джаз', params: { tag: 'jazz' } },
  { label: 'Новости', params: { tag: 'news' } },
  { label: 'Чилаут', params: { tag: 'chillout' } },
];

export function Media() {
  const player = useStore(playerStore);
  const stations = useStore(stationsStore);
  const [tab, setTab] = useState<Tab>('mine');
  const [adding, setAdding] = useState(false);
  const [newName, setNewName] = useState('');
  const [newUrl, setNewUrl] = useState('');
  const [q, setQ] = useState('');
  const [found, setFound] = useState<Station[] | null>(null);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const fileRef = useRef<HTMLInputElement>(null);
  const cur = player.current;
  const music = useStore(musicStore);
  const [view, setView] = useState<'radio' | 'youtube-music'>(() =>
    musicStore.get().active === 'youtube-music' || (!playerStore.get().current && settingsStore.get().preferredMusic === 'youtube-music') ? 'youtube-music' : 'radio',
  );

  async function find(params: { name?: string; countrycode?: string; tag?: string }) {
    setBusy(true);
    setErr(null);
    try {
      const list = await searchStations(params);
      setFound(list);
      if (!list.length) setErr('Подходящих станций не найдено');
    } catch {
      setErr(navigator.onLine ? 'Каталог станций сейчас недоступен' : 'Нет интернета');
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="section media">
      <div className="sources" role="tablist" aria-label="Источник музыки">
        {MUSIC_SOURCES.map((s) => (
          <button
            key={s.id}
            role="tab"
            aria-selected={view === s.id}
            disabled={s.kind === 'planned'}
            className={`source ${view === s.id ? 'is-active' : ''} ${music.active === s.id ? 'is-playing' : ''}`}
            onClick={() => s.kind !== 'planned' && setView(s.id as 'radio' | 'youtube-music')}
            title={s.note}
          >
            <Icon name={s.id === 'radio' ? 'radio' : s.kind === 'planned' ? 'clock' : 'play'} size="1.2em" filled={s.id === 'youtube-music'} stroke={s.id === 'youtube-music' ? 0 : undefined} />
            <span>{s.id === 'radio' ? 'Радио' : s.name}</span>
            {s.kind === 'planned' && <small>скоро</small>}
          </button>
        ))}
      </div>

      {view === 'youtube-music' ? (
        <YouTubeMusicPanel />
      ) : (
      <>
      <div className="now-playing">
        <div className={`np-art ${player.playing ? 'is-playing' : ''}`}>
          <Icon name={cur?.kind === 'file' ? 'music' : 'radio'} size="2.4rem" />
          <div className="eq">
            <span />
            <span />
            <span />
            <span />
          </div>
        </div>
        <div className="np-info">
          <div className="eyebrow">{player.loading ? 'Подключение…' : player.playing ? 'Сейчас играет' : cur ? 'Пауза' : 'Ничего не играет'}</div>
          <div className="np-title">{cur?.title ?? 'Выберите станцию'}</div>
          <div className="muted np-sub">{cur?.subtitle ?? 'Интернет-радио и музыка с устройства'}</div>
          {player.error && <div className="text-warn np-error">{player.error}</div>}
        </div>
        <div className="np-controls">
          <button className="btn-round" onClick={prev} disabled={player.queue.length < 2} aria-label="Предыдущая">
            <Icon name="prev" size="1.6rem" />
          </button>
          <button className="btn-round btn-round-xl btn-primary" onClick={togglePlay} aria-label={player.playing ? 'Пауза' : 'Играть'}>
            <Icon name={player.playing ? 'pause' : 'play'} size="2.2rem" filled stroke={0} />
          </button>
          <button className="btn-round" onClick={next} disabled={player.queue.length < 2} aria-label="Следующая">
            <Icon name="next" size="1.6rem" />
          </button>
          <button className="btn-round" onClick={stop} disabled={!cur} aria-label="Стоп">
            <Icon name="stop" size="1.4rem" />
          </button>
        </div>
        {volumeControllable ? (
          <label className="np-volume">
            <Icon name="speaker" />
            <input type="range" min={0} max={1} step={0.05} value={player.volume} onChange={(e) => setVolume(Number(e.target.value))} aria-label="Громкость" />
          </label>
        ) : (
          <div className="np-volume muted small">
            <Icon name="bluetooth" /> Громкость — кнопками iPad или автомобиля. Звук идёт на выбранный выход (Bluetooth автомобиля).
          </div>
        )}
      </div>

      <div className="tabs" role="tablist">
        {(
          [
            ['mine', 'Мои станции', 'star'],
            ['find', 'Найти', 'search'],
            ['files', 'Файлы', 'folder'],
          ] as const
        ).map(([id, label, icon]) => (
          <button key={id} role="tab" aria-selected={tab === id} className={`tab ${tab === id ? 'is-active' : ''}`} onClick={() => setTab(id)}>
            <Icon name={icon} /> <span>{label}</span>
          </button>
        ))}
      </div>

      {tab === 'mine' && (
        <>
          <div className="station-grid">
            {stations.map((s) => (
              <div key={s.id} className={`station ${cur?.id === s.id ? 'is-current' : ''}`}>
                <button className="station-main" onClick={() => playStation(s)}>
                  <Icon name={cur?.id === s.id && player.playing ? 'pause' : 'radio'} size="1.7rem" />
                  <span>
                    <strong>{s.name}</strong>
                    <small>{s.genre ?? 'Своя станция'}</small>
                  </span>
                </button>
                {s.custom && (
                  <button className="icon-btn" onClick={() => removeStation(s.id)} aria-label={`Удалить ${s.name}`}>
                    <Icon name="trash" />
                  </button>
                )}
              </div>
            ))}
            <button className="station station-add" onClick={() => setAdding((a) => !a)}>
              <Icon name="plus" size="1.6rem" /> Добавить по ссылке
            </button>
          </div>
          {adding && (
            <form
              className="form-row card"
              onSubmit={(e) => {
                e.preventDefault();
                if (!/^https:\/\//.test(newUrl)) {
                  toast('Нужна ссылка на поток, начинающаяся с https://', 'warn');
                  return;
                }
                addStation(newName.trim() || 'Моя станция', newUrl.trim());
                setNewName('');
                setNewUrl('');
                setAdding(false);
              }}
            >
              <input id="station-name" className="input" placeholder="Название" value={newName} onChange={(e) => setNewName(e.target.value)} />
              <input id="station-url" className="input" placeholder="https://… ссылка на поток" value={newUrl} onChange={(e) => setNewUrl(e.target.value)} inputMode="url" />
              <button className="btn btn-primary" type="submit">
                Сохранить
              </button>
            </form>
          )}
        </>
      )}

      {tab === 'find' && (
        <>
          <form
            className="search-row"
            onSubmit={(e) => {
              e.preventDefault();
              if (q.trim()) void find({ name: q.trim() });
            }}
          >
            <Icon name="search" size="1.5rem" />
            <input id="station-search" className="input input-bare" value={q} onChange={(e) => setQ(e.target.value)} placeholder="Название станции" enterKeyHint="search" />
            <button className="btn" type="submit" disabled={!q.trim() || busy}>
              Найти
            </button>
          </form>
          <div className="chips chips-scroll">
            {PRESETS.map((p) => (
              <button key={p.label} className="chip" onClick={() => void find(p.params)}>
                {p.label}
              </button>
            ))}
          </div>
          {busy && <div className="list-note">Ищу станции…</div>}
          {err && <div className="list-note text-warn">{err}</div>}
          {found && found.length > 0 && (
            <div className="station-grid">
              {found.map((s) => {
                const saved = stations.some((x) => x.id === s.id);
                return (
                  <div key={s.id} className={`station ${cur?.id === s.id ? 'is-current' : ''}`}>
                    <button className="station-main" onClick={() => playStation(s, found)}>
                      <Icon name={cur?.id === s.id && player.playing ? 'pause' : 'radio'} size="1.7rem" />
                      <span>
                        <strong>{s.name}</strong>
                        <small>{s.genre}</small>
                      </span>
                    </button>
                    <button className="icon-btn" onClick={() => (saved ? removeStation(s.id) : saveStation(s))} aria-label={saved ? 'Убрать из моих' : 'Сохранить в мои'}>
                      <Icon name="star" filled={saved} className={saved ? 'text-accent' : ''} />
                    </button>
                  </div>
                );
              })}
            </div>
          )}
          <p className="muted small">Каталог radio-browser.info. Показаны только потоки по HTTPS в форматах MP3/AAC.</p>
        </>
      )}

      {tab === 'files' && (
        <div className="card files-card">
          <p>Выберите аудиофайлы в «Файлах». Браузер даёт доступ только к выбранным файлам и до перезапуска приложения; медиатека Apple Music веб-приложению недоступна.</p>
          <input ref={fileRef} type="file" accept="audio/*" multiple hidden onChange={(e) => e.target.files && playFiles(e.target.files)} />
          <button className="btn btn-primary btn-lg" onClick={() => fileRef.current?.click()}>
            <Icon name="folder" /> Выбрать файлы
          </button>
          {player.queue.some((t) => t.kind === 'file') && (
            <div className="track-list">
              {player.queue
                .filter((t) => t.kind === 'file')
                .map((t) => (
                  <button key={t.id} className={`place-row ${cur?.id === t.id ? 'is-current' : ''}`} onClick={() => playTrack(t)}>
                    <Icon name="music" size="1.4rem" />
                    <span>
                      <strong>{t.title}</strong>
                    </span>
                  </button>
                ))}
            </div>
          )}
        </div>
      )}
      </>
      )}
    </div>
  );
}
