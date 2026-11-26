import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { App } from './App';
import './styles/global.css';
import { startTheme } from './lib/theme';
import { startPlacesBackup } from './lib/places';

startTheme();
const nativeBuild = ['android', 'ios', 'ios-simulator'].includes(import.meta.env.MODE);
if (nativeBuild) void import('./lib/geo/androidLifecycle');
// «Мои места»: резервная копия в IndexedDB и запрос постоянного хранилища.
void startPlacesBackup();

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <App />
  </StrictMode>,
);

if ('serviceWorker' in navigator && import.meta.env.PROD && import.meta.env.MODE !== 'artifact' && !nativeBuild) {
  window.addEventListener('load', () => {
    navigator.serviceWorker.register('./sw.js').catch(() => {});
  });
}

// Блокируем масштабирование жестами — интерфейс рассчитан на фиксированный масштаб.
document.addEventListener('gesturestart', (e) => e.preventDefault());

if (import.meta.env.MODE === 'ios-simulator') void import('./iosSimulatorCheck');
