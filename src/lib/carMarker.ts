/* Маркер автомобиля на карте: вид сверху, объёмный (градиент кузова, блик крыши, тень), цвет из настроек.
   Нос машинки смотрит вверх (на север); поворот на курс задаёт карта. */

export type CarColor = 'white' | 'black' | 'gray' | 'silver' | 'red' | 'blue' | 'navy' | 'green' | 'yellow' | 'orange' | 'beige' | 'brown';

/** [название, основной цвет кузова, тень кузова] */
export const CAR_COLORS: Record<CarColor, [string, string, string]> = {
  white: ['Белый', '#f7f8fa', '#c9ced6'],
  black: ['Чёрный', '#2a2d33', '#101114'],
  gray: ['Серый', '#8d939c', '#5f656e'],
  silver: ['Серебристый', '#cfd4da', '#9aa1aa'],
  red: ['Красный', '#d8383b', '#9c2124'],
  blue: ['Синий', '#3474e0', '#204f9f'],
  navy: ['Тёмно-синий', '#24406f', '#142645'],
  green: ['Зелёный', '#2f9461', '#1d6542'],
  yellow: ['Жёлтый', '#f3c432', '#bf931b'],
  orange: ['Оранжевый', '#ef7d2c', '#b75614'],
  beige: ['Бежевый', '#dbc7a3', '#ab9670'],
  brown: ['Коричневый', '#7a5236', '#523521'],
};

export function isCarColor(v: unknown): v is CarColor {
  return typeof v === 'string' && v in CAR_COLORS;
}

/** SVG машинки 30×52. id градиентов уникальны по цвету: на странице может быть превью нескольких цветов. */
export function carSvg(color: CarColor = 'white', size = 30): string {
  const [, body, shade] = CAR_COLORS[isCarColor(color) ? color : 'white'];
  const id = `car-${color}`;
  const dark = color === 'black' || color === 'navy' || color === 'brown';
  const glass = dark ? '#5d6b7d' : '#24303f';
  const h = Math.round((size * 52) / 30);
  return `<svg class="car-svg" width="${size}" height="${h}" viewBox="0 0 30 52" aria-hidden="true">
  <defs>
    <linearGradient id="${id}-b" x1="0" x2="1" y1="0" y2="0">
      <stop offset="0" stop-color="${shade}"/><stop offset="0.28" stop-color="${body}"/><stop offset="0.72" stop-color="${body}"/><stop offset="1" stop-color="${shade}"/>
    </linearGradient>
    <linearGradient id="${id}-r" x1="0" x2="0" y1="0" y2="1">
      <stop offset="0" stop-color="#fff" stop-opacity="0.55"/><stop offset="1" stop-color="#fff" stop-opacity="0"/>
    </linearGradient>
  </defs>
  <ellipse cx="15" cy="27" rx="14" ry="24.5" fill="#000" opacity="0.28"/>
  <rect x="2.5" y="2" width="25" height="47" rx="9" fill="url(#${id}-b)" stroke="${shade}" stroke-width="1"/>
  <rect x="3" y="7" width="2.2" height="7" rx="1" fill="${shade}"/><rect x="24.8" y="7" width="2.2" height="7" rx="1" fill="${shade}"/>
  <rect x="3" y="35" width="2.2" height="7" rx="1" fill="${shade}"/><rect x="24.8" y="35" width="2.2" height="7" rx="1" fill="${shade}"/>
  <path d="M6.5 15.5 Q15 11.5 23.5 15.5 L22 21.5 Q15 19.5 8 21.5 Z" fill="${glass}"/>
  <rect x="8" y="21.5" width="14" height="13" rx="3" fill="${body}"/>
  <rect x="8.5" y="22" width="13" height="7" rx="2.5" fill="url(#${id}-r)"/>
  <path d="M8 34.5 Q15 36.5 22 34.5 L23 40 Q15 42.5 7 40 Z" fill="${glass}"/>
  <path d="M5.5 4.5 L9 3.2 L9.5 5.2 Z M24.5 4.5 L21 3.2 L20.5 5.2 Z" fill="#fff8d6"/>
  <rect x="5" y="47" width="4" height="1.6" rx="0.8" fill="#e04848"/><rect x="21" y="47" width="4" height="1.6" rx="0.8" fill="#e04848"/>
</svg>`;
}

/** Поворот по кратчайшей дуге: 350° → 10° — плюс 20°, а не минус 340° (без «кувырка» при CSS-переходе). */
export function unwrapAngle(prevDisplayed: number, heading: number): number {
  const delta = ((heading - prevDisplayed) % 360 + 540) % 360 - 180;
  return prevDisplayed + delta;
}
