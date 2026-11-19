export const CONTROLS_IDLE_MS = 20_000;

export function verticalSwipe(dx: number, dy: number, elapsed: number): 'up' | 'down' | null {
  if (elapsed >= 800 || Math.abs(dy) < 30 || Math.abs(dy) < Math.abs(dx) * 1.5) return null;
  return dy < 0 ? 'up' : 'down';
}
