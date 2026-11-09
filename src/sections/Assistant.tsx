import { useEffect, useRef, useState } from 'react';
import { Icon } from '../components/Icon';
import { useStore } from '../lib/store';
import { chatStore, chatBusyStore, sendToAssistant, clearChat } from '../lib/assistant';
import { settingsStore, openSection } from '../lib/state';
import { listen, speechRecognitionSupported, stopSpeaking, speak } from '../lib/speech';
import { openArticle } from '../lib/manualNav';

const SUGGESTIONS = [
  'Маршрут до ближайшей заправки',
  'Как работает режим AUTO климата?',
  'Включи радио',
  'Какое масло нужно для моего мотора?',
  'Когда следующее ТО?',
  'Что значит код P0171?',
];

export function Assistant() {
  const messages = useStore(chatStore);
  const busy = useStore(chatBusyStore);
  const settings = useStore(settingsStore);
  const [text, setText] = useState('');
  const [listening, setListening] = useState(false);
  const stopRef = useRef<(() => void) | null>(null);
  const listRef = useRef<HTMLDivElement>(null);
  const remote = Boolean(settings.aiEndpoint);

  useEffect(() => {
    listRef.current?.scrollTo({ top: listRef.current.scrollHeight, behavior: 'smooth' });
  }, [messages.length, busy]);

  useEffect(() => () => stopRef.current?.(), []);

  const submit = (value: string) => {
    if (!value.trim()) return;
    void sendToAssistant(value);
    setText('');
  };

  const dictate = () => {
    if (listening) {
      stopRef.current?.();
      return;
    }
    if (!speechRecognitionSupported()) {
      document.getElementById('assistant-input')?.focus();
      return;
    }
    stopSpeaking();
    setListening(true);
    stopRef.current = listen(settings.speechLang, {
      onInterim: (t) => setText(t),
      onFinal: (t) => submit(t),
      onError: () => {},
      onEnd: () => {
        setListening(false);
        stopRef.current = null;
      },
    });
  };

  return (
    <div className="section assistant">
      <div className={`mode-line ${remote ? 'is-online' : 'is-offline'}`}>
        <span className="dot" />
        {remote ? 'Grok подключён через ваш сервер' : 'Grok не подключён — работают команды и встроенная база'}
        <span className="spacer" />
        <button
          className="icon-btn"
          onClick={() => settingsStore.set((s) => ({ ...s, speakReplies: !s.speakReplies }))}
          aria-label={settings.speakReplies ? 'Выключить озвучивание' : 'Включить озвучивание'}
        >
          <Icon name={settings.speakReplies ? 'speaker' : 'speakerOff'} />
        </button>
        {!remote && (
          <button className="btn btn-sm" onClick={() => openSection('settings')}>
            Подключить
          </button>
        )}
        {messages.length > 0 && (
          <button className="icon-btn" onClick={clearChat} aria-label="Очистить диалог">
            <Icon name="trash" />
          </button>
        )}
      </div>

      <div className="chat" ref={listRef}>
        {messages.length === 0 && (
          <div className="chat-empty">
            <div className="chat-empty-icon">
              <Icon name="spark" size="3rem" />
            </div>
            <h2>Чем помочь в дороге?</h2>
            <p className="muted">Скажите или напишите: маршрут, музыка, вопрос о вашем автомобиле.</p>
            <div className="chips">
              {SUGGESTIONS.map((s) => (
                <button key={s} className="chip" onClick={() => submit(s)}>
                  {s}
                </button>
              ))}
            </div>
          </div>
        )}
        {messages.map((m) => (
          <div key={m.id} className={`msg msg-${m.role}`}>
            <div className="msg-bubble">
              {m.text.split('\n').map((line, i) => (line ? <p key={i}>{line}</p> : <br key={i} />))}
            </div>
            {m.actions && m.actions.length > 0 && (
              <div className="msg-actions">
                {m.actions.map((a, i) => (
                  <span key={i} className="badge badge-info">
                    <Icon name="check" size="1em" /> {a}
                  </span>
                ))}
              </div>
            )}
            {m.role === 'assistant' && (
              <div className="msg-meta">
                <span>{m.source === 'ai' ? 'Grok' : 'Встроенная база'}</span>
                <button className="link-btn" onClick={() => speak(m.text, settings.speechLang)}>
                  <Icon name="speaker" size="1.1em" /> Озвучить
                </button>
                {m.articleId && (
                  <button className="link-btn" onClick={() => openArticle(m.articleId!)}>
                    <Icon name="book" size="1.1em" /> Открыть статью
                  </button>
                )}
              </div>
            )}
          </div>
        ))}
        {busy && (
          <div className="msg msg-assistant">
            <div className="msg-bubble typing">
              <span />
              <span />
              <span />
            </div>
          </div>
        )}
      </div>

      <form
        className="composer"
        onSubmit={(e) => {
          e.preventDefault();
          submit(text);
        }}
      >
        <button type="button" className={`btn-round ${listening ? 'is-live' : ''}`} onClick={dictate} aria-label="Сказать">
          <Icon name="mic" size="1.8rem" />
        </button>
        <input
          id="assistant-input"
          className="input input-xl"
          value={text}
          onChange={(e) => setText(e.target.value)}
          placeholder={listening ? 'Слушаю…' : 'Спросите Grok'}
          enterKeyHint="send"
          autoComplete="off"
        />
        <button type="submit" className="btn-round btn-primary" disabled={!text.trim() || busy} aria-label="Отправить">
          <Icon name="send" size="1.6rem" />
        </button>
      </form>
    </div>
  );
}
