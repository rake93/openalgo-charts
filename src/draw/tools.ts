/**
 * Built-in drawing tools + the tool registry. Same philosophy as the chart-type
 * and indicator registries: a tool is a descriptor, the layer just runs it, and
 * `registerDrawingTool` makes a custom one first-class.
 *
 * `draw` receives anchors already in device px; `distance` receives them in
 * media px, the same space as the incoming cursor.
 */
import type { DrawContext, DrawingStyle, DrawingTool, ScreenPoint } from './types';
import {
  distToSegment, distToLine, distToHorizontal, distToVertical,
  distToRect, distToEllipse, distToPolyline, rectOf, extendSegment,
} from './geometry';
import { roundRectPath, contrastText } from '../render/pill';

const registry = new Map<string, DrawingTool>();

export function registerDrawingTool(tool: DrawingTool): void {
  registry.set(tool.id, tool);
}

export function getDrawingTool(id: string): DrawingTool {
  const t = registry.get(id);
  if (t === undefined) throw new Error(`openalgo-charts: unknown drawing tool "${id}"`);
  return t;
}

export function hasDrawingTool(id: string): boolean {
  return registry.has(id);
}

export function registeredDrawingTools(): DrawingTool[] {
  return Array.from(registry.values());
}

/** Keyboard event fields a shortcut is matched against. */
export interface ShortcutEvent {
  key: string;
  altKey?: boolean;
  ctrlKey?: boolean;
  metaKey?: boolean;
  shiftKey?: boolean;
}

/** `'Shift+Alt+F'` -> its parts, for comparison against an event. */
function parseShortcut(spec: string): { key: string; alt: boolean; ctrl: boolean; shift: boolean } {
  const parts = spec.split('+').map((p) => p.trim().toLowerCase());
  const key = parts[parts.length - 1] ?? '';
  return {
    key,
    alt: parts.includes('alt'),
    ctrl: parts.includes('ctrl') || parts.includes('control'),
    shift: parts.includes('shift'),
  };
}

/**
 * The id of the tool whose `shortcut` matches this key event, or `null`.
 *
 * Pure, so a host can bind one `keydown` listener and decide for itself when
 * shortcuts apply — the library installs no listener, because only the host
 * knows whether the chart has focus, a dialog is open, or the user is typing.
 *
 * Modifiers must match exactly: `Alt+T` will not fire for `Ctrl+Alt+T`, so a
 * tool shortcut cannot shadow a browser or host chord. `metaKey` (Cmd) is
 * treated as Ctrl, which is what a Mac user expects.
 */
export function matchDrawingShortcut(e: ShortcutEvent): string | null {
  const key = (e.key ?? '').toLowerCase();
  if (key === '') return null;
  const alt = e.altKey === true;
  const ctrl = e.ctrlKey === true || e.metaKey === true;
  const shift = e.shiftKey === true;
  // A bare letter is never a shortcut: it would swallow ordinary typing.
  if (!alt && !ctrl) return null;
  for (const tool of registry.values()) {
    if (tool.shortcut === undefined) continue;
    const want = parseShortcut(tool.shortcut);
    if (want.key === key && want.alt === alt && want.ctrl === ctrl && want.shift === shift) {
      return tool.id;
    }
  }
  return null;
}

/** Every registered tool that has a shortcut, as `id -> shortcut`. */
export function drawingShortcuts(): Record<string, string> {
  const out: Record<string, string> = {};
  for (const tool of registry.values()) {
    if (tool.shortcut !== undefined) out[tool.id] = tool.shortcut;
  }
  return out;
}

// ── shared drawing helpers ────────────────────────────────────────────────

function applyStroke(c: DrawContext): void {
  const { ctx, rc, style } = c;
  const d = rc.dpr;
  ctx.strokeStyle = style.color;
  ctx.lineWidth = Math.max(1, Math.round(style.lineWidth * d));
  ctx.lineJoin = 'round';
  ctx.lineCap = 'round';
  ctx.setLineDash(
    style.lineStyle === 'dashed' ? [6 * d, 4 * d]
      : style.lineStyle === 'dotted' ? [1 * d, 3 * d]
      : [],
  );
}

function fillStyleOf(c: DrawContext): string {
  return c.style.fillColor ?? c.style.color;
}

function withFill(c: DrawContext, paint: () => void): void {
  if (c.style.fill !== true) return;
  const { ctx } = c;
  ctx.save();
  ctx.globalAlpha = c.style.fillOpacity ?? 0.12;
  ctx.fillStyle = fillStyleOf(c);
  paint();
  ctx.restore();
}

function label(c: DrawContext, text: string, x: number, y: number, color?: string): void {
  const { ctx, rc, style } = c;
  const size = (style.fontSize ?? 11) * rc.dpr;
  ctx.save();
  ctx.setLineDash([]);
  ctx.font = `${size}px ui-sans-serif, system-ui, sans-serif`;
  ctx.textBaseline = 'middle';
  ctx.textAlign = 'left';
  const w = ctx.measureText(text).width;
  ctx.globalAlpha = 0.85;
  ctx.fillStyle = rc.theme.background;
  ctx.fillRect(x - 2 * rc.dpr, y - size * 0.75, w + 4 * rc.dpr, size * 1.5);
  ctx.globalAlpha = 1;
  ctx.fillStyle = color ?? style.color;
  ctx.fillText(text, x, y);
  ctx.restore();
}

/**
 * A solid rounded chip with contrasting text, one row per line — the readout
 * style the position and forecast tools share. `align` positions the box
 * horizontally about `x`, `place` vertically about `y`. Returns its height so a
 * caller can stack chips.
 */
function chip(
  c: DrawContext,
  lines: readonly string[],
  x: number,
  y: number,
  bg: string,
  opts: { align?: 'left' | 'center' | 'right'; place?: 'above' | 'below' | 'middle' } = {},
): number {
  const { ctx, rc } = c;
  const d = rc.dpr;
  const size = (c.style.fontSize ?? 11) * d;
  ctx.save();
  ctx.setLineDash([]);
  ctx.globalAlpha = 1;
  ctx.font = `${size}px ui-sans-serif, system-ui, sans-serif`;
  ctx.textBaseline = 'middle';
  ctx.textAlign = 'left';
  const padX = 5 * d;
  const padY = 3 * d;
  const lh = size * 1.35;
  let textW = 0;
  for (const t of lines) textW = Math.max(textW, ctx.measureText(t).width);
  const w = textW + padX * 2;
  const h = lh * lines.length + padY * 2;
  const align = opts.align ?? 'left';
  const bx = align === 'center' ? x - w / 2 : align === 'right' ? x - w : x;
  const place = opts.place ?? 'above';
  const by = place === 'above' ? y - h - 4 * d : place === 'below' ? y + 4 * d : y - h / 2;
  ctx.beginPath();
  roundRectPath(ctx, bx, by, w, h, 3 * d);
  ctx.fillStyle = bg;
  ctx.fill();
  ctx.fillStyle = contrastText(bg);
  for (let i = 0; i < lines.length; i++) ctx.fillText(lines[i], bx + padX, by + padY + lh * (i + 0.5));
  ctx.restore();
  return h;
}

/** Thousands-separated fixed-point, locale-independent so output is stable. */
function grouped(n: number, dp = 0): string {
  const [i, f] = Math.abs(n).toFixed(dp).split('.');
  const sign = n < 0 ? '-' : '';
  return sign + i.replace(/\B(?=(\d{3})+(?!\d))/g, ',') + (f === undefined ? '' : '.' + f);
}

/** `YYYY-MM-DD` in UTC — enough to anchor a label to its bar. */
function isoDate(sec: number): string {
  const dt = new Date(sec * 1000);
  const p = (n: number): string => String(n).padStart(2, '0');
  return `${dt.getUTCFullYear()}-${p(dt.getUTCMonth() + 1)}-${p(dt.getUTCDate())}`;
}

/** Coarse elapsed span: `76d 23h`, `5h 12m`, `12m`. */
function humanSpan(sec: number): string {
  const s = Math.max(0, Math.round(Math.abs(sec)));
  const days = Math.floor(s / 86400);
  const hours = Math.floor((s % 86400) / 3600);
  const mins = Math.floor((s % 3600) / 60);
  if (days > 0) return `${days}d ${hours}h`;
  if (hours > 0) return `${hours}h ${mins}m`;
  return `${mins}m`;
}

/** Filled arrowhead at `b`, pointing away from `a`. Scales with line width. */
function arrowHead(c: DrawContext, a: ScreenPoint, b: ScreenPoint): void {
  const head = Math.max(8, c.style.lineWidth * 5) * c.rc.dpr;
  const ang = Math.atan2(b.y - a.y, b.x - a.x);
  c.ctx.beginPath();
  c.ctx.moveTo(b.x, b.y);
  c.ctx.lineTo(b.x - head * Math.cos(ang - 0.4), b.y - head * Math.sin(ang - 0.4));
  c.ctx.lineTo(b.x - head * Math.cos(ang + 0.4), b.y - head * Math.sin(ang + 0.4));
  c.ctx.closePath();
  c.ctx.fillStyle = c.style.color;
  c.ctx.fill();
}

/** 172.79M / 1.2K — a raw volume sum is unreadable in a label. */
function compactNumber(n: number): string {
  const abs = Math.abs(n);
  if (abs >= 1e9) return `${(n / 1e9).toFixed(2)}B`;
  if (abs >= 1e6) return `${(n / 1e6).toFixed(2)}M`;
  if (abs >= 1e3) return `${(n / 1e3).toFixed(2)}K`;
  return grouped(n);
}

const UP_TINT = '#26a69a';
const DOWN_TINT = '#ef5350';

const DEFAULT_FIB: readonly number[] = [0, 0.236, 0.382, 0.5, 0.618, 0.786, 1];

// ── line family ───────────────────────────────────────────────────────────

/** Trend line, ray, and extended line differ only in which ends extend. */
function lineTool(id: string, name: string, left: boolean, right: boolean): DrawingTool {
  return {
    id, name, points: 2,
    defaultStyle: { extendLeft: left, extendRight: right },
    draw: (c) => {
      const [a, b] = extendSegment(
        c.pts[0], c.pts[1], c.rc.plotWidth * c.rc.dpr,
        c.style.extendLeft ?? left, c.style.extendRight ?? right,
      );
      applyStroke(c);
      c.ctx.beginPath();
      c.ctx.moveTo(a.x, a.y);
      c.ctx.lineTo(b.x, b.y);
      c.ctx.stroke();
      c.ctx.setLineDash([]);
    },
    distance: (x, y, h) => {
      const el = h.drawing.style.extendLeft ?? left;
      const er = h.drawing.style.extendRight ?? right;
      if (el && er) return distToLine(x, y, h.pts[0], h.pts[1]);
      const [a, b] = extendSegment(h.pts[0], h.pts[1], h.rc.plotWidth, el, er);
      return distToSegment(x, y, a, b);
    },
  };
}

export const TREND_LINE: DrawingTool = { ...lineTool('trend-line', 'Trend Line', false, false), shortcut: 'Alt+T' };
export const RAY = lineTool('ray', 'Ray', false, true);
export const EXTENDED_LINE = lineTool('extended-line', 'Extended Line', true, true);

export const ARROW: DrawingTool = {
  id: 'arrow', name: 'Arrow', points: 2,
  draw: (c) => {
    const [a, b] = c.pts;
    applyStroke(c);
    c.ctx.beginPath();
    c.ctx.moveTo(a.x, a.y);
    c.ctx.lineTo(b.x, b.y);
    c.ctx.stroke();
    // Head at the far anchor, sized off the line width so it scales with style.
    const head = Math.max(8, c.style.lineWidth * 5) * c.rc.dpr;
    const ang = Math.atan2(b.y - a.y, b.x - a.x);
    c.ctx.beginPath();
    c.ctx.moveTo(b.x, b.y);
    c.ctx.lineTo(b.x - head * Math.cos(ang - 0.4), b.y - head * Math.sin(ang - 0.4));
    c.ctx.lineTo(b.x - head * Math.cos(ang + 0.4), b.y - head * Math.sin(ang + 0.4));
    c.ctx.closePath();
    c.ctx.fillStyle = c.style.color;
    c.ctx.fill();
    c.ctx.setLineDash([]);
  },
  distance: (x, y, h) => distToSegment(x, y, h.pts[0], h.pts[1]),
};

export const HORIZONTAL_LINE: DrawingTool = {
  id: 'horizontal-line', name: 'Horizontal Line', points: 1, shortcut: 'Alt+H',
  defaultStyle: { showLabels: true },
  draw: (c) => {
    const y = Math.round(c.pts[0].y) + 0.5;
    applyStroke(c);
    c.ctx.beginPath();
    c.ctx.moveTo(0, y);
    c.ctx.lineTo(c.rc.plotWidth * c.rc.dpr, y);
    c.ctx.stroke();
    c.ctx.setLineDash([]);
    if (c.style.showLabels !== false) {
      label(c, c.formatPrice(c.drawing.points[0].price), 4 * c.rc.dpr, y - 8 * c.rc.dpr);
    }
  },
  distance: (_x, y, h) => distToHorizontal(y, h.pts[0].y),
};

export const HORIZONTAL_RAY: DrawingTool = {
  id: 'horizontal-ray', name: 'Horizontal Ray', points: 1, shortcut: 'Alt+J',
  defaultStyle: { showLabels: true },
  draw: (c) => {
    const y = Math.round(c.pts[0].y) + 0.5;
    applyStroke(c);
    c.ctx.beginPath();
    c.ctx.moveTo(c.pts[0].x, y);
    c.ctx.lineTo(c.rc.plotWidth * c.rc.dpr, y);
    c.ctx.stroke();
    c.ctx.setLineDash([]);
    if (c.style.showLabels !== false) {
      label(c, c.formatPrice(c.drawing.points[0].price), c.pts[0].x + 4 * c.rc.dpr, y - 8 * c.rc.dpr);
    }
  },
  distance: (x, y, h) => (x < h.pts[0].x ? null : distToHorizontal(y, h.pts[0].y)),
};

export const VERTICAL_LINE: DrawingTool = {
  id: 'vertical-line', name: 'Vertical Line', points: 1, shortcut: 'Alt+V',
  draw: (c) => {
    const x = Math.round(c.pts[0].x) + 0.5;
    applyStroke(c);
    c.ctx.beginPath();
    c.ctx.moveTo(x, 0);
    c.ctx.lineTo(x, c.rc.plotHeight * c.rc.dpr);
    c.ctx.stroke();
    c.ctx.setLineDash([]);
  },
  distance: (x, _y, h) => distToVertical(x, h.pts[0].x),
};

export const CROSS_LINE: DrawingTool = {
  id: 'cross-line', name: 'Cross Line', points: 1, shortcut: 'Alt+C',
  draw: (c) => {
    const x = Math.round(c.pts[0].x) + 0.5;
    const y = Math.round(c.pts[0].y) + 0.5;
    applyStroke(c);
    c.ctx.beginPath();
    c.ctx.moveTo(x, 0); c.ctx.lineTo(x, c.rc.plotHeight * c.rc.dpr);
    c.ctx.moveTo(0, y); c.ctx.lineTo(c.rc.plotWidth * c.rc.dpr, y);
    c.ctx.stroke();
    c.ctx.setLineDash([]);
  },
  distance: (x, y, h) => Math.min(distToVertical(x, h.pts[0].x), distToHorizontal(y, h.pts[0].y)),
};

// ── shapes ────────────────────────────────────────────────────────────────

export const RECTANGLE: DrawingTool = {
  id: 'rectangle', name: 'Rectangle', points: 2,
  defaultStyle: { fill: true, fontSize: 14, textAlign: 'left', textVAlign: 'top', textPosition: 'inside' },
  draw: (c) => {
    const r = rectOf(c.pts[0], c.pts[1]);
    withFill(c, () => c.ctx.fillRect(r.x0, r.y0, r.x1 - r.x0, r.y1 - r.y0));
    applyStroke(c);
    c.ctx.strokeRect(r.x0, r.y0, r.x1 - r.x0, r.y1 - r.y0);
    c.ctx.setLineDash([]);
    shapeLabel(c, r.x0, r.y0, r.x1, r.y1);
  },
  distance: (x, y, h) => distToRect(x, y, h.pts[0], h.pts[1], h.drawing.style.fill === true),
};

export const ELLIPSE: DrawingTool = {
  id: 'ellipse', name: 'Ellipse', points: 2,
  defaultStyle: { fill: true, fontSize: 14, textAlign: 'center', textVAlign: 'middle', textPosition: 'inside' },
  draw: (c) => {
    const r = rectOf(c.pts[0], c.pts[1]);
    const cx = (r.x0 + r.x1) / 2;
    const cy = (r.y0 + r.y1) / 2;
    const rx = Math.max(1, (r.x1 - r.x0) / 2);
    const ry = Math.max(1, (r.y1 - r.y0) / 2);
    const path = (): void => {
      c.ctx.beginPath();
      c.ctx.ellipse(cx, cy, rx, ry, 0, 0, Math.PI * 2);
    };
    withFill(c, () => { path(); c.ctx.fill(); });
    applyStroke(c);
    path();
    c.ctx.stroke();
    c.ctx.setLineDash([]);
    shapeLabel(c, r.x0, r.y0, r.x1, r.y1);
  },
  distance: (x, y, h) => distToEllipse(x, y, h.pts[0], h.pts[1], h.drawing.style.fill === true),
};

export const PARALLEL_CHANNEL: DrawingTool = {
  id: 'parallel-channel', name: 'Parallel Channel', points: 3,
  defaultStyle: { fill: true },
  draw: (c) => {
    const [a, b, t] = c.pts;
    // The third anchor sets the channel width as a vertical offset.
    const dy = t.y - (a.y + (b.y - a.y) * 0.5);
    const a2 = { x: a.x, y: a.y + dy };
    const b2 = { x: b.x, y: b.y + dy };
    withFill(c, () => {
      c.ctx.beginPath();
      c.ctx.moveTo(a.x, a.y); c.ctx.lineTo(b.x, b.y);
      c.ctx.lineTo(b2.x, b2.y); c.ctx.lineTo(a2.x, a2.y);
      c.ctx.closePath();
      c.ctx.fill();
    });
    applyStroke(c);
    c.ctx.beginPath();
    c.ctx.moveTo(a.x, a.y); c.ctx.lineTo(b.x, b.y);
    c.ctx.moveTo(a2.x, a2.y); c.ctx.lineTo(b2.x, b2.y);
    c.ctx.stroke();
    c.ctx.setLineDash([]);
    shapeLabel(c, Math.min(a.x, b.x), Math.min(a.y, b.y, a2.y, b2.y),
      Math.max(a.x, b.x), Math.max(a.y, b.y, a2.y, b2.y));
  },
  distance: (x, y, h) => {
    const [a, b, t] = h.pts;
    const dy = t.y - (a.y + (b.y - a.y) * 0.5);
    const d1 = distToSegment(x, y, a, b);
    const d2 = distToSegment(x, y, { x: a.x, y: a.y + dy }, { x: b.x, y: b.y + dy });
    return Math.min(d1, d2);
  },
};

// ── fibonacci ─────────────────────────────────────────────────────────────

/** Retracement (2 anchors) and extension (3) share the level-drawing body. */
function fibTool(id: string, name: string, anchors: 2 | 3): DrawingTool {
  return {
    id, name, points: anchors,
    defaultStyle: { showLabels: true, levels: [...DEFAULT_FIB], fill: true, fillOpacity: 0.06 },
    draw: (c) => {
      const levels = c.style.levels ?? DEFAULT_FIB;
      const p = c.drawing.points;
      // Retracement measures p0→p1; extension projects that leg from p2.
      const from = anchors === 2 ? p[0].price : p[2].price;
      const span = anchors === 2 ? p[1].price - p[0].price : p[1].price - p[0].price;
      const x0 = Math.min(c.pts[0].x, c.pts[anchors - 1].x);
      const x1 = Math.max(c.pts[0].x, c.pts[anchors - 1].x);
      const right = c.style.extendRight === true ? c.rc.plotWidth * c.rc.dpr : x1;
      applyStroke(c);
      let prevY: number | null = null;
      for (const lv of levels) {
        const price = from + span * lv;
        const y = Math.round(c.rc.priceScale.priceToY(price) * c.rc.dpr) + 0.5;
        if (c.style.fill === true && prevY !== null) {
          c.ctx.save();
          c.ctx.globalAlpha = c.style.fillOpacity ?? 0.06;
          c.ctx.fillStyle = fillStyleOf(c);
          c.ctx.fillRect(x0, Math.min(prevY, y), right - x0, Math.abs(y - prevY));
          c.ctx.restore();
        }
        prevY = y;
        c.ctx.beginPath();
        c.ctx.moveTo(x0, y);
        c.ctx.lineTo(right, y);
        c.ctx.stroke();
        if (c.style.showLabels !== false) {
          label(c, `${(lv * 100).toFixed(1)}%  ${c.formatPrice(price)}`, x0 + 4 * c.rc.dpr, y - 8 * c.rc.dpr);
        }
      }
      c.ctx.setLineDash([]);
    },
    distance: (x, y, h) => {
      const levels = h.drawing.style.levels ?? DEFAULT_FIB;
      const p = h.drawing.points;
      const from = anchors === 2 ? p[0].price : p[2].price;
      const span = p[1].price - p[0].price;
      const x0 = Math.min(h.pts[0].x, h.pts[anchors - 1].x);
      const x1 = h.drawing.style.extendRight === true
        ? h.rc.plotWidth : Math.max(h.pts[0].x, h.pts[anchors - 1].x);
      if (x < x0 - 4 || x > x1 + 4) return null;
      let best = Infinity;
      for (const lv of levels) {
        const d = Math.abs(y - h.rc.priceScale.priceToY(from + span * lv));
        if (d < best) best = d;
      }
      return best;
    },
  };
}

export const FIB_RETRACEMENT = fibTool('fib-retracement', 'Fib Retracement', 2);
export const FIB_EXTENSION = fibTool('fib-extension', 'Fib Extension', 3);

// ── measurement & positions ───────────────────────────────────────────────

export const MEASURE: DrawingTool = {
  id: 'measure', name: 'Measure', points: 2,
  defaultStyle: { fill: true, showLabels: true, fillOpacity: 0.14 },
  draw: (c) => {
    const r = rectOf(c.pts[0], c.pts[1]);
    const d = c.rc.dpr;
    const p = c.drawing.points;
    const chg = p[1].price - p[0].price;
    const pct = p[0].price !== 0 ? (chg / p[0].price) * 100 : 0;
    const up = chg >= 0;
    const tint = up ? UP_TINT : DOWN_TINT;
    c.ctx.save();
    c.ctx.globalAlpha = c.style.fillOpacity ?? 0.14;
    c.ctx.fillStyle = tint;
    c.ctx.fillRect(r.x0, r.y0, r.x1 - r.x0, r.y1 - r.y0);
    c.ctx.restore();
    applyStroke(c);
    c.ctx.strokeStyle = tint;
    c.ctx.strokeRect(r.x0, r.y0, r.x1 - r.x0, r.y1 - r.y0);
    c.ctx.setLineDash([]);

    // Two arrows: one along price at the start level, one along time. They are
    // what make the box read as a measurement rather than a highlight.
    const midX = (r.x0 + r.x1) / 2;
    const y0 = c.pts[0].y;
    const y1 = c.pts[1].y;
    c.ctx.strokeStyle = tint;
    c.ctx.beginPath();
    c.ctx.moveTo(r.x0, y0);
    c.ctx.lineTo(r.x1, y0);
    c.ctx.stroke();
    arrowHead(c, { x: r.x0, y: y0 }, { x: r.x1, y: y0 });
    c.ctx.beginPath();
    c.ctx.moveTo(midX, y0);
    c.ctx.lineTo(midX, y1);
    c.ctx.stroke();
    arrowHead(c, { x: midX, y: y0 }, { x: midX, y: y1 });

    if (c.style.showLabels === false) return;
    // Bars come from logical indices, so the count matches the gapless axis
    // rather than raw elapsed time; the calendar span comes from the times.
    const i0 = c.rc.dataLayer.timeToIndexFloat(p[0].time);
    const i1 = c.rc.dataLayer.timeToIndexFloat(p[1].time);
    const bars = Math.abs(Math.round(i1 - i0));
    const sign = up ? '+' : '';
    const lines = [
      `${sign}${c.formatPrice(chg)} (${sign}${pct.toFixed(2)}%)`,
      `${grouped(bars)} bars, ${humanSpan(p[1].time - p[0].time)}`,
    ];
    // Volume over the span, when the pane can hand us the bars.
    const src = c.rc.bars?.();
    if (src !== undefined && src.length > 0) {
      const lo = Math.min(p[0].time, p[1].time);
      const hi = Math.max(p[0].time, p[1].time);
      let vol = 0;
      let seen = false;
      for (const b of src) {
        if (b.time < lo) continue;
        if (b.time > hi) break;
        if (b.volume !== undefined) { vol += b.volume; seen = true; }
      }
      if (seen) lines.push(`Vol ${compactNumber(vol)}`);
    }
    chip(c, lines, midX, Math.max(y0, y1) + 6 * d, tint, { align: 'center', place: 'below' });
  },
  distance: (x, y, h) => distToRect(x, y, h.pts[0], h.pts[1], true),
};

/** The numbers a long / short position calculator reports. */
export interface PositionSizing {
  /** Stop distance in price points. */
  riskPoints: number;
  /** Target distance in price points. */
  rewardPoints: number;
  /** reward ÷ risk; 0 when the stop sits on the entry. */
  rr: number;
  /** Contract multiplier in force (1 for cash). */
  lotSize: number;
  /** Whole lots the risk budget affords. Always 0 or more. */
  lots: number;
  /** Order quantity — `lots × lotSize` for derivatives, shares for cash. */
  qty: number;
  /** Currency at risk if the stop is hit. */
  riskAmount: number;
  /** Currency gained if the target is met. */
  rewardAmount: number;
  /** True when `qty` had to be capped by `maxQty` (an exchange freeze limit). */
  capped: boolean;
}

/**
 * Position size from a risk budget, respecting how the instrument trades.
 *
 * The budget is `accountSize × risk%`, and the stop distance is what spends it.
 * Everything else is the market's rules:
 *
 *  - **Cash** (`lotSize` 1) sizes in whole shares.
 *  - **Derivatives** — F&O, currency, commodity — trade in indivisible lots, so
 *    the budget buys a whole number of lots and the quantity is `lots × lotSize`.
 *    A budget that cannot afford one lot yields 0, which is the honest answer:
 *    the trade is too big for the account at that stop.
 *  - **`maxQty`** caps the result where the exchange caps a single order (the
 *    NSE freeze quantity), rounded back down to a whole lot.
 *
 * Exported so a host can show the same numbers in its own panel without
 * re-deriving them and drifting from what the chart draws.
 */
export function sizePosition(
  entry: number,
  target: number,
  stop: number,
  style: Pick<DrawingStyle, 'accountSize' | 'risk' | 'lotSize' | 'maxQty'>,
): PositionSizing {
  const riskPoints = Math.abs(entry - stop);
  const rewardPoints = Math.abs(target - entry);
  const rr = riskPoints > 0 ? rewardPoints / riskPoints : 0;
  const lotSize = Math.max(1, Math.floor(style.lotSize ?? 1));
  const budget = (style.accountSize ?? 0) * ((style.risk ?? 0) / 100);

  let lots = 0;
  if (riskPoints > 0 && budget > 0) {
    lots = Math.floor(budget / (riskPoints * lotSize));
  }
  let qty = lots * lotSize;

  const cap = style.maxQty ?? 0;
  const capped = cap > 0 && qty > cap;
  if (capped) {
    // Round the cap down to a whole lot — a part lot is not sendable either.
    lots = Math.floor(cap / lotSize);
    qty = lots * lotSize;
  }

  return {
    riskPoints,
    rewardPoints,
    rr,
    lotSize,
    lots,
    qty,
    riskAmount: qty * riskPoints,
    rewardAmount: qty * rewardPoints,
    capped,
  };
}

/**
 * Long / short position calculator — entry, target, stop.
 *
 * One click places the whole thing at a 1:1 reward:risk and every anchor stays
 * draggable, so the tool opens with something to adjust rather than asking for
 * three clicks before it shows anything. {@link sizePosition} turns the three
 * prices into an order quantity the instrument can actually be traded in.
 */
function positionTool(id: string, name: string, long: boolean): DrawingTool {
  return {
    id, name, points: 1,
    defaultStyle: { showLabels: true, fillOpacity: 0.13, accountSize: 100000, risk: 1 },
    expand: (clicked, ctx) => {
      const p = clicked[0];
      // 1% of price gives a 1:1 box that reads sensibly on any instrument; the
      // fallback covers a zero/near-zero price where a ratio has no meaning.
      const off = Math.abs(p.price) * 0.01 || 1;
      // ~8% of what is on screen, so the box is grabbable at any zoom instead
      // of a hairline when zoomed out or pane-filling when zoomed in.
      const bars = Math.max(5, Math.round(ctx.visibleBars * 0.08));
      const far = p.time + Math.max(1, ctx.barSeconds) * bars;
      return long
        ? [p, { time: far, price: p.price + off }, { time: far, price: p.price - off }]
        : [p, { time: far, price: p.price - off }, { time: far, price: p.price + off }];
    },
    draw: (c) => {
      // A single-anchor preview exists between the click and `expand`.
      if (c.drawing.points.length < 3 || c.pts.length < 3) return;
      const [entry, target, stop] = c.drawing.points;
      const d = c.rc.dpr;
      const x0 = Math.min(c.pts[0].x, c.pts[1].x, c.pts[2].x);
      const x1 = Math.max(c.pts[0].x, c.pts[1].x, c.pts[2].x);
      const yE = c.rc.priceScale.priceToY(entry.price) * d;
      const yT = c.rc.priceScale.priceToY(target.price) * d;
      const yS = c.rc.priceScale.priceToY(stop.price) * d;
      const band = (yA: number, yB: number, color: string): void => {
        c.ctx.save();
        c.ctx.globalAlpha = c.style.fillOpacity ?? 0.13;
        c.ctx.fillStyle = color;
        c.ctx.fillRect(x0, Math.min(yA, yB), x1 - x0, Math.abs(yB - yA));
        c.ctx.restore();
      };
      band(yE, yT, UP_TINT);
      band(yE, yS, DOWN_TINT);
      applyStroke(c);
      for (const y of [yE, yT, yS]) {
        const yy = Math.round(y) + 0.5;
        c.ctx.beginPath();
        c.ctx.moveTo(x0, yy);
        c.ctx.lineTo(x1, yy);
        c.ctx.stroke();
      }
      c.ctx.setLineDash([]);
      if (c.style.showLabels === false) return;
      // Chip presentation from master; the quantity behind it from
      // `sizePosition`, so a derivative sizes in whole lots and an exchange
      // freeze limit caps it. The inline `budget ÷ stop` this replaced sized
      // every instrument as though it traded in single units, which is wrong for
      // every F&O, currency and commodity contract.
      const size = sizePosition(entry.price, target.price, stop.price, c.style);
      const pctOf = (delta: number): string =>
        (entry.price !== 0 ? (delta / entry.price) * 100 : 0).toFixed(3);
      const cash = (delta: number): string =>
        size.qty > 0 ? `, Amount: ${grouped(size.qty * delta)}` : '';
      const cx = (x0 + x1) / 2;
      // Each readout hugs its own line, on the outside of the box — the target
      // chip sits past the target line whichever side of entry it landed on, so
      // it reads the same for a long and an inverted-drag short.
      chip(c, [`Target: ${c.formatPrice(size.rewardPoints)} (${pctOf(size.rewardPoints)}%)${cash(size.rewardPoints)}`],
        cx, yT, UP_TINT, { align: 'center', place: yT <= yE ? 'above' : 'below' });
      chip(c, [`Stop: ${c.formatPrice(size.riskPoints)} (${pctOf(size.riskPoints)}%)${cash(size.riskPoints)}`],
        cx, yS, DOWN_TINT, { align: 'center', place: yS >= yE ? 'below' : 'above' });
      // Lots and the freeze cap only appear when they actually apply, so a cash
      // instrument's chip reads exactly as it did before.
      const lotText = size.lotSize > 1 && size.lots > 0
        ? ` (${size.lots} lot${size.lots === 1 ? '' : 's'})`
        : '';
      const capText = size.capped ? ' · capped at freeze limit' : '';
      chip(c, [
        `${long ? 'Long' : 'Short'} · Qty: ${size.qty > 0 ? grouped(size.qty) : '—'}${lotText}${capText}`,
        `Risk/reward ratio: ${size.rr.toFixed(2)}`,
      ], cx, yE, c.rc.theme.background, { align: 'center', place: 'middle' });
    },
    distance: (x, y, h) => {
      if (h.pts.length < 3) return null;
      const x0 = Math.min(h.pts[0].x, h.pts[1].x, h.pts[2].x);
      const x1 = Math.max(h.pts[0].x, h.pts[1].x, h.pts[2].x);
      if (x < x0 - 4 || x > x1 + 4) return null;
      const ys = h.drawing.points.map((p) => h.rc.priceScale.priceToY(p.price));
      const lo = Math.min(...ys);
      const hi = Math.max(...ys);
      return y >= lo && y <= hi ? 0 : Math.min(Math.abs(y - lo), Math.abs(y - hi));
    },
  };
}

export const LONG_POSITION = positionTool('long-position', 'Long Position', true);
export const SHORT_POSITION = positionTool('short-position', 'Short Position', false);

// ── annotation ────────────────────────────────────────────────────────────

const TEXT_PAD = 5;
const LINE_GAP = 1.35;
const DEFAULT_FONT = 'ui-sans-serif, system-ui, -apple-system, Segoe UI, Roboto, sans-serif';

/** The CSS font shorthand for a text drawing's style. */
function textFont(style: DrawingStyle, sizePx: number): string {
  const weight = style.fontWeight === 'bold' ? '700 ' : '';
  const italic = style.fontStyle === 'italic' ? 'italic ' : '';
  return `${italic}${weight}${sizePx}px ${style.fontFamily ?? DEFAULT_FONT}`;
}

/**
 * Split into rendered lines: honour explicit `\n` always, and soft-wrap each
 * paragraph at `wrapWidth` when `wrap` is on. Measured with the *live* context
 * so the wrap matches the font actually being drawn.
 */
function textLines(ctx: CanvasRenderingContext2D, style: DrawingStyle, maxWidth: number): string[] {
  const paragraphs = (style.text ?? '').split('\n');
  if (style.wrap !== true) return paragraphs;
  const out: string[] = [];
  for (const para of paragraphs) {
    const words = para.split(/\s+/).filter((w) => w !== '');
    if (words.length === 0) { out.push(''); continue; }
    let line = words[0];
    for (let i = 1; i < words.length; i++) {
      const next = `${line} ${words[i]}`;
      if (ctx.measureText(next).width > maxWidth) { out.push(line); line = words[i]; }
      else line = next;
    }
    out.push(line);
  }
  return out;
}

/** Measured box of a text drawing, in media px, anchored at its top-left. */
function textBox(
  ctx: CanvasRenderingContext2D,
  style: DrawingStyle,
  dpr: number,
): { lines: string[]; width: number; height: number; lineHeight: number } {
  const size = (style.fontSize ?? 13) * dpr;
  ctx.font = textFont(style, size);
  const maxWidth = (style.wrapWidth ?? 220) * dpr;
  const lines = textLines(ctx, style, maxWidth);
  let width = 0;
  for (const l of lines) width = Math.max(width, ctx.measureText(l).width);
  const lineHeight = size * LINE_GAP;
  return {
    lines,
    width: width + TEXT_PAD * 2 * dpr,
    height: lines.length * lineHeight + TEXT_PAD * 2 * dpr,
    lineHeight,
  };
}


/**
 * Draw a shape's attached label. Shapes carry an optional `text` that renders
 * inside (or just above) their bounds, with its own colour, font, and
 * alignment — the outline colour and the label colour are different decisions.
 */
function shapeLabel(c: DrawContext, x0: number, y0: number, x1: number, y1: number): void {
  const { ctx, rc, style } = c;
  const text = style.text;
  if (text === undefined || text === '') return;
  const d = rc.dpr;
  const size = (style.fontSize ?? 14) * d;
  const pad = 6 * d;
  ctx.save();
  ctx.setLineDash([]);
  ctx.font = textFont(style, size);
  ctx.fillStyle = style.fontColor ?? style.color;
  ctx.textBaseline = 'top';

  const lines = style.wrap === true
    ? textLines(ctx, style, Math.max(20 * d, x1 - x0 - pad * 2))
    : text.split('\n');
  const lineHeight = size * LINE_GAP;
  const blockH = lines.length * lineHeight;

  const align = style.textAlign ?? 'left';
  ctx.textAlign = align;
  const tx = align === 'center' ? (x0 + x1) / 2 : align === 'right' ? x1 - pad : x0 + pad;

  // `outside` lifts the block clear of the shape so it never sits on the outline.
  let ty: number;
  if (style.textPosition === 'outside') {
    ty = y0 - blockH - pad;
  } else {
    const v = style.textVAlign ?? 'top';
    ty = v === 'middle' ? (y0 + y1 - blockH) / 2
      : v === 'bottom' ? y1 - blockH - pad
      : y0 + pad;
  }
  for (const line of lines) {
    ctx.fillText(line, tx, ty);
    ty += lineHeight;
  }
  ctx.restore();
}

export const TEXT: DrawingTool = {
  id: 'text', name: 'Text', points: 1,
  defaultStyle: {
    text: 'Text', fontSize: 14, fontWeight: 'normal', fontStyle: 'normal',
    background: false, backgroundOpacity: 1, border: false, wrap: false,
    wrapWidth: 220, textAlign: 'left',
  },
  draw: (c) => {
    const { ctx, rc, style } = c;
    const d = rc.dpr;
    const box = textBox(ctx, style, d);
    const x = c.pts[0].x;
    const y = c.pts[0].y;

    ctx.save();
    ctx.setLineDash([]);
    if (style.background === true) {
      ctx.globalAlpha = style.backgroundOpacity ?? 1;
      ctx.fillStyle = style.backgroundColor ?? rc.theme.background;
      ctx.beginPath();
      ctx.roundRect(x, y, box.width, box.height, 4 * d);
      ctx.fill();
      ctx.globalAlpha = 1;
    }
    if (style.border === true) {
      ctx.strokeStyle = style.borderColor ?? style.color;
      ctx.lineWidth = Math.max(1, style.lineWidth * d);
      ctx.beginPath();
      ctx.roundRect(x, y, box.width, box.height, 4 * d);
      ctx.stroke();
    }

    ctx.font = textFont(style, (style.fontSize ?? 13) * d);
    ctx.fillStyle = style.color;
    ctx.textBaseline = 'top';
    const align = style.textAlign ?? 'left';
    ctx.textAlign = align;
    const inner = box.width - TEXT_PAD * 2 * d;
    const tx = align === 'center' ? x + box.width / 2
      : align === 'right' ? x + box.width - TEXT_PAD * d
      : x + TEXT_PAD * d;
    let ty = y + TEXT_PAD * d;
    for (const line of box.lines) {
      ctx.fillText(line, tx, ty);
      ty += box.lineHeight;
    }
    void inner;
    ctx.restore();
  },
  distance: (x, y, h) => {
    // Measure with a throwaway 2D context so the hit box matches what is drawn
    // (wrapping and font metrics decide the real size, not a character count).
    const style = h.drawing.style;
    const size = style.fontSize ?? 13;
    const p = h.pts[0];
    const probe = measureContext();
    const box = probe === null
      ? { width: (style.text ?? '').length * size * 0.6 + 10, height: size * LINE_GAP + 10 }
      : textBox(probe, style, 1);
    return x >= p.x - 3 && x <= p.x + box.width + 3
      && y >= p.y - 3 && y <= p.y + box.height + 3 ? 0 : null;
  },
};

/** A 1×1 offscreen context used only for text measurement. Cached. */
let _probe: CanvasRenderingContext2D | null | undefined;
function measureContext(): CanvasRenderingContext2D | null {
  if (_probe !== undefined) return _probe;
  try {
    _probe = (typeof document === 'undefined' ? null : document.createElement('canvas').getContext('2d'));
  } catch {
    _probe = null;
  }
  return _probe;
}

/**
 * Path — click each vertex, double-click to finish, arrowhead on the last leg.
 * The arrow is what separates it from `polyline`: a path points somewhere.
 */
export const PATH: DrawingTool = {
  id: 'path', name: 'Path', points: 0,
  draw: (c) => {
    if (c.pts.length < 2) return;
    applyStroke(c);
    c.ctx.beginPath();
    c.ctx.moveTo(c.pts[0].x, c.pts[0].y);
    for (let i = 1; i < c.pts.length; i++) c.ctx.lineTo(c.pts[i].x, c.pts[i].y);
    c.ctx.stroke();
    c.ctx.setLineDash([]);
    arrowHead(c, c.pts[c.pts.length - 2], c.pts[c.pts.length - 1]);
  },
  distance: (x, y, h) => (h.pts.length < 2 ? null : distToPolyline(x, y, h.pts)),
};

/** Brush — freehand ink: press, drag, release. */
export const BRUSH: DrawingTool = {
  id: 'brush', name: 'Brush', points: 0, freehand: true,
  defaultStyle: { lineWidth: 2 },
  draw: (c) => {
    if (c.pts.length < 2) return;
    applyStroke(c);
    c.ctx.lineCap = 'round';
    c.ctx.lineJoin = 'round';
    c.ctx.beginPath();
    c.ctx.moveTo(c.pts[0].x, c.pts[0].y);
    for (let i = 1; i < c.pts.length; i++) c.ctx.lineTo(c.pts[i].x, c.pts[i].y);
    c.ctx.stroke();
    c.ctx.setLineDash([]);
  },
  distance: (x, y, h) => (h.pts.length < 2 ? null : distToPolyline(x, y, h.pts)),
};

/**
 * Rotated rectangle — anchors 0→1 lay out one edge (and so the rotation), and
 * anchor 2 sets the depth perpendicular to it. An axis-aligned `rectangle`
 * cannot follow a trend channel; this can.
 */
export const ROTATED_RECTANGLE: DrawingTool = {
  id: 'rotated-rectangle', name: 'Rotated Rectangle', points: 3,
  defaultStyle: { fill: true, fillOpacity: 0.12 },
  draw: (c) => {
    if (c.pts.length < 3) return;
    const corners = rotatedCorners(c.pts[0], c.pts[1], c.pts[2]);
    c.ctx.beginPath();
    c.ctx.moveTo(corners[0].x, corners[0].y);
    for (let i = 1; i < 4; i++) c.ctx.lineTo(corners[i].x, corners[i].y);
    c.ctx.closePath();
    if (c.style.fill === true) {
      c.ctx.save();
      c.ctx.globalAlpha = c.style.fillOpacity ?? 0.12;
      c.ctx.fillStyle = fillStyleOf(c);
      c.ctx.fill();
      c.ctx.restore();
    }
    applyStroke(c);
    c.ctx.stroke();
    c.ctx.setLineDash([]);
  },
  distance: (x, y, h) => {
    if (h.pts.length < 3) return null;
    const corners = rotatedCorners(h.pts[0], h.pts[1], h.pts[2]);
    if (h.drawing.style.fill === true && pointInPolygon(x, y, corners)) return 0;
    let best = Infinity;
    for (let i = 0; i < 4; i++) {
      best = Math.min(best, distToSegment(x, y, corners[i], corners[(i + 1) % 4]));
    }
    return best;
  },
};

/**
 * The four corners of a rotated rectangle: `a`→`b` is one edge, and `c` is
 * projected onto the perpendicular to give the depth.
 */
function rotatedCorners(a: ScreenPoint, b: ScreenPoint, c: ScreenPoint): ScreenPoint[] {
  const dx = b.x - a.x;
  const dy = b.y - a.y;
  const len = Math.hypot(dx, dy) || 1;
  // Unit normal to the a→b edge; the signed projection of `c` onto it is depth.
  const nx = -dy / len;
  const ny = dx / len;
  const depth = (c.x - b.x) * nx + (c.y - b.y) * ny;
  return [
    a, b,
    { x: b.x + nx * depth, y: b.y + ny * depth },
    { x: a.x + nx * depth, y: a.y + ny * depth },
  ];
}

/** Even-odd point-in-polygon, for filled shapes that are not axis-aligned. */
function pointInPolygon(x: number, y: number, poly: readonly ScreenPoint[]): boolean {
  let inside = false;
  for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) {
    const a = poly[i];
    const b = poly[j];
    if ((a.y > y) !== (b.y > y) && x < ((b.x - a.x) * (y - a.y)) / (b.y - a.y) + a.x) inside = !inside;
  }
  return inside;
}

/**
 * Double curve — an S through three anchors. `curve` bends one way off a single
 * control; this mirrors that control about the midpoint so the second half bends
 * back, which is the shape a rounded top-then-bottom actually needs.
 */
export const DOUBLE_CURVE: DrawingTool = {
  id: 'double-curve', name: 'Double Curve', points: 3,
  draw: (c) => {
    if (c.pts.length < 3) return;
    const [a, mid, b] = c.pts;
    applyStroke(c);
    c.ctx.beginPath();
    c.ctx.moveTo(a.x, a.y);
    // Second control is `mid` reflected through the chord's midpoint.
    c.ctx.bezierCurveTo(mid.x, mid.y, a.x + b.x - mid.x, a.y + b.y - mid.y, b.x, b.y);
    c.ctx.stroke();
    c.ctx.setLineDash([]);
  },
  distance: (x, y, h) => {
    if (h.pts.length < 3) return null;
    const [a, mid, b] = h.pts;
    const c2 = { x: a.x + b.x - mid.x, y: a.y + b.y - mid.y };
    return distToPolyline(x, y, sampleCubic(a, mid, c2, b, 24));
  },
};

/** Flatten a cubic bezier to `steps` segments, for hit-testing curves. */
function sampleCubic(a: ScreenPoint, c1: ScreenPoint, c2: ScreenPoint, b: ScreenPoint, steps: number): ScreenPoint[] {
  const out: ScreenPoint[] = [];
  for (let i = 0; i <= steps; i++) {
    const t = i / steps;
    const u = 1 - t;
    const w0 = u * u * u;
    const w1 = 3 * u * u * t;
    const w2 = 3 * u * t * t;
    const w3 = t * t * t;
    out.push({
      x: w0 * a.x + w1 * c1.x + w2 * c2.x + w3 * b.x,
      y: w0 * a.y + w1 * c1.y + w2 * c2.y + w3 * b.y,
    });
  }
  return out;
}

// ── cycles ────────────────────────────────────────────────────────────────

/** How many repeats a cycle tool draws past its two anchors. */
const CYCLE_REPEATS = 12;

/**
 * Cyclic lines — vertical lines repeating at the interval the two anchors set,
 * for reading a rhythm forward off a measured swing.
 */
export const CYCLIC_LINES: DrawingTool = {
  id: 'cyclic-lines', name: 'Cyclic Lines', points: 2,
  defaultStyle: { lineStyle: 'dashed' },
  draw: (c) => {
    const [a, b] = c.pts;
    const step = b.x - a.x;
    if (!Number.isFinite(step) || Math.abs(step) < 0.5) return;
    const h = c.rc.plotHeight * c.rc.dpr;
    const w = c.rc.plotWidth * c.rc.dpr;
    applyStroke(c);
    c.ctx.beginPath();
    for (let i = 0; i <= CYCLE_REPEATS; i++) {
      const x = Math.round(a.x + step * i) + 0.5;
      if (x < 0 || x > w) continue;   // off-plot repeats cost nothing to skip
      c.ctx.moveTo(x, 0);
      c.ctx.lineTo(x, h);
    }
    c.ctx.stroke();
    c.ctx.setLineDash([]);
  },
  distance: (x, y, h) => {
    void y;
    const step = h.pts[1].x - h.pts[0].x;
    if (!Number.isFinite(step) || Math.abs(step) < 0.5) return null;
    // Distance to the nearest repeat, clamped to the ones actually drawn.
    const k = Math.round((x - h.pts[0].x) / step);
    if (k < 0 || k > CYCLE_REPEATS) return null;
    return Math.abs(x - (h.pts[0].x + step * k));
  },
};

/**
 * Time cycles — semicircles of the anchors' width repeating along the axis, the
 * classic cycle-projection overlay.
 */
export const TIME_CYCLES: DrawingTool = {
  id: 'time-cycles', name: 'Time Cycles', points: 2,
  draw: (c) => {
    const [a, b] = c.pts;
    const step = b.x - a.x;
    if (!Number.isFinite(step) || Math.abs(step) < 1) return;
    const r = Math.abs(step) / 2;
    applyStroke(c);
    c.ctx.beginPath();
    for (let i = 0; i < CYCLE_REPEATS; i++) {
      const cx = a.x + step * i + step / 2;
      if (cx + r < 0 || cx - r > c.rc.plotWidth * c.rc.dpr) continue;
      c.ctx.moveTo(cx + r, a.y);
      c.ctx.arc(cx, a.y, r, 0, Math.PI, true);   // upper half only
    }
    c.ctx.stroke();
    c.ctx.setLineDash([]);
  },
  distance: (x, y, h) => {
    const [a, b] = h.pts;
    const step = b.x - a.x;
    if (!Number.isFinite(step) || Math.abs(step) < 1) return null;
    const r = Math.abs(step) / 2;
    let best = Infinity;
    for (let i = 0; i < CYCLE_REPEATS; i++) {
      const cx = a.x + step * i + step / 2;
      // Distance to the rim, and only the drawn (upper) half counts.
      if (y > a.y + 2) continue;
      best = Math.min(best, Math.abs(Math.hypot(x - cx, y - a.y) - r));
    }
    return Number.isFinite(best) ? best : null;
  },
};

/**
 * Sine line — a full wave between the anchors: the horizontal span is one
 * period, the vertical offset its amplitude.
 */
export const SINE_LINE: DrawingTool = {
  id: 'sine-line', name: 'Sine Line', points: 2,
  draw: (c) => {
    const pts = sinePoints(c.pts[0], c.pts[1]);
    if (pts === null) return;
    applyStroke(c);
    c.ctx.beginPath();
    c.ctx.moveTo(pts[0].x, pts[0].y);
    for (let i = 1; i < pts.length; i++) c.ctx.lineTo(pts[i].x, pts[i].y);
    c.ctx.stroke();
    c.ctx.setLineDash([]);
  },
  distance: (x, y, h) => {
    const pts = sinePoints(h.pts[0], h.pts[1]);
    return pts === null ? null : distToPolyline(x, y, pts);
  },
};

/** One period of a sine from `a` to `a.x + span`, amplitude `b.y - a.y`. */
function sinePoints(a: ScreenPoint, b: ScreenPoint): ScreenPoint[] | null {
  const span = b.x - a.x;
  const amp = b.y - a.y;
  if (!Number.isFinite(span) || Math.abs(span) < 1) return null;
  const steps = 64;
  const out: ScreenPoint[] = [];
  for (let i = 0; i <= steps; i++) {
    const t = i / steps;
    out.push({ x: a.x + span * t, y: a.y + amp * Math.sin(t * Math.PI * 2) });
  }
  return out;
}

// ── notes & marks ─────────────────────────────────────────────────────────

/**
 * Price label — a pill of the anchored price with a tail pointing at the bar.
 * Reads its value off the anchor, so dragging it re-reads rather than going
 * stale the way a typed-in `text` would.
 */
export const PRICE_LABEL: DrawingTool = {
  id: 'price-label', name: 'Price Label', points: 1,
  defaultStyle: { fontSize: 12 },
  draw: (c) => {
    const p = c.pts[0];
    const d = c.rc.dpr;
    const text = c.style.text !== undefined && c.style.text !== ''
      ? c.style.text : c.formatPrice(c.drawing.points[0].price);
    const box = calloutBox(c, [text], p.x + 18 * d, p.y - 30 * d);
    calloutTail(c, box, p, c.style.color);
    calloutText(c, box, [text], c.style.color);
  },
  distance: (x, y, h) => {
    // The anchor plus a generous box to its upper right — measuring the real
    // text needs a context the hit path does not have.
    const p = h.pts[0];
    const w = 64;
    const hgt = 22;
    const x0 = p.x + 18;
    const y0 = p.y - 30 - hgt / 2;
    if (x >= x0 && x <= x0 + w && y >= y0 && y <= y0 + hgt) return 0;
    return Math.hypot(x - p.x, y - p.y) <= 10 ? 0 : null;
  },
};

/**
 * Callout — a text bubble on its own anchor with a tail back to the point it
 * annotates, so the note can sit clear of the price action it refers to.
 */
export const CALLOUT: DrawingTool = {
  id: 'callout', name: 'Callout', points: 2,
  defaultStyle: { fontSize: 12, text: 'Note' },
  draw: (c) => {
    if (c.pts.length < 2) return;
    const [target, seat] = c.pts;
    const lines = (c.style.text ?? 'Note').split('\n');
    const box = calloutBox(c, lines, seat.x, seat.y);
    calloutTail(c, box, target, c.style.color);
    calloutText(c, box, lines, c.style.color);
  },
  distance: (x, y, h) => {
    if (h.pts.length < 2) return null;
    const [target, seat] = h.pts;
    // Bubble body, else the tail back to the annotated point.
    if (Math.abs(x - seat.x) <= 60 && Math.abs(y - seat.y) <= 16) return 0;
    return distToSegment(x, y, target, seat);
  },
};

/** Rounded bubble at (x, y) sized to `lines`; returns its device-px box. */
function calloutBox(
  c: DrawContext, lines: readonly string[], x: number, y: number,
): { x: number; y: number; w: number; h: number } {
  const d = c.rc.dpr;
  const size = (c.style.fontSize ?? 12) * d;
  c.ctx.save();
  c.ctx.font = `${size}px ui-sans-serif, system-ui, sans-serif`;
  let textW = 0;
  for (const t of lines) textW = Math.max(textW, c.ctx.measureText(t).width);
  c.ctx.restore();
  const w = textW + 14 * d;
  const h = size * 1.4 * lines.length + 8 * d;
  return { x: x - w / 2, y: y - h / 2, w, h };
}

/** Bubble fill plus the tail from it to `tip`. */
function calloutTail(
  c: DrawContext, box: { x: number; y: number; w: number; h: number }, tip: ScreenPoint, color: string,
): void {
  const d = c.rc.dpr;
  const cx = box.x + box.w / 2;
  const cy = box.y + box.h / 2;
  const ang = Math.atan2(tip.y - cy, tip.x - cx);
  // Two base points either side of the bubble→tip direction, so the tail always
  // leaves from the edge facing the point it annotates.
  const base = 5 * d;
  const bx = cx + Math.cos(ang) * (box.w / 2 - base);
  const by = cy + Math.sin(ang) * (box.h / 2 - base);
  c.ctx.save();
  c.ctx.setLineDash([]);
  c.ctx.fillStyle = color;
  c.ctx.beginPath();
  c.ctx.moveTo(tip.x, tip.y);
  c.ctx.lineTo(bx - Math.sin(ang) * base, by + Math.cos(ang) * base);
  c.ctx.lineTo(bx + Math.sin(ang) * base, by - Math.cos(ang) * base);
  c.ctx.closePath();
  c.ctx.fill();
  c.ctx.beginPath();
  roundRectPath(c.ctx, box.x, box.y, box.w, box.h, 5 * d);
  c.ctx.fill();
  // Anchor dot, so the exact bar being annotated stays visible.
  c.ctx.beginPath();
  c.ctx.arc(tip.x, tip.y, 2.5 * d, 0, Math.PI * 2);
  c.ctx.fill();
  c.ctx.restore();
}

/** Bubble text, centred, in the contrasting colour. */
function calloutText(
  c: DrawContext, box: { x: number; y: number; w: number; h: number }, lines: readonly string[], color: string,
): void {
  const d = c.rc.dpr;
  const size = (c.style.fontSize ?? 12) * d;
  c.ctx.save();
  c.ctx.setLineDash([]);
  c.ctx.font = `${size}px ui-sans-serif, system-ui, sans-serif`;
  c.ctx.textAlign = 'center';
  c.ctx.textBaseline = 'middle';
  c.ctx.fillStyle = c.style.fontColor ?? contrastText(color);
  const lh = size * 1.4;
  const top = box.y + box.h / 2 - (lh * (lines.length - 1)) / 2;
  for (let i = 0; i < lines.length; i++) c.ctx.fillText(lines[i], box.x + box.w / 2, top + lh * i);
  c.ctx.restore();
}

/** Flag mark — a pennant on a pole at one anchor, for tagging a bar. */
export const FLAG_MARK: DrawingTool = {
  id: 'flag-mark', name: 'Flag Mark', points: 1,
  defaultStyle: { fill: true, fillOpacity: 0.95 },
  draw: (c) => {
    const p = c.pts[0];
    const d = c.rc.dpr;
    const pole = 22 * d;
    const flagW = 15 * d;
    const flagH = 11 * d;
    applyStroke(c);
    c.ctx.beginPath();
    c.ctx.moveTo(p.x, p.y);
    c.ctx.lineTo(p.x, p.y - pole);
    c.ctx.stroke();
    c.ctx.setLineDash([]);
    // Pennant off the top of the pole, notched on its trailing edge.
    c.ctx.beginPath();
    c.ctx.moveTo(p.x, p.y - pole);
    c.ctx.lineTo(p.x + flagW, p.y - pole + flagH * 0.28);
    c.ctx.lineTo(p.x + flagW * 0.72, p.y - pole + flagH * 0.5);
    c.ctx.lineTo(p.x + flagW, p.y - pole + flagH * 0.72);
    c.ctx.lineTo(p.x, p.y - pole + flagH);
    c.ctx.closePath();
    c.ctx.save();
    c.ctx.globalAlpha = c.style.fillOpacity ?? 0.95;
    c.ctx.fillStyle = fillStyleOf(c);
    c.ctx.fill();
    c.ctx.restore();
  },
  distance: (x, y, h) => {
    const p = h.pts[0];
    // Pole plus the pennant box hanging off its top.
    if (x >= p.x - 4 && x <= p.x + 16 && y >= p.y - 24 && y <= p.y + 2) return 0;
    return Math.hypot(x - p.x, y - p.y) <= 8 ? 0 : null;
  },
};

/** Every built-in, in toolbar order. */
/**
 * Measurers. `measure` reports price *and* time together; these two constrain it
 * to one axis, which is what you want when the other one is noise — sizing a
 * retracement without caring how long it took, or counting bars to an event
 * without caring where price went.
 */
export const PRICE_RANGE: DrawingTool = {
  id: 'price-range', name: 'Price Range', points: 2,
  defaultStyle: { fill: true, showLabels: true, fillOpacity: 0.1 },
  draw: (c) => {
    const d = c.rc.dpr;
    const p = c.drawing.points;
    const chg = p[1].price - p[0].price;
    const pct = p[0].price !== 0 ? (chg / p[0].price) * 100 : 0;
    const up = chg >= 0;
    const tint = up ? '#26a69a' : '#ef5350';
    // Span the drawn x-range so the band reads as a price zone, not a bare line.
    const x0 = Math.min(c.pts[0].x, c.pts[1].x);
    const x1 = Math.max(c.pts[0].x, c.pts[1].x) + (c.pts[0].x === c.pts[1].x ? 60 * d : 0);
    const y0 = c.pts[0].y;
    const y1 = c.pts[1].y;
    c.ctx.save();
    c.ctx.globalAlpha = c.style.fillOpacity ?? 0.1;
    c.ctx.fillStyle = tint;
    c.ctx.fillRect(x0, Math.min(y0, y1), x1 - x0, Math.abs(y1 - y0));
    c.ctx.restore();
    applyStroke(c);
    c.ctx.strokeStyle = tint;
    c.ctx.beginPath();
    for (const y of [y0, y1]) { c.ctx.moveTo(x0, Math.round(y) + 0.5); c.ctx.lineTo(x1, Math.round(y) + 0.5); }
    // The measured leg, with arrow heads at both ends.
    const mx = (x0 + x1) / 2;
    c.ctx.moveTo(mx, y0); c.ctx.lineTo(mx, y1);
    const dir = y1 > y0 ? 1 : -1;
    c.ctx.moveTo(mx - 4 * d, y1 - 5 * d * dir); c.ctx.lineTo(mx, y1); c.ctx.lineTo(mx + 4 * d, y1 - 5 * d * dir);
    c.ctx.moveTo(mx - 4 * d, y0 + 5 * d * dir); c.ctx.lineTo(mx, y0); c.ctx.lineTo(mx + 4 * d, y0 + 5 * d * dir);
    c.ctx.stroke();
    c.ctx.setLineDash([]);
    const sign = up ? '+' : '';
    label(c, `${sign}${c.formatPrice(chg)}  (${sign}${pct.toFixed(2)}%)`, mx + 6 * d, (y0 + y1) / 2, tint);
  },
  distance: (x, y, h) => distToRect(x, y, h.pts[0], h.pts[1], true),
};

export const DATE_RANGE: DrawingTool = {
  id: 'date-range', name: 'Date Range', points: 2,
  defaultStyle: { fill: true, showLabels: true, fillOpacity: 0.1 },
  draw: (c) => {
    const d = c.rc.dpr;
    const p = c.drawing.points;
    const tint = c.style.color;
    const x0 = c.pts[0].x;
    const x1 = c.pts[1].x;
    const y0 = Math.min(c.pts[0].y, c.pts[1].y);
    const y1 = Math.max(c.pts[0].y, c.pts[1].y) + (c.pts[0].y === c.pts[1].y ? 40 * d : 0);
    c.ctx.save();
    c.ctx.globalAlpha = c.style.fillOpacity ?? 0.1;
    c.ctx.fillStyle = tint;
    c.ctx.fillRect(Math.min(x0, x1), y0, Math.abs(x1 - x0), y1 - y0);
    c.ctx.restore();
    applyStroke(c);
    c.ctx.beginPath();
    for (const x of [x0, x1]) { c.ctx.moveTo(Math.round(x) + 0.5, y0); c.ctx.lineTo(Math.round(x) + 0.5, y1); }
    const my = (y0 + y1) / 2;
    c.ctx.moveTo(x0, my); c.ctx.lineTo(x1, my);
    const dir = x1 > x0 ? 1 : -1;
    c.ctx.moveTo(x1 - 5 * d * dir, my - 4 * d); c.ctx.lineTo(x1, my); c.ctx.lineTo(x1 - 5 * d * dir, my + 4 * d);
    c.ctx.moveTo(x0 + 5 * d * dir, my - 4 * d); c.ctx.lineTo(x0, my); c.ctx.lineTo(x0 + 5 * d * dir, my + 4 * d);
    c.ctx.stroke();
    c.ctx.setLineDash([]);
    // Counted on logical indices, so it matches the gapless axis rather than
    // raw elapsed time (a weekend is not 48 bars).
    const i0 = c.rc.dataLayer.timeToIndexFloat(p[0].time);
    const i1 = c.rc.dataLayer.timeToIndexFloat(p[1].time);
    const bars = Math.abs(Math.round(i1 - i0));
    label(c, `${bars} bars`, (x0 + x1) / 2, y0 - 10 * d, tint);
  },
  distance: (x, y, h) => distToRect(x, y, h.pts[0], h.pts[1], true),
};

/**
 * Position forecast — project a move from an anchor. Two anchors give the
 * projected leg; the shape extends the same slope past the target as a dashed
 * cone, so the drawing says "if this continues" rather than just marking a line.
 */
export const FORECAST: DrawingTool = {
  id: 'forecast', name: 'Forecast', points: 2,
  defaultStyle: { fill: true, showLabels: true, fillOpacity: 0.12, lineStyle: 'dashed' },
  draw: (c) => {
    const d = c.rc.dpr;
    const p = c.drawing.points;
    const [a, b] = c.pts;
    const chg = p[1].price - p[0].price;
    const pct = p[0].price !== 0 ? (chg / p[0].price) * 100 : 0;
    const up = chg >= 0;
    const tint = up ? '#26a69a' : '#ef5350';
    // The cone widens with the projected distance — a forecast is less certain
    // the further out it runs, and the shape should say so.
    const spread = Math.abs(b.y - a.y) * 0.35 + 6 * d;
    c.ctx.save();
    c.ctx.globalAlpha = c.style.fillOpacity ?? 0.12;
    c.ctx.fillStyle = tint;
    c.ctx.beginPath();
    c.ctx.moveTo(a.x, a.y);
    c.ctx.lineTo(b.x, b.y - spread);
    c.ctx.lineTo(b.x, b.y + spread);
    c.ctx.closePath();
    c.ctx.fill();
    c.ctx.restore();
    applyStroke(c);
    c.ctx.strokeStyle = tint;
    c.ctx.beginPath();
    c.ctx.moveTo(a.x, a.y);
    c.ctx.lineTo(b.x, b.y);
    c.ctx.stroke();
    c.ctx.setLineDash([]);
    c.ctx.beginPath();
    c.ctx.arc(a.x, a.y, 3 * d, 0, Math.PI * 2);
    c.ctx.fillStyle = tint;
    c.ctx.fill();
    if (c.style.showLabels === false) return;
    const sign = up ? '+' : '';
    // Anchor chip: where the projection was struck from.
    chip(c, [c.formatPrice(p[0].price), isoDate(p[0].time)], a.x, a.y, tint, { align: 'center' });
    // Projection chip: the move, and what it lands on when.
    chip(c, [
      `${sign}${c.formatPrice(chg)} (${sign}${pct.toFixed(2)}%) in ${humanSpan(p[1].time - p[0].time)}`,
      `${c.formatPrice(p[1].price)} · ${isoDate(p[1].time)}`,
    ], b.x, b.y, tint, { align: 'center', place: 'below' });
    // Verdict, once the window has actually elapsed: did price get there? A
    // forecast nobody scores is just a line.
    const bars = c.rc.bars?.();
    if (bars !== undefined && bars.length > 0 && bars[bars.length - 1].time >= p[1].time) {
      let hit = false;
      for (const bar of bars) {
        if (bar.time < p[0].time) continue;
        if (bar.time > p[1].time) break;
        if (up ? bar.high >= p[1].price : bar.low <= p[1].price) { hit = true; break; }
      }
      chip(c, [hit ? 'SUCCESS' : 'MISSED'], b.x, b.y + 36 * d,
        hit ? '#4a934a' : '#8a4a4a', { align: 'center', place: 'below' });
    }
  },
  distance: (x, y, h) => distToSegment(x, y, h.pts[0], h.pts[1]),
};

// ── shapes ────────────────────────────────────────────────────────────────

/**
 * Circle from centre + a radius handle. The radius is measured in *pixels*, so
 * it stays a circle on screen instead of the ellipse the two axes' differing
 * scales would otherwise produce.
 */
export const CIRCLE: DrawingTool = {
  id: 'circle', name: 'Circle', points: 2,
  defaultStyle: { fill: true },
  draw: (c) => {
    const [a, b] = c.pts;
    const r = Math.hypot(b.x - a.x, b.y - a.y);
    c.ctx.beginPath();
    c.ctx.arc(a.x, a.y, r, 0, Math.PI * 2);
    withFill(c, () => c.ctx.fill());
    applyStroke(c);
    c.ctx.stroke();
    c.ctx.setLineDash([]);
  },
  distance: (x, y, h) => {
    const [a, b] = h.pts;
    const r = Math.hypot(b.x - a.x, b.y - a.y);
    const d = Math.hypot(x - a.x, y - a.y);
    if (h.drawing.style.fill === true && d <= r) return 0;
    return Math.abs(d - r);
  },
};

export const TRIANGLE: DrawingTool = {
  id: 'triangle', name: 'Triangle', points: 3,
  defaultStyle: { fill: true },
  draw: (c) => {
    c.ctx.beginPath();
    c.ctx.moveTo(c.pts[0].x, c.pts[0].y);
    c.ctx.lineTo(c.pts[1].x, c.pts[1].y);
    c.ctx.lineTo(c.pts[2].x, c.pts[2].y);
    c.ctx.closePath();
    withFill(c, () => c.ctx.fill());
    applyStroke(c);
    c.ctx.stroke();
    c.ctx.setLineDash([]);
  },
  distance: (x, y, h) => distToPolyline(x, y, [...h.pts, h.pts[0]]),
};

/** Free-form polyline: click each vertex, double-click to finish. */
export const POLYLINE: DrawingTool = {
  id: 'polyline', name: 'Polyline', points: 0,
  defaultStyle: { fill: false },
  draw: (c) => {
    if (c.pts.length < 2) return;
    c.ctx.beginPath();
    c.ctx.moveTo(c.pts[0].x, c.pts[0].y);
    for (let i = 1; i < c.pts.length; i++) c.ctx.lineTo(c.pts[i].x, c.pts[i].y);
    if (c.style.fill === true) { c.ctx.closePath(); withFill(c, () => c.ctx.fill()); }
    applyStroke(c);
    c.ctx.stroke();
    c.ctx.setLineDash([]);
  },
  distance: (x, y, h) => distToPolyline(x, y, h.pts),
};

/** Sample a quadratic whose control is derived so the curve passes through `m`. */
function quadPoints(a: ScreenPoint, m: ScreenPoint, b: ScreenPoint): ScreenPoint[] {
  const cx = 2 * m.x - (a.x + b.x) / 2;
  const cy = 2 * m.y - (a.y + b.y) / 2;
  const out: ScreenPoint[] = [];
  for (let i = 0; i <= 16; i++) {
    const t = i / 16;
    const u = 1 - t;
    out.push({ x: u * u * a.x + 2 * u * t * cx + t * t * b.x, y: u * u * a.y + 2 * u * t * cy + t * t * b.y });
  }
  return out;
}

/** Arc through three anchors — the middle one is on the curve, not a handle. */
export const ARC: DrawingTool = {
  id: 'arc', name: 'Arc', points: 3,
  draw: (c) => {
    const [a, m, b] = c.pts;
    applyStroke(c);
    c.ctx.beginPath();
    c.ctx.moveTo(a.x, a.y);
    // Lift the control point so the curve passes *through* the middle anchor
    // rather than merely leaning toward it.
    c.ctx.quadraticCurveTo(2 * m.x - (a.x + b.x) / 2, 2 * m.y - (a.y + b.y) / 2, b.x, b.y);
    c.ctx.stroke();
    c.ctx.setLineDash([]);
  },
  distance: (x, y, h) => distToPolyline(x, y, quadPoints(h.pts[0], h.pts[1], h.pts[2])),
};

/** Quadratic curve — the middle anchor is a control handle, off the curve. */
export const CURVE: DrawingTool = {
  id: 'curve', name: 'Curve', points: 3,
  draw: (c) => {
    const [a, m, b] = c.pts;
    applyStroke(c);
    c.ctx.beginPath();
    c.ctx.moveTo(a.x, a.y);
    c.ctx.quadraticCurveTo(m.x, m.y, b.x, b.y);
    c.ctx.stroke();
    c.ctx.setLineDash([]);
  },
  distance: (x, y, h) => {
    const [a, m, b] = h.pts;
    const pts: ScreenPoint[] = [];
    for (let i = 0; i <= 16; i++) {
      const t = i / 16;
      const u = 1 - t;
      pts.push({ x: u * u * a.x + 2 * u * t * m.x + t * t * b.x, y: u * u * a.y + 2 * u * t * m.y + t * t * b.y });
    }
    return distToPolyline(x, y, pts);
  },
};

// ── arrows & brushes ──────────────────────────────────────────────────────

/** A single-anchor marker that points at a bar. `up` sits below, pointing up. */
function arrowMarker(id: string, name: string, up: boolean): DrawingTool {
  return {
    id, name, points: 1,
    defaultStyle: { fill: true, fillOpacity: 0.9 },
    draw: (c) => {
      const d = c.rc.dpr;
      const { x, y } = c.pts[0];
      const len = 16 * d;
      const w = 6 * d;
      const dir = up ? 1 : -1;
      // Offset off the anchor so the marker sits beside the bar, not on top of it.
      const tipY = y + dir * 2 * d;
      c.ctx.beginPath();
      c.ctx.moveTo(x, tipY);
      c.ctx.lineTo(x - w, tipY + dir * w);
      c.ctx.lineTo(x - w / 2.4, tipY + dir * w);
      c.ctx.lineTo(x - w / 2.4, tipY + dir * len);
      c.ctx.lineTo(x + w / 2.4, tipY + dir * len);
      c.ctx.lineTo(x + w / 2.4, tipY + dir * w);
      c.ctx.lineTo(x + w, tipY + dir * w);
      c.ctx.closePath();
      c.ctx.save();
      c.ctx.globalAlpha = c.style.fillOpacity ?? 0.9;
      c.ctx.fillStyle = fillStyleOf(c);
      c.ctx.fill();
      c.ctx.restore();
      applyStroke(c);
      c.ctx.stroke();
      c.ctx.setLineDash([]);
    },
    distance: (x, y, hc) => {
      const a = hc.pts[0];
      const dy = up ? y - a.y : a.y - y;
      return Math.abs(x - a.x) <= 8 && dy >= -4 && dy <= 20 ? 0 : null;
    },
  };
}
export const ARROW_UP = arrowMarker('arrow-up', 'Arrow Up', true);
export const ARROW_DOWN = arrowMarker('arrow-down', 'Arrow Down', false);

/** Highlighter — the brush with a fat, translucent stroke. */
export const HIGHLIGHTER: DrawingTool = {
  id: 'highlighter', name: 'Highlighter', points: 0, freehand: true,
  defaultStyle: { lineWidth: 12, fillOpacity: 0.28 },
  draw: (c) => {
    if (c.pts.length < 2) return;
    const d = c.rc.dpr;
    c.ctx.save();
    c.ctx.globalAlpha = c.style.fillOpacity ?? 0.28;
    c.ctx.strokeStyle = c.style.color;
    c.ctx.lineWidth = Math.max(2, (c.style.lineWidth || 12) * d);
    c.ctx.lineCap = 'round';
    c.ctx.lineJoin = 'round';
    c.ctx.beginPath();
    c.ctx.moveTo(c.pts[0].x, c.pts[0].y);
    for (let i = 1; i < c.pts.length; i++) c.ctx.lineTo(c.pts[i].x, c.pts[i].y);
    c.ctx.stroke();
    c.ctx.restore();
  },
  distance: (x, y, h) => {
    const d = distToPolyline(x, y, h.pts);
    return d <= Math.max(6, (h.drawing.style.lineWidth ?? 12) / 2) ? 0 : d;
  },
};

// ── fibonacci & gann ──────────────────────────────────────────────────────

/** Fib channel — fib levels spread across a trend leg, parallel to it. */
export const FIB_CHANNEL: DrawingTool = {
  id: 'fib-channel', name: 'Fib Channel', points: 3,
  defaultStyle: { showLabels: true, levels: [...DEFAULT_FIB] },
  draw: (c) => {
    const levels = c.style.levels ?? DEFAULT_FIB;
    const [a, b, w] = c.pts;
    // The third anchor sets the channel width; each level is a fraction of it.
    const offX = w.x - b.x;
    const offY = w.y - b.y;
    applyStroke(c);
    for (const lv of levels) {
      c.ctx.beginPath();
      c.ctx.moveTo(a.x + offX * lv, a.y + offY * lv);
      c.ctx.lineTo(b.x + offX * lv, b.y + offY * lv);
      c.ctx.stroke();
      if (c.style.showLabels !== false) {
        label(c, `${(lv * 100).toFixed(1)}%`, b.x + offX * lv + 4 * c.rc.dpr, b.y + offY * lv);
      }
    }
    c.ctx.setLineDash([]);
  },
  distance: (x, y, h) => {
    const levels = h.drawing.style.levels ?? DEFAULT_FIB;
    const [a, b, w] = h.pts;
    let best = Infinity;
    for (const lv of levels) {
      const d = distToSegment(x, y,
        { x: a.x + (w.x - b.x) * lv, y: a.y + (w.y - b.y) * lv },
        { x: b.x + (w.x - b.x) * lv, y: b.y + (w.y - b.y) * lv });
      if (d < best) best = d;
    }
    return best;
  },
};

/** The Fibonacci sequence itself — time zones count bars, not ratios. */
const FIB_SEQUENCE: readonly number[] = [0, 1, 2, 3, 5, 8, 13, 21, 34, 55];

/** Fib time zone — vertical lines at fib multiples of the base leg's width. */
export const FIB_TIME_ZONE: DrawingTool = {
  id: 'fib-time-zone', name: 'Fib Time Zone', points: 2,
  defaultStyle: { showLabels: true },
  draw: (c) => {
    const [a, b] = c.pts;
    const unit = b.x - a.x;
    if (Math.abs(unit) < 0.5) return;
    const d = c.rc.dpr;
    const maxX = c.rc.plotWidth * d;
    applyStroke(c);
    for (const n of FIB_SEQUENCE) {
      const x = a.x + unit * n;
      if (x < -10 || x > maxX + 10) continue;
      c.ctx.beginPath();
      c.ctx.moveTo(Math.round(x) + 0.5, 0);
      c.ctx.lineTo(Math.round(x) + 0.5, c.rc.plotHeight * d);
      c.ctx.stroke();
      if (c.style.showLabels !== false) label(c, String(n), x + 3 * d, 12 * d);
    }
    c.ctx.setLineDash([]);
  },
  distance: (x, y, h) => {
    void y;
    const [a, b] = h.pts;
    const unit = b.x - a.x;
    if (Math.abs(unit) < 0.5) return null;
    let best = Infinity;
    for (const n of FIB_SEQUENCE) best = Math.min(best, Math.abs(x - (a.x + unit * n)));
    return best;
  },
};

const FAN_LEVELS: readonly number[] = [0.236, 0.382, 0.5, 0.618, 0.786, 1];

/** Rays from the anchor at fib fractions of the leg — speed resistance fan. */
export const FIB_FAN: DrawingTool = {
  id: 'fib-fan', name: 'Fib Speed Fan', points: 2,
  defaultStyle: { showLabels: true, levels: [...FAN_LEVELS] },
  draw: (c) => {
    const levels = c.style.levels ?? FAN_LEVELS;
    const [a, b] = c.pts;
    const d = c.rc.dpr;
    const maxX = c.rc.plotWidth * d;
    applyStroke(c);
    for (const lv of levels) {
      // Each ray takes the full run but a fraction of the rise.
      const end = extendSegment(a, { x: b.x, y: a.y + (b.y - a.y) * lv }, maxX, false, true)[1];
      c.ctx.beginPath();
      c.ctx.moveTo(a.x, a.y);
      c.ctx.lineTo(end.x, end.y);
      c.ctx.stroke();
      if (c.style.showLabels !== false) label(c, `${(lv * 100).toFixed(1)}%`, b.x + 4 * d, a.y + (b.y - a.y) * lv);
    }
    c.ctx.setLineDash([]);
  },
  distance: (x, y, h) => {
    const levels = h.drawing.style.levels ?? FAN_LEVELS;
    const [a, b] = h.pts;
    let best = Infinity;
    for (const lv of levels) {
      best = Math.min(best, distToSegment(x, y, a,
        extendSegment(a, { x: b.x, y: a.y + (b.y - a.y) * lv }, h.rc.plotWidth, false, true)[1]));
    }
    return best;
  },
};

/** Gann price/time ratios: 1x8 … 1x1 … 8x1. */
const GANN_RATIOS: readonly (readonly [number, number])[] = [
  [1, 0.125], [1, 0.25], [1, 0.5], [1, 1], [0.5, 1], [0.25, 1], [0.125, 1],
];

/** Gann fan — rays at the classic price/time ratios from one anchor. */
export const GANN_FAN: DrawingTool = {
  id: 'gann-fan', name: 'Gann Fan', points: 2,
  defaultStyle: { showLabels: true },
  draw: (c) => {
    const [a, b] = c.pts;
    const d = c.rc.dpr;
    const maxX = c.rc.plotWidth * d;
    const dx = b.x - a.x;
    const dy = b.y - a.y;
    if (Math.abs(dx) < 0.5) return;
    applyStroke(c);
    for (const [rx, ry] of GANN_RATIOS) {
      const end = extendSegment(a, { x: a.x + dx * rx, y: a.y + dy * ry }, maxX, false, true)[1];
      c.ctx.beginPath();
      c.ctx.moveTo(a.x, a.y);
      c.ctx.lineTo(end.x, end.y);
      c.ctx.stroke();
    }
    // Only the 1x1 gets a label — the rest are read off it.
    if (c.style.showLabels !== false) label(c, '1x1', b.x + 4 * d, b.y);
    c.ctx.setLineDash([]);
  },
  distance: (x, y, h) => {
    const [a, b] = h.pts;
    const dx = b.x - a.x;
    const dy = b.y - a.y;
    let best = Infinity;
    for (const [rx, ry] of GANN_RATIOS) {
      best = Math.min(best, distToSegment(x, y, a,
        extendSegment(a, { x: a.x + dx * rx, y: a.y + dy * ry }, h.rc.plotWidth, false, true)[1]));
    }
    return best;
  },
};

/** Gann box — an 8x8 grid over the drawn rectangle, plus the 1x1 diagonal. */
export const GANN_BOX: DrawingTool = {
  id: 'gann-box', name: 'Gann Box', points: 2,
  defaultStyle: { fill: true, fillOpacity: 0.05 },
  draw: (c) => {
    const r = rectOf(c.pts[0], c.pts[1]);
    withFill(c, () => c.ctx.fillRect(r.x0, r.y0, r.x1 - r.x0, r.y1 - r.y0));
    applyStroke(c);
    const w = r.x1 - r.x0;
    const h = r.y1 - r.y0;
    c.ctx.beginPath();
    for (let i = 0; i <= 8; i++) {
      const x = Math.round(r.x0 + (w * i) / 8) + 0.5;
      const y = Math.round(r.y0 + (h * i) / 8) + 0.5;
      c.ctx.moveTo(x, r.y0); c.ctx.lineTo(x, r.y1);
      c.ctx.moveTo(r.x0, y); c.ctx.lineTo(r.x1, y);
    }
    c.ctx.moveTo(r.x0, r.y1); c.ctx.lineTo(r.x1, r.y0);
    c.ctx.stroke();
    c.ctx.setLineDash([]);
  },
  distance: (x, y, h) => distToRect(x, y, h.pts[0], h.pts[1], h.drawing.style.fill === true),
};

export const BUILTIN_DRAWING_TOOLS: readonly DrawingTool[] = [
  TREND_LINE, RAY, EXTENDED_LINE, ARROW,
  HORIZONTAL_LINE, HORIZONTAL_RAY, VERTICAL_LINE, CROSS_LINE,
  RECTANGLE, ELLIPSE, PARALLEL_CHANNEL,
  FIB_RETRACEMENT, FIB_EXTENSION,
  LONG_POSITION, SHORT_POSITION, FORECAST,
  MEASURE, PRICE_RANGE, DATE_RANGE,
  CIRCLE, TRIANGLE, POLYLINE, ARC, CURVE,
  ROTATED_RECTANGLE, DOUBLE_CURVE,
  ARROW_UP, ARROW_DOWN, HIGHLIGHTER, BRUSH,
  FIB_CHANNEL, FIB_TIME_ZONE, FIB_FAN, GANN_FAN, GANN_BOX,
  CYCLIC_LINES, TIME_CYCLES, SINE_LINE,
  TEXT, PATH, PRICE_LABEL, CALLOUT, FLAG_MARK,
];

let _registered = false;

/** Register every built-in tool. Idempotent; called on tier import. */
export function registerBuiltinDrawingTools(): void {
  if (_registered) return;
  _registered = true;
  for (const t of BUILTIN_DRAWING_TOOLS) registerDrawingTool(t);
}

export type { ScreenPoint };
