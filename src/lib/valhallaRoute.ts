import type { LatLon, Route, RouteStep } from './routing';

interface Maneuver {
  type: number;
  length: number;
  time: number;
  begin_shape_index: number;
  street_names?: string[];
  roundabout_exit_count?: number;
}
interface Trip {
  summary: { length: number; time: number };
  legs: { shape: string; maneuvers: Maneuver[] }[];
}

export function decodePolyline6(shape: string): LatLon[] {
  let offset = 0, lat = 0, lon = 0;
  const coord = () => {
    let result = 0, next: number, shift = 0;
    do {
      next = shape.charCodeAt(offset++) - 63;
      if (next < 0 || next > 63 || shift > 25 || offset > shape.length) throw new Error('Повреждена геометрия маршрута.');
      result |= (next & 31) << shift;
      shift += 5;
    } while (next >= 32);
    return (result & 1) ? ~(result >>> 1) : result >>> 1;
  };
  const points: LatLon[] = [];
  while (offset < shape.length) {
    lat += coord(); lon += coord();
    points.push({ lat: lat / 1e6, lon: lon / 1e6 });
  }
  return points;
}

const modifier: Record<number, string> = {
  9: 'straight', 10: 'slight right', 11: 'right', 12: 'sharp right', 13: 'uturn', 14: 'uturn',
  15: 'sharp left', 16: 'left', 17: 'slight left', 19: 'right', 20: 'left', 21: 'right', 22: 'left',
  23: 'straight', 24: 'slight right', 25: 'slight left', 37: 'right', 38: 'left',
};

export function fromValhalla({ trip }: { trip: Trip }, name: string): Route {
  const coords: LatLon[] = [];
  const steps: RouteStep[] = [];
  for (const [index, leg] of trip.legs.entries()) {
    const shape = decodePolyline6(leg.shape);
    coords.push(...(index ? shape.slice(1) : shape));
    for (const m of leg.maneuvers) {
      const arrive = m.type >= 4 && m.type <= 6;
      const depart = m.type >= 1 && m.type <= 3;
      if (depart && index) continue;
      const location = shape[m.begin_shape_index];
      if (!location) throw new Error('Повреждён манёвр локального маршрута.');
      steps.push({
        type: arrive ? index + 1 < trip.legs.length ? 'waypoint' : 'arrive' : depart ? 'depart' :
          m.type === 26 ? 'merge' : m.type === 27 ? 'roundabout' : m.type === 28 ? 'exit roundabout' :
          m.type === 21 || m.type === 22 ? 'off ramp' : modifier[m.type] && modifier[m.type] !== 'straight' ? 'turn' : 'continue',
        modifier: modifier[m.type],
        exit: m.roundabout_exit_count,
        name: m.street_names?.join(' / ') ?? '',
        distance: m.length * 1000,
        duration: m.time,
        location,
      });
    }
  }
  return { source: `Valhalla · офлайн · ${name}`, coords, steps, distance: trip.summary.length * 1000, duration: trip.summary.time };
}
