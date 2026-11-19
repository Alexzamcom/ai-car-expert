import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { App } from './App';
import './styles/global.css';
import { startTheme } from './lib/theme';
import { startPlacesBackup } from './lib/places';

startTheme();
// «Мои места»: резервная копия в IndexedDB и запрос постоянного хранилища.
void startPlacesBackup();

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <App />
  </StrictMode>,
);

if ('serviceWorker' in navigator && import.meta.env.PROD && import.meta.env.MODE !== 'artifact') {
  window.addEventListener('load', () => {
    navigator.serviceWorker.register('./sw.js').catch(() => {});
  });
}

// Блокируем масштабирование жестами — интерфейс рассчитан на фиксированный масштаб.
document.addEventListener('gesturestart', (e) => e.preventDefault());
