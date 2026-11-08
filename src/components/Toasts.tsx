import { useStore } from '../lib/store';
import { toastStore } from '../lib/state';
import { Icon } from './Icon';

export function Toasts() {
  const toasts = useStore(toastStore);
  return (
    <div className="toasts" aria-live="polite">
      {toasts.map((t) => (
        <div key={t.id} className={`toast toast-${t.tone}`}>
          <Icon name={t.tone === 'warn' ? 'alert' : t.tone === 'ok' ? 'check' : 'info'} size="1.4em" />
          <span>{t.text}</span>
        </div>
      ))}
    </div>
  );
}
