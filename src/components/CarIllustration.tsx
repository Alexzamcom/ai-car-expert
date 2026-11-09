/** Стилизованный силуэт автомобиля (собственная графика AI Car Expert). */
export function CarIllustration() {
  return (
    <svg className="car-illustration" viewBox="0 0 640 220" role="img" aria-label="Автомобиль">
      <defs>
        <linearGradient id="carBody" x1="0" y1="0" x2="0" y2="1">
          <stop offset="0" style={{ stopColor: 'var(--car-body)' }} />
          <stop offset="1" style={{ stopColor: 'var(--car-body-2)' }} />
        </linearGradient>
        <linearGradient id="carGlass" x1="0" y1="0" x2="1" y2="1">
          <stop offset="0" style={{ stopColor: 'var(--accent)', stopOpacity: 0.35 }} />
          <stop offset="1" style={{ stopColor: 'var(--accent)', stopOpacity: 0.05 }} />
        </linearGradient>
        <radialGradient id="carShadow" cx="0.5" cy="0.5" r="0.5">
          <stop offset="0" style={{ stopColor: 'var(--shadow)', stopOpacity: 1 }} />
          <stop offset="1" style={{ stopColor: 'var(--shadow)', stopOpacity: 0 }} />
        </radialGradient>
      </defs>
      <ellipse cx="320" cy="196" rx="290" ry="18" fill="url(#carShadow)" />
      <path
        d="M40 150c0-18 8-30 26-36l84-22 64-44c14-9 30-14 48-14h132c20 0 36 6 50 18l52 42 74 12c26 4 42 20 42 42v14c0 9-7 16-16 16h-34a52 52 0 0 0-102 0H222a52 52 0 0 0-102 0H58c-10 0-18-8-18-18v-10Z"
        fill="url(#carBody)"
        style={{ stroke: 'var(--car-line)' }}
        strokeWidth="2"
      />
      <path d="M226 58c10-7 22-10 36-10h56v50H170l56-40Z" fill="url(#carGlass)" style={{ stroke: 'var(--accent)', strokeOpacity: 0.35 }} />
      <path d="M332 48h50c16 0 28 5 40 14l42 36H332V48Z" fill="url(#carGlass)" style={{ stroke: 'var(--accent)', strokeOpacity: 0.35 }} />
      <path d="M150 112h440" style={{ stroke: 'var(--accent)', strokeOpacity: 0.5 }} strokeWidth="2" />
      <path d="M560 128h34" style={{ stroke: '#e8b84a' }} strokeWidth="6" strokeLinecap="round" opacity="0.8" />
      <path d="M46 136h22" style={{ stroke: 'var(--danger)' }} strokeWidth="6" strokeLinecap="round" opacity="0.7" />
      {[171, 487].map((cx) => (
        <g key={cx}>
          <circle cx={cx} cy="170" r="40" style={{ fill: 'var(--car-wheel)', stroke: 'var(--car-line)' }} strokeWidth="3" />
          <circle cx={cx} cy="170" r="22" style={{ fill: 'none', stroke: 'var(--car-rim)' }} strokeWidth="3" />
          <circle cx={cx} cy="170" r="5" style={{ fill: 'var(--car-rim)' }} />
        </g>
      ))}
    </svg>
  );
}
