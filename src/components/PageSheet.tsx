import type { ComponentType } from 'react';
import { Icon } from './Icon';
import { closePage } from '../lib/state';
import { SECTIONS, type PageId } from '../lib/sections';
import { Vehicle } from '../sections/Vehicle';
import { Manual } from '../sections/Manual';
import { Service } from '../sections/Service';
import { Diagnostics } from '../sections/Diagnostics';
import { Settings } from '../sections/Settings';

const VIEWS: Record<PageId, ComponentType> = { vehicle: Vehicle, manual: Manual, service: Service, diagnostics: Diagnostics, settings: Settings };

/** Дополнительный раздел поверх главного экрана. Карта под ним продолжает работать. */
export function PageSheet({ page }: { page: PageId }) {
  const View = VIEWS[page];
  const meta = SECTIONS[page];
  return (
    <section className="page-sheet" aria-label={meta.title}>
      <header className="page-head">
        <button className="btn page-back" onClick={closePage}>
          <Icon name="back" /> На главный
        </button>
        <h1 className="page-title">
          <Icon name={meta.icon} size="1.2em" /> {meta.title}
        </h1>
      </header>
      <div className="page-body">
        <View />
      </div>
    </section>
  );
}
