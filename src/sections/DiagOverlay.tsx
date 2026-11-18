/* Временная панель диагностики поверх карты: карта (жизненный цикл), сырой GPS, показанная позиция и причина. */
import { useEffect, useState } from 'react';
import { useStore } from '../lib/store';
import { geoStore, locatorState } from '../lib/nav';
import { displayStore } from '../lib/matching/display';
import { mapDiagStore, geoDiagStore, diagModeStore, meanInterval } from '../lib/diag';
import { FIX_SOURCE_LABEL } from '../lib/geo/locator';

const ago = (t: number | null | undefined, now: number) => (t ? `${((now - t) / 1000).toFixed(1)} с` : '—');

export function DiagOverlay({ engine }: { engine: 'leaflet' | 'maplibre' }) {
  const on = useStore(diagModeStore).on;
  const m = useStore(mapDiagStore);
  const g = useStore(geoStore);
  const gd = useStore(geoDiagStore);
  const d = useStore(displayStore);
  const [now, setNow] = useState(Date.now());
  // На телефоне панель свёрнута по умолчанию: не закрывает поиск и карточки (развернуть — одним касанием).
  const [open, setOpen] = useState(() => typeof innerWidth === 'number' && innerWidth >= 700);
  useEffect(() => {
    if (!on) return;
    const t = setInterval(() => setNow(Date.now()), 500);
    return () => clearInterval(t);
  }, [on]);
  if (!on) return null;
  const ls = locatorState();
  const mean = meanInterval(gd.arrivals);
  const sinceLast = gd.arrivals.length ? now - gd.arrivals[gd.arrivals.length - 1] : null;
  return (
    <div className="diag-overlay" role="status" aria-label="Диагностика карты и геопозиции">
      <button type="button" className="diag-toggle" onClick={() => setOpen(!open)}>
        Диагностика {open ? '▾' : '▸'}
      </button>
      {open && (
        <div className="diag-body">
          <div className="diag-h">Карта · {engine === 'maplibre' ? 'MapLibre' : 'Leaflet'}</div>
          <div>
            создано {m.creates} · удалено {m.removes} · setStyle {m.setStyles} · стиль загружен {m.styleLoads}
          </div>
          <div>
            ошибок {m.errors} · WebGL потерян {m.contextLost}/{m.contextRestored} · кадров/с {engine === 'maplibre' ? m.fps : '—'}
          </div>
          <div className="diag-h">
            <span className="diag-dot diag-dot-raw" /> GPS браузера (сырой)
          </div>
          <div>
            {g.lat != null ? `${g.lat.toFixed(6)}, ${g.lon!.toFixed(6)}` : 'нет точки'} · ±{g.accuracy != null ? Math.round(g.accuracy) : '—'} м
          </div>
          <div>
            возраст {ago(g.fixAt, now)} · получена {ago(g.updated, now)} назад · {g.source ? FIX_SOURCE_LABEL[g.source] : '—'}
          </div>
          <div>
            точек {gd.accepted} · интервал {mean != null ? `${mean.toFixed(1)} с` : '—'} · макс. пауза {(gd.maxGap / 1000).toFixed(1)} с · сейчас {sinceLast != null ? `${(sinceLast / 1000).toFixed(1)} с` : '—'}
          </div>
          <div>
            отброшено: старых {gd.rejected.stale}, менее точных {gd.rejected.coarse}, скачков {gd.rejected.jump} · запросы: {[ls.high && 'высокая точность', ls.low && 'запасной'].filter(Boolean).join(' + ') || '—'}
          </div>
          {g.lastError && <div>ошибка: код {g.lastError.code} {g.lastError.message} ({ago(g.lastError.at, now)} назад)</div>}
          <div className="diag-h">
            <span className="diag-dot diag-dot-car" /> Машинка (показанная)
          </div>
          <div>
            {d.mode ?? '—'} · сдвиг от GPS {d.shift.toFixed(0)} м · уверенность {d.confidence.toFixed(2)}
          </div>
          <div className="diag-reason">{d.reason || '—'}</div>
          {m.events.length > 0 && (
            <>
              <div className="diag-h">События карты</div>
              {m.events.slice(0, 5).map((e) => (
                <div key={e.at + e.text}>
                  {new Date(e.at).toLocaleTimeString('ru-RU')} {e.text}
                </div>
              ))}
            </>
          )}
        </div>
      )}
    </div>
  );
}
