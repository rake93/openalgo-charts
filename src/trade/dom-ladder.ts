/**
 * Depth-of-market ladder (ARCHITECTURE.md §9.4). Docked to the right of the
 * plot, price-aligned to the price scale. Depth-agnostic: it reads the level
 * count from the payload (5 / 20 / 30 / 50 / 200) at runtime. Viewport
 * virtualization keeps a deep book at 60 fps; price-bucket aggregation compacts
 * deep books; a size heatmap highlights resting liquidity; and it degrades
 * gracefully to nothing when no depth is available.
 *
 * Pure helpers (capability / aggregation / virtualization) are split out for
 * unit testing; the primitive draws on the top (overlay) canvas so frequent
 * depth updates only repaint the cheap overlay.
 */
import type { IPrimitive, PrimitiveHost, PrimitiveRenderContext, PrimitiveHit, ZOrder } from 'openalgo-charts';
import type { MarketDepth } from '../feed/types';
import { contrastText, withAlpha, parseColor } from '../render/pill';

export type LadderTier = 'none' | 'compact' | 'deep';

/** Capability tier from the live payload — drives graceful degradation. */
export function ladderCapability(depth: MarketDepth): LadderTier {
  const n = Math.max(depth.bids.length, depth.asks.length);
  if (n === 0) return 'none';
  return n <= 5 ? 'compact' : 'deep';
}

export interface LadderRow {
  price: number;
  bidQty: number;
  askQty: number;
}

/**
 * Merge bids + asks into price rows, optionally bucketing every `groupBy` ticks
 * (price-step aggregation for deep books). Returns rows sorted high → low price.
 */
export function buildRows(depth: MarketDepth, tickSize: number, groupBy = 1): LadderRow[] {
  const step = tickSize * Math.max(1, groupBy);
  const bucket = (p: number): number => Math.round(Math.round(p / step) * step * 1e8) / 1e8;
  const map = new Map<number, LadderRow>();
  const add = (price: number, qty: number, side: 'bid' | 'ask'): void => {
    const key = bucket(price);
    let row = map.get(key);
    if (row === undefined) { row = { price: key, bidQty: 0, askQty: 0 }; map.set(key, row); }
    if (side === 'bid') row.bidQty += qty; else row.askQty += qty;
  };
  for (const b of depth.bids) add(b.price, b.qty, 'bid');
  for (const a of depth.asks) add(a.price, a.qty, 'ask');
  return Array.from(map.values()).sort((x, y) => y.price - x.price);
}

/**
 * Virtualize: keep only rows whose y is inside the plot (± one row) and cap the
 * count to `maxRows` nearest the vertical centre (around the LTP). This is what
 * keeps a 200-level book cheap and readable.
 */
export function visibleRows(
  rows: readonly LadderRow[],
  priceToY: (p: number) => number,
  plotHeight: number,
  rowHeight: number,
  maxRows: number,
): LadderRow[] {
  const onScreen = rows.filter((r) => {
    const y = priceToY(r.price);
    return y >= -rowHeight && y <= plotHeight + rowHeight;
  });
  if (onScreen.length <= maxRows) return onScreen;
  // keep the maxRows closest to the centre y
  const centre = plotHeight / 2;
  return onScreen
    .map((r) => ({ r, d: Math.abs(priceToY(r.price) - centre) }))
    .sort((a, b) => a.d - b.d)
    .slice(0, maxRows)
    .map((x) => x.r)
    .sort((a, b) => b.price - a.price);
}

export interface DomLadderOptions {
  tickSize: number;
  /** Strip width in media px. */
  width: number;
  /** Group every N ticks into one row (deep-book aggregation). */
  groupBy: number;
  /** Max rows drawn per frame (virtualization cap). */
  maxRows: number;
  rowHeight: number;
  /** Name the two sides across the top of the strip. */
  showHeader: boolean;
  /**
   * Sum each side across the foot of the strip.
   *
   * Totals cover **every level in the payload**, not only the rows currently on
   * screen: virtualization drops rows far from the last price, and a total that
   * silently changed as the chart scrolled would be worse than no total at all.
   */
  showTotals: boolean;
}

export const DEFAULT_DOM_LADDER_OPTIONS: DomLadderOptions = {
  tickSize: 0.05, width: 96, groupBy: 1, maxRows: 60, rowHeight: 14,
  showHeader: true, showTotals: true,
};

export class DomLadder implements IPrimitive {
  private _opts: DomLadderOptions;
  private _depth: MarketDepth | null = null;
  private _host: PrimitiveHost | null = null;
  private _rowHits: { price: number; y: number; side: 'bid' | 'ask' }[] = [];

  public constructor(options: Partial<DomLadderOptions> = {}) {
    this._opts = { ...DEFAULT_DOM_LADDER_OPTIONS, ...options };
  }

  public attached(host: PrimitiveHost): void { this._host = host; }
  public detached(): void { this._host = null; }
  public zOrder(): ZOrder { return 'top'; }

  public setDepth(depth: MarketDepth): void {
    this._depth = depth;
    this._host?.requestUpdate();
  }

  public tier(): LadderTier {
    return this._depth === null ? 'none' : ladderCapability(this._depth);
  }

  public draw(ctx: CanvasRenderingContext2D, rc: PrimitiveRenderContext): void {
    this._rowHits = [];
    if (this._depth === null) return; // graceful degradation: no depth → no ladder
    const rows = visibleRows(
      buildRows(this._depth, this._opts.tickSize, this._opts.groupBy),
      (p) => rc.priceScale.priceToY(p),
      rc.plotHeight,
      this._opts.rowHeight,
      this._opts.maxRows,
    );
    if (rows.length === 0) return;

    const dpr = rc.dpr;
    const stripW = this._opts.width * dpr;
    const x0 = (rc.plotWidth - this._opts.width) * dpr;
    const mid = x0 + stripW / 2;
    const rowH = this._opts.rowHeight * dpr;
    let maxQty = 1;
    for (const r of rows) maxQty = Math.max(maxQty, r.bidQty, r.askQty);

    // theme-derived palette: heat from buy/sell, legible qty text on any theme
    const bid = parseColor(rc.theme.buy) ?? { r: 38, g: 166, b: 154, a: 1 };
    const ask = parseColor(rc.theme.sell) ?? { r: 239, g: 83, b: 80, a: 1 };
    const qtyText = withAlpha(contrastText(rc.theme.background === 'transparent' ? '#808080' : rc.theme.background), 0.9);

    ctx.save();
    // subtle inner edge so the ladder strip reads as a docked panel
    ctx.strokeStyle = withAlpha(rc.theme.axisLine, 0.6);
    ctx.lineWidth = Math.max(1, Math.round(dpr));
    ctx.beginPath();
    ctx.moveTo(Math.round(x0) + 0.5, 0);
    ctx.lineTo(Math.round(x0) + 0.5, Math.round(rc.plotHeight * dpr));
    ctx.stroke();

    ctx.font = `${9 * dpr}px system-ui, sans-serif`;
    ctx.textBaseline = 'middle';
    for (const r of rows) {
      const yc = rc.priceScale.priceToY(r.price) * dpr;
      const bidHover = rc.hoverId === `ladder-bid:${r.price}`;
      const askHover = rc.hoverId === `ladder-ask:${r.price}`;
      // bid heatmap + bar (left of mid)
      if (r.bidQty > 0) {
        ctx.fillStyle = `rgba(${bid.r},${bid.g},${bid.b},${0.15 + 0.5 * (r.bidQty / maxQty) + (bidHover ? 0.15 : 0)})`;
        const w = (stripW / 2) * (r.bidQty / maxQty);
        ctx.fillRect(mid - w, yc - rowH / 2, w, rowH - 1);
        ctx.fillStyle = qtyText;
        ctx.textAlign = 'left';
        ctx.fillText(String(r.bidQty), x0 + 2 * dpr, yc);
        this._rowHits.push({ price: r.price, y: rc.priceScale.priceToY(r.price), side: 'bid' });
      }
      // ask heatmap + bar (right of mid)
      if (r.askQty > 0) {
        ctx.fillStyle = `rgba(${ask.r},${ask.g},${ask.b},${0.15 + 0.5 * (r.askQty / maxQty) + (askHover ? 0.15 : 0)})`;
        const w = (stripW / 2) * (r.askQty / maxQty);
        ctx.fillRect(mid, yc - rowH / 2, w, rowH - 1);
        ctx.fillStyle = qtyText;
        ctx.textAlign = 'right';
        ctx.fillText(String(r.askQty), x0 + stripW - 2 * dpr, yc);
        this._rowHits.push({ price: r.price, y: rc.priceScale.priceToY(r.price), side: 'ask' });
      }
      // hovered row: outline the clickable half (place-order affordance)
      if (bidHover || askHover) {
        ctx.strokeStyle = bidHover ? withAlpha(rc.theme.buy, 0.9) : withAlpha(rc.theme.sell, 0.9);
        ctx.lineWidth = Math.max(1, Math.round(dpr));
        ctx.strokeRect(bidHover ? x0 + 0.5 : mid + 0.5, yc - rowH / 2 + 0.5, stripW / 2 - 1, rowH - 2);
      }
    }

    // Header and totals last, on opaque backings, so a row that reaches the top or
    // bottom edge cannot be mistaken for either of them.
    const surface = rc.theme.background === 'transparent' ? '#808080' : rc.theme.background;
    const band = (y: number): void => {
      ctx.fillStyle = withAlpha(surface, 0.93);
      ctx.fillRect(x0, y, stripW, rowH);
      ctx.strokeStyle = withAlpha(rc.theme.axisLine, 0.5);
      ctx.lineWidth = Math.max(1, Math.round(dpr));
      ctx.beginPath();
      ctx.moveTo(x0, Math.round(y) + 0.5);
      ctx.lineTo(x0 + stripW, Math.round(y) + 0.5);
      ctx.stroke();
    };

    if (this._opts.showHeader) {
      band(0);
      ctx.fillStyle = withAlpha(contrastText(surface), 0.6);
      ctx.textAlign = 'left';
      ctx.fillText('BID', x0 + 2 * dpr, rowH / 2);
      ctx.textAlign = 'right';
      ctx.fillText('ASK', x0 + stripW - 2 * dpr, rowH / 2);
    }

    if (this._opts.showTotals) {
      let bidTotal = 0;
      let askTotal = 0;
      for (const l of this._depth.bids) bidTotal += l.qty;
      for (const l of this._depth.asks) askTotal += l.qty;
      const y = rc.plotHeight * dpr - rowH;
      band(y);
      // The heavier side is emphasised; the lighter one stays muted, so which way
      // the book leans reads without doing the arithmetic.
      const lean = bidTotal === askTotal ? 0 : bidTotal > askTotal ? 1 : -1;
      ctx.textAlign = 'left';
      ctx.fillStyle = lean > 0 ? withAlpha(rc.theme.buy, 0.95) : withAlpha(contrastText(surface), 0.55);
      ctx.fillText(String(bidTotal), x0 + 2 * dpr, y + rowH / 2);
      ctx.textAlign = 'right';
      ctx.fillStyle = lean < 0 ? withAlpha(rc.theme.sell, 0.95) : withAlpha(contrastText(surface), 0.55);
      ctx.fillText(String(askTotal), x0 + stripW - 2 * dpr, y + rowH / 2);
    }
    ctx.restore();
  }

  public hitTest(x: number, y: number, rc: PrimitiveRenderContext): PrimitiveHit | null {
    if (this._depth === null) return null;
    const x0 = rc.plotWidth - this._opts.width;
    if (x < x0 || x > rc.plotWidth) return null;
    let best: { price: number; side: 'bid' | 'ask'; d: number } | null = null;
    for (const h of this._rowHits) {
      const d = Math.abs(h.y - y);
      if (d <= this._opts.rowHeight / 2 && (best === null || d < best.d)) best = { price: h.price, side: h.side, d };
    }
    if (best === null) return null;
    return { externalId: `ladder-${best.side}:${best.price}`, zOrder: 'top', distance: best.d, cursor: 'pointer' };
  }
}
