import { useSyncExternalStore } from 'react';

type Listener = () => void;

export interface Store<T> {
  get(): T;
  set(next: T | ((prev: T) => T)): void;
  subscribe(listener: Listener): () => void;
}

const PREFIX = 'ace:';

function readStorage<T>(key: string, fallback: T): T {
  try {
    const raw = localStorage.getItem(PREFIX + key);
    if (raw == null) return fallback;
    const parsed = JSON.parse(raw) as T;
    // Для объектов — дополняем значениями по умолчанию (новые поля после обновлений).
    if (fallback && typeof fallback === 'object' && !Array.isArray(fallback) && parsed && typeof parsed === 'object') {
      return { ...fallback, ...parsed };
    }
    return parsed;
  } catch {
    return fallback;
  }
}

/** Простое глобальное хранилище; при наличии ключа — сохраняется в localStorage. */
export function createStore<T>(initial: T, persistKey?: string): Store<T> {
  let state = persistKey ? readStorage(persistKey, initial) : initial;
  const listeners = new Set<Listener>();
  return {
    get: () => state,
    set(next) {
      state = typeof next === 'function' ? (next as (p: T) => T)(state) : next;
      if (persistKey) {
        try {
          localStorage.setItem(PREFIX + persistKey, JSON.stringify(state));
        } catch {
          /* хранилище недоступно — работаем в памяти */
        }
      }
      listeners.forEach((l) => l());
    },
    subscribe(listener) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
  };
}

export function useStore<T>(store: Store<T>): T {
  return useSyncExternalStore(store.subscribe, store.get, store.get);
}

export function uid(): string {
  return Date.now().toString(36) + Math.random().toString(36).slice(2, 8);
}
