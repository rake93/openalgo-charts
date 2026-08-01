/**
 * Series markers (ARCHITECTURE.md §8.1): buy/sell signals and shapes anchored
 * to bars. Visible-range culled, per-bar stacked, four discrete sizes.
 */
import type { Bar } from '../model/bar';
import type { SeriesId } from '../model/data-layer';
import type { IPrimitive, PrimitiveHost, PrimitiveRenderContext, PrimitiveHit, ZOrder } from './primitive';
import { roundRectPath, contrastText } from '../render/pill';

/**
 * `labelUp` / `labelDown` are text plates with a tail, for named signals ("Buy",
 * "Sell") rather than bare glyphs. The tail points *at* the anchor price and the
 * body sits clear of it: `labelUp`'s tail points up so its body hangs below the
 * anchor, `labelDown` is the mirror. Both require `text`.
 */
export type MarkerShape =
  | 'arrowUp' | 'arrowDown' | 'circle' | 'square'
  | 'triangleUp' | 'triangleDown' | 'diamond' | 'flag' | 'text'
  | 'labelUp' | 'labelDown';
export type MarkerPosition = 'aboveBar' | 'belowBar' | 'inBar' | 'atPrice';
export type MarkerSize = 'tiny' | 'small' | 'medium' | 'big';

export interface SeriesMarker {
  time: number;
  position: MarkerPosition;
  price?: number;
  shape: MarkerShape;
  size: MarkerSize;
  color: string;
  text?: string;
  id?: string;
  /**
   * Shrink the glyph to the current bar spacing (default `true`). Set `false`
   * when `size` is meant literally and overlap is acceptable -- see
   * `effectiveMarkerPx`.
   */
  clampToBarSpacing?: boolean;
}

const SIZE_PX: Record<MarkerSize, number> = { tiny: 6, small: 9, medium: 12, big: 16 };

/** Base glyph size in CSS px for a marker size preset. */
export function markerSizePx(size: MarkerSize): number {
  return SIZE_PX[size];
}

/**
 * Effective glyph px. By default the glyph is clamped so it never exceeds the
 * current bar spacing, which keeps dense charts from turning into overlapping
 * mush.
 *
 * That density clamp also makes `size` inert for callers who mean it literally:
 * at 1653 bars in ~1180px the spacing is ~0.7, `floor()` is 0, and every marker
 * collapses onto the 4px floor no matter how large it was authored. Pass
 * `clamp: false` to honour the authored size instead -- what a Pine
 * `plotshape(size=...)` port needs, where sizes are absolute and glyphs are
 * expected to overlap.
 */
export function effectiveMarkerPx(size: MarkerSize, barSpacing: number, clamp = true): number {
  if (!clamp) return SIZE_PX[size];
  return Math.max(4, Math.min(SIZE_PX[size], Math.floor(barSpacing)));
}

export function drawShape(
  ctx: CanvasRenderingContext2D,
  shape: MarkerShape,
  cx: number,
  cy: number,
  px: number,
  color: string,
): void {
  const r = px / 2;
  ctx.fillStyle = color;
  ctx.strokeStyle = color;
  ctx.beginPath();
  switch (shape) {
    case 'arrowUp':
      ctx.moveTo(cx, cy - r); ctx.lineTo(cx + r, cy + r); ctx.lineTo(cx - r, cy + r); ctx.closePath(); ctx.fill();
      break;
    case 'triangleUp':
      ctx.moveTo(cx, cy - r); ctx.lineTo(cx + r, cy + r); ctx.lineTo(cx - r, cy + r); ctx.closePath(); ctx.fill();
      break;
    case 'arrowDown':
      ctx.moveTo(cx, cy + r); ctx.lineTo(cx + r, cy - r); ctx.lineTo(cx - r, cy - r); ctx.closePath(); ctx.fill();
      break;
    case 'triangleDown':
      ctx.moveTo(cx, cy + r); ctx.lineTo(cx + r, cy - r); ctx.lineTo(cx - r, cy - r); ctx.closePath(); ctx.fill();
      break;
    case 'circle':
      ctx.arc(cx, cy, r, 0, Math.PI * 2); ctx.fill();
      break;
    case 'square':
      ctx.fillRect(cx - r, cy - r, px, px);
      break;
    case 'diamond':
      ctx.moveTo(cx, cy - r); ctx.lineTo(cx + r, cy); ctx.lineTo(cx, cy + r); ctx.lineTo(cx - r, cy); ctx.closePath(); ctx.fill();
      break;
    case 'flag':
      ctx.fillRect(cx - 1, cy - r, Math.max(1, px / 8), px); // pole
      ctx.fillRect(cx, cy - r, r, r * 0.8); // flag
      break;
    case 'text':
    case 'labelUp':
    case 'labelDown':
      // text-bearing markers: nothing drawn here; the caller has the string,
      // the font, and the device ratio. See `drawLabel`.
      break;
  }
}

/**
 * A signal label: rounded plate, contrasting text, and a tail that points at
 * `anchorY`. All coordinates are bitmap px — the caller has already applied dpr.
 * `up` puts the tail on the top edge and the body below the anchor.
 */
export function drawLabel(
  ctx: CanvasRenderingContext2D,
  up: boolean,
  cx: number,
  anchorY: number,
  text: string,
  color: string,
  fontPx: number,
): void {
  ctx.font = `600 ${fontPx}px system-ui, sans-serif`;
  const padX = fontPx * 0.5;
  const w = ctx.measureText(text).width + padX * 2;
  const h = fontPx + fontPx * 0.64;
  const tail = fontPx * 0.42;
  const top = up ? anchorY + tail : anchorY - tail - h;

  ctx.fillStyle = color;
  roundRectPath(ctx, cx - w / 2, top, w, h, Math.min(fontPx * 0.3, h / 2));
  ctx.fill();
  // The tail overlaps the plate edge by a pixel so the two fills read as one
  // shape instead of showing a hairline seam at fractional dpr.
  const base = up ? top + 1 : top + h - 1;
  ctx.beginPath();
  ctx.moveTo(cx, anchorY);
  ctx.lineTo(cx - tail, base);
  ctx.lineTo(cx + tail, base);
  ctx.closePath();
  ctx.fill();

  ctx.fillStyle = contrastText(color);
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  ctx.fillText(text, cx, top + h / 2);
}

export class SeriesMarkers implements IPrimitive {
  private readonly _seriesId: SeriesId;
  private _markers: SeriesMarker[] = [];
  private _host: PrimitiveHost | null = null;
  private _lastPositions: { id: string; x: number; y: number }[] = [];

  public constructor(seriesId: SeriesId) {
    this._seriesId = seriesId;
  }

  public attached(host: PrimitiveHost): void { this._host = host; }
  public detached(): void { this._host = null; }
  public zOrder(): ZOrder { return 'normal'; }

  public setMarkers(markers: readonly SeriesMarker[]): void {
    this._markers = markers.slice().sort((a, b) => a.time - b.time);
    this._host?.requestUpdate();
  }

  public draw(ctx: CanvasRenderingContext2D, rc: PrimitiveRenderContext): void {
    this._lastPositions = [];
    if (this._markers.length === 0) return;
    const barByTime = new Map<number, Bar>();
    for (const ib of rc.dataLayer.indexedBars(this._seriesId)) barByTime.set(ib.bar.time, ib.bar);
    const range = rc.timeScale.visibleRange();
    const stackByTime = new Map<number, number>();

    ctx.save();
    for (const m of this._markers) {
      const index = rc.dataLayer.timeToIndex(m.time);
      if (index === undefined || index < range.from - 1 || index > range.to + 1) continue;
      const bar = barByTime.get(m.time);
      const px = effectiveMarkerPx(m.size, rc.timeScale.barSpacing, m.clampToBarSpacing ?? true) * rc.dpr;
      const x = rc.timeScale.indexToX(index) * rc.dpr;
      const stack = stackByTime.get(m.time) ?? 0;
      const gap = (px + 4 * rc.dpr) * stack;
      let y: number;
      if (m.position === 'atPrice' && m.price !== undefined) {
        y = rc.priceScale.priceToY(m.price) * rc.dpr;
      } else if (bar !== undefined && m.position === 'aboveBar') {
        y = rc.priceScale.priceToY(bar.high) * rc.dpr - px - gap;
      } else if (bar !== undefined && m.position === 'belowBar') {
        y = rc.priceScale.priceToY(bar.low) * rc.dpr + px + gap;
      } else if (bar !== undefined) {
        y = rc.priceScale.priceToY((bar.open + bar.close) / 2) * rc.dpr;
      } else {
        continue;
      }
      stackByTime.set(m.time, stack + 1);
      if (m.shape === 'labelUp' || m.shape === 'labelDown') {
        if (m.text !== undefined) {
          drawLabel(ctx, m.shape === 'labelUp', x, y, m.text, m.color,
            Math.max(9, markerSizePx(m.size)) * rc.dpr);
        }
        if (m.id !== undefined) this._lastPositions.push({ id: m.id, x: x / rc.dpr, y: y / rc.dpr });
        continue;
      }
      drawShape(ctx, m.shape, x, y, px, m.color);
      if (m.text !== undefined) {
        ctx.fillStyle = m.color;
        ctx.font = `${Math.max(9, markerSizePx(m.size)) * rc.dpr}px system-ui, sans-serif`;
        ctx.textAlign = 'center';
        ctx.textBaseline = m.position === 'belowBar' ? 'top' : 'bottom';
        const ty = m.position === 'belowBar' ? y + px : y - px;
        ctx.fillText(m.text, x, ty);
      }
      if (m.id !== undefined) this._lastPositions.push({ id: m.id, x: x / rc.dpr, y: y / rc.dpr });
    }
    ctx.restore();
  }

  public hitTest(x: number, y: number): PrimitiveHit | null {
    let best: PrimitiveHit | null = null;
    for (const p of this._lastPositions) {
      const d = Math.hypot(p.x - x, p.y - y);
      if (d <= 8 && (best === null || d < best.distance)) {
        best = { externalId: p.id, zOrder: 'normal', distance: d, cursor: 'pointer' };
      }
    }
    return best;
  }
}
