import { createStore } from './store';
import { openSection } from './state';

export const manualArticleStore = createStore<string | null>(null);

export function openArticle(id: string) {
  manualArticleStore.set(id);
  openSection('manual');
}
