/**
 * Drawing model (ARCHITECTURE.md §8). A drawing is **plain data** — anchors in
 * `{ time, price }`, a style bag, a tool id — so it serialises straight into
 * `ChartState.drawings` with no custom encoder, and a tool is a registry entry
 * exactly like a chart type or an indicator.
 *
 * Anchors are stored in *data* space, never pixels: the chart's time axis is
 * gapless (§5.3), so a pixel anchor would slide the moment a weekend collapsed
 * or the user zoomed. `DataLayer.timeToIndexFloat` maps them back, which also
 * gives anchors between bars and to the right of the last one — where trend
 * projections and forecasts live.
 */
import type { PrimitiveRenderContext } from 'openalgo-charts';

/** One anchor, in data space. */
export interface DrawingPoint {
  /** UTC seconds. May fall between bars, or past the last one. */
  time: number;
  price: number;
}

export interface DrawingStyle {
  color?: string;
  lineWidth?: number;
  lineStyle?: 'solid' | 'dashed' | 'dotted';
  /** Fill the shape's interior (rectangle, ellipse, channel, position boxes). */
  fill?: boolean;
  fillColor?: string;
  /** 0..1. Defaults to 0.12. */
  fillOpacity?: number;
  /** Extend the line past its anchors. */
  extendLeft?: boolean;
  extendRight?: boolean;
  /** Draw level / price / ratio labels where the tool has them. */
  showLabels?: boolean;
  /** Fibonacci levels as fractions. Defaults per tool. */
  levels?: number[];
  // ── text tools ──────────────────────────────────────────────────────────
  /** Body text. `\n` starts a new line; see `wrap` for soft wrapping. */
  text?: string;
  fontSize?: number;
  /** CSS font stack. Defaults to the UI sans-serif stack. */
  fontFamily?: string;
  fontWeight?: 'normal' | 'bold';
  fontStyle?: 'normal' | 'italic';
  /** Draw a filled plate behind the text. */
  background?: boolean;
  backgroundColor?: string;
  /** Plate opacity, 0..1. Defaults to 1 — a text background is usually opaque. */
  backgroundOpacity?: number;
  /** Stroke a border around the plate. */
  border?: boolean;
  borderColor?: string;
  /** Soft-wrap the text at `wrapWidth` instead of running off the pane. */
  wrap?: boolean;
  /** Wrap width in media px. Defaults to 220. */
  wrapWidth?: number;
  /** Horizontal alignment within the box. Defaults to 'left'. */
  textAlign?: 'left' | 'center' | 'right';
  /** Vertical placement within the box. Defaults to 'top'. */
  textVAlign?: 'top' | 'middle' | 'bottom';
  /**
   * Where a shape's label sits relative to the shape: `inside` the outline, or
   * `outside` just above it. Shapes only — the text tool *is* its own box.
   */
  textPosition?: 'inside' | 'outside';
  /**
   * Label colour. Shapes need this separate from `color`, which is the outline —
   * a purple rectangle with white text is one shape with two colours.
   * Falls back to `color`.
   */
  fontColor?: string;
  /** Position tools: capital base and risk per trade, for the size readout. */
  accountSize?: number;
  risk?: number;
  /**
   * Position tools: contract multiplier. Derivatives trade in indivisible lots
   * — NIFTY futures in 65 — so a size of "24" is not an order anyone can send.
   * Above 1, the tool rounds down to whole lots and reports both the lot count
   * and the resulting quantity. Defaults to 1 (cash, one unit per share).
   */
  lotSize?: number;
  /**
   * Position tools: exchange cap on a single order (the NSE freeze quantity).
   * A computed size above it is clamped down to a whole lot and flagged.
   */
  maxQty?: number;
  /** Position tools: prefix for money amounts in the readout, e.g. `₹`. */
  currencyPrefix?: string;
}

export interface Drawing {
  id: string;
  /** Registered tool id. */
  tool: string;
  points: DrawingPoint[];
  style: DrawingStyle;
  paneIndex: number;
  /** Locked drawings render but cannot be selected or dragged. */
  locked?: boolean;
  /** Default true. */
  visible?: boolean;
}

/** A point mapped to the pane, in media px. */
export interface ScreenPoint {
  x: number;
  y: number;
}

export interface DrawContext {
  ctx: CanvasRenderingContext2D;
  rc: PrimitiveRenderContext;
  /** Anchors in **device** px, ready to stroke. */
  pts: ScreenPoint[];
  drawing: Drawing;
  style: Required<Pick<DrawingStyle, 'color' | 'lineWidth'>> & DrawingStyle;
  selected: boolean;
  /** Format a price the way the pane's axis does. */
  formatPrice(price: number): string;
}

export interface HitContext {
  /** Anchors in **media** px — the same space as the incoming x/y. */
  pts: ScreenPoint[];
  drawing: Drawing;
  rc: PrimitiveRenderContext;
}

/** What {@link DrawingTool.expand} needs to size a default in chart units. */
export interface ExpandContext {
  /** Seconds between adjacent bars, so a default can span a sane bar count. */
  barSeconds: number;
  /**
   * Bars currently on screen. A default sized in fixed bars is a hairline when
   * zoomed out and fills the pane when zoomed in, so size against this instead.
   */
  visibleBars: number;
}

export interface DrawingTool {
  id: string;
  name: string;
  /**
   * Anchors the tool needs before it is complete. `0` means free-form: the
   * drawing finishes on double-click.
   */
  points: number;
  /**
   * Sample the cursor continuously while the pointer is held, and finish on
   * release — one press-drag-release gesture is one stroke. Brushes want this;
   * without it a `points: 0` tool collects a vertex per click, which is
   * polyline behaviour and never terminates on its own.
   */
  freehand?: boolean;
  /**
   * Turn the anchors actually clicked into the full anchor set. Lets a tool drop
   * a complete, immediately editable default from fewer clicks — the position
   * tools place a 1:1 box off a single click, which the user then drags, rather
   * than demanding entry/target/stop be clicked in turn.
   *
   * The returned points become the drawing's anchors, so each one stays a
   * draggable handle.
   */
  expand?(clicked: readonly DrawingPoint[], ctx: ExpandContext): DrawingPoint[];
  /**
   * Keyboard shortcut that arms this tool, as `'Alt+T'` / `'Shift+Alt+F'` —
   * modifiers in `Ctrl`, `Alt`, `Shift` order, then a single key. Hosts render
   * it beside the tool's name in a palette and bind it with
   * `matchDrawingShortcut`; the library itself installs no listener, since only
   * the host knows whether the chart has focus or a dialog is open.
   */
  shortcut?: string;
  /** Merged under the caller's style when a drawing is created. */
  defaultStyle?: DrawingStyle;
  draw(c: DrawContext): void;
  /**
   * Distance in media px from the cursor to the shape, or `null` for a miss.
   * Return `0` for "inside" so a filled region is grabbable anywhere.
   */
  distance(x: number, y: number, c: HitContext): number | null;
}
