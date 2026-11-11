import { useState } from 'react';
import { Icon } from './Icon';
import { useStore } from '../lib/store';
import { voiceStore, closeVoice, startVoice, stopListening, submitTyped } from '../lib/voice';
import { quickActions } from '../lib/voiceCommands';
import { navStore, savedPlacesStore } from '../lib/nav';
import { settingsStore } from '../lib/state';

export function VoiceOverlay() {
  const v = useStore(voiceStore);
  // Подписка на маршрут, «дом/работу» и язык: быстрые действия зависят от них.
  useStore(navStore);
  useStore(savedPlacesStore);
  const uk = useStore(settingsStore).speechLang.startsWith('uk');
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
        {v.interim || (v.listening ? (uk ? 'Слухаю…' : 'Слушаю…') : unsupported ? 'Голосовой ввод недоступен' : uk ? 'Натисніть, щоб говорити' : 'Нажмите, чтобы говорить')}
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

      {/* Быстрые действия — одно касание вместо фразы. */}
      <div className="voice-quick" role="group" aria-label={uk ? 'Швидкі дії' : 'Быстрые действия'}>
        {quickActions().map((q) => (
          <button key={q.command} className={`btn btn-xl ${q.primary ? 'btn-primary' : ''}`} onClick={() => submitTyped(q.command)}>
            {q.label}
          </button>
        ))}
      </div>
      <p className="voice-examples muted">
        {uk ? 'Можна сказати: «Їдемо до Львова», «Заїдемо на заправку», «Увімкни джаз», «Нагадай завтра заїхати на мийку»' : 'Можно сказать: «Маршрут до вокзала», «Заедем на заправку», «Включи джаз», «Напомни завтра заехать на мойку»'}
      </p>
    </div>
  );
}
