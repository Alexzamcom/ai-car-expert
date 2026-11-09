import { useState } from 'react';
import { Icon } from './Icon';
import { useStore } from '../lib/store';
import { CHATGPT_URL, chatgptPrefsStore, markLeaving, returnHint, shortcutUrl } from '../lib/chatgpt';

/** Знак ChatGPT в интерфейсе — нейтральный значок чата (без логотипа OpenAI). */
function Glyph({ size = '1.9rem' }: { size?: string }) {
  return <Icon name="chat" size={size} />;
}

const linkProps = { href: CHATGPT_URL, target: '_blank', rel: 'noopener noreferrer' } as const;

/** Кнопка ChatGPT. При первом использовании — подсказка, как вернуться. */
export function ChatGptButton({ variant }: { variant: 'dock' | 'card' }) {
  const prefs = useStore(chatgptPrefsStore);
  const [sheet, setSheet] = useState(false);

  const content =
    variant === 'dock' ? (
      <>
        <Glyph />
        <span>ChatGPT</span>
      </>
    ) : (
      <>
        <span className="cg-card-icon">
          <Glyph size="2rem" />
        </span>
        <span className="cg-card-text">
          <strong>Открыть ChatGPT</strong>
          <small>Ваша подписка и голосовой режим — в приложении ChatGPT</small>
        </span>
        <Icon name="external" />
      </>
    );
  const cls = variant === 'dock' ? 'dock-btn dock-chatgpt' : 'cg-card';

  return (
    <>
      {prefs.hintSeen ? (
        <a className={cls} {...linkProps} onClick={markLeaving} aria-label="Открыть ChatGPT">
          {content}
        </a>
      ) : (
        <button className={cls} onClick={() => setSheet(true)} aria-label="Открыть ChatGPT">
          {content}
        </button>
      )}
      {sheet && <ChatGptSheet onClose={() => setSheet(false)} />}
    </>
  );
}

export function ChatGptSheet({ onClose }: { onClose: () => void }) {
  const prefs = useStore(chatgptPrefsStore);
  const [dontShow, setDontShow] = useState(true);
  const voice = shortcutUrl(prefs.voiceShortcut);
  const leave = () => {
    if (dontShow) chatgptPrefsStore.set((p) => ({ ...p, hintSeen: true }));
    markLeaving();
    onClose();
  };

  return (
    <div className="cg-sheet-backdrop" role="dialog" aria-label="Открыть ChatGPT" onClick={onClose}>
      <div className="cg-sheet" onClick={(e) => e.stopPropagation()}>
        <div className="cg-sheet-head">
          <span className="cg-card-icon">
            <Glyph size="2rem" />
          </span>
          <div>
            <h2>ChatGPT</h2>
            <p className="muted">Откроется приложение ChatGPT (или сайт, если приложения нет) с вашей подпиской. Оплата API не нужна.</p>
          </div>
        </div>
        <label className="cg-check">
          <input type="checkbox" checked={dontShow} onChange={(e) => setDontShow(e.target.checked)} />
          Больше не показывать — открывать сразу
        </label>
        <div className="cg-actions">
          <a className="btn btn-primary btn-lg" {...linkProps} onClick={leave}>
            <Icon name="external" /> Открыть ChatGPT
          </a>
          {voice && (
            <a className="btn btn-lg" href={voice} onClick={leave}>
              <Icon name="mic" /> Голосовой режим
            </a>
          )}
          <button className="btn btn-lg" onClick={onClose}>
            Отмена
          </button>
        </div>
        <div className="cg-return">
          <strong>Как вернуться в AI Car Expert</strong>
          <ul>
            {returnHint().map((h) => (
              <li key={h}>{h}</li>
            ))}
          </ul>
          <p className="muted small">Маршрут и настройки сохранятся. Радио на время голосового разговора встанет на паузу.</p>
        </div>
      </div>
    </div>
  );
}
