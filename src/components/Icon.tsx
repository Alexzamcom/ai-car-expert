import type { CSSProperties } from 'react';

/** Собственный набор линейных иконок (24×24, stroke). */
const PATHS = {
  car: 'M3 15v-2.5c0-1 .6-1.8 1.5-2.1L6.5 10l2-3.3C9 5.9 9.9 5.5 10.8 5.5h3.6c.9 0 1.7.4 2.2 1.1L19 10l1.4.5c.9.3 1.6 1.2 1.6 2.1V15c0 .6-.4 1-1 1h-1M3 15c0 .6.4 1 1 1h1M9 16h6M6 10h12M7 16a1.5 1.5 0 1 0 3 0 1.5 1.5 0 1 0-3 0M14 16a1.5 1.5 0 1 0 3 0 1.5 1.5 0 1 0-3 0',
  map: 'M9 4 3 6.5v13L9 17l6 2.5 6-2.5V4l-6 2.5L9 4ZM9 4v13M15 6.5v13',
  music: 'M9 18V6l11-2v12M9 18a3 3 0 1 1-6 0 3 3 0 0 1 6 0ZM20 16a3 3 0 1 1-6 0 3 3 0 0 1 6 0Z',
  spark: 'M12 3l1.8 5.2L19 10l-5.2 1.8L12 17l-1.8-5.2L5 10l5.2-1.8L12 3ZM19 16l.8 2.2L22 19l-2.2.8L19 22l-.8-2.2L16 19l2.2-.8L19 16Z',
  book: 'M4 5.5C4 4.7 4.7 4 5.5 4H11v16H5.5c-.8 0-1.5-.7-1.5-1.5v-13ZM20 5.5c0-.8-.7-1.5-1.5-1.5H13v16h5.5c.8 0 1.5-.7 1.5-1.5v-13Z',
  wrench: 'M14.5 6.5a4 4 0 0 0 5 5L21 13l-1.5 1.5M14.5 6.5 13 5l1.5-1.5a4 4 0 0 1 5 5M14.5 6.5l-11 11a1.8 1.8 0 0 0 2.5 2.5l11-11',
  gauge: 'M4.5 18a9 9 0 1 1 15 0M12 13l4-5M12 13a1.5 1.5 0 1 0 0 .01M7 12H6M18 12h-1M12 6V5',
  gear: 'M12 15a3 3 0 1 0 0-6 3 3 0 0 0 0 6ZM19.4 13.5l1.6 1.2-2 3.4-1.9-.7a7 7 0 0 1-2 1.2L14.8 21h-4l-.3-2.4a7 7 0 0 1-2-1.2l-1.9.7-2-3.4 1.6-1.2a7 7 0 0 1 0-2.4L4.6 9.9l2-3.4 1.9.7a7 7 0 0 1 2-1.2L10.8 3h4l.3 2.4a7 7 0 0 1 2 1.2l1.9-.7 2 3.4-1.6 1.2a7 7 0 0 1 0 2.4Z',
  mic: 'M12 3a3 3 0 0 0-3 3v6a3 3 0 0 0 6 0V6a3 3 0 0 0-3-3ZM5 11a7 7 0 0 0 14 0M12 18v3M8.5 21h7',
  swap: 'M7 4v13M7 4 4 7M7 4l3 3M17 20V7M17 20l-3-3M17 20l3-3',
  expand: 'M4 9V4h5M20 9V4h-5M4 15v5h5M20 15v5h-5',
  collapse: 'M9 4v5H4M15 4v5h5M9 20v-5H4M15 20v-5h5',
  close: 'M6 6l12 12M18 6 6 18',
  play: 'M7 4.5v15l12-7.5-12-7.5Z',
  pause: 'M7 4.5h3.5v15H7zM13.5 4.5H17v15h-3.5z',
  next: 'M5 5l10 7-10 7V5ZM19 5v14',
  prev: 'M19 5 9 12l10 7V5ZM5 5v14',
  stop: 'M6 6h12v12H6z',
  radio: 'M4 9h16v11H4zM4 9l12-5M8 14.5a1.5 1.5 0 1 0 3 0 1.5 1.5 0 1 0-3 0M14 13h3M14 16h3',
  folder: 'M3 6.5C3 5.7 3.7 5 4.5 5H9l2 2h8.5c.8 0 1.5.7 1.5 1.5v9c0 .8-.7 1.5-1.5 1.5h-15c-.8 0-1.5-.7-1.5-1.5v-11Z',
  search: 'M11 18a7 7 0 1 0 0-14 7 7 0 0 0 0 14ZM20 20l-4-4',
  locate: 'M12 19a7 7 0 1 0 0-14 7 7 0 0 0 0 14ZM12 2v3M12 19v3M2 12h3M19 12h3M12 14a2 2 0 1 0 0-4 2 2 0 0 0 0 4Z',
  navigate: 'M12 2.5 19 20l-7-3.5L5 20l7-17.5Z',
  plus: 'M12 5v14M5 12h14',
  trash: 'M4 7h16M10 11v6M14 11v6M6 7l1 13h10l1-13M9 7V4h6v3',
  edit: 'M4 20h4L19 9l-4-4L4 16v4ZM13.5 6.5l4 4',
  lock: 'M6 11h12v9H6zM8.5 11V8a3.5 3.5 0 0 1 7 0v3',
  fan: 'M12 12c0-4 1-8 4-8 2 0 2.5 2 1.5 3.5S14 10 12 12Zm0 0c4 0 8 1 8 4 0 2-2 2.5-3.5 1.5S14 14 12 12Zm0 0c0 4-1 8-4 8-2 0-2.5-2-1.5-3.5S10 14 12 12Zm0 0c-4 0-8-1-8-4 0-2 2-2.5 3.5-1.5S10 10 12 12Z',
  door: 'M6 21V4.5C6 3.7 6.7 3 7.5 3h9c.8 0 1.5.7 1.5 1.5V21M4 21h16M14.5 12.5h.01',
  window: 'M4 18 7 7h10l3 11H4ZM12 7v11',
  light: 'M9 6c-3 0-5 2.7-5 6s2 6 5 6h1V6H9ZM14 8l6-1.5M14 12h6M14 16l6 1.5',
  trunk: 'M3 16h18M5 16l2-6h10l2 6M5 16v3h14v-3M10 13h4',
  fuel: 'M5 20V5.5C5 4.7 5.7 4 6.5 4h6c.8 0 1.5.7 1.5 1.5V20M4 20h11M5 10h9M14 8l3 2v6.5a1.5 1.5 0 0 0 3 0V9l-2.5-2.5',
  bolt: 'M13 3 5 13.5h6L10 21l8-10.5h-6L13 3Z',
  wifi: 'M5 12.5a10 10 0 0 1 14 0M8 15.5a6 6 0 0 1 8 0M12 19h.01M2 9.5a14 14 0 0 1 20 0',
  wifiOff: 'M3 3l18 18M8 15.5a6 6 0 0 1 6.4-1.2M5 12.5a10 10 0 0 1 4-2.4M12 19h.01M2 9.5a14 14 0 0 1 4.7-3.1M14 6.2a14 14 0 0 1 8 3.3M17.6 11.2a10 10 0 0 1 1.4 1.3',
  gps: 'M12 21s-6.5-6.2-6.5-11a6.5 6.5 0 0 1 13 0c0 4.8-6.5 11-6.5 11ZM12 12.5a2.5 2.5 0 1 0 0-5 2.5 2.5 0 0 0 0 5Z',
  send: 'M4 12 20 4l-6 16-3-7-7-1Z',
  speaker: 'M4 9.5h4L13 5v14l-5-4.5H4v-5ZM16.5 9a4 4 0 0 1 0 6M19 6.5a8 8 0 0 1 0 11',
  speakerOff: 'M4 9.5h4L13 5v14l-5-4.5H4v-5ZM17 9.5l5 5M22 9.5l-5 5',
  check: 'M5 12.5 10 17 19 7',
  alert: 'M12 4 2.5 20h19L12 4ZM12 10v4.5M12 17.5h.01',
  info: 'M12 21a9 9 0 1 0 0-18 9 9 0 0 0 0 18ZM12 11v5.5M12 7.5h.01',
  chevronRight: 'M9 5l7 7-7 7',
  back: 'M15 5l-7 7 7 7',
  download: 'M12 4v11M7 10.5l5 5 5-5M4 20h16',
  upload: 'M12 16V5M7 9.5l5-5 5 5M4 20h16',
  calendar: 'M4 6h16v14H4zM4 10h16M8 3.5V7M16 3.5V7',
  home: 'M3.5 11 12 4l8.5 7M6 9.5V20h12V9.5',
  star: 'M12 3.5l2.6 5.3 5.9.9-4.2 4.1 1 5.8-5.3-2.8-5.3 2.8 1-5.8-4.2-4.1 5.9-.9L12 3.5Z',
  external: 'M14 4h6v6M20 4l-9 9M18 14v5c0 .6-.4 1-1 1H5c-.6 0-1-.4-1-1V7c0-.6.4-1 1-1h5',
  keyboard: 'M3 7h18v11H3zM6.5 10.5h.01M10 10.5h.01M13.5 10.5h.01M17 10.5h.01M8 14.5h8',
  sun: 'M12 16a4 4 0 1 0 0-8 4 4 0 0 0 0 8ZM12 2.5v2M12 19.5v2M2.5 12h2M19.5 12h2M5.3 5.3l1.4 1.4M17.3 17.3l1.4 1.4M5.3 18.7l1.4-1.4M17.3 6.7l1.4-1.4',
  plug: 'M9 3v5M15 3v5M6 8h12v3a6 6 0 0 1-12 0V8ZM12 17v4',
  thermo: 'M10 13.5V5a2 2 0 1 1 4 0v8.5a4 4 0 1 1-4 0ZM12 9v7',
  grid: 'M4 4h6v6H4zM14 4h6v6h-6zM4 14h6v6H4zM14 14h6v6h-6z',
  obd: 'M3 8h18v9H3zM6 17v2M18 17v2M7 11h.01M10 11h.01M13 11h.01M16 11h.01M8.5 14h.01M11.5 14h.01M14.5 14h.01',
  arrowLeft: 'M10 5 4 11l6 6M4 11h9a6 6 0 0 1 6 6v3',
  arrowRight: 'M14 5l6 6-6 6M20 11h-9a6 6 0 0 0-6 6v3',
  arrowUp: 'M12 20V4M6 10l6-6 6 6',
  uturn: 'M8 20V9a4 4 0 0 1 8 0v4M12 9l4 4 4-4',
  roundabout: 'M12 21v-5M12 16a4 4 0 1 0 0-8 4 4 0 0 0 0 8ZM15 9l5-5M16 4h4v4',
  flag: 'M5 21V4M5 4h11l-2 4 2 4H5',
  route: 'M6 19a2 2 0 1 0 0-4 2 2 0 0 0 0 4ZM18 9a2 2 0 1 0 0-4 2 2 0 0 0 0 4ZM6 15V9a4 4 0 0 1 4-4h6M18 9v6a4 4 0 0 1-4 4H8',
  chevronUp: 'M5 15l7-7 7 7',
  chevronDown: 'M5 9l7 7 7-7',
  more: 'M5 12h.01M12 12h.01M19 12h.01',
  clock: 'M12 21a9 9 0 1 0 0-18 9 9 0 0 0 0 18ZM12 7v5l3 2',
  cup: 'M4 8h13v5a5 5 0 0 1-5 5H9a5 5 0 0 1-5-5V8ZM17 10h1.5a2.5 2.5 0 0 1 0 5H17M7 3v2M11 3v2',
  parking: 'M5 3h14v18H5zM10 17V7h3a3 3 0 0 1 0 6h-3',
  phone: 'M5 4h4l2 5-2.5 1.5a11 11 0 0 0 5 5L15 13l5 2v4a2 2 0 0 1-2 2A16 16 0 0 1 3 6a2 2 0 0 1 2-2Z',
  chat: 'M4 5h16v11H9l-5 4V5Z',
  bluetooth: 'M7 7l10 10-5 4V3l5 4L7 17',
  camera: 'M4 8h4l2-3h4l2 3h4v11H4zM12 17a3.5 3.5 0 1 0 0-7 3.5 3.5 0 0 0 0 7Z',
  moon: 'M20 14.5A8 8 0 0 1 9.5 4a8 8 0 1 0 10.5 10.5Z',
  autoTheme: 'M12 3a9 9 0 1 0 0 18V3ZM12 3a9 9 0 0 1 0 18',
  shield: 'M12 3l8 3v6c0 4.5-3.4 8.3-8 9-4.6-.7-8-4.5-8-9V6l8-3Z',
} as const;

export type IconName = keyof typeof PATHS;

interface Props {
  name: IconName;
  size?: number | string;
  stroke?: number;
  className?: string;
  style?: CSSProperties;
  filled?: boolean;
}

export function Icon({ name, size = '1.5em', stroke = 1.8, className, style, filled }: Props) {
  return (
    <svg
      viewBox="0 0 24 24"
      width={size}
      height={size}
      fill={filled ? 'currentColor' : 'none'}
      stroke="currentColor"
      strokeWidth={stroke}
      strokeLinecap="round"
      strokeLinejoin="round"
      className={className}
      style={style}
      aria-hidden="true"
      focusable="false"
    >
      <path d={PATHS[name]} />
    </svg>
  );
}
