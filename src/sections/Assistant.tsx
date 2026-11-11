import { useEffect, useRef, useState } from 'react';
import { Icon } from '../components/Icon';
import { useStore } from '../lib/store';
import { chatStore, chatBusyStore, sendToAssistant, clearChat } from '../lib/assistant';
import { settingsStore, openSection } from '../lib/state';
import { listen, speechRecognitionSupported, stopSpeaking, speak } from '../lib/speech';
import { openArticle } from '../lib/manualNav';
import { ChatGptButton } from '../components/ChatGpt';
import { usageStore, currentUsage, cloudBlock, fmtUsd, PROVIDER_LABEL } from '../lib/ai/usage';
import { blockNote } from '../lib/assistant';

const SUGGESTIONS: Record<'ru' | 'uk', string[]> = {
  ru: ['Заедем на заправку', 'Как работает режим AUTO климата?', 'Включи радио', 'Какое масло нужно для моего мотора?', 'Когда следующее ТО?', 'Что значит код P0171?'],
  uk: ['Заїдемо на заправку', 'Як працює режим AUTO клімату?', 'Увімкни радіо', 'Яке мастило потрібне для мого мотора?', 'Коли наступне ТО?', 'Що означає код P0171?'],
};

export function Assistant() {
  const messages = useStore(chatStore);
  const busy = useStore(chatBusyStore);
  const settings = useStore(settingsStore);
  const [text, setText] = useState('');
  const [listening, setListening] = useState(false);
  const stopRef = useRef<(() => void) | null>(null);
  const listRef = useRef<HTMLDivElement>(null);
  useStore(usageStore);
  const usage = currentUsage();
  const block = cloudBlock();
  const remote = Boolean(settings.aiEndpoint);
  const provider = PROVIDER_LABEL[settings.aiProvider];
  const uk = settings.speechLang.startsWith('uk');

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
      <div className={`mode-line ${!block ? 'is-online' : 'is-offline'}`}>
        <span className="dot" />
        <span className="mode-text">
          {!block ? `${provider} · гибридный режим` : `${blockNote(block)} — работают команды и встроенная база`}
          {remote && (
            <small className="usage-line">
              Сегодня {usage.dayRequests}
              {settings.aiDailyLimit ? ` из ${settings.aiDailyLimit}` : ''} · за месяц {fmtUsd(usage.monthCostUsd)}
              {usage.costUnknown ? '+' : ''}
              {settings.aiMonthlyBudgetUsd ? ` из ${fmtUsd(settings.aiMonthlyBudgetUsd)}` : ''}
            </small>
          )}
        </span>
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
            <h2>{uk ? 'Чим допомогти в дорозі?' : 'Чем помочь в дороге?'}</h2>
            <p className="muted">
              {uk
                ? 'Скажіть або напишіть: маршрут, зупинка, музика, питання про ваш автомобіль. Прості команди виконуються на пристрої безкоштовно.'
                : 'Скажите или напишите: маршрут, остановка, музыка, вопрос о вашем автомобиле. Простые команды выполняются на устройстве бесплатно.'}
            </p>
            <ChatGptButton variant="card" />
            <div className="chips">
              {SUGGESTIONS[uk ? 'uk' : 'ru'].map((s) => (
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
                <span className={`msg-source ${m.source === 'ai' ? 'is-cloud' : 'is-local'}`}>{m.source === 'ai' ? PROVIDER_LABEL[m.provider ?? 'grok'] : 'На устройстве'}</span>
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
          placeholder={listening ? (uk ? 'Слухаю…' : 'Слушаю…') : uk ? 'Запитайте помічника' : 'Спросите помощника'}
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
