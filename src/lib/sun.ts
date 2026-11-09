/* Восход и закат по координатам — астрономический расчёт на устройстве, без сети.
   Алгоритм: уравнение восхода (как в SunCalc / NOAA), точность — единицы минут. */

const rad = Math.PI / 180;
const DAY_MS = 86_400_000;
const J1970 = 2440588;
const J2000 = 2451545;
const J0 = 0.0009;
const OBLIQUITY = rad * 23.4397;
/** Высота центра Солнца при восходе/закате с учётом рефракции и радиуса диска. */
const H0 = -0.833 * rad;

const toJulian = (d: Date) => d.valueOf() / DAY_MS - 0.5 + J1970;
const fromJulian = (j: number) => new Date((j + 0.5 - J1970) * DAY_MS);
const toDays = (d: Date) => toJulian(d) - J2000;

const meanAnomaly = (d: number) => rad * (357.5291 + 0.98560028 * d);
function eclipticLongitude(M: number) {
  const C = rad * (1.9148 * Math.sin(M) + 0.02 * Math.sin(2 * M) + 0.0003 * Math.sin(3 * M));
  return M + C + rad * 102.9372 + Math.PI;
}
const declination = (L: number) => Math.asin(Math.sin(OBLIQUITY) * Math.sin(L));
const julianCycle = (d: number, lw: number) => Math.round(d - J0 - lw / (2 * Math.PI));
const approxTransit = (ht: number, lw: number, n: number) => J0 + (ht + lw) / (2 * Math.PI) + n;
const solarTransit = (ds: number, M: number, L: number) => J2000 + ds + 0.0053 * Math.sin(M) - 0.0069 * Math.sin(2 * L);

export type SunTimes =
  | { kind: 'normal'; sunrise: Date; sunset: Date }
  | { kind: 'polar-day' }
  | { kind: 'polar-night' };

/** Восход и закат для календарных суток, содержащих date (по солнечному полудню в этой долготе). */
export function sunTimes(date: Date, lat: number, lon: number): SunTimes {
  const lw = rad * -lon;
  const phi = rad * lat;
  const d = toDays(date);
  const n = julianCycle(d, lw);
  const ds = approxTransit(0, lw, n);
  const M = meanAnomaly(ds);
  const L = eclipticLongitude(M);
  const dec = declination(L);
  const noon = solarTransit(ds, M, L);
  const cosW = (Math.sin(H0) - Math.sin(phi) * Math.sin(dec)) / (Math.cos(phi) * Math.cos(dec));
  if (cosW < -1) return { kind: 'polar-day' };
  if (cosW > 1) return { kind: 'polar-night' };
  const w = Math.acos(cosW);
  const set = solarTransit(approxTransit(w, lw, n), M, L);
  const rise = noon - (set - noon);
  return { kind: 'normal', sunrise: fromJulian(rise), sunset: fromJulian(set) };
}

export interface DaylightInfo {
  day: boolean;
  /** Ближайшее переключение (восход или закат), если оно есть. */
  next: { at: Date; to: 'day' | 'night' } | null;
  sunrise: Date | null;
  sunset: Date | null;
}

/** Светло ли сейчас, и когда следующее переключение. */
export function daylight(now: Date, lat: number, lon: number): DaylightInfo {
  const t = sunTimes(now, lat, lon);
  if (t.kind !== 'normal') return { day: t.kind === 'polar-day', next: null, sunrise: null, sunset: null };
  const day = now >= t.sunrise && now < t.sunset;
  let next: DaylightInfo['next'];
  if (now < t.sunrise) next = { at: t.sunrise, to: 'day' };
  else if (now < t.sunset) next = { at: t.sunset, to: 'night' };
  else {
    const tomorrow = sunTimes(new Date(now.valueOf() + DAY_MS), lat, lon);
    next = tomorrow.kind === 'normal' ? { at: tomorrow.sunrise, to: 'day' } : null;
  }
  return { day, next, sunrise: t.sunrise, sunset: t.sunset };
}
