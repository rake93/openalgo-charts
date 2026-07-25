/**
 * Drawing tier (opt-in: "openalgo-charts/draw").
 *
 * 43 built-in tools plus a headless controller. Importing this module registers
 * every built-in tool as a side effect. The named descriptor re-exports below
 * cover the most-customised subset; `BUILTIN_DRAWING_TOOLS` is the full list and
 * `registeredDrawingTools()` reads the live registry.
 *
 * ```ts
 * import { createChart } from 'openalgo-charts';
 * import { DrawingController } from 'openalgo-charts/draw';
 *
 * const chart = createChart(el);
 * chart.addSeries('candlestick').setData(bars);
 *
 * const draw = new DrawingController(chart, { magnet: true });
 * draw.setTool('trend-line');   // next two clicks place it
 * ```
 *
 * The controller ships **no UI** — no toolbar, no dialogs. It exposes the model
 * and the interactions; a host wires its own buttons (or the future
 * `openalgo-charts-ui` package) to `setTool` / `undo` / `remove`.
 *
 * Tools register into the base bundle's registry through the package entry, not
 * a deep path, so `createChart` and this tier share one registry — see
 * rollup.config.js.
 */
import { registerBuiltinDrawingTools } from './tools';

export const DRAW_TIER = 'draw' as const;

registerBuiltinDrawingTools(); // side effect on tier import

export {
  registerDrawingTool,
  getDrawingTool,
  hasDrawingTool,
  registeredDrawingTools,
  matchDrawingShortcut,
  drawingShortcuts,
  registerBuiltinDrawingTools,
  BUILTIN_DRAWING_TOOLS,
  TREND_LINE, RAY, EXTENDED_LINE, ARROW,
  HORIZONTAL_LINE, HORIZONTAL_RAY, VERTICAL_LINE, CROSS_LINE,
  RECTANGLE, ELLIPSE, PARALLEL_CHANNEL,
  FIB_RETRACEMENT, FIB_EXTENSION,
  LONG_POSITION, SHORT_POSITION, MEASURE,
  TEXT, PATH,
  sizePosition,
  type PositionSizing,
} from './tools';

export { DrawingLayer } from './layer';
export { DrawingController, type DrawingControllerOptions } from './controller';

export type {
  Drawing,
  DrawingPoint,
  DrawingStyle,
  DrawingTool,
  DrawContext,
  HitContext,
  ScreenPoint,
} from './types';

export type { ShortcutEvent } from './tools';

export {
  distToSegment, distToLine, distToPolyline,
  distToRect, distToEllipse, rectOf, extendSegment,
} from './geometry';
