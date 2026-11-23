import { useEffect, useMemo, useRef } from 'react';
import { approachHudProgress, GameHudGeometry, type GameHudScene } from '../lib/gameHud';
import type { Route } from '../lib/routing';

function paint(ctx: CanvasRenderingContext2D, scene: GameHudScene, width: number, height: number, fade: number) {
  ctx.clearRect(0, 0, width, height);
  const half = Math.min(width * 0.32, height * 0.46);
  const points = scene.road;
  if (!points.length) return;
  const gradient = ctx.createLinearGradient(0, height * 0.32, 0, height * 0.82);
  gradient.addColorStop(0, '#030c12');
  gradient.addColorStop(1, '#082333');
  ctx.fillStyle = gradient;
  ctx.beginPath();
  points.forEach((p) => ctx.lineTo(p.x - p.scale * half, p.y));
  points.slice().reverse().forEach((p) => ctx.lineTo(p.x + p.scale * half, p.y));
  ctx.closePath();
  ctx.fill();
  ctx.strokeStyle = '#4396b0';
  ctx.lineWidth = 2;
  for (const side of [-1, 1]) {
    ctx.beginPath();
    points.forEach((p) => ctx.lineTo(p.x + side * p.scale * half, p.y));
    ctx.stroke();
  }
  ctx.lineJoin = 'round';
  for (const { point, angle, opacity } of scene.chevrons) {
    ctx.save();
    ctx.translate(point.x, point.y);
    ctx.rotate(angle);
    ctx.scale(point.scale, point.scale);
    ctx.globalAlpha = opacity * fade;
    const span = half * 0.58;
    for (const [offset, stroke, lineWidth] of [[4, '#13547a', 15], [0, '#2079a7', 14], [-1, '#69d9ff', 7], [-2, '#c2f5ff', 2]] as const) {
      ctx.strokeStyle = stroke;
      ctx.lineWidth = lineWidth;
      ctx.beginPath();
      ctx.moveTo(-span, 9 + offset);
      ctx.lineTo(0, -10 + offset);
      ctx.lineTo(span, 9 + offset);
      ctx.stroke();
    }
    ctx.restore();
  }
}

export function GameHudRoad({ route, remaining, step, aligned }: { route: Route | null; remaining: number | null; step: number | null; aligned: boolean }) {
  const canvas = useRef<HTMLCanvasElement>(null);
  const geometry = useMemo(() => route ? new GameHudGeometry(route) : null, [route]);
  const target = useRef({ remaining, step, aligned });
  target.current = { remaining, step, aligned };

  useEffect(() => {
    const element = canvas.current;
    const ctx = element?.getContext('2d');
    if (!element || !ctx || !geometry) return;
    let width = 0, height = 0, shown: number | null = null, last = 0, previousStep: number | null = null, raf = 0;
    let dirty = true;
    let stepAt = 0;
    let previousFade = 0;
    const reduced = matchMedia('(prefers-reduced-motion: reduce)');
    const resize = () => {
      width = element.clientWidth;
      height = element.clientHeight;
      const ratio = Math.min(devicePixelRatio || 1, 1.5);
      element.width = Math.round(width * ratio);
      element.height = Math.round(height * ratio);
      ctx.setTransform(ratio, 0, 0, ratio, 0, 0);
      dirty = true;
    };
    resize();
    const observer = new ResizeObserver(resize);
    observer.observe(element);
    const frame = (now: number) => {
      raf = requestAnimationFrame(frame);
      if (now - last < 32) return;
      const dt = (now - last) / 1000;
      last = now;
      const next = target.current;
      if (!next.aligned || next.remaining == null) {
        if (shown != null || dirty) ctx.clearRect(0, 0, width, height);
        shown = null;
        previousStep = null;
        dirty = false;
        if (element.dataset.chevrons !== '0') element.dataset.chevrons = '0';
        return;
      }
      const distance = geometry.total - next.remaining;
      const position = shown == null || reduced.matches ? distance : approachHudProgress(shown, distance, dt);
      if (previousStep !== next.step) stepAt = now;
      const fade = reduced.matches ? 1 : Math.min(1, (now - stepAt) / 230);
      if (!dirty && position === shown && previousStep === next.step && (next.step == null || fade === previousFade)) return;
      previousFade = fade;
      shown = position;
      previousStep = next.step;
      dirty = false;
      const scene = geometry.scene(position, next.step, width, height);
      paint(ctx, scene, width, height, fade);
      element.dataset.chevrons = String(scene.chevrons.length);
    };
    raf = requestAnimationFrame(frame);
    return () => {
      cancelAnimationFrame(raf);
      observer.disconnect();
      ctx.clearRect(0, 0, width, height);
    };
  }, [geometry]);

  return <canvas ref={canvas} className="hud-game-road" aria-hidden="true" data-chevrons="0" />;
}
