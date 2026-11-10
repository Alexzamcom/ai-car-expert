/* Распознавание долгого нажатия на карте.
   Срабатывает, если один палец держат неподвижно ≥ delay мс.
   Отменяется: движение дальше tolerance (сдвиг карты), второй палец (масштаб, прокрутка двумя пальцами),
   отпускание раньше времени, отмена системой (pointercancel). */

export interface LongPressOptions {
  delay?: number;
  tolerance?: number;
  onLongPress: (x: number, y: number) => void;
}

export class LongPressDetector {
  readonly delay: number;
  readonly tolerance: number;
  private pointers = new Map<number, { x: number; y: number }>();
  private start: { id: number; x: number; y: number } | null = null;
  private timer: ReturnType<typeof setTimeout> | null = null;
  /** Был ли жест после первого касания многопальцевым — тогда до отпускания всех пальцев не срабатываем. */
  private multi = false;
  /** Время последнего срабатывания (чтобы не дублировать системным contextmenu). */
  lastFired = 0;

  constructor(private opts: LongPressOptions) {
    this.delay = opts.delay ?? 600;
    this.tolerance = opts.tolerance ?? 10;
  }

  down(id: number, x: number, y: number) {
    this.pointers.set(id, { x, y });
    if (this.pointers.size > 1) {
      this.multi = true;
      this.clear();
      return;
    }
    if (this.multi) return;
    this.start = { id, x, y };
    this.clear(false);
    this.timer = setTimeout(() => {
      this.timer = null;
      const s = this.start;
      if (!s || this.multi || this.pointers.size !== 1) return;
      this.start = null;
      this.lastFired = Date.now();
      this.opts.onLongPress(s.x, s.y);
    }, this.delay);
  }

  move(id: number, x: number, y: number) {
    if (!this.pointers.has(id)) return;
    this.pointers.set(id, { x, y });
    if (this.start?.id === id && Math.hypot(x - this.start.x, y - this.start.y) > this.tolerance) this.clear();
  }

  up(id: number) {
    this.pointers.delete(id);
    if (this.start?.id === id) this.clear();
    if (this.pointers.size === 0) this.multi = false;
  }

  /** Сброс: отмена жеста системой, начало сдвига/масштабирования карты. */
  cancel() {
    this.clear();
  }

  reset() {
    this.clear();
    this.pointers.clear();
    this.multi = false;
  }

  get pending() {
    return this.timer != null;
  }

  private clear(dropStart = true) {
    if (this.timer) clearTimeout(this.timer);
    this.timer = null;
    if (dropStart) this.start = null;
  }
}
