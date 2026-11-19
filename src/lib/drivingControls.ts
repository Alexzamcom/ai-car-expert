export const CONTROLS_IDLE_MS = 20_000;

export function verticalSwipe(dx: number, dy: number): 'up' | 'down' | null {
  if (Math.abs(dy) < 30 || Math.abs(dy) < Math.abs(dx) * 1.5) return null;
  return dy < 0 ? 'up' : 'down';
}
