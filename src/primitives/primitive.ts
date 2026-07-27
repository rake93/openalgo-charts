/**
 * Primitive / plugin API (ARCHITECTURE.md §8). The extension point that keeps
 * the core small and powers markers, events, indicators, and the trade layer.
 * A primitive draws on a pane, optionally contributes to autoscale, and
 * optionally hit-tests for hover/drag.
 */
import type { TimeScale } from '../scale/time-scale';
import type { PriceScale } from '../scale/price-scale';
import type { DataLayer } from '../model/data-layer';
import type { Bar } from '../model/bar';
import type { ChartTheme } from '../theme';

export type ZOrder = 'bottom' | 'normal' | 'top';

export interface PrimitiveRenderContext {
  timeScale: TimeScale;
  priceScale: PriceScale;
  dataLayer: DataLayer;
  plotWidth: number;
  plotHeight: number;
  priceAxisWidth: number;
  dpr: number;
  theme: ChartTheme;
  /**
   * The pane's primary price series, for a primitive that needs what price
   * actually did rather than just the scales — a forecast scoring itself, say.
   * Lazy, so nothing pays for it unless asked. Absent on synthetic contexts.
   */
  bars?: () => readonly Bar[];
  /** externalId of the primitive hit under the pointer (hover state), if any. */
  hoverId?: string | null;
  /** externalId of the line being dragged (active state), if any. */
  dragId?: string | null;
}

export interface PrimitiveHit {
  externalId: string;
  zOrder: ZOrder;
  /** Pixel distance from the cursor (smaller wins ties before z-order). */
  distance: number;
  cursor?: string;
  /**
   * Arm a drag on press. Price lines set `cursor: 'ns-resize'` and move on one
   * axis; anything that moves on **both** (a drawing anchor, a whole shape)
   * declares it here, and the drag callbacks receive time as well as price.
   */
  draggable?: boolean;
  /**
   * Tie-break weight when two hits are exactly as close. Default 0.
   *
   * Several primitives claim a whole rectangle at distance 0 — a pane legend's
   * row, a floating control panel — and without this the winner is simply
   * whichever was registered first. An interactive control floating over the plot
   * declares a higher priority so a passive backdrop beneath it cannot swallow
   * the hover and the press. Breaks *ties only*: a genuinely nearer hit still
   * wins whatever its priority.
   */
  priority?: number;
}

/** Injected when a primitive is attached; lets it request a repaint. */
export interface PrimitiveHost {
  requestUpdate(): void;
}

export interface IPrimitive {
  /** Layer order vs series: 'bottom' (behind), 'normal' (over), 'top' (overlay). */
  zOrder(): ZOrder;
  draw(ctx: CanvasRenderingContext2D, rc: PrimitiveRenderContext): void;
  /** Optional: expand the pane's autoscale range so this primitive isn't clipped. */
  autoscaleInfo?(): { min: number; max: number } | null;
  /** Optional: topmost hit under (x,y) in media px (relative to the pane plot). */
  hitTest?(x: number, y: number, rc: PrimitiveRenderContext): PrimitiveHit | null;
  attached?(host: PrimitiveHost): void;
  detached?(): void;
}

/**
 * Pick the best hit across primitives: nearest distance, then declared priority,
 * then z-order. Registration order decides only when all three tie.
 */
export function bestHit(hits: readonly (PrimitiveHit | null)[]): PrimitiveHit | null {
  const order: Record<ZOrder, number> = { top: 2, normal: 1, bottom: 0 };
  const rank = (h: PrimitiveHit): [number, number, number] =>
    [h.distance, -(h.priority ?? 0), -order[h.zOrder]];
  let best: PrimitiveHit | null = null;
  let bestRank: [number, number, number] | null = null;
  for (const h of hits) {
    if (h === null) continue;
    const r = rank(h);
    if (bestRank === null || r[0] < bestRank[0]
      || (r[0] === bestRank[0] && r[1] < bestRank[1])
      || (r[0] === bestRank[0] && r[1] === bestRank[1] && r[2] < bestRank[2])) {
      best = h;
      bestRank = r;
    }
  }
  return best;
}
