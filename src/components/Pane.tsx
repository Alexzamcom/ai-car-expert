import { Suspense, lazy, type ComponentType } from 'react';
import { Icon } from './Icon';
import { SECTIONS, type SectionId } from '../lib/sections';
import { closeSecondary, openInSecondary, swapPanes, toggleMaximize } from '../lib/state';
import { Vehicle } from '../sections/Vehicle';
import { Assistant } from '../sections/Assistant';
import { Media } from '../sections/Media';
import { Manual } from '../sections/Manual';
import { Service } from '../sections/Service';
import { Diagnostics } from '../sections/Diagnostics';
import { Settings } from '../sections/Settings';

// Карта (Leaflet) загружается отдельным чанком.
const Navigation = lazy(() => import('../sections/Navigation').then((m) => ({ default: m.Navigation })));

const VIEWS: Record<SectionId, ComponentType> = {
  vehicle: Vehicle,
  navigation: Navigation,
  media: Media,
  assistant: Assistant,
  manual: Manual,
  service: Service,
  diagnostics: Diagnostics,
  settings: Settings,
};

interface Props {
  section: SectionId;
  role: 'primary' | 'secondary';
  maximized: boolean;
  hasPartner: boolean;
}

export function Pane({ section, role, maximized, hasPartner }: Props) {
  const meta = SECTIONS[section];
  const View = VIEWS[section];
  return (
    <section className={`pane pane-${role}`} aria-label={meta.title}>
      <header className="pane-head">
        <h1 className="pane-title">
          <Icon name={meta.icon} size="1.3em" />
          {meta.title}
        </h1>
        <div className="pane-actions">
          {hasPartner && !maximized && (
            <button className="icon-btn" onClick={swapPanes} aria-label="Поменять панели местами">
              <Icon name="swap" />
            </button>
          )}
          {!hasPartner && role === 'primary' && (
            <button className="icon-btn" onClick={() => openInSecondary(section === 'vehicle' ? 'media' : 'vehicle')} aria-label="Разделить экран">
              <Icon name="collapse" />
            </button>
          )}
          {hasPartner && (
            <button className="icon-btn" onClick={() => toggleMaximize(role)} aria-label={maximized ? 'Свернуть' : 'Развернуть'}>
              <Icon name={maximized ? 'collapse' : 'expand'} />
            </button>
          )}
          {role === 'secondary' && (
            <button className="icon-btn" onClick={closeSecondary} aria-label="Закрыть панель">
              <Icon name="close" />
            </button>
          )}
        </div>
      </header>
      <div className="pane-body">
        <Suspense fallback={<div className="pane-loading">Загрузка…</div>}>
          <View />
        </Suspense>
      </div>
    </section>
  );
}
