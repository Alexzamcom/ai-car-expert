/* Распознавание речи (Web Speech API) и озвучивание ответов. */

interface RecognitionResultEvent {
  resultIndex: number;
  results: ArrayLike<ArrayLike<{ transcript: string }> & { isFinal: boolean }>;
}

interface Recognition {
  lang: string;
  interimResults: boolean;
  continuous: boolean;
  maxAlternatives: number;
  start(): void;
  stop(): void;
  abort(): void;
  onresult: ((e: RecognitionResultEvent) => void) | null;
  onerror: ((e: { error: string }) => void) | null;
  onend: (() => void) | null;
}

type RecognitionCtor = new () => Recognition;

function getCtor(): RecognitionCtor | null {
  const w = window as unknown as { SpeechRecognition?: RecognitionCtor; webkitSpeechRecognition?: RecognitionCtor };
  return w.SpeechRecognition ?? w.webkitSpeechRecognition ?? null;
}

export const speechRecognitionSupported = () => getCtor() !== null;

export interface ListenHandlers {
  onInterim(text: string): void;
  onFinal(text: string): void;
  onError(message: string): void;
  onEnd(): void;
}

const ERRORS: Record<string, string> = {
  'not-allowed': 'Нет доступа к микрофону. Разрешите его в настройках Safari.',
  'service-not-allowed': 'Распознавание речи недоступно в этом режиме. Используйте диктовку клавиатуры.',
  'no-speech': 'Речь не распознана. Попробуйте ещё раз.',
  'audio-capture': 'Микрофон недоступен.',
  network: 'Для распознавания речи нужна сеть.',
  aborted: '',
};

/** Запускает распознавание одной фразы. Возвращает функцию остановки. */
export function listen(lang: string, h: ListenHandlers): () => void {
  const Ctor = getCtor();
  if (!Ctor) {
    h.onError('Распознавание речи не поддерживается. Используйте диктовку на клавиатуре.');
    h.onEnd();
    return () => {};
  }
  const rec = new Ctor();
  rec.lang = lang;
  rec.interimResults = true;
  rec.continuous = false;
  rec.maxAlternatives = 1;
  let finalText = '';
  rec.onresult = (e) => {
    let interim = '';
    for (let i = e.resultIndex; i < e.results.length; i++) {
      const r = e.results[i];
      if (r.isFinal) finalText += r[0].transcript;
      else interim += r[0].transcript;
    }
    h.onInterim((finalText + interim).trim());
  };
  rec.onerror = (e) => {
    const msg = ERRORS[e.error] ?? `Ошибка распознавания: ${e.error}`;
    if (msg) h.onError(msg);
  };
  rec.onend = () => {
    if (finalText.trim()) h.onFinal(finalText.trim());
    h.onEnd();
  };
  try {
    rec.start();
  } catch {
    h.onError('Не удалось запустить микрофон.');
    h.onEnd();
  }
  return () => rec.stop();
}

/* ---------- Синтез речи ---------- */

export function speak(text: string, lang: string) {
  if (!('speechSynthesis' in window)) return;
  window.speechSynthesis.cancel();
  const clean = text.replace(/[*_#`>]/g, '').slice(0, 1200);
  const u = new SpeechSynthesisUtterance(clean);
  u.lang = lang;
  const voice = window.speechSynthesis.getVoices().find((v) => v.lang.replace('_', '-').startsWith(lang.slice(0, 2)));
  if (voice) u.voice = voice;
  u.rate = 1.02;
  window.speechSynthesis.speak(u);
}

export function stopSpeaking() {
  if ('speechSynthesis' in window) window.speechSynthesis.cancel();
}
