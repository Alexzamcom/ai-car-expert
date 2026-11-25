import { useEffect, useRef, useState } from 'react';
import { coordsPlace, type Place } from '../lib/geo/geocode';
import { searchPlaces } from '../lib/nav';
import { placesStore } from '../lib/places';
import { plannedRoute, type Endpoint } from '../lib/routePlanner';
import { fmtDistance, fmtDuration, type LatLon } from '../lib/routing';
import { useStore } from '../lib/store';

export function RoutePlanner({ actual, pick, build, busy, ready }: {
  actual: LatLon | null; pick(field: Endpoint): void; build(): void; busy: boolean; ready: boolean;
}) {
  const plan = useStore(plannedRoute);
  const places = useStore(placesStore);
  const [field, setField] = useState<Endpoint | null>(plan.from ? null : 'from');
  const [query, setQuery] = useState('');
  const [matches, setMatches] = useState<Place[]>([]);
  const [status, setStatus] = useState('');
  const request = useRef<AbortController | null>(null);
  useEffect(() => () => request.current?.abort(), []);

  function select(place: Place) {
    if (!field) return;
    request.current?.abort();
    plannedRoute.set({ ...plan, [field]: place, route: null });
    edit(null);
  }

  function edit(next: Endpoint | null) {
    request.current?.abort();
    setField(next);
    setQuery('');
    setMatches([]);
    setStatus('');
  }

  async function search() {
    if (!field || query.trim().length < 2) return;
    request.current?.abort();
    const controller = new AbortController();
    request.current = controller;
    setStatus('Ищем адрес…');
    setMatches([]);
    try {
      const found = await searchPlaces(query.trim(), undefined, controller.signal);
      if (controller.signal.aborted) return;
      setMatches(found);
      setStatus(found.length ? '' : 'Адрес не найден. Выберите точку на карте.');
    } catch {
      if (!controller.signal.aborted) setStatus('Поиск недоступен. Выберите точку на карте.');
    }
  }

  return <section className="route-planner" aria-label="Построение маршрута">
    <div className="route-planner-fields">
      {(['from', 'to'] as const).map((key) => <button key={key} type="button" className="btn route-planner-field"
        aria-pressed={field === key} disabled={busy} onClick={() => edit(field === key ? null : key)}>
        <small>{key === 'from' ? 'Откуда' : 'Куда'}</small><strong>{plan[key]?.name ?? 'Выберите точку'}</strong>
      </button>)}
      <button className="btn route-planner-swap" aria-label="Поменять точки местами" disabled={busy || !plan.from && !plan.to}
        onClick={() => { edit(null); plannedRoute.set({ from: plan.to, to: plan.from, route: null }); }}>⇅</button>
    </div>
    {field && <>
      <form className="route-planner-search" onSubmit={(event) => { event.preventDefault(); void search(); }}>
        <input className="input" aria-label={field === 'from' ? 'Адрес отправления' : 'Адрес назначения'} placeholder="Адрес, улица или город"
          value={query} onChange={(event) => { request.current?.abort(); setQuery(event.target.value); setMatches([]); setStatus(''); }} />
        <button className="btn" disabled={busy || query.trim().length < 2}>Найти</button>
      </form>
      {status && <small role="status">{status}</small>}
      <div className="route-planner-options">
        <button className="btn" disabled={busy} onClick={() => { edit(null); pick(field); }}>Выбрать на карте</button>
        {actual && <button className="btn" disabled={busy} onClick={() => select({ ...coordsPlace(actual), name: 'Моё местоположение' })}>Моё местоположение</button>}
        {places.map((place) => <button className="btn" disabled={busy} key={place.id} onClick={() => select(place)}>{place.name}</button>)}
      </div>
      {matches.map((place) => <button className="btn route-planner-result" disabled={busy} key={place.id} onClick={() => select(place)}>
        {place.name}{place.address && <small>{place.address}</small>}
      </button>)}
    </>}
    {ready && plan.route && <p className="route-planner-summary">{fmtDistance(plan.route.distance)} · {fmtDuration(plan.route.duration)}</p>}
    <button className={ready ? 'btn' : 'btn btn-primary'} disabled={busy || !plan.from || !plan.to} onClick={build}>
      {busy ? 'Строим маршрут…' : ready ? 'Построить заново' : 'Построить маршрут'}
    </button>
  </section>;
}
