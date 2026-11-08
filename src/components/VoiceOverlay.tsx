import { useState } from 'react';
import { Icon } from './Icon';
import { useStore } from '../lib/store';
import { voiceStore, closeVoice, startVoice, stopListening, submitTyped } from '../lib/voice';

const HINTS = ['«Открой навигацию»', '«Маршрут до Красной площади»', '«Включи радио»', '«Что значит код P0420?»', '«Когда следующее ТО?»'];

export function VoiceOverlay() {
  const v = useStore(voiceStore);
  const [typed, setTyped] = useState('');
  if (!v.open) return null;
  const unsupported = v.error === 'unsupported';
  const showInput = unsupported || (!v.listening && !v.interim);

  return (
    <div className="voice-overlay" role="dialog" aria-label="Голосовая команда">
      <button className="voice-close" onClick={closeVoice} aria-label="Закрыть">
        <Icon name="close" size="2rem" />
      </button>

      <button
        className={`voice-orb ${v.listening ? 'is-listening' : ''}`}
        onClick={() => (v.listening ? stopListening() : startVoice())}
        aria-label={v.listening ? 'Остановить' : 'Говорить'}
      >
        <Icon name="mic" size="4.5rem" stroke={1.8} />
      </button>

      <p className="voice-transcript">
        {v.interim || (v.listening ? 'Слушаю…' : unsupported ? 'Голосовой ввод недоступен' : 'Нажмите, чтобы говорить')}
      </p>

      {v.error && !unsupported && <p className="voice-error">{v.error}</p>}
      {unsupported && (
        <p className="voice-error">
          Распознавание речи в этом браузере недоступно. Введите команду или нажмите
          значок микрофона на клавиатуре iPad, чтобы надиктовать её.
        </p>
      )}

      {showInput && (
        <form
          className="voice-form"
          onSubmit={(e) => {
            e.preventDefault();
            if (typed.trim()) submitTyped(typed);
            setTyped('');
          }}
        >
          <input
            className="input input-xl"
            value={typed}
            onChange={(e) => setTyped(e.target.value)}
            placeholder="Команда или вопрос"
            enterKeyHint="send"
            autoFocus={unsupported}
          />
          <button className="btn btn-primary btn-xl" type="submit" aria-label="Отправить">
            <Icon name="send" />
          </button>
        </form>
      )}

      <div className="voice-hints">
        {HINTS.map((h) => (
          <button key={h} onClick={() => submitTyped(h.replace(/[«»]/g, ''))}>
            {h}
          </button>
        ))}
      </div>
    </div>
  );
}
