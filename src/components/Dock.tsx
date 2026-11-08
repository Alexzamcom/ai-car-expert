import { Icon } from './Icon';
import { useStore } from '../lib/store';
import { layoutStore, openSection } from '../lib/state';
import { SECTIONS, DOCK_LEFT, DOCK_RIGHT, type SectionId } from '../lib/sections';
import { voiceStore, startVoice, closeVoice } from '../lib/voice';

function DockButton({ id }: { id: SectionId }) {
  const layout = useStore(layoutStore);
  const meta = SECTIONS[id];
  const active = layout.primary === id || layout.secondary === id;
  return (
    <button className={`dock-btn ${active ? 'is-active' : ''}`} onClick={() => openSection(id)} aria-label={meta.title}>
      <Icon name={meta.icon} size="2rem" />
      <span>{meta.short}</span>
    </button>
  );
}

export function Dock() {
  const voice = useStore(voiceStore);
  return (
    <nav className="dock" aria-label="Разделы">
      {DOCK_LEFT.map((id) => (
        <DockButton key={id} id={id} />
      ))}
      <button
        className={`dock-mic ${voice.open ? 'is-listening' : ''}`}
        onClick={() => (voice.open ? closeVoice() : startVoice())}
        aria-label="Голосовая команда"
      >
        <Icon name="mic" size="2.4rem" stroke={2} />
      </button>
      {DOCK_RIGHT.map((id) => (
        <DockButton key={id} id={id} />
      ))}
    </nav>
  );
}
