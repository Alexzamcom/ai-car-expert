import { Suspense, type ComponentType } from 'react';
import { Icon } from './Icon';
import { useStore } from '../lib/store';
import { layoutStore, openSection, setPanelMode, swapOrder } from '../lib/state';
import { PANELS, SECTIONS, type PanelId } from '../lib/sections';
import { playerStore, togglePlay, next } from '../lib/player';
import { musicStore } from '../lib/music/sources';
import { Media } from '../sections/Media';
import { Assistant } from '../sections/Assistant';
import { Apps } from '../sections/Apps';
import { Trip } from '../sections/Trip';

const VIEWS: Record<PanelId, ComponentType> = { media: Media, assistant: Assistant, apps: Apps, trip: Trip };

/** Панель рядом с картой: вкладки, сворачивание, разворот, перестановка. */
export function Panel() {
  const layout = useStore(layoutStore);
  const player = useStore(playerStore);
  const music = useStore(musicStore);
  const View = VIEWS[layout.panel];
  const collapsed = layout.panelMode === 'collapsed';

  return (
    <section className={`panel panel-${layout.panelMode}`} aria-label="Панель">
      <header className="panel-head">
        <div className="panel-tabs" role="tablist">
          {PANELS.map((id) => (
            <button
              key={id}
              role="tab"
              aria-selected={layout.panel === id && !collapsed}
              className={`panel-tab ${layout.panel === id ? 'is-active' : ''}`}
              onClick={() => openSection(id)}
              aria-label={SECTIONS[id].title}
            >
              <Icon name={SECTIONS[id].icon} size="1.35em" />
              <span className="panel-tab-label">{SECTIONS[id].short}</span>
            </button>
          ))}
        </div>

        {collapsed && music.active === 'youtube-music' && !player.playing ? (
          <div className="mini-player">
            <span className="mini-title">YouTube Music</span>
            <small className="mini-note">управление — системный плеер или голосовой помощник</small>
          </div>
        ) : collapsed && player.current && (
          <div className="mini-player">
            <span className="mini-title">{player.current.title}</span>
            <button className="icon-btn" onClick={togglePlay} aria-label={player.playing ? 'Пауза' : 'Играть'}>
              <Icon name={player.playing ? 'pause' : 'play'} filled stroke={0} />
            </button>
            <button className="icon-btn" onClick={next} aria-label="Следующая">
              <Icon name="next" />
            </button>
          </div>
        )}

        <div className="panel-actions">
          {!collapsed && (
            <button className="icon-btn panel-swap" onClick={swapOrder} aria-label="Поменять карту и панель местами">
              <Icon name="swap" />
            </button>
          )}
          {layout.panelMode !== 'expanded' && (
            <button
              className="icon-btn"
              onClick={() => setPanelMode(collapsed ? 'normal' : 'expanded')}
              aria-label={collapsed ? 'Показать панель' : 'Развернуть панель'}
            >
              <Icon name={layout.order === 'map-first' ? 'chevronUp' : 'chevronDown'} />
            </button>
          )}
          {layout.panelMode !== 'collapsed' && (
            <button
              className="icon-btn"
              onClick={() => setPanelMode(layout.panelMode === 'expanded' ? 'normal' : 'collapsed')}
              aria-label={layout.panelMode === 'expanded' ? 'Уменьшить панель' : 'Свернуть панель'}
            >
              <Icon name={layout.order === 'map-first' ? 'chevronDown' : 'chevronUp'} />
            </button>
          )}
        </div>
      </header>
      {!collapsed && (
        <div className="panel-body">
          <Suspense fallback={<div className="pane-loading">Загрузка…</div>}>
            <View />
          </Suspense>
        </div>
      )}
    </section>
  );
}
