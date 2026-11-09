import { createStore } from './store';
import { listen, speechRecognitionSupported, stopSpeaking, setPreferredVoice } from './speech';
import { settingsStore } from './state';
import { handleVoiceCommand } from './voiceCommands';
import { setAfterSpokenHook } from './assistant';

export interface VoiceState {
  open: boolean;
  listening: boolean;
  interim: string;
  error: string | null;
}

export const voiceStore = createStore<VoiceState>({ open: false, listening: false, interim: '', error: null });

let stopFn: (() => void) | null = null;
/** Последний запрос пришёл голосом — в режиме разговора слушаем снова после ответа. */
let lastViaVoice = false;

setPreferredVoice(settingsStore.get().voiceURI);
settingsStore.subscribe(() => setPreferredVoice(settingsStore.get().voiceURI));

setAfterSpokenHook(() => {
  if (lastViaVoice && settingsStore.get().conversationMode && !voiceStore.get().open) {
    lastViaVoice = false;
    startVoice();
  }
});

export function startVoice() {
  stopSpeaking();
  const supported = speechRecognitionSupported();
  voiceStore.set({ open: true, listening: supported, interim: '', error: supported ? null : 'unsupported' });
  if (!supported) return;
  stopFn = listen(settingsStore.get().speechLang, {
    onInterim: (t) => voiceStore.set((s) => ({ ...s, interim: t })),
    onFinal: (t) => {
      voiceStore.set((s) => ({ ...s, interim: t }));
      setTimeout(() => {
        closeVoice();
        lastViaVoice = true;
        void handleVoiceCommand(t);
      }, 300);
    },
    onError: (m) => voiceStore.set((s) => ({ ...s, error: m })),
    onEnd: () => {
      stopFn = null;
      voiceStore.set((s) => ({ ...s, listening: false }));
    },
  });
}

export function stopListening() {
  stopFn?.();
}

export function closeVoice() {
  stopFn?.();
  stopFn = null;
  voiceStore.set({ open: false, listening: false, interim: '', error: null });
}

export function submitTyped(text: string) {
  closeVoice();
  lastViaVoice = false;
  void handleVoiceCommand(text);
}
