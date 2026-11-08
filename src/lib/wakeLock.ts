/* Экран не гаснет, пока приложение открыто (Screen Wake Lock API). */

interface Sentinel {
  release(): Promise<void>;
  addEventListener(type: 'release', cb: () => void): void;
}

let sentinel: Sentinel | null = null;
let wanted = false;

async function acquire() {
  const nav = navigator as Navigator & { wakeLock?: { request(type: 'screen'): Promise<Sentinel> } };
  if (!wanted || !nav.wakeLock || sentinel || document.visibilityState !== 'visible') return;
  try {
    sentinel = await nav.wakeLock.request('screen');
    sentinel.addEventListener('release', () => {
      sentinel = null;
    });
  } catch {
    sentinel = null;
  }
}

document.addEventListener('visibilitychange', () => {
  if (document.visibilityState === 'visible') acquire();
});

export const wakeLockSupported = () => 'wakeLock' in navigator;

export function setKeepAwake(on: boolean) {
  wanted = on;
  if (on) acquire();
  else if (sentinel) {
    sentinel.release().catch(() => {});
    sentinel = null;
  }
}

/** iOS требует жест пользователя — повторяем попытку при первом касании. */
export function retryWakeLockOnGesture() {
  acquire();
}
