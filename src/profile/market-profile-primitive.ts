/**
 * Market Profile / TPO renderer (ARCHITECTURE.md §8, §6A). Draws the output of
 * `computeMarketProfile` on-chart: per-session TPO letter columns, the Point of
 * Control / Value Area lines, Initial Balance, single prints and tails, poor
 * highs / lows, the developing POC-VA track, naked prior levels, day / open type
 * labels and an optional volume sub-profile.
 *
 * A pane primitive — it overlays the price range rather than driving it (though
 * `autoscaleInfo` reports its extent so a profile-only chart still frames).
 *
 * **Letters degrade to bricks automatically.** A TPO row is only as tall as the
 * price scale makes it, so at some zoom level a letter stops fitting. Rather
 * than clip glyphs or make the user toggle a setting, the renderer crossfades:
 * the block is always drawn and the letter fades in over `letterFade` px above
 * `minLetterHeight`, so zooming through the threshold reads as one continuous
 * change instead of a jump.
 */
import type { IPrimitive, PrimitiveHost, PrimitiveRenderContext, ZOrder } from 'openalgo-charts';
import type { MarketProfileResult, MarketProfileSessionResult, MarketProfileLevel } from './market-profile';
import { nakedLevels } from './market-profile';

/**
 * `auto` crossfades letters into bricks as rows get short (the default, and the
 * only mode that stays readable at every zoom). The rest pin the choice.
 */
export type MpBlockDisplay = 'auto' | 'blocks+letters' | 'letters' | 'blocks';

/**
 * What drives a block's colour.
 * `period` — one hue per TPO period, so the session's shape over time is visible.
 * `valueArea` — inside vs outside the value area.
 * `count` / `volume` — heat by TPO count or traded volume at that row.
 * `uniform` — a single colour.
 */
export type MpColorMode = 'period' | 'valueArea' | 'count' | 'volume' | 'uniform';

/** Default period palette — 12 hues that stay distinct on a dark background. */
export const TPO_PERIOD_COLORS: readonly string[] = [
  '#e05555', '#e08a3c', '#d9c341', '#8cc44a', '#3fb96b', '#38b2a3',
  '#3b9fd1', '#5a7fe0', '#8a68d9', '#c05fc4', '#d1508f', '#9b7b5a',
];

export interface MarketProfilePrimitiveOptions {
  /** How blocks render. `auto` crossfades letters to bricks — see the note above. */
  blockDisplay: MpBlockDisplay;
  /** Row height (px) below which a letter no longer fits and bricks take over. */
  minLetterHeight: number;
  /** Height (px) over which the letter fades in above `minLetterHeight`. */
  letterFade: number;
  /** Width of one TPO column in media px. */
  letterWidth: number;
  /** Letter font size in media px. Auto-shrinks to fit short rows. */
  font: number;
  colorMode: MpColorMode;
  /** Period palette for `colorMode: 'period'`. */
  periodColors: readonly string[];
  color: string;
  vaColor: string;
  opacity: number;
  /** Dim blocks outside the value area to this alpha (1 = no dimming). */
  outsideVaOpacity: number;
  zOrder: ZOrder;
  /** Draw each period in its own column slot instead of packing rows left. */
  split: boolean;
  /** Gap in px between session profiles. */
  profileSpacing: number;
  showPoc: boolean;
  pocColor: string;
  pocThickness: number;
  showPocLabel: boolean;
  showValueArea: boolean;
  vahColor: string;
  valColor: string;
  showValueAreaLabels: boolean;
  fillValueArea: boolean;
  valueAreaFillColor: string;
  valueAreaFillOpacity: number;
  showInitialBalance: boolean;
  ibColor: string;
  showSinglePrints: boolean;
  singlePrintColor: string;
  /** Buying / selling tails, when the model promoted them (`tailEdges`). */
  showTails: boolean;
  buyTailColor: string;
  sellTailColor: string;
  /** Mark a session high / low that printed more than one TPO. */
  showPoorHighLow: boolean;
  poorColor: string;
  /** Extend untraded prior POC / VAH / VAL to the right edge. */
  showNakedLevels: boolean;
  nakedColor: string;
  /** Trace the POC / value area as they developed through the session. */
  showDevelopingPoc: boolean;
  developingPocColor: string;
  showDevelopingVa: boolean;
  developingVaColor: string;
  /** Per-level TPO count column, drawn just past the blocks. */
  showTpoCounts: boolean;
  countColor: string;
  /** Session label / day type / open type text above each profile. */
  showSessionLabel: boolean;
  showDayType: boolean;
  showOpenType: boolean;
  labelColor: string;
  showVolumeProfile: boolean;
  volumeProfileWidth: number;
  volumeProfileSide: 'left' | 'right';
  volumeColor: string;
  /** Print the volume number on each row (skipped when rows are tight). */
  showVolumeValues: boolean;
}

export const DEFAULT_MARKET_PROFILE_PRIMITIVE_OPTIONS: MarketProfilePrimitiveOptions = {
  blockDisplay: 'auto',
  minLetterHeight: 7,
  letterFade: 4,
  letterWidth: 8,
  font: 10,
  colorMode: 'period',
  periodColors: TPO_PERIOD_COLORS,
  color: '#5a6b8c',
  vaColor: '#4a8f7a',
  opacity: 0.92,
  outsideVaOpacity: 0.45,
  zOrder: 'top',
  split: false,
  profileSpacing: 4,
  showPoc: true,
  pocColor: '#f0a020',
  pocThickness: 2,
  showPocLabel: true,
  showValueArea: true,
  vahColor: '#8892a6',
  valColor: '#8892a6',
  showValueAreaLabels: true,
  fillValueArea: true,
  valueAreaFillColor: '#4a8f7a',
  valueAreaFillOpacity: 0.07,
  showInitialBalance: true,
  ibColor: '#c8853a',
  showSinglePrints: true,
  singlePrintColor: '#e0556b',
  showTails: true,
  buyTailColor: '#3fb96b',
  sellTailColor: '#e05555',
  showPoorHighLow: false,
  poorColor: '#ffd966',
  showNakedLevels: false,
  nakedColor: '#b0b0b0',
  showDevelopingPoc: false,
  developingPocColor: '#ffffff',
  showDevelopingVa: false,
  developingVaColor: '#888888',
  showTpoCounts: false,
  countColor: '#8892a6',
  showSessionLabel: true,
  showDayType: false,
  showOpenType: false,
  labelColor: '#cccccc',
  showVolumeProfile: false,
  volumeProfileWidth: 60,
  volumeProfileSide: 'right',
  volumeColor: '#3b5168',
  showVolumeValues: false,
};

const DAY_TYPE_TEXT: Record<string, string> = {
  'normal': 'Normal',
  'normal-variation': 'Normal Var',
  'trend': 'Trend',
  'double-distribution': 'Double Dist',
  'neutral': 'Neutral',
};
const OPEN_TYPE_TEXT: Record<string, string> = {
  'drive': 'Open-Drive',
  'test-drive': 'Open-Test-Drive',
  'rejection-reverse': 'Open-Rej-Rev',
  'auction': 'Open-Auction',
};

/** Hover payload for a TPO row, for a host-drawn tooltip. */
export interface MarketProfileHover {
  sessionIndex: number;
  price: number;
  level: MarketProfileLevel;
  session: MarketProfileSessionResult;
  isPoc: boolean;
  inValueArea: boolean;
  isSinglePrint: boolean;
}

export class MarketProfile implements IPrimitive {
  private _result: MarketProfileResult | null;
  private _opts: MarketProfilePrimitiveOptions;
  private _host: PrimitiveHost | null = null;
  /** Session x-extents from the last paint, for hit-testing (media px). */
  private _boxes: { index: number; x0: number; x1: number }[] = [];
  private _rowH = 0;
  private _rc: PrimitiveRenderContext | null = null;

  public constructor(result: MarketProfileResult | null = null, opts: Partial<MarketProfilePrimitiveOptions> = {}) {
    this._result = result;
    this._opts = { ...DEFAULT_MARKET_PROFILE_PRIMITIVE_OPTIONS, ...opts };
  }

  public attached(host: PrimitiveHost): void { this._host = host; }
  public detached(): void { this._host = null; }
  public zOrder(): ZOrder { return this._opts.zOrder; }
  public options(): MarketProfilePrimitiveOptions { return this._opts; }

  public autoscaleInfo(): { min: number; max: number } | null {
    if (this._result === null) return null;
    let min = Infinity;
    let max = -Infinity;
    for (const s of this._result.sessions) {
      if (s.levels.length === 0) continue;
      max = Math.max(max, s.levels[0].price);
      min = Math.min(min, s.levels[s.levels.length - 1].price);
    }
    return Number.isFinite(min) ? { min, max } : null;
  }

  public setData(result: MarketProfileResult): void {
    this._result = result;
    this._host?.requestUpdate();
  }

  public setOptions(patch: Partial<MarketProfilePrimitiveOptions>): void {
    this._opts = { ...this._opts, ...patch };
    this._host?.requestUpdate();
  }

  // Deliberately no `hitTest`. It used to claim `distance: 0` for every point
  // inside a session's x-range — a whole trading day's width, at any height,
  // because it ignored `y`. `bestHit` sorts by distance first, so that area claim
  // beat every drawing, order line and price line beneath it: a fib level could
  // only be selected by clicking within a pixel of it, and on a chart with
  // Studies switched on a shape could not be re-selected, dragged or deleted.
  //
  // Nothing consumed the `mp:<index>` id it returned. The hover readout comes
  // from `hoverAt()` driven by the crosshair and is unaffected, so the claim
  // bought a `crosshair` cursor and cost the drawing tier its interactivity.

  /**
   * Full hover payload for `(x, y)` in media px. `rc` defaults to the context of
   * the last paint, so a crosshair handler can just call `hoverAt(p.x, p.y)`.
   */
  public hoverAt(x: number, y: number, rc?: PrimitiveRenderContext): MarketProfileHover | null {
    const ctx = rc ?? this._rc;
    if (ctx === null || this._result === null) return null;
    const box = this._boxes.find((b) => x >= b.x0 && x <= b.x1);
    if (box === undefined) return null;
    const s = this._result.sessions[box.index];
    if (s === undefined) return null;
    let level: MarketProfileLevel | null = null;
    let best = Infinity;
    for (const l of s.levels) {
      const d = Math.abs(ctx.priceScale.priceToY(l.price) - y);
      if (d < best && d <= Math.max(4, this._rowH)) { best = d; level = l; }
    }
    if (level === null) return null;
    return {
      sessionIndex: box.index,
      price: level.price,
      level,
      session: s,
      isPoc: level.price === s.poc,
      inValueArea: level.price <= s.vah && level.price >= s.val,
      isSinglePrint: s.singlePrints.includes(level.price),
    };
  }

  public draw(ctx: CanvasRenderingContext2D, rc: PrimitiveRenderContext): void {
    this._rc = rc;
    this._boxes = [];
    if (this._result === null || this._result.sessions.length === 0) return;
    const o = this._result.options;
    const row = o.tickSize * Math.max(1, Math.floor(o.rowTicks));
    for (let i = 0; i < this._result.sessions.length; i++) {
      this._drawSession(ctx, rc, this._result.sessions[i], row, i);
    }
    if (this._opts.showNakedLevels) this._drawNaked(ctx, rc);
  }

  /**
   * How opaque the letter is at this row height: 0 below the threshold, 1 well
   * above, linear between. The block stays visible throughout, so the change
   * reads as a fade rather than a swap.
   */
  private _letterAlpha(rowHpx: number): number {
    const o = this._opts;
    if (o.blockDisplay === 'letters' || o.blockDisplay === 'blocks+letters') return 1;
    if (o.blockDisplay === 'blocks') return 0;
    const fade = Math.max(1, o.letterFade);
    return Math.max(0, Math.min(1, (rowHpx - o.minLetterHeight) / fade));
  }

  private _blockColor(l: MarketProfileLevel, periodIdx: number, s: MarketProfileSessionResult): string {
    const o = this._opts;
    if (o.colorMode === 'period') return o.periodColors[periodIdx % o.periodColors.length];
    if (o.colorMode === 'valueArea') return l.price <= s.vah && l.price >= s.val ? o.vaColor : o.color;
    return o.color;
  }

  private _drawSession(
    ctx: CanvasRenderingContext2D,
    rc: PrimitiveRenderContext,
    s: MarketProfileSessionResult,
    row: number,
    index: number,
  ): void {
    const o = this._opts;
    const dpr = rc.dpr;
    const i0 = rc.dataLayer.timeToIndex(s.startTime);
    const i1 = rc.dataLayer.timeToIndex(s.endTime);
    if (i0 === undefined || i1 === undefined) return;
    const spacing = o.profileSpacing * dpr;
    const x0 = Math.round(rc.timeScale.indexToX(i0) * dpr) + spacing / 2;
    const x1 = Math.max(x0 + 1, Math.round(rc.timeScale.indexToX(i1) * dpr) - spacing / 2);
    this._boxes.push({ index, x0: x0 / dpr, x1: x1 / dpr });

    const yOf = (p: number): number => rc.priceScale.priceToY(p) * dpr;
    // Row height straight off the price scale — this decides letters vs bricks.
    const rowH = Math.max(1, Math.abs(rc.priceScale.priceToY(s.poc) - rc.priceScale.priceToY(s.poc + row)) * dpr);
    this._rowH = rowH / dpr;
    const lw = o.letterWidth * dpr;
    const alpha = this._letterAlpha(rowH / dpr);
    const drawBlock = o.blockDisplay !== 'letters' || alpha < 1;

    ctx.save();

    if (o.fillValueArea) {
      const yTop = yOf(s.vah) - rowH / 2;
      const yBot = yOf(s.val) + rowH / 2;
      ctx.globalAlpha = o.valueAreaFillOpacity;
      ctx.fillStyle = o.valueAreaFillColor;
      ctx.fillRect(x0, yTop, x1 - x0, yBot - yTop);
      ctx.globalAlpha = 1;
    }

    let maxCount = 1;
    let maxVol = 0;
    for (const l of s.levels) {
      if (l.count > maxCount) maxCount = l.count;
      if (l.volume > maxVol) maxVol = l.volume;
    }

    if (o.showVolumeProfile && maxVol > 0) this._drawVolume(ctx, rc, s, x0, x1, rowH, maxVol);

    // ── TPO blocks ────────────────────────────────────────────────────────
    // Font shrinks to the row so a letter never spills into its neighbour.
    const fontPx = Math.min(o.font * dpr, rowH * 0.95);
    if (alpha > 0) {
      ctx.font = `${fontPx}px ui-monospace, SFMono-Regular, Menlo, monospace`;
      ctx.textBaseline = 'middle';
      ctx.textAlign = 'center';
    }
    const blockH = Math.max(1, rowH - Math.min(1.5 * dpr, rowH * 0.15));
    const heatMode = o.colorMode === 'count' || o.colorMode === 'volume';

    for (const l of s.levels) {
      const y = yOf(l.price);
      const inVa = l.price <= s.vah && l.price >= s.val;
      const dim = inVa ? 1 : o.outsideVaOpacity;
      const heat = o.colorMode === 'count' ? l.count / maxCount
        : o.colorMode === 'volume' ? (maxVol > 0 ? l.volume / maxVol : 1) : 1;
      const baseAlpha = o.opacity * dim * (heatMode ? 0.3 + 0.7 * heat : 1);

      for (let j = 0; j < l.periods.length; j++) {
        // `split` gives each period its own column slot, so a gap shows which
        // periods never traded that row; packed mode closes the gaps up.
        const slot = o.split ? l.periods[j] : j;
        const bx = x0 + slot * lw;
        if (bx > x1) break;
        const color = this._blockColor(l, l.periods[j], s);
        if (drawBlock) {
          ctx.globalAlpha = baseAlpha;
          ctx.fillStyle = color;
          ctx.fillRect(bx, y - blockH / 2, Math.max(1, lw - Math.min(1, lw * 0.12)), blockH);
        }
        if (alpha > 0) {
          // Letters ride on top: dark ink on a filled block, the period colour
          // when the letter is the only thing being drawn.
          ctx.globalAlpha = alpha * (drawBlock ? 0.95 : baseAlpha);
          ctx.fillStyle = drawBlock ? '#12151c' : color;
          ctx.fillText(l.letters[j] ?? '', bx + lw / 2, y);
        }
      }
    }
    ctx.globalAlpha = 1;

    if (o.showTpoCounts) {
      ctx.font = `${Math.min((o.font - 1) * dpr, rowH)}px ui-monospace, monospace`;
      ctx.textAlign = 'left';
      ctx.textBaseline = 'middle';
      ctx.fillStyle = o.countColor;
      const cx = x0 + (o.split ? s.periods : maxCount) * lw + 3 * dpr;
      for (const l of s.levels) ctx.fillText(String(l.count), cx, yOf(l.price));
    }

    if (o.showSinglePrints && s.singlePrints.length > 0) {
      ctx.strokeStyle = o.singlePrintColor;
      ctx.lineWidth = Math.max(1, Math.round(dpr));
      for (const price of s.singlePrints) {
        const y = Math.round(yOf(price)) + 0.5;
        ctx.beginPath();
        ctx.moveTo(x0, y);
        ctx.lineTo(x0 + 6 * dpr, y);
        ctx.stroke();
      }
    }

    if (o.showTails) {
      const tail = (t: { high: number; low: number } | null, color: string): void => {
        if (t === null) return;
        ctx.fillStyle = color;
        ctx.globalAlpha = 0.75;
        const yH = yOf(t.high) - rowH / 2;
        const yL = yOf(t.low) + rowH / 2;
        ctx.fillRect(x0 - 4 * dpr, yH, 3 * dpr, yL - yH);
        ctx.globalAlpha = 1;
      };
      tail(s.sellingTail, o.sellTailColor);
      tail(s.buyingTail, o.buyTailColor);
    }

    if (o.showInitialBalance && Number.isFinite(s.initialBalance.high)) {
      const yH = yOf(s.initialBalance.high);
      const yL = yOf(s.initialBalance.low);
      const xb = x0 - 2 * dpr;
      ctx.strokeStyle = o.ibColor;
      ctx.lineWidth = Math.max(1, Math.round(1.5 * dpr));
      ctx.beginPath();
      ctx.moveTo(xb, yH); ctx.lineTo(xb, yL);
      ctx.moveTo(xb, yH); ctx.lineTo(xb + 5 * dpr, yH);
      ctx.moveTo(xb, yL); ctx.lineTo(xb + 5 * dpr, yL);
      ctx.stroke();
    }

    const hline = (price: number, color: string, label: string, width = 1): void => {
      const y = Math.round(yOf(price)) + 0.5;
      ctx.strokeStyle = color;
      ctx.lineWidth = Math.max(1, Math.round(width * dpr));
      ctx.beginPath();
      ctx.moveTo(x0, y);
      ctx.lineTo(x1, y);
      ctx.stroke();
      if (label !== '') {
        ctx.font = `${(o.font - 1) * dpr}px ui-sans-serif, system-ui, sans-serif`;
        ctx.textBaseline = 'middle';
        ctx.textAlign = 'left';
        ctx.fillStyle = color;
        ctx.fillText(label, x1 + 3 * dpr, y);
      }
    };
    if (o.showValueArea) {
      hline(s.vah, o.vahColor, o.showValueAreaLabels ? `VAH ${rc.priceScale.format(s.vah)}` : '');
      hline(s.val, o.valColor, o.showValueAreaLabels ? `VAL ${rc.priceScale.format(s.val)}` : '');
    }
    if (o.showPoc) hline(s.poc, o.pocColor, o.showPocLabel ? `POC ${rc.priceScale.format(s.poc)}` : '', o.pocThickness);
    if (o.showPoorHighLow) {
      if (s.poorHigh) hline(s.high, o.poorColor, 'Poor High');
      if (s.poorLow) hline(s.low, o.poorColor, 'Poor Low');
    }

    if (o.showDevelopingPoc) this._drawDeveloping(ctx, rc, s, 'poc', o.developingPocColor);
    if (o.showDevelopingVa) {
      this._drawDeveloping(ctx, rc, s, 'vah', o.developingVaColor);
      this._drawDeveloping(ctx, rc, s, 'val', o.developingVaColor);
    }

    // ── header labels ─────────────────────────────────────────────────────
    const bits: string[] = [];
    if (o.showSessionLabel && s.label !== undefined) bits.push(s.label);
    if (o.showDayType) bits.push(DAY_TYPE_TEXT[s.dayType] ?? s.dayType);
    if (o.showOpenType) bits.push(OPEN_TYPE_TEXT[s.openType] ?? s.openType);
    if (bits.length > 0) {
      ctx.font = `${(o.font - 1) * dpr}px ui-sans-serif, system-ui, sans-serif`;
      ctx.textAlign = 'left';
      ctx.textBaseline = 'bottom';
      ctx.fillStyle = o.labelColor;
      ctx.fillText(bits.join('  ·  '), x0, yOf(s.high) - rowH);
    }

    ctx.restore();
  }

  private _drawVolume(
    ctx: CanvasRenderingContext2D,
    rc: PrimitiveRenderContext,
    s: MarketProfileSessionResult,
    x0: number,
    x1: number,
    rowH: number,
    maxVol: number,
  ): void {
    const o = this._opts;
    const dpr = rc.dpr;
    const w = o.volumeProfileWidth * dpr;
    const right = o.volumeProfileSide === 'right';
    ctx.globalAlpha = 0.55;
    ctx.fillStyle = o.volumeColor;
    for (const l of s.levels) {
      const bw = w * (l.volume / maxVol);
      const y = rc.priceScale.priceToY(l.price) * dpr - rowH / 2;
      ctx.fillRect(right ? x1 - bw : x0, y, bw, Math.max(1, rowH - 1));
    }
    ctx.globalAlpha = 1;
    // Numbers only when the row can hold a line of text.
    if (o.showVolumeValues && rowH >= 7 * dpr) {
      ctx.font = `${Math.min(9 * dpr, rowH * 0.9)}px ui-monospace, monospace`;
      ctx.textBaseline = 'middle';
      ctx.textAlign = right ? 'right' : 'left';
      ctx.fillStyle = o.countColor;
      for (const l of s.levels) {
        ctx.fillText(Math.round(l.volume).toString(), right ? x1 - 2 * dpr : x0 + 2 * dpr,
          rc.priceScale.priceToY(l.price) * dpr);
      }
    }
  }

  /** Step-plot one developing series across the session. */
  private _drawDeveloping(
    ctx: CanvasRenderingContext2D,
    rc: PrimitiveRenderContext,
    s: MarketProfileSessionResult,
    key: 'poc' | 'vah' | 'val',
    color: string,
  ): void {
    if (s.developing.length === 0) return;
    const dpr = rc.dpr;
    ctx.save();
    ctx.strokeStyle = color;
    ctx.lineWidth = Math.max(1, Math.round(dpr));
    ctx.beginPath();
    let started = false;
    for (const d of s.developing) {
      const idx = rc.dataLayer.timeToIndex(d.time);
      if (idx === undefined) continue;
      const x = rc.timeScale.indexToX(idx) * dpr;
      const y = Math.round(rc.priceScale.priceToY(d[key]) * dpr) + 0.5;
      if (!started) { ctx.moveTo(x, y); started = true; } else { ctx.lineTo(x, y); }
    }
    if (started) ctx.stroke();
    ctx.restore();
  }

  /** Untraded prior POC / VAH / VAL, extended to the right edge. */
  private _drawNaked(ctx: CanvasRenderingContext2D, rc: PrimitiveRenderContext): void {
    const o = this._opts;
    const dpr = rc.dpr;
    const levels = nakedLevels(this._result as MarketProfileResult);
    if (levels.length === 0) return;
    ctx.save();
    ctx.strokeStyle = o.nakedColor;
    ctx.lineWidth = Math.max(1, Math.round(dpr));
    ctx.setLineDash([4 * dpr, 3 * dpr]);
    const xEnd = rc.plotWidth * dpr;
    for (const n of levels) {
      const idx = rc.dataLayer.timeToIndex(n.time);
      if (idx === undefined) continue;
      const y = Math.round(rc.priceScale.priceToY(n.price) * dpr) + 0.5;
      ctx.beginPath();
      ctx.moveTo(rc.timeScale.indexToX(idx) * dpr, y);
      ctx.lineTo(xEnd, y);
      ctx.stroke();
    }
    ctx.setLineDash([]);
    ctx.restore();
  }
}
