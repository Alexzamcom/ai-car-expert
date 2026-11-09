import { useState } from 'react';
import { Icon } from './Icon';
import { useStore } from '../lib/store';
import { layoutStore, openSection } from '../lib/state';
import { SECTIONS, PAGES, type SectionId } from '../lib/sections';
import { voiceStore, startVoice, closeVoice } from '../lib/voice';

function DockButton({ id, active }: { id: SectionId; active: boolean }) {
  const meta = SECTIONS[id];
  return (
    <button className={`dock-btn ${active ? 'is-active' : ''}`} onClick={() => openSection(id)} aria-label={meta.title}>
      <Icon name={meta.icon} size="1.9rem" />
      <span>{meta.short}</span>
    </button>
  );
}

export function Dock() {
  const voice = useStore(voiceStore);
  const layout = useStore(layoutStore);
  const [more, setMore] = useState(false);
  const onDrive = layout.page === null;
  const panelOn = (id: SectionId) => onDrive && layout.panelMode !== 'collapsed' && layout.panel === id;

  return (
    <>
      {more && (
        <div className="more-menu" role="menu" onClick={() => setMore(false)}>
          <div className="more-grid" onClick={(e) => e.stopPropagation()}>
            {PAGES.map((id) => (
              <button
                key={id}
                role="menuitem"
                className="more-item"
                onClick={() => {
                  openSection(id);
                  setMore(false);
                }}
              >
                <Icon name={SECTIONS[id].icon} size="2rem" />
                <span>{SECTIONS[id].title}</span>
              </button>
            ))}
          </div>
        </div>
      )}
      <nav className="dock" aria-label="Разделы">
        <DockButton id="navigation" active={onDrive && layout.panelMode === 'collapsed'} />
        <DockButton id="media" active={panelOn('media')} />
        <DockButton id="assistant" active={panelOn('assistant')} />
        <button
          className={`dock-mic ${voice.open ? 'is-listening' : ''}`}
          onClick={() => (voice.open ? closeVoice() : startVoice())}
          aria-label="Голосовая команда"
        >
          <Icon name="mic" size="2.3rem" stroke={2} />
        </button>
        <DockButton id="apps" active={panelOn('apps')} />
        <DockButton id="trip" active={panelOn('trip')} />
        <button className={`dock-btn ${!onDrive || more ? 'is-active' : ''}`} onClick={() => setMore((m) => !m)} aria-label="Ещё разделы" aria-expanded={more}>
          <Icon name="more" size="1.9rem" stroke={3} />
          <span>Ещё</span>
        </button>
      </nav>
    </>
  );
}
