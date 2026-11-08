import { createStore } from './store';
import { listen, speechRecognitionSupported, stopSpeaking } from './speech';
import { settingsStore } from './state';
import { handleVoiceCommand } from './voiceCommands';

export interface VoiceState {
  open: boolean;
  listening: boolean;
  interim: string;
  error: string | null;
}

export const voiceStore = createStore<VoiceState>({ open: false, listening: false, interim: '', error: null });

let stopFn: (() => void) | null = null;

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
        handleVoiceCommand(t);
      }, 350);
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
  handleVoiceCommand(text);
}
