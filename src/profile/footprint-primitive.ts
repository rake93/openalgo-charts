/**
 * Footprint / order-flow renderer (ARCHITECTURE.md §6A, Family C).
 *
 * Each bar is a column of price rows; each row shows bid volume against ask
 * volume as two filled cells whose colour intensity tracks their share of the
 * bar's peak. Diagonal imbalances fill saturated rather than getting an outline
 * — at the sizes a footprint actually renders, a 1px box is invisible while a
 * colour step reads instantly. Runs of stacked imbalances get a bracket.
 *
 * Beneath the cells sits a stats table: one column per bar, one row per metric
 * (volume, delta, delta %, cumulative delta, trade count), each cell tinted by
 * sign and strength.
 *
 * Everything is theme-driven and reconfigurable at runtime via `setOptions` —
 * the previous version hardcoded twelve colours and could only be restyled by
 * rebuilding the chart.
 */
import type { IPrimitive, PrimitiveHost, PrimitiveRenderContext, ZOrder } from 'openalgo-charts';
import type { FootprintBar, FootprintCell } from './profile-model';
import { contrastText, parseColor, withAlpha } from '../render/pill';

/** Which metric a stats row shows. */
export type FootprintStatRow = 'volume' | 'delta' | 'deltaPct' | 'cvd' | 'trades';

/**
 * Gutter names for the stats rows. Kept short because the gutter has to stay
 * narrow enough not to eat a column, and `Δ` is the standard shorthand for delta
 * on every order-flow platform.
 */
const STAT_LABEL: Record<FootprintStatRow, string> = {
  volume: 'vol',
  delta: 'Δ',
  deltaPct: 'Δ%',
  cvd: 'cvd',
  trades: 'trd',
};

export type FootprintDisplayMode = 'bidask' | 'delta' | 'volume';

export interface FootprintOptions {
  /**
   * Full column width (both halves) in media px. Omit to derive it from the
   * chart's bar spacing, so cells stop colliding when you zoom out.
   */
  cellWidth?: number;
  /** Fraction of the bar slot a column may occupy when auto-sizing. Default 0.9. */
  widthFactor: number;
  /** Price step → row height. Inferred from the cell spacing when omitted. */
  tickSize?: number;
  /**
   * Smallest cell text size in media px. Default 10. The size actually drawn is
   * fitted to each cell and clamped between this and {@link maxFont}.
   */
  font: number;
  /**
   * Largest cell text size in media px. Default 18.
   *
   * Numbers scale with the cell rather than staying at one size, so zooming in
   * makes a footprint more readable instead of only making the boxes bigger. Raise
   * this if you read a footprint zoomed in; lower it to `font` to pin one size.
   */
  maxFont: number;
  /** Below this row height, numbers are dropped and cells render as a heatmap. */
  minTextHeight: number;
  /** Height (px) over which the cell numbers fade in around `minTextHeight`. */
  textFade: number;
  /** `bidask` two columns; `delta` or `volume` a single column. */
  displayMode: FootprintDisplayMode;
  /** Diagonal-imbalance ratio. */
  imbalanceRatio: number;
  /** Ignore cells below this volume when flagging imbalances. */
  imbalanceThreshold: number;
  /** Bracket runs of ≥ N consecutive same-side imbalances. 0 disables. */
  stackedImbalances: number;
  /** Stats rows under the columns, in order. Empty hides the table. */
  statsRows: readonly FootprintStatRow[];
  /**
   * Name each stats row in a gutter at the left of the table. Without it the rows
   * are four unlabelled bands of numbers and the only way to tell delta from CVD
   * is to remember the configured order.
   */
  statsLabels: boolean;
  /** Row height of the stats table in media px. */
  statsRowHeight: number;
  /** Draw the bar's range line + body behind the cells. */
  showCandle: boolean;
  /** Mark the highest-volume row of each bar. */
  showPoc: boolean;
  /** Colours. All default to the chart theme. */
  buyColor?: string;
  sellColor?: string;
  pocColor: string;
  /** Cell corner radius in media px. */
  radius: number;
}

export const DEFAULT_FOOTPRINT_OPTIONS: FootprintOptions = {
  widthFactor: 0.9,
  font: 10,
  maxFont: 18,
  minTextHeight: 11,
  textFade: 4,
  displayMode: 'bidask',
  imbalanceRatio: 3,
  imbalanceThreshold: 0,
  stackedImbalances: 3,
  statsRows: ['volume', 'delta', 'deltaPct', 'cvd'],
  statsLabels: true,
  statsRowHeight: 15,
  showCandle: true,
  showPoc: true,
  pocColor: '#f0a020',
  radius: 2,
};

/** Per-bar aggregates the stats table and the tooltip both read. */
export interface FootprintBarStats {
  time: number;
  volume: number;
  delta: number;
  deltaPct: number;
  cvd: number;
  trades: number;
  poc: number;
}

/** What the pointer is over, for a host-drawn tooltip. */
export interface FootprintHover {
  time: number;
  /** Null when the pointer is over the stats table rather than a cell. */
  price: number | null;
  cell: FootprintCell | null;
  stats: FootprintBarStats;
}

/** 3 significant figures with a K/M/B suffix — 4.53M, 47.1K, 128K, 3K. */
export function compactVol(v: number): string {
  const a = Math.abs(v);
  const [suffix, div] = a >= 1e9 ? ['B', 1e9] : a >= 1e6 ? ['M', 1e6] : a >= 1e3 ? ['K', 1e3] : ['', 1];
  const n = v / div;
  const abs = Math.abs(n);
  const s = abs >= 100 || div === 1 ? n.toFixed(0) : abs >= 10 ? n.toFixed(1) : n.toFixed(2);
  return s.replace(/\.0+$/, '').replace(/(\.\d*?)0+$/, '$1') + suffix;
}

const signed = (v: number): string => (v >= 0 ? '+' : '') + compactVol(v);

/** Blend two colours; `t` 0 → a, 1 → b. */
function mix(a: string, b: string, t: number): string {
  const ca = parseColor(a);
  const cb = parseColor(b);
  if (ca === null || cb === null) return b;
  const k = t < 0 ? 0 : t > 1 ? 1 : t;
  return `rgb(${Math.round(ca.r + (cb.r - ca.r) * k)},${Math.round(ca.g + (cb.g - ca.g) * k)},${Math.round(ca.b + (cb.b - ca.b) * k)})`;
}

interface Column {
  bar: FootprintBar;
  x: number;
  stats: FootprintBarStats;
}

export class Footprint implements IPrimitive {
  private _bars: FootprintBar[] = [];
  private _opts: FootprintOptions;
  private _host: PrimitiveHost | null = null;
  /** Per-bar aggregates, recomputed when the bars change (CVD needs order). */
  private _stats: FootprintBarStats[] = [];
  /** Column geometry from the last draw, in media px, for hit-testing. */
  private _cols: { time: number; x0: number; x1: number }[] = [];
  private _rowH = 0;
  /** Last context the primitive drew with; see `draw`. */
  private _rc: PrimitiveRenderContext | null = null;

  public constructor(opts: Partial<FootprintOptions> = {}) {
    this._opts = { ...DEFAULT_FOOTPRINT_OPTIONS, ...opts };
  }

  public attached(host: PrimitiveHost): void { this._host = host; }
  public detached(): void { this._host = null; }
  public zOrder(): ZOrder { return 'normal'; }

  /**
   * Footprint rows span the bar's traded range, so unlike the profile overlays
   * this one *does* drive autoscale — otherwise the top and bottom rows clip.
   */
  public autoscaleInfo(): { min: number; max: number } | null {
    let min = Infinity;
    let max = -Infinity;
    for (const b of this._bars) {
      if (b.cells.length === 0) continue;
      max = Math.max(max, b.cells[0].price);
      min = Math.min(min, b.cells[b.cells.length - 1].price);
    }
    return Number.isFinite(min) ? { min, max } : null;
  }

  public setBars(bars: FootprintBar[]): void {
    this._bars = bars;
    this._recomputeStats();
    this._host?.requestUpdate();
  }

  public setOptions(patch: Partial<FootprintOptions>): void {
    this._opts = { ...this._opts, ...patch };
    this._host?.requestUpdate();
  }

  public options(): FootprintOptions {
    return this._opts;
  }

  /** Per-bar aggregates, in bar order. */
  public stats(): readonly FootprintBarStats[] {
    return this._stats;
  }

  private _recomputeStats(): void {
    let cvd = 0;
    this._stats = this._bars.map((bar) => {
      let volume = 0;
      let trades = 0;
      let pocVol = -1;
      let poc = bar.cells.length > 0 ? bar.cells[0].price : 0;
      for (const c of bar.cells) {
        const total = c.bidVol + c.askVol;
        volume += total;
        trades += 1;
        if (total > pocVol) { pocVol = total; poc = c.price; }
      }
      cvd += bar.delta;
      return {
        time: bar.time,
        volume,
        delta: bar.delta,
        deltaPct: volume > 0 ? (bar.delta / volume) * 100 : 0,
        cvd,
        trades,
        poc,
      };
    });
  }

  /** Row height in device px from the tick size (option, else the min cell gap). */
  private _rowHeight(cells: readonly FootprintCell[], rc: PrimitiveRenderContext): number {
    let tick = this._opts.tickSize ?? 0;
    if (tick <= 0) {
      let min = Infinity;
      for (let i = 1; i < cells.length; i++) {
        const g = Math.abs(cells[i - 1].price - cells[i].price);
        if (g > 0) min = Math.min(min, g);
      }
      tick = Number.isFinite(min) ? min : 0;
    }
    const p0 = cells[0].price;
    const rh = tick > 0
      ? Math.abs(rc.priceScale.priceToY(p0) - rc.priceScale.priceToY(p0 + tick)) * rc.dpr
      : 0;
    return Math.max(rh > 1 ? rh : 16 * rc.dpr, 6 * rc.dpr);
  }

  /**
   * Column width in device px — explicit, else the share of the bar slot that
   * {@link FootprintOptions.widthFactor} allows.
   *
   * Never wider than the slot the bar owns. A floor above the slot width (this
   * used to guarantee 24px) makes every column overlap its neighbours below about
   * 27px of bar spacing, which is ordinary zoom: cells collide and two stats
   * values print on top of each other. When the slot is genuinely too narrow for
   * numbers the text is dropped instead and the column reads as a heatmap, which
   * is legible where overlapping digits are not.
   */
  private _columnWidth(rc: PrimitiveRenderContext): number {
    const o = this._opts;
    if (o.cellWidth !== undefined && o.cellWidth > 0) return o.cellWidth * rc.dpr;
    const slot = rc.timeScale.barSpacing * rc.dpr;
    return Math.max(rc.dpr, Math.min(slot, slot * o.widthFactor));
  }

  public draw(ctx: CanvasRenderingContext2D, rc: PrimitiveRenderContext): void {
    // Kept so `hoverAt` can map a pointer back to a cell without the host having
    // to fabricate a render context out of internals it should not need.
    this._rc = rc;
    if (this._bars.length === 0) return;
    const o = this._opts;
    const dpr = rc.dpr;
    const buy = o.buyColor ?? rc.theme.upColor;
    const sell = o.sellColor ?? rc.theme.downColor;
    const bg = rc.theme.background;
    const range = rc.timeScale.visibleRange();
    const width = this._columnWidth(rc);
    const plotH = rc.plotHeight * dpr;
    const statsH = o.statsRows.length * o.statsRowHeight * dpr;
    this._cols = [];

    const cols: Column[] = [];
    for (let i = 0; i < this._bars.length; i++) {
      const bar = this._bars[i];
      if (bar.cells.length === 0) continue;
      const index = rc.dataLayer.timeToIndex(bar.time);
      if (index === undefined || index < range.from - 1 || index > range.to + 1) continue;
      cols.push({ bar, x: Math.round(rc.timeScale.indexToX(index) * dpr), stats: this._stats[i] });
    }
    if (cols.length === 0) return;

    ctx.save();
    ctx.textBaseline = 'middle';
    // The cells stop above the stats table so the two never overlap.
    const cellBottom = plotH - statsH;
    for (const col of cols) this._drawColumn(ctx, rc, col, width, buy, sell, bg, cellBottom);
    if (o.statsRows.length > 0) this._drawStats(ctx, rc, cols, width, buy, sell, bg, plotH, statsH);
    ctx.restore();
  }

  private _drawColumn(
    ctx: CanvasRenderingContext2D, rc: PrimitiveRenderContext, col: Column,
    width: number, buy: string, sell: string, bg: string, cellBottom: number,
  ): void {
    const o = this._opts;
    const dpr = rc.dpr;
    const { bar, stats } = col;
    const cells = bar.cells;
    const rowH = this._rowHeight(cells, rc);
    this._rowH = rowH / dpr;
    const half = width / 2;
    const x0 = col.x - half;
    this._cols.push({ time: bar.time, x0: x0 / dpr, x1: (x0 + width) / dpr });

    let peak = 1;
    for (const c of cells) peak = Math.max(peak, c.bidVol, c.askVol);

    // Candle *behind* the cells: wick down the column's centre line, body across
    // its full width, both translucent and both drawn before the cells so the
    // numbers stay on top. The bar is still a bar.
    //
    // Direction comes from open/close when the host supplied them, and falls back
    // to the sign of delta when it did not — a footprint bar on its own knows its
    // traded range but not where it opened or closed.
    if (o.showCandle) {
      const yHi = rc.priceScale.priceToY(cells[0].price) * dpr - rowH / 2;
      const yLo = rc.priceScale.priceToY(cells[cells.length - 1].price) * dpr + rowH / 2;
      const hasBody = bar.open !== undefined && bar.close !== undefined;
      const up = hasBody ? (bar.close as number) >= (bar.open as number) : stats.delta >= 0;
      const tone = up ? buy : sell;

      const wickW = Math.max(1, Math.round(dpr));
      ctx.fillStyle = withAlpha(tone, 0.45);
      ctx.fillRect(Math.round(col.x - wickW / 2), yHi, wickW, yLo - yHi);

      if (hasBody) {
        const yO = rc.priceScale.priceToY(bar.open as number) * dpr;
        const yC = rc.priceScale.priceToY(bar.close as number) * dpr;
        // Faint enough to read cells through, firm enough to see the bar's shape.
        ctx.fillStyle = withAlpha(tone, 0.16);
        ctx.fillRect(x0, Math.min(yO, yC), width, Math.max(1, Math.abs(yC - yO)));
      }
    }

    const imbalanced = this._imbalances(cells);
    // 0 below the threshold, 1 a few px above it, linear between.
    const fade = Math.max(0, Math.min(1,
      (rowH / dpr - o.minTextHeight) / Math.max(1, o.textFade) + 1));
    const fitted = this._cellFont(cells, width, rowH, dpr);
    // A null fit means the cell cannot hold a legible number, so the alpha the
    // cells are drawn with goes to zero — `_cell` gates its text on that alone.
    const textAlpha = fitted === null ? 0 : fade;
    if (textAlpha > 0) {
      ctx.font = `${fitted}px ui-monospace, SFMono-Regular, Menlo, monospace`;
      ctx.textAlign = 'center';
    }

    for (let i = 0; i < cells.length; i++) {
      const c = cells[i];
      const y = rc.priceScale.priceToY(c.price) * dpr;
      const top = Math.round(y - rowH / 2);
      const h = Math.max(1, Math.round(rowH) - 1);
      if (top + h < 0 || top > cellBottom) continue; // cull off-pane rows

      const flag = imbalanced.get(c.price);
      if (o.displayMode === 'bidask') {
        this._cell(ctx, x0, top, half - dpr, h, c.bidVol, peak, sell, bg, flag === 'sell', textAlpha, dpr);
        this._cell(ctx, col.x + dpr, top, half - dpr, h, c.askVol, peak, buy, bg, flag === 'buy', textAlpha, dpr);
      } else {
        const v = o.displayMode === 'delta' ? c.askVol - c.bidVol : c.bidVol + c.askVol;
        const color = o.displayMode === 'delta' ? (v >= 0 ? buy : sell) : mix(sell, buy, 0.5);
        this._cell(ctx, x0, top, width - dpr, h, Math.abs(v), peak, color, bg, false, textAlpha, dpr, v);
      }

      if (o.showPoc && c.price === stats.poc) {
        // Inside the column, not a tab hanging off its left edge: with columns now
        // sized to the bar slot, anything outside reaches into the next bar.
        ctx.fillStyle = o.pocColor;
        ctx.fillRect(x0, top, 2 * dpr, h);
      }
    }

    // Stacked-imbalance brackets: the run is the signal, not the single cell.
    if (o.stackedImbalances > 0) {
      for (const run of this._runs(cells, imbalanced, o.stackedImbalances)) {
        const yTop = rc.priceScale.priceToY(run.from) * dpr - rowH / 2;
        const yBot = rc.priceScale.priceToY(run.to) * dpr + rowH / 2;
        const bx = run.side === 'buy' ? col.x + half + 2 * dpr : x0 - 8 * dpr;
        ctx.strokeStyle = run.side === 'buy' ? buy : sell;
        ctx.lineWidth = Math.max(1, Math.round(1.5 * dpr));
        ctx.beginPath();
        ctx.moveTo(bx, yTop); ctx.lineTo(bx, yBot);
        ctx.moveTo(bx, yTop); ctx.lineTo(bx + (run.side === 'buy' ? 3 : -3) * dpr, yTop);
        ctx.moveTo(bx, yBot); ctx.lineTo(bx + (run.side === 'buy' ? 3 : -3) * dpr, yBot);
        ctx.stroke();
      }
    }
  }

  /**
   * Text size for one column's numbers, fitted to the box a cell actually has.
   *
   * A single fixed size made legibility purely a function of zoom: the cells grew
   * but the numbers did not, so reading a footprint meant zooming until 10px text
   * was a large enough share of the screen. Fitting to the cell means zooming in
   * makes the numbers bigger, which is what a reader expects.
   *
   * Bounded by both axes — the widest label in the column has to fit across the
   * cell (monospace advance is about 0.6em, so `n` glyphs need `n * 0.6 * size`)
   * and to leave headroom inside the row. Capped at `maxFont` so it never grows
   * into a cartoon on a heavily zoomed chart.
   *
   * Returns `null` when the cell cannot hold even `font`, the smallest size worth
   * reading. Text is then dropped rather than scaled below legibility or, worse,
   * drawn at a size that spills into the neighbouring column.
   */
  private _cellFont(
    cells: readonly FootprintCell[], width: number, rowH: number, dpr: number,
  ): number | null {
    const o = this._opts;
    // `bidask` splits the column in two; the other modes use the whole width.
    const box = (o.displayMode === 'bidask' ? width / 2 : width) - 2 * dpr;
    if (box <= 0) return null;
    let chars = 1;
    for (const c of cells) {
      if (o.displayMode === 'bidask') {
        chars = Math.max(chars, compactVol(c.bidVol).length, compactVol(c.askVol).length);
      } else {
        const v = o.displayMode === 'delta' ? c.askVol - c.bidVol : c.bidVol + c.askVol;
        chars = Math.max(chars, compactVol(v).length);
      }
    }
    const fit = Math.min(box / (0.6 * chars), rowH * 0.72);
    if (fit < o.font * dpr) return null;
    return Math.min(o.maxFont * dpr, fit);
  }

  /** One filled, intensity-graded cell with its number. */
  private _cell(
    ctx: CanvasRenderingContext2D, x: number, y: number, w: number, h: number,
    value: number, peak: number, color: string, bg: string,
    hot: boolean, textAlpha: number, dpr: number, display?: number,
  ): void {
    if (w <= 0) return;
    const t = peak > 0 ? value / peak : 0;
    // Saturated when imbalanced, otherwise a background→colour ramp. The eased
    // curve keeps low-volume rows visible instead of crushing them to black.
    const fill = hot ? color : mix(bg, color, 0.08 + 0.62 * Math.sqrt(t));
    ctx.fillStyle = fill;
    const r = Math.min(this._opts.radius * dpr, h / 2, w / 2);
    ctx.beginPath();
    ctx.roundRect(x, y, w, h, r);
    ctx.fill();
    if (textAlpha <= 0) return;
    // Contrast against the *surface*, not the individual fill. Every cell fill is
    // a mix of the background toward the accent, so one choice made from the
    // background is legible across the whole ramp (>= 3:1 in both themes),
    // whereas judging each fill separately lands mid-ramp fills at ~2:1. The
    // numerals used to be hardcoded white, which vanished on a light theme.
    // Fade rather than switch: zooming through the threshold reads as one
    // continuous change instead of numbers blinking on and off.
    ctx.fillStyle = withAlpha(contrastText(bg), (hot ? 1 : 0.9) * textAlpha);
    ctx.fillText(compactVol(display ?? value), x + w / 2, y + h / 2);
  }

  /** Price → imbalance side, using the diagonal (ask vs the bid one tick below). */
  private _imbalances(cells: readonly FootprintCell[]): Map<number, 'buy' | 'sell'> {
    const o = this._opts;
    const out = new Map<number, 'buy' | 'sell'>();
    for (let i = 0; i < cells.length; i++) {
      const here = cells[i];
      const below = cells[i + 1];
      const above = cells[i - 1];
      if (below && here.askVol >= o.imbalanceThreshold
        && here.askVol >= o.imbalanceRatio * Math.max(1, below.bidVol)) out.set(here.price, 'buy');
      if (above && here.bidVol >= o.imbalanceThreshold
        && here.bidVol >= o.imbalanceRatio * Math.max(1, above.askVol)) out.set(here.price, 'sell');
    }
    return out;
  }

  /** Consecutive same-side imbalance runs of at least `min` rows. */
  private _runs(
    cells: readonly FootprintCell[], flags: Map<number, 'buy' | 'sell'>, min: number,
  ): { from: number; to: number; side: 'buy' | 'sell' }[] {
    const out: { from: number; to: number; side: 'buy' | 'sell' }[] = [];
    let run: { side: 'buy' | 'sell'; prices: number[] } | null = null;
    const flush = (): void => {
      if (run && run.prices.length >= min) {
        out.push({ from: run.prices[0], to: run.prices[run.prices.length - 1], side: run.side });
      }
    };
    for (const c of cells) {
      const side = flags.get(c.price);
      if (side !== undefined && (run === null || run.side === side)) {
        run = run ?? { side, prices: [] };
        run.prices.push(c.price);
      } else {
        flush();
        run = side !== undefined ? { side, prices: [c.price] } : null;
      }
    }
    flush();
    return out;
  }

  /** The stats table: one column per bar, one row per metric. */
  private _drawStats(
    ctx: CanvasRenderingContext2D, rc: PrimitiveRenderContext, cols: readonly Column[],
    width: number, buy: string, sell: string, bg: string, plotH: number, statsH: number,
  ): void {
    const o = this._opts;
    const dpr = rc.dpr;
    const rowH = o.statsRowHeight * dpr;
    const top = plotH - statsH;

    // Per-metric extremes, so a cell can be tinted by strength relative to what
    // is actually on screen rather than an arbitrary constant.
    const peak = new Map<FootprintStatRow, number>();
    for (const row of o.statsRows) {
      let m = 0;
      for (const c of cols) m = Math.max(m, Math.abs(this._metric(c.stats, row)));
      peak.set(row, m || 1);
    }

    // The widest label decides whether any of them fit: a stats value drawn wider
    // than its column lands over the neighbouring column's value, which is how
    // "-10" and "+8.3%" ended up printed on top of each other.
    let chars = 1;
    for (const row of o.statsRows) {
      for (const c of cols) chars = Math.max(chars, this._statText(this._metric(c.stats, row), row).length);
    }
    const fit = Math.min((width - 2 * dpr) / (0.6 * chars), (rowH - 2 * dpr) * 0.8);
    const showText = fit >= (o.font - 2) * dpr;

    ctx.save();
    ctx.fillStyle = withAlpha(bg, 0.92);
    ctx.fillRect(0, top, rc.plotWidth * dpr, statsH);
    ctx.font = `${Math.min((o.font - 0.5) * dpr, fit)}px ui-monospace, SFMono-Regular, Menlo, monospace`;
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';

    o.statsRows.forEach((row, r) => {
      const y = top + r * rowH;
      for (const col of cols) {
        const v = this._metric(col.stats, row);
        const strength = Math.abs(v) / (peak.get(row) as number);
        const x = col.x - width / 2;
        const w = width - dpr;
        // Volume has no sign, so it reads neutral; the rest tint by direction.
        const tint = row === 'volume' || row === 'trades'
          ? mix(bg, rc.theme.axisText, 0.10 + 0.16 * strength)
          : row === 'cvd'
            ? mix(bg, '#4f8cff', 0.10 + 0.5 * strength)
            : mix(bg, v >= 0 ? buy : sell, 0.10 + 0.55 * strength);
        ctx.fillStyle = tint;
        ctx.beginPath();
        ctx.roundRect(x, y + dpr, w, rowH - 2 * dpr, 2 * dpr);
        ctx.fill();
        if (!showText) continue; // tint alone still reads as a heatmap
        // Same reasoning as the cells: these tints are mixes off the background.
        ctx.fillStyle = withAlpha(contrastText(bg), 0.92);
        ctx.fillText(this._statText(v, row), col.x, y + rowH / 2);
      }
    });

    // Row names last, so they sit above any column value that reaches the gutter,
    // on their own opaque backing.
    if (o.statsLabels) {
      const labelFont = Math.min((o.font - 1) * dpr, rowH * 0.6);
      ctx.font = `${labelFont}px ui-monospace, SFMono-Regular, Menlo, monospace`;
      ctx.textAlign = 'left';
      o.statsRows.forEach((row, r) => {
        const y = top + r * rowH;
        const text = STAT_LABEL[row];
        ctx.fillStyle = withAlpha(bg, 0.95);
        ctx.fillRect(0, y + dpr, (text.length * 0.6 * labelFont) + 4 * dpr, rowH - 2 * dpr);
        ctx.fillStyle = withAlpha(contrastText(bg), 0.7);
        ctx.fillText(text, 2 * dpr, y + rowH / 2);
      });
      ctx.textAlign = 'center';
    }
    ctx.restore();
  }

  private _metric(s: FootprintBarStats, row: FootprintStatRow): number {
    switch (row) {
      case 'volume': return s.volume;
      case 'delta': return s.delta;
      case 'deltaPct': return s.deltaPct;
      case 'cvd': return s.cvd;
      default: return s.trades;
    }
  }

  private _statText(v: number, row: FootprintStatRow): string {
    if (row === 'deltaPct') return `${v >= 0 ? '+' : ''}${v.toFixed(1)}%`;
    if (row === 'volume' || row === 'trades') return compactVol(v);
    return signed(v);
  }

  // Deliberately no `hitTest`, for the same reason as the market profile: it
  // claimed `distance: 0` for the full height of every column, and `bestHit`
  // sorts by distance first, so it shut out every drawing and order line drawn
  // over the footprint. Nothing consumed the `footprint:<time>` id; the tooltip
  // payload comes from `hoverAt()` on the crosshair and is unaffected.

  /**
   * Full hover payload for `(x, y)` in media px, for a host-drawn tooltip.
   * `rc` defaults to the context of the last paint, so a crosshair handler can
   * just call `hoverAt(p.x, p.y)`.
   */
  public hoverAt(x: number, y: number, rc?: PrimitiveRenderContext): FootprintHover | null {
    const ctx = rc ?? this._rc;
    if (ctx === null) return null;
    const col = this._cols.find((c) => x >= c.x0 && x <= c.x1);
    if (col === undefined) return null;
    const i = this._bars.findIndex((b) => b.time === col.time);
    if (i < 0) return null;
    const bar = this._bars[i];
    const price = ctx.priceScale.yToPrice(y);
    let cell: FootprintCell | null = null;
    let best = Infinity;
    for (const c of bar.cells) {
      const d = Math.abs(ctx.priceScale.priceToY(c.price) - y);
      if (d < best && d <= Math.max(4, this._rowH)) { best = d; cell = c; }
    }
    return { time: bar.time, price: cell === null ? null : price, cell, stats: this._stats[i] };
  }
}
