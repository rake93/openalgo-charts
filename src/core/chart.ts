/**
 * Top-level chart orchestrator (ARCHITECTURE.md §3.3). Owns the shared
 * DataLayer + time scale, the panes, the invalidate mask, and the render loop.
 * Phase 2 renders static candlesticks with price/time axes; pan/zoom (Phase 3)
 * and live data (Phase 4) build on this.
 */
import { InvalidateMask, InvalidationLevel } from './invalidate-mask';
import { RenderLoop, type RafScheduler, type RafCanceller } from './render-loop';
import { Pane, type PaneRenderContext } from './pane';
import { type ChartTheme, DEFAULT_THEME } from '../theme';
import { TimeScale } from '../scale/time-scale';
import type { LogicalRange } from '../scale/time-scale';
import type { PriceScaleOptions, PriceScale } from '../scale/price-scale';
import type { TickMarkType } from '../render/axis';
import { DataLayer } from '../model/data-layer';
import { createSeriesRecord, type SeriesApi, type PriceScaleId } from '../model/series';
import { getChartType, type SeriesType } from '../model/chart-type-registry';
import {
  getIndicator, hasIndicator, plotStyleKeys,
  type IndicatorDescriptor, type IndicatorSettings,
} from '../model/indicator-registry';

/**
 * Colours the 2nd and later instances of the same indicator rotate through.
 * Chosen to stay apart on both dark and light panes and to read as distinct at
 * a 1px stroke, which rules out near-neighbour hues.
 */
/** PaneLegend's own defaults, restated so a pane can be reset to them. */
const DEFAULT_LEGEND_TOP = 6;
const DEFAULT_LEGEND_LEFT = 8;
/** How close to the chart top counts as "in the host's corner", in media px. */
const LEGEND_TOP_EPS = 12;

const INSTANCE_PALETTE: readonly string[] = [
  '#f5a623', '#26a69a', '#ab47bc', '#ef5350',
  '#26c6da', '#8bc34a', '#ff7043', '#5c6bc0',
];
import { IndicatorInstance, type IndicatorApi, type IndicatorHost } from '../model/indicator-instance';
import {
  CHART_STATE_VERSION,
  type ChartState,
  type PaneState,
  type SeriesState,
  type RestoreReport,
} from '../model/chart-state';
import type { SeriesStyle } from '../render/series-style';
import type { Bar, SeriesDataItem } from '../model/bar';
import { toBar } from '../model/bar';
import { KineticAnimation } from '../input/kinetic';
import { magnetSnapPrice, type CrosshairMode } from '../input/crosshair';
import { ShortcutManager } from '../input/shortcuts';
import type { ShortcutManagerOptions } from '../input/shortcuts';
import { TradingController } from './trading-controller';
import { pinchState, pinchDelta, type PinchState } from '../input/touch';
import type { IPrimitive, PrimitiveHost, PrimitiveHit } from '../primitives/primitive';
import { PriceLine, type PriceLineOptions } from '../primitives/price-line';
import { SeriesMarkers } from '../primitives/markers';
import { EventMarkers } from '../primitives/event-markers';
import { PaneLegend, type PaneLegendAction } from '../primitives/pane-legend';
import { TimeNavigator, type TimeNavigatorOptions } from '../primitives/time-navigator';

export interface ChartOptions {
  document?: Document;
  pixelRatio?: () => number;
  raf?: { schedule: RafScheduler; cancel?: RafCanceller };
  /** Full palette; pass `lightTheme` (the default), `darkTheme`, or a custom ChartTheme. */
  theme?: ChartTheme;
  priceAxisWidth?: number;
  timeAxisHeight?: number;
  /**
   * Where indicator legend rows start inside **one** pane, in media px. A host
   * that draws its own overlay in a pane's top-left corner — an OHLC readout, a
   * symbol line, a trade panel — needs to push these clear of it, or the rows
   * land underneath and their settings / close buttons become invisible and
   * unclickable.
   *
   * It follows whichever pane currently renders at that corner, which is
   * normally pane 0 — but maximizing a lower pane parks the others at a
   * placeholder weight, so the maximized pane moves into the same corner and
   * inherits the offset. Every other pane keeps the default corner, because a
   * short lower pane would have its legend pushed off it entirely.
   *
   * Defaults to `{ top: 6, left: 8 }`.
   */
  legendOffset?: { top?: number; left?: number };
  /**
   * Crosshair behaviour. 'normal' (default) — the cross follows the pointer
   * exactly. 'magnet' — the horizontal line snaps to the nearest O/H/L/C of the
   * bar under the cursor (price pane only).
   */
  crosshairMode?: CrosshairMode;
  /** Time source for kinetic animation (defaults to performance.now). */
  now?: () => number;
  /** Enable OHLC-preserving conflation when zoomed out (§4.4). Default false. */
  conflate?: boolean;
  /** Conflation aggressiveness (default 1). */
  conflationFactor?: number;
  /** Grid line visibility. Both default to true. */
  grid?: { vertLines?: boolean; horzLines?: boolean };
  /** Accessible label for the chart container (screen readers). */
  ariaLabel?: string;
  /**
   * Keyboard shortcuts. Pass a configured `ShortcutManager`, options to build
   * one, or `false` to disable keyboard control. Defaults to the built-in keymap.
   */
  shortcuts?: ShortcutManager | Partial<ShortcutManagerOptions> | false;
  /**
   * Custom price formatter for every pane's axis tick labels, the last-price
   * tag, and price-line labels. e.g. `(p) => '$' + p.toFixed(2)`. When omitted,
   * a tick-size-aware `toFixed` is used. Change it later via `setPriceFormatter`.
   */
  priceFormatter?: (price: number) => string;
  /**
   * Default price-scale options applied to every pane (tick size `minMove`,
   * `mode: 'linear' | 'logarithmic'`, `inverted`, and top/bottom margins).
   * Tune a single pane later via `chart.panes()[n].priceScale.setOptions(...)`.
   */
  priceScale?: Partial<PriceScaleOptions>;
  /**
   * Custom time-axis and crosshair label formatter (receives UTC seconds). When
   * omitted, labels use IST (Indian market default). e.g. for UTC:
   * `(s) => new Date(s * 1000).toISOString().slice(11, 16)`.
   */
  timeFormatter?: (utcSeconds: number, tickMark?: TickMarkType) => string;
  /**
   * Hover-revealed zoom / step controls above the time axis, as terminals show.
   * `true` by default — they stay invisible until the pointer nears the bottom
   * of the chart. Pass `false` to drop them, or an options object to restyle.
   */
  timeNavigator?: boolean | Partial<TimeNavigatorOptions>;
}

export interface AddSeriesOptions {
  /** Target pane index (0 = price). Higher panes are created on demand. */
  paneIndex?: number;
  /** Style overrides merged onto the chart type's defaults. */
  style?: SeriesStyle;
  /**
   * Which price axis this series maps to. 'right' (default) and 'left' each draw
   * an axis and autoscale independently; '' is a hidden overlay scale (no axis)
   * for a volume histogram inside the price pane.
   */
  priceScaleId?: PriceScaleId;
  /**
   * Value formatting applied to this series' price scale (axis + crosshair tag):
   * `price` (tick-size precision), `volume` (compact 1.2K / 3.4M / 5.6B), or a
   * `custom` formatter (currency, percent, ...).
   */
  priceFormat?:
    | { type: 'price'; precision?: number; minMove?: number }
    | { type: 'volume' }
    | { type: 'custom'; formatter: (value: number) => string };
}

/** Compact volume/number formatter (1.2K / 3.4M / 5.6B). */
export function compactVolume(v: number): string {
  const a = Math.abs(v);
  if (a >= 1e9) return (v / 1e9).toFixed(2) + 'B';
  if (a >= 1e6) return (v / 1e6).toFixed(2) + 'M';
  if (a >= 1e3) return (v / 1e3).toFixed(2) + 'K';
  return String(Math.round(v));
}

/**
 * Emitted on every crosshair move (and `null` fields on pointer-leave) so a host
 * can render an OHLC legend / tooltip. `bar` is the hovered bar of the primary
 * price series; `point` is container-relative media px for positioning a
 * floating tooltip. See `subscribeCrosshairMove`.
 */
export interface CrosshairMoveEvent {
  /** UTC seconds of the hovered bar, or null when off the data / pointer left. */
  time: number | null;
  /** Logical index under the cursor, or null. */
  index: number | null;
  /** Price under the cursor on the hovered pane, or null. */
  price: number | null;
  /** Hovered bar of the primary (first) price series, or null. */
  bar: Bar | null;
  /** Cursor position in container media px, or null on leave. */
  point: { x: number; y: number } | null;
  /** Pane under the cursor, or null on leave. */
  paneIndex?: number | null;
}

function defaultPixelRatio(): number {
  return typeof window !== 'undefined' && window.devicePixelRatio ? window.devicePixelRatio : 1;
}

export class Chart {
  private readonly _container: HTMLElement;
  private readonly _doc: Document;
  private readonly _pixelRatio: () => number;
  private _theme: ChartTheme;
  private readonly _panes: Pane[] = [];
  private readonly _loop: RenderLoop;
  private readonly _dataLayer = new DataLayer();
  private readonly _timeScale = new TimeScale();
  private readonly _priceAxisWidth: number;
  private readonly _timeAxisHeight: number;
  private _pending: InvalidateMask | null = null;
  private _resizeObserver: ResizeObserver | null = null;
  private _width = 0;
  private _height = 0;
  private _hasFitContent = false;

  // interaction state
  private _crosshairMode: CrosshairMode;
  private _shortcuts: ShortcutManager | null = null;
  private _trading: TradingController | null = null;
  private _pointerInside = false;
  private _keyTarget: HTMLElement | Document | null = null;
  private readonly _now: () => number;
  private readonly _conflate: boolean;
  private readonly _conflationFactor: number;
  private _gridVert = true;
  private _gridHorz = true;
  private _cursorPane: number | null = null;
  private _cursor: { x: number; y: number } | null = null;
  private _dragging = false;
  private _dragStartX = 0;
  private _dragStartY = 0;
  private _lastDragY = 0;
  // multi-touch: active pointers + current pinch gesture
  private readonly _pointers = new Map<number, { x: number; y: number; pane: number }>();
  private _pinch: PinchState | null = null;
  private _pinchPane = 0;
  private _liveRegion: HTMLElement | null = null;
  private _dragStartOffset = 0;
  private _lastDragX = 0;
  private _lastDragT = 0;
  private _dragVelocity = 0;
  private _kineticHandle: number | null = null;
  private readonly _firstDataId: { value: number | null } = { value: null };
  private readonly _indicators: IndicatorInstance[] = [];
  /** Guards indicator recompute against re-entry via its own `series.setData`. */
  private _recomputing = false;
  /** Opaque drawing-tier payload, round-tripped through get/restoreState. */
  private _drawingState: unknown = undefined;
  /** Pane currently maximized, and the weights to restore when it un-maximizes. */
  private _maximizedPane: number | null = null;
  private _savedWeights: number[] | null = null;
  /** Legend rows per pane, so new ones stack below existing ones. */
  private readonly _legends: { legend: PaneLegend; paneIndex: number }[] = [];
  /** Pane holding the primary price series (only this pane gets magnet snapping). */
  private _firstPaneIndex = 0;
  private _historyLoader: (() => void) | null = null;
  private _loadingHistory = false;
  private _clickCb: ((externalId: string) => void) | null = null;
  private _crosshairCb: ((e: CrosshairMoveEvent) => void) | null = null;
  private _pointerMoved = false;
  /** While true, pointer gestures place anchors instead of panning. */
  private _placementMode = false;
  /** Where indicator legend rows start inside a pane (see `legendOffset`). */
  private readonly _legendOffset: { top: number; left: number } = { top: 6, left: 8 };
  private _downPane = 0;
  private _downX = 0;
  private _downLocalY = 0;
  private _dragId: string | null = null; // externalId of the primitive being dragged
  private _hoverId: string | null = null; // externalId of the primitive under the pointer
  private _overlayFrozen = false; // native context menu open: keep the save-image snapshot
  private _dragCb: ((externalId: string, price: number, time: number) => void) | null = null;
  private _dragEndCb: ((externalId: string, price: number, time: number) => void) | null = null;
  // axis-drag rescale (price axis = vertical, time axis = horizontal)
  private _axisDrag: 'price' | 'time' | null = null;
  /** Active pane-divider drag: which boundary, and the weights/heights at grab time. */
  /** True once a primitive drag has actually moved — see the pointerup note. */
  private _dragMoved = false;
  /** Where the drag was grabbed, in data space, so deltas start at the press. */
  private _dragFrom: { time: number; price: number } = { time: 0, price: 0 };
  private _paneResize: {
    index: number; startY: number;
    aWeight: number; bWeight: number; aHeight: number; bHeight: number;
  } | null = null;
  private _axisStartCoord = 0;
  private _axisStartMin = 0;
  private _axisStartMax = 0;
  private _axisStartSpacing = 0;
  private _priceFormatter: ((price: number) => string) | null = null;
  private _priceScaleOptions: Partial<PriceScaleOptions> | null = null;
  private _timeFormatter: ((utcSeconds: number, tickMark?: TickMarkType) => string) | undefined = undefined;
  private _leftAxisWidth = 0; // chart-wide reserved left-axis column (0 = none)
  private _timeNav: TimeNavigator | null = null;
  /** Pane the navigator is currently attached to, so it can follow the bottom. */
  private _timeNavPane = -1;

  public constructor(container: HTMLElement, options: ChartOptions = {}) {
    this._container = container;
    this._doc = options.document ?? container.ownerDocument;
    this._pixelRatio = options.pixelRatio ?? defaultPixelRatio;
    this._theme = options.theme ?? DEFAULT_THEME;
    this._priceAxisWidth = options.priceAxisWidth ?? 56;
    if (options.legendOffset?.top !== undefined) this._legendOffset.top = options.legendOffset.top;
    if (options.legendOffset?.left !== undefined) this._legendOffset.left = options.legendOffset.left;
    this._timeAxisHeight = options.timeAxisHeight ?? 22;
    this._crosshairMode = options.crosshairMode ?? 'normal';
    const sc = options.shortcuts;
    this._shortcuts = sc === false ? null : (sc instanceof ShortcutManager ? sc : new ShortcutManager(sc ?? {}));
    this._now = options.now ?? (() => (typeof performance !== 'undefined' ? performance.now() : 0));
    this._conflate = options.conflate ?? false;
    this._conflationFactor = options.conflationFactor ?? 1;
    this._priceFormatter = options.priceFormatter ?? null;
    this._priceScaleOptions = options.priceScale ?? null;
    this._timeFormatter = options.timeFormatter;
    this._gridVert = options.grid?.vertLines ?? true;
    this._gridHorz = options.grid?.horzLines ?? true;
    const nav = options.timeNavigator ?? true;
    if (nav !== false) {
      this._timeNav = new TimeNavigator(
        { ...(nav === true ? {} : nav), hints: this._navHints(nav === true ? undefined : nav) },
        this._now,
      );
    }

    // Respect a position set via CSS (absolute/relative/fixed); only force
    // 'relative' when the container is statically positioned. Reading
    // container.style.position alone misses stylesheet rules and would wrongly
    // override an `position: absolute` set in CSS, collapsing the container.
    const computedPos = typeof getComputedStyle === 'function'
      ? getComputedStyle(container).position
      : container.style.position;
    if (!computedPos || computedPos === 'static') container.style.position = 'relative';
    container.style.display = 'flex';
    container.style.flexDirection = 'column';
    container.style.background = this._theme.background;
    // Touch: let the chart own pan/pinch gestures instead of the browser scrolling/zooming.
    container.style.touchAction = 'none';

    // Accessibility: a focusable, labelled region with a polite live summary so the
    // canvas (which screen readers can't introspect) is at least navigable + announced.
    if (!container.getAttribute('role')) container.setAttribute('role', 'application');
    container.setAttribute('aria-label', options.ariaLabel ?? 'Interactive financial chart');
    if (!container.hasAttribute('tabindex')) container.tabIndex = 0;
    const live = this._doc.createElement('div');
    live.setAttribute('aria-live', 'polite');
    const s = live.style;
    s.position = 'absolute'; s.width = '1px'; s.height = '1px'; s.overflow = 'hidden';
    s.clip = 'rect(0 0 0 0)'; s.whiteSpace = 'nowrap'; s.border = '0'; s.padding = '0'; s.margin = '-1px';
    container.appendChild(live);
    this._liveRegion = live;

    this._loop = options.raf
      ? new RenderLoop(() => this._onFrame(), options.raf.schedule, options.raf.cancel)
      : new RenderLoop(() => this._onFrame());

    this._addPane();
    this._observeSize();
    this._attachInput();
    // A host that mutates the time scale directly (e.g. setVisibleLogicalRange to
    // preserve zoom across a data reload) still triggers a repaint.
    this._timeScale.setChangeHandler(() => this.invalidate((m) => m.invalidateGlobal(InvalidationLevel.Full)));
    this.applySize(container.clientWidth, container.clientHeight);
    // 'ready' fires on a microtask so `createChart(el).on('ready', ...)` — a
    // subscription registered on the very next line — still receives it.
    if (typeof queueMicrotask === 'function') queueMicrotask(() => this.emit('ready', {}));
  }

  /** Register a callback fired when the user pans near the left (oldest) edge. */
  public setHistoryLoader(loader: () => void): void {
    this._historyLoader = loader;
  }

  /** Call after a history-paging load resolves to re-enable the trigger. */
  public historyLoadComplete(): void {
    this._loadingHistory = false;
  }

  public get dataLayer(): DataLayer {
    return this._dataLayer;
  }

  public get timeScale(): TimeScale {
    return this._timeScale;
  }

  /** Restore a saved logical range (e.g. preserve the user's zoom across a data reload). */
  public setVisibleLogicalRange(range: LogicalRange): void {
    this._timeScale.setVisibleLogicalRange(range);
  }

  /** The current visible logical range. */
  public getVisibleLogicalRange(): LogicalRange {
    return this._timeScale.visibleRange();
  }

  /** Fit all bars into view (no-arg convenience; bar count from the data). */
  public fitContent(): void {
    if (this._dataLayer.length <= 0) return;
    this._timeScale.fitContent(this._dataLayer.length);
    this.invalidate((m) => m.invalidateGlobal(InvalidationLevel.Full));
  }

  /** The keyboard shortcut manager (null when shortcuts are disabled). */
  public get shortcuts(): ShortcutManager | null {
    return this._shortcuts;
  }

  /**
   * The data-driven trading layer: push positions/orders/trades and the chart
   * renders pills + markers, emitting `trading:*` events on interaction. Created
   * on first access.
   */
  public get trading(): TradingController {
    if (this._trading === null) this._trading = new TradingController(this);
    return this._trading;
  }

  /** Add a series and return its data handle. */
  public addSeries(type: SeriesType, options: AddSeriesOptions = {}): SeriesApi {
    return this._createSeries(type, options, true);
  }

  /**
   * `claimPrimary` is false for series the chart creates on a caller's behalf
   * (indicator plots), so an indicator's line never becomes the price series
   * that drives the magnet crosshair and the OHLC legend.
   */
  private _createSeries(type: SeriesType, options: AddSeriesOptions, claimPrimary: boolean): SeriesApi {
    const dataId = this._dataLayer.createSeries();
    const paneIndex = options.paneIndex ?? 0;
    this._ensurePane(paneIndex);
    // The first price-type series drives the magnet crosshair + OHLC legend.
    if (claimPrimary && this._firstDataId.value === null && getChartType(type).isPriceSeries) {
      this._firstDataId.value = dataId;
      this._firstPaneIndex = paneIndex;
    }
    const record = createSeriesRecord(dataId, type, options.style, options.priceScaleId ?? 'right');
    this._panes[paneIndex].addSeries(record);
    this._recomputeLeftAxis(); // reserve/free the left-axis column
    if (options.priceFormat) {
      const scale = this._panes[paneIndex].scaleOf(record);
      const pf = options.priceFormat;
      if (pf.type === 'custom') scale.setPriceFormatter(pf.formatter);
      else if (pf.type === 'volume') scale.setPriceFormatter(compactVolume);
      else {
        const minMove = pf.minMove ?? (pf.precision !== undefined ? Math.pow(10, -pf.precision) : undefined);
        if (minMove !== undefined) scale.setOptions({ minMove });
      }
    }

    return {
      setData: (bars: readonly SeriesDataItem[]): void => this._setData(dataId, bars.map(toBar)),
      prependData: (bars: readonly SeriesDataItem[]): void => this._prependData(dataId, bars.map(toBar)),
      update: (bar: SeriesDataItem): void => this._updateBar(dataId, toBar(bar)),
      getData: (): Bar[] => this._dataLayer.indexedBars(dataId).map((ib) => ib.bar),
      applyOptions: (patch: Partial<SeriesStyle>): void => {
        Object.assign(record.style, patch);
        this.invalidate((m) => m.invalidateGlobal(InvalidationLevel.Full));
      },
      remove: (): void => {
        this._panes[paneIndex].removeSeries(record);
        this._dataLayer.removeSeries(dataId);
        if (this._firstDataId.value === dataId) this._firstDataId.value = null;
        this._timeScale.setBaseIndex(this._dataLayer.baseIndex);
        this._recomputeLeftAxis();
        this.invalidate((m) => m.invalidateGlobal(InvalidationLevel.Full));
      },
      priceScale: (): PriceScale => this._panes[paneIndex].scaleOf(record),
      createMarkers: (): SeriesMarkers => {
        const m = new SeriesMarkers(dataId);
        this._addPrimitive(paneIndex, m);
        return m;
      },
    };
  }

  /** Add a horizontal price line (order/SL/TP/alert/level) to a pane. */
  public addPriceLine(opts: PriceLineOptions, paneIndex = 0): PriceLine {
    const line = new PriceLine(opts);
    this._addPrimitive(paneIndex, line);
    return line;
  }

  /** Add an earnings/dividend/split event-marker strip to a pane. */
  public addEventMarkers(paneIndex = 0): EventMarkers {
    const em = new EventMarkers();
    this._addPrimitive(paneIndex, em);
    return em;
  }

  /**
   * Add a registered indicator. Built-in descriptors live in the lazy
   * `openalgo-charts/indicators` tier — import it (or register your own with
   * `registerIndicator`) before calling this.
   *
   * `'onchart'` indicators overlay the price pane; `'pane'` indicators get a new
   * pane of their own unless `paneIndex` says otherwise. The returned handle
   * recomputes automatically whenever the source data changes.
   *
   * ```ts
   * import 'openalgo-charts/indicators';
   * const macd = chart.addIndicator('macd', { fastPeriod: 8 });
   * macd.setSettings({ fastPeriod: 12 });
   * macd.remove();
   * ```
   */
  public addIndicator(
    indicatorId: string,
    settings: Readonly<IndicatorSettings> = {},
    options: { paneIndex?: number } = {},
  ): IndicatorApi {
    const descriptor = getIndicator(indicatorId);
    const instance = new IndicatorInstance(
      this._indicatorHost(),
      descriptor,
      this._distinctColors(descriptor, settings),
      options.paneIndex,
    );
    this._indicators.push(instance);
    return instance;
  }

  /**
   * Give a repeated indicator its own colours. Three EMAs all in the
   * descriptor's default blue are indistinguishable on the chart *and* in the
   * legend, so the second and later instances rotate through a palette.
   *
   * Only fills colour keys the caller left unset, so an explicit colour always
   * wins, and the first instance is never touched — it keeps the colours the
   * descriptor chose.
   */
  private _distinctColors(
    descriptor: IndicatorDescriptor,
    settings: Readonly<IndicatorSettings>,
  ): Readonly<IndicatorSettings> {
    const nth = this._indicators.filter((i) => i.indicatorId === descriptor.id).length;
    if (nth === 0) return settings;
    const out: IndicatorSettings = { ...settings };
    const plots = descriptor.plots;
    for (let i = 0; i < plots.length; i++) {
      const key = plotStyleKeys(plots[i]).color;
      if (out[key] !== undefined) continue; // an explicit colour always wins
      // Stride by the plot count so a multi-plot indicator (MACD) shifts as a
      // block rather than landing on the previous instance's colours.
      out[key] = INSTANCE_PALETTE[(nth * plots.length + i) % INSTANCE_PALETTE.length];
    }
    return out;
  }

  /** Every live indicator instance, in the order they were added. */
  public indicators(): readonly IndicatorApi[] {
    return this._indicators;
  }

  /** Remove one indicator instance by its handle id. Returns true if it existed. */
  public removeIndicator(instanceId: string): boolean {
    const i = this._indicators.findIndex((x) => x.id === instanceId);
    if (i < 0) return false;
    const { indicatorId, paneIndex } = this._indicators[i];
    this._indicators[i].remove();
    this._indicators.splice(i, 1);
    this.emit('indicatorRemoved', { instanceId, indicatorId, paneIndex });
    // An indicator pane that just emptied has nothing left to show. This lived
    // in the legend's close handler, so only the on-chart × pruned the pane — a
    // host removing the same indicator from its own UI left it behind, and
    // `getState` then persisted the orphan, so every reload restored a blank
    // region. Doing it here means every caller behaves the same.
    if (paneIndex > 0 && this._panes[paneIndex]?.series().length === 0) this.removePane(paneIndex);
    return true;
  }

  private _indicatorHost(): IndicatorHost {
    return {
      addIndicatorLegend: (o): PaneLegend => {
        // The first legend on a non-price pane also carries the pane-level
        // controls (move / maximize), the way a charting pane toolbar does;
        // extra rows keep only their own show / settings / delete.
        const paneActions: PaneLegendAction[] =
          o.row === 0 && o.paneIndex > 0
            ? ['hide', 'settings', 'up', 'down', 'maximize', 'close']
            : ['hide', 'settings', 'close'];
        // _syncLegendOffsets decides which pane wears the offset, and runs on
        // every relayout; this is just the initial placement.
        const legend = new PaneLegend({ ...o, actions: paneActions });
        this._addPrimitive(o.paneIndex, legend);
        return legend;
      },
      removeIndicatorLegend: (legend): void => {
        this.removePrimitive(legend);
        this._restackLegends();
      },
      legendRowsOn: (paneIndex): number => this._legends.filter((l) => l.paneIndex === paneIndex).length,
      addIndicatorSeries: (type, paneIndex, style, priceScaleId): SeriesApi =>
        this._createSeries(
          type as SeriesType,
          { paneIndex, style: style as SeriesStyle | undefined, priceScaleId: priceScaleId as PriceScaleId | undefined },
          false,
        ),
      addIndicatorLevel: (price, color, dashed, label, id, paneIndex): PriceLine =>
        this.addPriceLine({ price, color, lineWidth: 1, dashed, leftLabel: label, id }, paneIndex),
      removeIndicatorLevel: (line): void => this.removePrimitive(line),
      addIndicatorFill: (fill, paneIndex): void => this._addPrimitive(paneIndex, fill),
      removeIndicatorFill: (fill): void => this.removePrimitive(fill),
      removeIndicatorMarkers: (markers): void => this.removePrimitive(markers),
      sourceBars: (): readonly Bar[] =>
        this._firstDataId.value === null ? [] : this._dataLayer.seriesBars(this._firstDataId.value),
      nextPaneIndex: (): number => this._panes.length,
      setPaneRange: (paneIndex, range): void => {
        const pane = this._panes[paneIndex];
        if (pane === undefined) return;
        if (range === null) {
          pane.priceScale.setAutoScale(true);
        } else {
          pane.priceScale.setAutoScale(false);
          pane.priceScale.setPriceRange(range);
        }
      },
    };
  }

  /**
   * Recompute every indicator after a source-data change. Reentrant-guarded:
   * an indicator writes its plots with `series.setData`, which re-enters the
   * same data-mutation path that called us.
   */
  private _recomputeIndicators(): void {
    if (this._recomputing || this._indicators.length === 0) return;
    this._recomputing = true;
    try {
      for (const indicator of this._indicators) indicator.recompute();
    } finally {
      this._recomputing = false;
    }
  }

  /** Subscribe to clicks on hit-testable primitives (markers, events, lines). */
  public subscribeClick(cb: (externalId: string) => void): void {
    this._clickCb = cb;
  }

  /**
   * Subscribe to crosshair movement for an OHLC legend / tooltip. The callback
   * fires with the hovered bar of the primary price series on every move, and
   * with all-null fields when the pointer leaves the plot.
   */
  public subscribeCrosshairMove(cb: (e: CrosshairMoveEvent) => void): void {
    this._crosshairCb = cb;
  }

  /**
   * Subscribe to drags of draggable primitives (order / SL / TP lines, drawing
   * handles). Fires per move and on release.
   *
   * `time` is the UTC seconds under the cursor, interpolated between bars and
   * extrapolated past the right edge — so a two-axis drag (a trendline endpoint,
   * a projection) has a usable time even where the gapless axis has no bar.
   * Price-only consumers can simply ignore it.
   */
  public subscribeDrag(
    onDrag: (externalId: string, price: number, time: number) => void,
    onDragEnd?: (externalId: string, price: number, time: number) => void,
  ): void {
    this._dragCb = onDrag;
    this._dragEndCb = onDragEnd ?? null;
  }

  /**
   * Guarantee a pane's price scale has a real range before converting y↔price.
   * Autoscaling normally happens during paint, so every coordinate API — and
   * the price carried by click/drag events — used to answer with the default
   * 0..1 (or ±Infinity) until the first frame had run. Callers cannot be asked
   * to wait for a paint, so scale on demand.
   */
  private _ensureScaled(paneIndex: number): void {
    const pane = this._panes[paneIndex];
    if (pane === undefined || pane.priceScale.scaled) return;
    pane.autoscale(this._renderContext(paneIndex === this._panes.length - 1));
  }

  /** Container-relative x (media px) → UTC seconds on the (gapless) time axis. */
  private _xToTime(x: number): number {
    return this._dataLayer.indexToTimeFloat(this._timeScale.xToIndex(x - this._leftAxisWidth));
  }

  /** UTC seconds → container-relative x (media px). The inverse of `_xToTime`. */
  public timeToCoordinate(time: number): number {
    return this._timeScale.indexToX(this._dataLayer.timeToIndexFloat(time)) + this._leftAxisWidth;
  }

  /** Container-relative x (media px) → UTC seconds. */
  public coordinateToTime(x: number): number {
    return this._xToTime(x);
  }

  // ── unified event bus ─────────────────────────────────────────────────────
  // One `on(name, cb)` surface for every chart event, complementing the typed
  // `subscribe*` helpers. Names emitted by the core: 'ready', 'crosshair:move',
  // 'click', 'dblclick', 'hover', 'drag', 'drag:end', 'pan', 'zoom', 'resize',
  // 'lazy-load', 'paneRemoved', 'paneMoved', 'paneMaximized', 'paneResized',
  // 'indicatorRemoved', 'indicatorSettings'. The trading layer routes its
  // 'trading:*' events through here too, and the draw tier emits 'draw:*'.
  //
  // Event names are the same string on both buses: `TradingController` keys its
  // own listener map on the full name, so it is `chart.trading.on(
  // 'trading:order_modify')`, never the bare 'order_modify'.
  private readonly _listeners = new Map<string, Set<(payload: unknown) => void>>();

  /** Subscribe to a named chart event. Returns an unsubscribe function. */
  public on(event: string, cb: (payload: unknown) => void): () => void {
    let set = this._listeners.get(event);
    if (set === undefined) {
      set = new Set();
      this._listeners.set(event, set);
    }
    set.add(cb);
    return (): void => this.off(event, cb);
  }

  /** Subscribe to the next occurrence of an event, then auto-unsubscribe. */
  public once(event: string, cb: (payload: unknown) => void): () => void {
    const wrap = (payload: unknown): void => {
      this.off(event, wrap);
      cb(payload);
    };
    return this.on(event, wrap);
  }

  /** Remove one listener, or (when `cb` is omitted) every listener for an event. */
  public off(event: string, cb?: (payload: unknown) => void): void {
    if (cb === undefined) {
      this._listeners.delete(event);
      return;
    }
    this._listeners.get(event)?.delete(cb);
  }

  /** Dispatch a named event. Public so the lazy trade layer can route through it. */
  public emit(event: string, payload: unknown): void {
    const set = this._listeners.get(event);
    if (set === undefined) return;
    for (const cb of [...set]) {
      try {
        cb(payload);
      } catch {
        /* one bad listener must not break the others or the render loop */
      }
    }
  }

  /** Emit a viewport event ('pan' | 'zoom') carrying the visible time + logical range. */
  private _emitViewport(type: 'pan' | 'zoom'): void {
    if (this._listeners.get(type) === undefined) return;
    const r = this._timeScale.visibleRange();
    this.emit(type, {
      from: this._dataLayer.indexToTime(Math.round(r.from)) ?? null,
      to: this._dataLayer.indexToTime(Math.round(r.to)) ?? null,
      logicalFrom: r.from,
      logicalTo: r.to,
    });
  }

  /** Public: attach any primitive (indicators, profiles, custom overlays) to a pane. */
  public addPrimitive(primitive: IPrimitive, paneIndex = 0): void {
    this._addPrimitive(paneIndex, primitive);
  }

  /**
   * Map a price to a container-relative Y in media (CSS) px, for positioning DOM
   * overlays (order panels, tooltips) over a pane. Returns null if the pane
   * doesn't exist. The inverse is `coordinateToPrice`.
   */
  public priceToCoordinate(price: number, paneIndex = 0): number | null {
    this._ensureScaled(paneIndex);
    const pane = this._panes[paneIndex];
    if (pane === undefined) return null;
    const top = this._paneLayout()[paneIndex]?.top ?? 0;
    return top + pane.priceScale.priceToY(price);
  }

  /** Map a container-relative media-px Y back to a price on a pane (inverse of priceToCoordinate). */
  public coordinateToPrice(y: number, paneIndex = 0): number | null {
    this._ensureScaled(paneIndex);
    const pane = this._panes[paneIndex];
    if (pane === undefined) return null;
    const top = this._paneLayout()[paneIndex]?.top ?? 0;
    return pane.priceScale.yToPrice(y - top);
  }

  /**
   * Toggle the vertical (time) and/or horizontal (price) grid lines at runtime.
   * Omitted fields keep their current visibility. Repaints every pane.
   */
  public setGridOptions(opts: { vertLines?: boolean; horzLines?: boolean }): void {
    if (opts.vertLines !== undefined) this._gridVert = opts.vertLines;
    if (opts.horzLines !== undefined) this._gridHorz = opts.horzLines;
    this.invalidate((m) => m.invalidateGlobal(InvalidationLevel.Full));
  }

  /** Current grid line visibility. */
  public gridOptions(): { vertLines: boolean; horzLines: boolean } {
    return { vertLines: this._gridVert, horzLines: this._gridHorz };
  }

  /**
   * Flatten every pane's base + overlay canvas into one opaque canvas (device
   * px). The chart renders as stacked layered canvases, so the browser's native
   * right-click "Save image" only captures the layer under the pointer (usually
   * the transparent crosshair overlay) — use this to export the full chart.
   */
  public takeScreenshot(): HTMLCanvasElement {
    const dpr = this._pixelRatio();
    const out = this._doc.createElement('canvas');
    out.width = Math.max(1, Math.round(this._width * dpr));
    out.height = Math.max(1, Math.round(this._height * dpr));
    const g = out.getContext('2d');
    if (g === null) return out;
    g.fillStyle = this._theme.background;
    g.fillRect(0, 0, out.width, out.height);
    const layout = this._paneLayout();
    for (let i = 0; i < this._panes.length; i++) {
      const y = Math.round((layout[i]?.top ?? 0) * dpr);
      const h = Math.round((layout[i]?.height ?? this._height) * dpr);
      // Each layer goes into an explicit destination rect rather than being drawn
      // at its natural size. The output is sized from the *current* pixel ratio,
      // but a pane canvas holds whatever ratio it was last laid out at, and the
      // two diverge whenever the ratio changes without a resize — dragging the
      // window to a differently-scaled monitor leaves the CSS size identical, so
      // no ResizeObserver fires and no relayout happens. Drawn at natural size
      // that filled the top-left corner and left the rest of the image blank.
      g.drawImage(this._panes[i].base.element, 0, y, out.width, h);
      g.drawImage(this._panes[i].top.element, 0, y, out.width, h);
    }
    return out;
  }

  private _addPrimitive(paneIndex: number, primitive: IPrimitive): void {
    this._ensurePane(paneIndex);
    const host: PrimitiveHost = {
      requestUpdate: (): void =>
        this.invalidate((m) => m.invalidatePane(paneIndex, { level: InvalidationLevel.Light, autoScale: false })),
    };
    this._panes[paneIndex].addPrimitive(primitive, host);
    // Track legend rows however they were added — a host can add its own (a
    // symbol/OHLC row) and indicator legends must stack beneath it.
    if (primitive instanceof PaneLegend) {
      this._legends.push({ legend: primitive, paneIndex });
      this._restackLegends();
    }
    this.invalidate((m) => m.invalidatePane(paneIndex, { level: InvalidationLevel.Light, autoScale: false }));
  }

  /** Remove a primitive from whichever pane holds it. */
  public removePrimitive(primitive: IPrimitive): void {
    const li = this._legends.findIndex((l) => l.legend === primitive);
    if (li >= 0) this._legends.splice(li, 1);
    for (let i = 0; i < this._panes.length; i++) {
      if (this._panes[i].removePrimitive(primitive)) {
        if (li >= 0) this._restackLegends();
        this.invalidate((m) => m.invalidatePane(i, { level: InvalidationLevel.Light, autoScale: false }));
        return;
      }
    }
  }

  /**
   * Renumber legend rows per pane in insertion order, so removing one closes
   * the gap instead of leaving a hole where it used to sit.
   */
  private _restackLegends(): void {
    const rowByPane = new Map<number, number>();
    for (const entry of this._legends) {
      const row = rowByPane.get(entry.paneIndex) ?? 0;
      entry.legend.setOptions({ row });
      rowByPane.set(entry.paneIndex, row + 1);
    }
    this._syncLegendOffsets();
  }

  /**
   * Apply `legendOffset` to whichever pane currently renders at the chart's
   * top-left, rather than a fixed index.
   *
   * The offset describes a region of the *chart* the host has covered with its
   * own overlay — a symbol line, an OHLC readout. Normally that is pane 0, but
   * maximizing a lower pane parks the others at a placeholder weight, so the
   * maximized pane ends up rendering in that same corner. Pinning the offset to
   * pane 0 left it drawing its legend straight through the host's readout.
   *
   * Host-added legend rows are left alone: the host positions its own.
   */
  private _syncLegendOffsets(): void {
    const layout = this._paneLayout();
    for (const entry of this._legends) {
      if (!entry.legend.options().id.startsWith('indicator:')) continue;
      // A collapsed pane above still occupies a fraction of a pixel, so "at the
      // top" is a tolerance rather than an equality.
      const atTop = (layout[entry.paneIndex]?.top ?? Number.POSITIVE_INFINITY) <= LEGEND_TOP_EPS;
      entry.legend.setOptions(
        atTop
          ? { top: this._legendOffset.top, left: this._legendOffset.left }
          : { top: DEFAULT_LEGEND_TOP, left: DEFAULT_LEGEND_LEFT },
      );
    }
  }

  /** A host for the (lazy-loaded) trade layer to attach/detach its primitives on a pane. */
  public tradeHost(paneIndex = 0): { addPrimitive(p: IPrimitive): void; removePrimitive(p: IPrimitive): void } {
    return {
      addPrimitive: (p: IPrimitive): void => this._addPrimitive(paneIndex, p),
      removePrimitive: (p: IPrimitive): void => this.removePrimitive(p),
    };
  }

  /** Apply one live bar; auto-scroll only on a genuine right-edge append. */
  private _updateBar(dataId: number, bar: Bar): void {
    const wasAtRight = this._timeScale.rightOffset >= 0;
    const kind = this._dataLayer.update(dataId, bar);
    this._timeScale.setBaseIndex(this._dataLayer.baseIndex);
    // Only a real append advances the view; late/historical inserts must not
    // be treated as a new right-edge bar (would wrongly auto-scroll / shift).
    if (kind === 'append' && !wasAtRight) {
      this._timeScale.setRightOffset(this._timeScale.rightOffset - 1);
    }
    if (dataId === this._firstDataId.value) this._recomputeIndicators();
    this.invalidate((m) => m.invalidateGlobal(InvalidationLevel.Full));
    this._updateAccessibleSummary();
  }

  private _ensurePane(index: number): void {
    let changed = false;
    while (this._panes.length <= index) {
      // price pane (0) takes full weight; lower panes (volume/indicators) are shorter
      this._addPane(this._panes.length === 0 ? 1 : 0.32);
      changed = true;
    }
    if (changed) this._relayout();
  }

  private _setData(dataId: number, bars: readonly Bar[]): void {
    this._dataLayer.setSeriesData(dataId, bars);
    this._timeScale.setBaseIndex(this._dataLayer.baseIndex);
    if (!this._hasFitContent && this._dataLayer.length > 0) {
      this._timeScale.setWidth(Math.max(0, this._width - this._priceAxisWidth - this._leftAxisWidth));
      this._timeScale.fitContent(this._dataLayer.length);
      this._hasFitContent = true;
    }
    if (dataId === this._firstDataId.value) this._recomputeIndicators();
    this.invalidate((m) => m.invalidateGlobal(InvalidationLevel.Full));
    this._updateAccessibleSummary();
  }

  /** History paging: merge older bars, preserving the viewport (§4.2). */
  private _prependData(dataId: number, bars: readonly Bar[]): void {
    this._dataLayer.addBars(dataId, bars);
    // baseIndex shifts up by the inserted count; updating it keeps the same
    // bars on screen because (rightEdge − index) is invariant.
    this._timeScale.setBaseIndex(this._dataLayer.baseIndex);
    if (dataId === this._firstDataId.value) this._recomputeIndicators();
    this.invalidate((m) => m.invalidateGlobal(InvalidationLevel.Full));
    this._updateAccessibleSummary();
  }

  private _addPane(weight = 1): Pane {
    const pane = new Pane(this._doc);
    pane.weight = weight;
    pane.priceScale.setPriceFormatter(this._priceFormatter);
    if (this._priceScaleOptions) pane.priceScale.setOptions(this._priceScaleOptions);
    this._panes.push(pane);
    this._container.appendChild(pane.element);
    return pane;
  }

  /**
   * Set a custom price formatter for every pane's axis labels, last-price tag,
   * and price-line labels at runtime (e.g. switch to a currency format). Pass
   * null to restore the default tick-size-aware formatting.
   */
  public setPriceFormatter(fn: ((price: number) => string) | null): void {
    this._priceFormatter = fn;
    for (const pane of this._panes) pane.priceScale.setPriceFormatter(fn);
    this.invalidate((m) => m.invalidateGlobal(InvalidationLevel.Full));
  }

  /**
   * Set a custom time-axis + crosshair label formatter (UTC seconds -> string)
   * at runtime. Pass undefined to restore the IST default.
   */
  public setTimeFormatter(fn: ((utcSeconds: number, tickMark?: TickMarkType) => string) | undefined): void {
    this._timeFormatter = fn;
    this.invalidate((m) => m.invalidateGlobal(InvalidationLevel.Full));
  }

  /**
   * Turn pointer gestures into anchor placement instead of panning. A host arms
   * this while a drawing tool is active: a press no longer scrolls the chart, and
   * a press-drag-release is reported as two `click` events (press point, then
   * release point, the latter tagged `viaDrag`) so a two-point shape can be drawn
   * in one gesture. `DrawingController` drives this for you.
   */
  public setPlacementMode(active: boolean): void {
    this._placementMode = active;
  }

  /** Swap the palette at runtime (dark/light toggle) without recreating the chart. */
  public setTheme(theme: ChartTheme): void {
    this._theme = theme;
    this._container.style.background = theme.background;
    this.invalidate((m) => m.invalidateGlobal(InvalidationLevel.Full));
  }

  /**
   * Apply a subset of chart options at runtime (theme, grid, formatters,
   * crosshair mode) without recreating the chart.
   */
  public applyOptions(opts: {
    theme?: ChartTheme;
    grid?: { vertLines?: boolean; horzLines?: boolean };
    priceFormatter?: ((price: number) => string) | null;
    timeFormatter?: ((utcSeconds: number, tickMark?: TickMarkType) => string) | undefined;
    crosshairMode?: CrosshairMode;
  }): void {
    if (opts.theme) this.setTheme(opts.theme);
    if (opts.grid) this.setGridOptions(opts.grid);
    if (opts.priceFormatter !== undefined) this.setPriceFormatter(opts.priceFormatter);
    if ('timeFormatter' in opts) this.setTimeFormatter(opts.timeFormatter);
    if (opts.crosshairMode) this._crosshairMode = opts.crosshairMode;
  }

  public panes(): readonly Pane[] {
    return this._panes;
  }

  /**
   * Capture the chart's serialisable state: viewport, grid, crosshair mode,
   * pane weights and price scales, indicator instances, and a `drawings` slot
   * the drawing tier fills. JSON-safe.
   *
   * Series **data** is not captured — the app owns that (it knows the symbol,
   * the timeframe, and the feed). Series *descriptors* are, so an app that
   * rebuilds its own series can re-apply their styling and placement.
   */
  public getState(): ChartState {
    const panes: PaneState[] = this._panes.map((pane) => {
      const scale = pane.priceScale;
      const o = scale.options;
      const state: PaneState = {
        weight: pane.weight,
        priceScale: {
          marginTop: o.marginTop, marginBottom: o.marginBottom, minMove: o.minMove,
          mode: o.mode, inverted: o.inverted, autoScale: scale.autoScale,
        },
      };
      if (!scale.autoScale) state.priceScale.range = { ...scale.priceRange() };
      return state;
    });

    const series: SeriesState[] = [];
    this._panes.forEach((pane, paneIndex) => {
      for (const record of pane.series()) {
        series.push({ type: record.type, style: { ...record.style }, paneIndex, priceScaleId: record.scaleId });
      }
    });

    const state: ChartState = {
      version: CHART_STATE_VERSION,
      viewport: { ...this.getVisibleLogicalRange() },
      barSpacing: this._timeScale.barSpacing,
      grid: this.gridOptions(),
      crosshairMode: this._crosshairMode,
      panes,
      series,
      indicators: this._indicators.map((i) => ({
        indicatorId: i.indicatorId,
        settings: i.settings(),
        paneIndex: i.paneIndex,
      })),
    };
    if (this._drawingState !== undefined) state.drawings = this._drawingState;
    return state;
  }

  /**
   * Re-apply a state captured by `getState`. Restores grid, crosshair mode,
   * pane weights and price scales, indicators, and the viewport — everything
   * the chart is the source of truth for.
   *
   * It does **not** recreate series: the chart has no way to know their data.
   * The returned report lists the series descriptors it saw so the caller can
   * rebuild them (`addSeries(s.type, { paneIndex: s.paneIndex, style: s.style })`)
   * and then feed them.
   *
   * Restore the viewport *after* your data lands — logical ranges index bars, so
   * a range applied to an empty chart means nothing. Call `restoreState` again
   * (or `setVisibleLogicalRange`) once the series are populated.
   */
  public restoreState(state: unknown): RestoreReport {
    const s = state as ChartState | null;
    if (s === null || typeof s !== 'object' || typeof s.version !== 'number') {
      return { applied: false, series: [], indicators: 0, reason: 'not a chart state object' };
    }
    if (s.version > CHART_STATE_VERSION) {
      return { applied: false, series: [], indicators: 0, reason: `state version ${s.version} is newer than ${CHART_STATE_VERSION}` };
    }

    if (s.grid) this.setGridOptions(s.grid);
    if (s.crosshairMode) this._crosshairMode = s.crosshairMode;

    if (s.panes) {
      s.panes.forEach((ps, i) => {
        this._ensurePane(i);
        const pane = this._panes[i];
        pane.weight = ps.weight;
        const scale = pane.priceScale;
        scale.setOptions({
          marginTop: ps.priceScale.marginTop, marginBottom: ps.priceScale.marginBottom,
          minMove: ps.priceScale.minMove, mode: ps.priceScale.mode, inverted: ps.priceScale.inverted,
        });
        scale.setAutoScale(ps.priceScale.autoScale);
        if (!ps.priceScale.autoScale && ps.priceScale.range) scale.setPriceRange(ps.priceScale.range);
      });
      this._relayout();
    }

    // Indicators are fully derivable from the source data, so they *can* be
    // recreated. Replace rather than append, so restore is idempotent.
    let indicators = 0;
    if (s.indicators) {
      for (const instance of this._indicators) instance.remove();
      this._indicators.length = 0;
      for (const spec of s.indicators) {
        if (!hasIndicator(spec.indicatorId)) continue; // tier not loaded — skip, don't throw
        this._indicators.push(new IndicatorInstance(
          this._indicatorHost(), getIndicator(spec.indicatorId), spec.settings, spec.paneIndex,
        ));
        indicators += 1;
      }
    }

    // A saved pane only exists to hold an indicator, and an indicator is skipped
    // when its tier was never imported — so a restore can leave a pane behind
    // with nothing in it. An empty pane still claims its weight and still draws
    // a default 0..100 axis, which reads as a large blank region under the
    // chart. Drop them, the same way removing the last indicator from a pane
    // already does. Walk backwards so the indices stay valid as panes go.
    for (let i = this._panes.length - 1; i > 0; i--) {
      if (this._panes[i].series().length === 0) this.removePane(i);
    }

    this._drawingState = s.drawings;
    if (s.barSpacing !== undefined) this._timeScale.setBarSpacing(s.barSpacing);
    if (s.viewport && this._dataLayer.length > 0) this.setVisibleLogicalRange(s.viewport);
    this.invalidate((m) => m.invalidateGlobal(InvalidationLevel.Full));
    return { applied: true, series: s.series ?? [], indicators };
  }

  /**
   * The opaque `drawings` slot in the chart state. The base engine only
   * round-trips it; the drawing tier reads and writes it.
   */
  public drawingState(): unknown {
    return this._drawingState;
  }

  public setDrawingState(value: unknown): void {
    this._drawingState = value;
  }

  public invalidate(build: (mask: InvalidateMask) => void): void {
    if (this._pending === null) this._pending = new InvalidateMask();
    build(this._pending);
    this._loop.requestFrame();
  }

  public applySize(width: number, height: number): void {
    if (width === this._width && height === this._height) return;
    this._width = width;
    this._height = height;
    this._relayout();
    this.invalidate((m) => m.invalidateGlobal(InvalidationLevel.Full));
    this.emit('resize', { width, height });
  }

  /** Distribute height across panes by weight; sync the shared time-scale width. */
  private _relayout(): void {
    this._syncTimeNavPane();
    // Weights just changed, so the pane at the chart's top may have too.
    this._syncLegendOffsets();
    const dpr = this._pixelRatio();
    const total = this._weightTotal();
    for (const pane of this._panes) {
      const h = (this._height * pane.weight) / total;
      // The DOM box is given the SAME pixel height the canvas is sized to,
      // rather than a flex ratio. With `flex: w 1 0` the browser distributed the
      // container's *real* height while the canvas used `this._height` — so any
      // drift between the two (a container that resized before the observer
      // fired) silently offset every hit-test from what was drawn: pane
      // boundaries, legend buttons, and crosshair mapping all landed elsewhere.
      // Deriving both from one number makes layout == hit-test by construction.
      pane.element.style.flex = `0 0 ${h}px`;
      // A hairline between stacked panes — every pane but the first. Drawn on
      // the DOM box, so it sits exactly on the boundary the user drags.
      const first = pane === this._panes[0];
      pane.element.style.borderTopWidth = first ? '0px' : '1px';
      pane.element.style.borderTopColor = first ? 'transparent' : this._theme.paneSeparator;
      pane.resize(this._width, h, dpr);
      // Scale height is a layout property — see Pane.setScaleHeights.
      const isLast = pane === this._panes[this._panes.length - 1];
      pane.setScaleHeights(Math.max(0, h - (isLast ? this._timeAxisHeight : 0)));
    }
    this._timeScale.setWidth(Math.max(0, this._width - this._priceAxisWidth - this._leftAxisWidth));
  }

  /** Reserve a chart-wide left-axis column when any pane has a left price scale. */
  private _recomputeLeftAxis(): void {
    const w = this._panes.some((p) => p.hasLeftScale()) ? this._priceAxisWidth : 0;
    if (w === this._leftAxisWidth) return;
    this._leftAxisWidth = w;
    this._relayout();
    this.invalidate((m) => m.invalidateGlobal(InvalidationLevel.Full));
  }

  private _weightTotal(): number {
    let total = 0;
    for (const pane of this._panes) total += pane.weight;
    return total <= 0 ? 1 : total;
  }

  /** Grab tolerance around a pane boundary, in media px. */
  private static readonly DIVIDER_GRAB = 4;

  /**
   * Index of the pane whose *bottom* boundary is within grab range of `y`, or
   * null. Boundary `i` separates pane `i` from pane `i + 1`; the last pane's
   * bottom is the chart edge and is not draggable.
   */
  private _dividerAt(y: number): number | null {
    const layout = this._paneLayout();
    for (let i = 0; i < layout.length - 1; i++) {
      const boundary = layout[i].top + layout[i].height;
      if (Math.abs(y - boundary) <= Chart.DIVIDER_GRAB) return i;
    }
    return null;
  }

  /**
   * Set a pane's relative height weight. Panes share the chart height in
   * proportion to their weights, so only the ratio matters.
   */
  public setPaneWeight(index: number, weight: number): void {
    const pane = this._panes[index];
    if (pane === undefined) return;
    pane.weight = Math.max(0.05, weight);
    this._relayout();
    this.invalidate((m) => m.invalidateGlobal(InvalidationLevel.Full));
  }

  public paneWeight(index: number): number {
    return this._panes[index]?.weight ?? 0;
  }

  /**
   * Remove a pane, everything drawn in it, and any indicator that lives there.
   * Pane 0 (price) is never removable — removing it would leave the chart with
   * no time axis owner.
   *
   * Returns false when the index is out of range or is pane 0.
   */
  public removePane(index: number): boolean {
    if (index <= 0 || index >= this._panes.length) return false;
    // Indicators own their series, so let them tear themselves down first —
    // otherwise their series rows would outlive the pane holding them.
    for (let i = this._indicators.length - 1; i >= 0; i--) {
      if (this._indicators[i].paneIndex !== index) continue;
      this._indicators[i].remove();
      this._indicators.splice(i, 1);
    }
    const pane = this._panes[index];
    for (const record of [...pane.series()]) {
      pane.removeSeries(record);
      this._dataLayer.removeSeries(record.dataId);
      if (this._firstDataId.value === record.dataId) this._firstDataId.value = null;
    }
    pane.destroy();
    this._panes.splice(index, 1);
    // Keep the maximize snapshot aligned. It is indexed by pane position, so
    // dropping a pane without splicing it leaves un-maximize restoring the
    // wrong weights — which is how panes end up stranded at the 0.001
    // placeholder maximize parks them at, and `getState` then persists that.
    if (this._savedWeights !== null) {
      this._savedWeights.splice(index, 1);
      if (this._savedWeights.length <= 1) this._savedWeights = null;
    }
    // Indicators below the removed pane shift up one.
    for (const indicator of this._indicators) {
      if (indicator.paneIndex > index) indicator.shiftPane(-1);
    }
    this._timeScale.setBaseIndex(this._dataLayer.baseIndex);
    this._recomputeLeftAxis();
    this._relayout();
    this.invalidate((m) => m.invalidateGlobal(InvalidationLevel.Full));
    this.emit('paneRemoved', { paneIndex: index });
    return true;
  }

  /**
   * Move a pane up or down one slot. Pane 0 (price) is pinned — it owns the
   * primary series and the shared price context — so a move that would displace
   * it is refused.
   */
  public movePane(index: number, direction: -1 | 1): boolean {
    const target = index + direction;
    if (index <= 0 || target <= 0 || index >= this._panes.length || target >= this._panes.length) return false;
    const panes = this._panes;
    [panes[index], panes[target]] = [panes[target], panes[index]];
    for (const indicator of this._indicators) {
      if (indicator.paneIndex === index) indicator.shiftPane(direction);
      else if (indicator.paneIndex === target) indicator.shiftPane(-direction);
    }
    // Re-append in the new order so the DOM matches the pane array.
    for (const pane of panes) this._container.appendChild(pane.element);
    this._relayout();
    this.invalidate((m) => m.invalidateGlobal(InvalidationLevel.Full));
    this.emit('paneMoved', { from: index, to: target });
    return true;
  }

  /**
   * Expand one pane to fill the chart, collapsing the others to a sliver.
   * Calling it again (or on another pane) restores the previous weights.
   */
  public maximizePane(index: number): boolean {
    if (index < 0 || index >= this._panes.length) return false;
    if (this._maximizedPane === index) {
      const saved = this._savedWeights;
      if (saved !== null) this._panes.forEach((p, i) => { p.weight = saved[i] ?? p.weight; });
      this._maximizedPane = null;
      this._savedWeights = null;
    } else {
      if (this._savedWeights === null) this._savedWeights = this._panes.map((p) => p.weight);
      this._panes.forEach((p, i) => { p.weight = i === index ? 1 : 0.001; });
      this._maximizedPane = index;
    }
    this._relayout();
    this.invalidate((m) => m.invalidateGlobal(InvalidationLevel.Full));
    this.emit('paneMaximized', { paneIndex: this._maximizedPane });
    return true;
  }

  /** The maximized pane index, or null when none is. */
  public maximizedPane(): number | null {
    return this._maximizedPane;
  }

  /**
   * Route a pane-legend button press. Ids look like `indicator:<instanceId>::close`.
   * Returns true when the id was ours and was handled.
   */
  private _handleLegendAction(externalId: string): boolean {
    const sep = externalId.lastIndexOf('::');
    if (sep < 0) return false;
    const action = externalId.slice(sep + 2);
    // Navigator buttons run the same commands the keyboard does, so the two
    // paths can never drift apart.
    if (this._timeNav !== null && externalId.startsWith(`${this._timeNav.options().id}::`)) {
      if (this._runShortcut(action)) {
        this.invalidate((m) => m.invalidateGlobal(InvalidationLevel.Full));
      }
      return true;
    }
    // A host-owned legend row (a symbol/OHLC row) also reveals on hover; swallow
    // its click so it never surfaces as a phantom id.
    if (action === 'row' && !externalId.startsWith('indicator:')) return true;
    if (!externalId.startsWith('indicator:')) return false;
    const instanceId = externalId.slice('indicator:'.length, sep);
    // `::row` is the hover target that reveals the controls — never an action.
    if (action === 'row') return true;
    const indicator = this._indicators.find((i) => i.id === instanceId);
    if (indicator === undefined) return false;
    const paneIndex = indicator.paneIndex;
    switch (action) {
      case 'close':
        this.removeIndicator(instanceId);   // prunes its pane if it emptied
        return true;
      case 'hide': indicator.setVisible(!indicator.visible()); return true;
      case 'up': this.movePane(paneIndex, -1); return true;
      case 'down': this.movePane(paneIndex, 1); return true;
      case 'maximize': this.maximizePane(paneIndex); return true;
      // The engine is canvas-only and ships no DOM, so the settings form is the
      // host's. Everything it needs to *generate* one is on the descriptor
      // (`inputs`), and applying it is `indicator.setSettings(patch)`.
      case 'settings':
        this.emit('indicatorSettings', { instanceId, indicatorId: indicator.indicatorId, paneIndex });
        return true;
      default: return false;
    }
  }

  /** Cumulative top + height of each pane, by weight (the source of truth for hit-testing). */
  private _paneLayout(): { top: number; height: number }[] {
    const total = this._weightTotal();
    const out: { top: number; height: number }[] = [];
    let top = 0;
    for (const pane of this._panes) {
      const h = (this._height * pane.weight) / total;
      out.push({ top, height: h });
      top += h;
    }
    return out;
  }

  /**
   * Keyboard hints for the navigator tooltips, read from the live keymap so a
   * rebind shows up in the tooltip instead of a stale hardcoded string. The
   * one-bar step buttons have no default binding, so they get no hint.
   */
  private _navHints(opts?: Partial<TimeNavigatorOptions>): Partial<Record<string, string>> {
    if (opts?.hints !== undefined) return opts.hints;
    if (this._shortcuts === null) return {};
    const out: Record<string, string> = {};
    for (const e of this._shortcuts.list()) {
      if (e.command !== 'zoomIn' && e.command !== 'zoomOut') continue;
      const combo = e.combos[0];
      if (combo !== undefined) out[e.command] = prettyCombo(combo);
    }
    return out;
  }

  /**
   * Keep the navigator on the bottom pane — it belongs just above the time
   * axis, and adding or removing a pane moves which one that is.
   */
  private _syncTimeNavPane(): void {
    if (this._timeNav === null) return;
    const target = this._panes.length - 1;
    if (target === this._timeNavPane || target < 0) return;
    if (this._timeNavPane >= 0) this._panes[this._timeNavPane]?.removePrimitive(this._timeNav);
    this._addPrimitive(target, this._timeNav);
    this._timeNavPane = target;
  }

  /**
   * Push the pointer to the navigator and keep painting while it fades, so the
   * animation runs even when nothing else on the chart is changing.
   */
  private _feedTimeNav(p: { x: number; y: number } | null): void {
    const nav = this._timeNav;
    if (nav === null) return;
    nav.setPointer(p);
    if (nav.animating()) this.invalidate((m) => m.invalidateGlobal(InvalidationLevel.Light));
  }

  private _renderContext(showTimeAxis: boolean): PaneRenderContext {
    return {
      timeScale: this._timeScale,
      dataLayer: this._dataLayer,
      dpr: this._pixelRatio(),
      priceAxisWidth: this._priceAxisWidth,
      timeAxisHeight: this._timeAxisHeight,
      showTimeAxis,
      conflate: this._conflate,
      conflationFactor: this._conflationFactor,
      theme: this._theme,
      showVertGrid: this._gridVert,
      showHorzGrid: this._gridHorz,
      timeFormatter: this._timeFormatter,
      leftAxisWidth: this._leftAxisWidth,
      hoverId: this._hoverId,
      dragId: this._dragId,
    };
  }

  private _observeSize(): void {
    if (typeof ResizeObserver === 'undefined') return;
    this._resizeObserver = new ResizeObserver((entries) => {
      const entry = entries[0];
      if (entry) this.applySize(entry.contentRect.width, entry.contentRect.height);
    });
    this._resizeObserver.observe(this._container);
  }

  private _onFrame(): void {
    const mask = this._pending;
    this._pending = null;
    if (mask === null || mask.isEmpty()) return;

    const global = mask.globalLevel;
    for (let i = 0; i < this._panes.length; i++) {
      const pane = this._panes[i];
      const perPane = mask.paneInvalidation(i);
      const level = Math.max(global, perPane?.level ?? InvalidationLevel.None);
      const isBottom = i === this._panes.length - 1;
      const ctx = this._renderContext(isBottom);
      if (level >= InvalidationLevel.Full || perPane?.autoScale) pane.autoscale(ctx);
      if (level >= InvalidationLevel.Light) pane.paintBase(ctx);
      if (level >= InvalidationLevel.Cursor && !this._overlayFrozen) {
        // Global crosshair: every pane draws the vertical line at the shared x;
        // only the hovered pane draws the horizontal line + price tag; the bottom
        // pane draws the date tag.
        const cross = this._cursor === null
          ? null
          : { x: this._cursor.x, yLocal: i === this._cursorPane ? this._cursor.y : null, showTimeTag: isBottom };
        pane.paintTop(cross, ctx);
      }
    }
  }

  // ── input handling ──────────────────────────────────────────────────────

  private _attachInput(): void {
    if (typeof window === 'undefined') return;
    const el = this._container;
    el.addEventListener('pointerdown', this._onPointerDown);
    el.addEventListener('pointermove', this._onPointerMove);
    el.addEventListener('pointerup', this._onPointerUpNative);
    el.addEventListener('pointercancel', this._onPointerUp);
    el.addEventListener('pointerleave', this._onPointerLeave);
    el.addEventListener('wheel', this._onWheel, { passive: false });
    el.addEventListener('dblclick', this._onDblClick);
    el.addEventListener('pointerenter', this._onPointerEnter);
    el.addEventListener('contextmenu', this._onContextMenu);
    // Keyboard: listen on the document when available (so shortcuts fire on hover
    // without focusing the chart), else on the focusable container. The handler
    // gates by scope / hover / focus.
    const keyTarget: HTMLElement | Document =
      typeof this._doc.addEventListener === 'function' ? this._doc : el;
    keyTarget.addEventListener('keydown', this._onKeyDown as EventListener);
    this._keyTarget = keyTarget;
  }

  private readonly _onPointerEnter = (): void => { this._pointerInside = true; };

  /**
   * The chart renders as stacked canvases, so the browser's right-click
   * "Save image as…" would capture only the topmost (transparent overlay)
   * layer — a blank image. Just before the native menu opens, composite the
   * clicked pane's base layer *beneath* its overlay bitmap so the saved image
   * is the visible chart, and freeze overlay repaints (live ticks repaint every
   * few hundred ms and would wipe the snapshot while the menu is open). The
   * freeze lifts on the next pointer/wheel/key input after the menu closes.
   * Apps that present their own menu (preventDefault on contextmenu) are
   * unaffected. Multi-pane note: the native save captures the clicked pane
   * only — use `downloadScreenshot()` for the full multi-pane composite.
   */
  private readonly _onContextMenu = (e: MouseEvent): void => {
    if (e.defaultPrevented) return; // app shows its own menu (e.g. order entry)
    const pane = this._panes[this._localPoint(e).pane];
    if (pane === undefined) return;
    // Null the crosshair without invalidating: a pointerleave fired while the
    // native menu is open must not schedule a repaint that wipes the snapshot.
    this._cursor = null;
    this._cursorPane = null;
    try {
      const g = pane.top.ctx;
      g.save();
      g.globalCompositeOperation = 'destination-over';
      g.drawImage(pane.base.element, 0, 0);
      g.restore();
      this._overlayFrozen = true;
    } catch { /* zero-sized or detached canvas — nothing to snapshot */ }
  };

  /** Resume overlay repaints after the native context menu closes. */
  private _unfreezeOverlay(): void {
    if (!this._overlayFrozen) return;
    this._overlayFrozen = false;
    this.invalidate((m) => m.invalidateGlobal(InvalidationLevel.Cursor));
  }

  private _localPoint(e: { clientX: number; clientY: number }): { x: number; y: number; pane: number; localY: number; paneHeight: number } {
    const rect = this._container.getBoundingClientRect();
    const x = e.clientX - rect.left;
    const y = e.clientY - rect.top;
    // Map Y to a pane by cumulative *weighted* heights — matches the DOM/canvas layout.
    const layout = this._paneLayout();
    let pane = 0;
    for (let i = 0; i < layout.length; i++) if (y >= layout[i].top) pane = i;
    const pl = layout[pane] ?? { top: 0, height: this._height };
    return { x, y, pane, localY: y - pl.top, paneHeight: pl.height };
  }

  private readonly _onPointerDown = (e: PointerEvent): void => {
    this._unfreezeOverlay();
    // Only the primary button starts a pan / line-drag. A right-click (context
    // menu) also fires pointerdown, and its pointerup is often swallowed by the
    // menu — arming the drag state then makes the chart pan with no button held.
    if (e.pointerType === 'mouse' && e.button !== 0) return;
    this._stopKinetic();
    const p = this._localPoint(e);
    this._pointers.set(e.pointerId, { x: p.x, y: p.y, pane: p.pane });
    // `setPointerCapture` throws NotFoundError when the pointer id is not
    // currently active (a synthetic event, or one already released). The
    // optional call only guarded against the method being absent, so the throw
    // aborted the rest of pointerdown — losing the divider grab, the axis-drag
    // arm, and the line-drag arm. Capture is an optimisation; never fatal.
    try { this._container.setPointerCapture?.(e.pointerId); } catch { /* not capturable */ }
    if (this._pointers.size >= 2) { this._beginPinch(); return; } // second finger → pinch, skip single-drag
    this._downPane = p.pane;
    this._downX = p.x;
    this._downLocalY = p.localY;

    // Pane divider: pressing within a few px of the boundary between two panes
    // starts a resize, redistributing weight between them.
    const divider = this._dividerAt(p.y);
    if (divider !== null) {
      const layout = this._paneLayout();
      this._paneResize = {
        index: divider,
        startY: p.y,
        aWeight: this._panes[divider].weight,
        bWeight: this._panes[divider + 1].weight,
        aHeight: layout[divider].height,
        bHeight: layout[divider + 1].height,
      };
      this._dragging = false;
      return;
    }

    // Axis-drag rescale: dragging the price axis (right strip) rescales Y;
    // dragging the time axis (bottom strip of the last pane) rescales X.
    const plotWidth = Math.max(0, this._width - this._priceAxisWidth);
    const onPriceAxis = p.x >= plotWidth;
    const onTimeAxis = p.pane === this._panes.length - 1 && p.localY >= p.paneHeight - this._timeAxisHeight;
    if (onPriceAxis) {
      this._axisDrag = 'price';
      this._axisStartCoord = p.localY;
      const r = this._panes[p.pane].priceScale.priceRange();
      this._axisStartMin = r.min;
      this._axisStartMax = r.max;
      this._dragging = false;
      return;
    }
    if (onTimeAxis) {
      this._axisDrag = 'time';
      this._axisStartCoord = p.x;
      this._axisStartSpacing = this._timeScale.barSpacing;
      this._dragging = false;
      return;
    }

    // While a host is placing something (a drawing tool is armed), a press is the
    // start of a shape, not a pan. Bail before the drag/hit paths so the gesture
    // can only produce anchors — `_onPointerUp` turns it into clicks.
    if (this._placementMode) {
      this._dragging = false;
      this._pointerMoved = false;
      return;
    }

    // If the press lands on a draggable line (order/SL/TP), drag it — don't pan.
    const hit = this._panes[p.pane]?.hitTestPrimitives(p.x - this._leftAxisWidth, p.localY, this._renderContext(p.pane === this._panes.length - 1));
    // `draggable` primitives (drawing anchors/shapes) arm regardless of a host
    // callback — they publish through the `drag` event bus. The `ns-resize`
    // form is the original price-line path and still needs `subscribeDrag`.
    if (hit && (hit.draggable === true || (hit.cursor === 'ns-resize' && this._dragCb !== null))) {
      this._dragId = hit.externalId;
      this._dragMoved = false;
      this._ensureScaled(p.pane);
      this._dragFrom = {
        time: this._xToTime(p.x),
        price: this._panes[p.pane].priceScale.yToPrice(p.localY),
      };
      this._setHover(hit); // active state + cursor even when no hover preceded (touch)
      // Hide the crosshair while dragging a line — a frozen crosshair at the
      // grab point reads as a phantom second line (the axis tag tracks price).
      this._cursor = null;
      this._cursorPane = null;
      this.invalidate((m) => m.invalidateGlobal(InvalidationLevel.Cursor));
      this._dragging = false;
      this._pointerMoved = false;
      return;
    }

    this._dragging = true;
    this._pointerMoved = false;
    this._dragStartX = p.x;
    this._dragStartY = p.y;
    this._lastDragY = p.y;
    this._dragStartOffset = this._timeScale.rightOffset;
    this._lastDragX = p.x;
    this._lastDragT = this._now();
    this._dragVelocity = 0;
  };

  private readonly _onPointerMove = (e: PointerEvent): void => {
    this._unfreezeOverlay();
    // Safety: if the primary button is no longer held (missed pointerup — e.g.
    // released over a context menu or outside the window), end any drag now.
    if (e.pointerType === 'mouse' && (e.buttons & 1) === 0 && (this._dragging || this._dragId !== null || this._axisDrag !== null)) {
      this._onPointerUp(e);
      return;
    }
    const p = this._localPoint(e);
    if (this._pointers.has(e.pointerId)) this._pointers.set(e.pointerId, { x: p.x, y: p.y, pane: p.pane });
    if (this._pinch !== null) { this._updatePinch(); return; }
    if (this._axisDrag === 'price') {
      // drag up (dy<0) → expand (zoom in); drag down → compress (zoom out)
      const dy = p.localY - this._axisStartCoord;
      const factor = Math.exp(dy * 0.005);
      const centre = (this._axisStartMin + this._axisStartMax) / 2;
      const half = ((this._axisStartMax - this._axisStartMin) / 2) * factor;
      const ps = this._panes[this._downPane].priceScale;
      ps.setPriceRange({ min: centre - half, max: centre + half });
      ps.setAutoScale(false);
      this.invalidate((m) => m.invalidatePane(this._downPane, { level: InvalidationLevel.Light, autoScale: false }));
      return;
    }
    if (this._paneResize !== null) {
      const r = this._paneResize;
      // Move `dy` px of height from one pane to the other, keeping their summed
      // weight constant so the other panes are untouched. Clamped so neither
      // side collapses below a usable height.
      const total = r.aHeight + r.bHeight;
      const sum = r.aWeight + r.bWeight;
      const min = Math.min(24, total / 4);
      const aH = Math.max(min, Math.min(total - min, r.aHeight + (p.y - r.startY)));
      this._panes[r.index].weight = (aH / total) * sum;
      this._panes[r.index + 1].weight = sum - this._panes[r.index].weight;
      this._relayout();
      this.invalidate((m) => m.invalidateGlobal(InvalidationLevel.Full));
      return;
    }
    if (this._axisDrag === 'time') {
      // drag right (dx>0) → expand (wider bars); drag left → compress
      const dx = p.x - this._axisStartCoord;
      this._timeScale.setBarSpacing(this._axisStartSpacing * Math.exp(dx * 0.005));
      this.invalidate((m) => m.invalidateGlobal(InvalidationLevel.Full));
      return;
    }
    // Placement mode suppresses the pan path, which is where `_pointerMoved`
    // is normally set — track the gesture here so pointerup can still tell a
    // click from a drag-to-draw.
    if (this._placementMode && this._pointers.size > 0
      && (Math.abs(p.x - this._downX) > 3 || Math.abs(p.localY - this._downLocalY) > 3)) {
      this._pointerMoved = true;
    }
    if (this._dragId !== null) {
      if (Math.abs(p.x - this._downX) > 3 || Math.abs(p.localY - this._downLocalY) > 3) this._dragMoved = true;
      const price = this._panes[this._downPane].priceScale.yToPrice(p.localY);
      const time = this._xToTime(p.x);
      this._dragCb?.(this._dragId, price, time);
      this.emit('drag', {
        id: this._dragId, price, time, paneIndex: this._downPane,
        // The grab origin, so a consumer's delta starts at the press instead of
        // the first move — otherwise the shape lags the cursor by one event.
        fromPrice: this._dragFrom.price, fromTime: this._dragFrom.time,
      });
      return;
    }
    if (this._dragging) {
      const dx = p.x - this._dragStartX;
      if (Math.abs(dx) > 3 || Math.abs(p.y - this._dragStartY) > 3) this._pointerMoved = true;
      // horizontal: scroll time
      this._timeScale.setRightOffset(this._dragStartOffset - dx / this._timeScale.barSpacing);
      // vertical: pan the dragged pane's price scale (incremental, switches to manual)
      this._panes[this._downPane]?.priceScale.panByPixels(p.y - this._lastDragY);
      this._lastDragY = p.y;
      const t = this._now();
      const dt = t - this._lastDragT;
      if (dt > 0) this._dragVelocity = (p.x - this._lastDragX) / dt;
      this._lastDragX = p.x;
      this._lastDragT = t;
      this._maybeLoadHistory();
      this.invalidate((m) => m.invalidateGlobal(InvalidationLevel.Full));
      this._emitViewport('pan');
      return;
    }
    this._updateCursor(p.pane, p.x, p.localY, p.y);
  };

  private readonly _onPointerUp = (e: PointerEvent): void => {
    try { this._container.releasePointerCapture?.(e.pointerId); } catch { /* already released */ }
    this._pointers.delete(e.pointerId);
    if (this._pinch !== null) {
      // a finger lifted mid-pinch: end the gesture; don't start a drag with the remnant
      if (this._pointers.size < 2) { this._pinch = null; this._dragging = false; }
      return;
    }
    if (this._paneResize !== null) {
      this._paneResize = null;
      this.emit('paneResized', { paneIndex: this._downPane });
      return;
    }
    if (this._axisDrag !== null) {
      this._axisDrag = null;
      return;
    }
    if (this._dragId !== null) {
      const p = this._localPoint(e);
      const price = this._panes[this._downPane].priceScale.yToPrice(p.localY);
      const time = this._xToTime(p.x);
      this._dragEndCb?.(this._dragId, price, time);
      this.emit('drag:end', { id: this._dragId, price, time, paneIndex: this._downPane });
      // A press on a draggable primitive arms a drag, so this branch used to
      // swallow the release — and a plain click on a drawing never reached the
      // click path, leaving it unselectable. A gesture that never moved is a
      // click by any reasonable reading.
      if (!this._dragMoved) {
        const id = this._dragId;
        this._clickCb?.(id);
        this.emit('click', {
          id, price, time,
          paneIndex: this._downPane,
          point: { x: this._downX, y: this._downLocalY },
        });
      }
      this._dragId = null;
      // Re-evaluate hover at the release point (mouse keeps hovering the line;
      // touch has no pointer any more) and drop the dragging visual state.
      const hit = e.pointerType === 'touch'
        ? null
        : this._panes[p.pane]?.hitTestPrimitives(p.x - this._leftAxisWidth, p.localY, this._renderContext(p.pane === this._panes.length - 1)) ?? null;
      this._setHover(hit);
      this.invalidate((m) => m.invalidateGlobal(InvalidationLevel.Light));
      return;
    }
    this._dragging = false;
    // Placement mode: a press-drag-release is how every charting UI draws a
    // two-point shape, but the click branch below is gated on the pointer having
    // stayed still, so the gesture used to place nothing at all. Replay it as the
    // two clicks it means — press point, then release point. `viaDrag` lets the
    // host ignore the second one for single-anchor tools it already completed.
    if (this._placementMode && this._pointerMoved) {
      const p = this._localPoint(e);
      this._ensureScaled(this._downPane);
      this.emit('click', {
        id: null,
        price: this._panes[this._downPane]?.priceScale.yToPrice(this._downLocalY) ?? null,
        time: this._xToTime(this._downX),
        paneIndex: this._downPane,
        point: { x: this._downX, y: this._downLocalY },
      });
      this.emit('click', {
        id: null,
        price: this._panes[this._downPane]?.priceScale.yToPrice(p.localY) ?? null,
        time: this._xToTime(p.x),
        paneIndex: this._downPane,
        point: { x: p.x, y: p.localY },
        viaDrag: true,
      });
      return;
    }
    // Always hit-test a clean click: the chart's own chrome (pane-legend
    // buttons) must work whether or not the host subscribed to clicks.
    if (!this._pointerMoved) {
      const isBottom = this._downPane === this._panes.length - 1;
      const hit = this._panes[this._downPane]?.hitTestPrimitives(this._downX - this._leftAxisWidth, this._downLocalY, this._renderContext(isBottom));
      // Pane-legend buttons are the chart's own chrome — handle them here so
      // the host doesn't have to re-implement remove/hide/move/maximize.
      if (hit && this._handleLegendAction(hit.externalId)) return;
      if (hit) this._clickCb?.(hit.externalId);
      // The event carries position and fires on empty plot too, which is what a
      // tool that *places* something (a drawing, an alert) needs; `id` is null
      // there. `subscribeClick` stays hit-only for back-compat.
      this._ensureScaled(this._downPane);
      this.emit('click', {
        id: hit?.externalId ?? null,
        price: this._panes[this._downPane]?.priceScale.yToPrice(this._downLocalY) ?? null,
        time: this._xToTime(this._downX),
        paneIndex: this._downPane,
        point: { x: this._downX, y: this._downLocalY },
      });
      return;
    }
    if (KineticAnimation.shouldAnimate(this._dragVelocity)) this._startKinetic(this._dragVelocity);
  };

  /**
   * DOM pointerup entry point. Mirrors the primary-button guard in
   * `_onPointerDown`: a right-click (or any non-primary mouse button) fires
   * pointerdown *and* pointerup, but `_onPointerDown` ignores it — so the
   * down state (`_downX`/`_downLocalY`/`_downPane`/`_pointerMoved`) is never
   * refreshed and still holds the *previous* left-click. Letting a non-primary
   * pointerup through would re-run the click branch against that stale position
   * and replay the last click (e.g. re-firing a Buy/Sell button → a phantom
   * order). Touch/pen are unaffected (they contact with button 0). The internal
   * recovery call from `_onPointerMove` invokes `_onPointerUp` directly, so it
   * bypasses this filter and still ends a drag when a button release is missed.
   */
  private readonly _onPointerUpNative = (e: PointerEvent): void => {
    if (e.pointerType === 'mouse' && e.button !== 0) return;
    this._onPointerUp(e);
  };

  private readonly _onPointerLeave = (): void => {
    this._pointerInside = false;
    this._feedTimeNav(null);
    if (this._dragId === null) this._setHover(null); // keep the active state while dragging
    if (this._cursor !== null) {
      this._cursor = null;
      this._cursorPane = null;
      // clear the crosshair from every pane (global vertical line)
      this.invalidate((m) => m.invalidateGlobal(InvalidationLevel.Cursor));
      // Pointer left the plot: legends fall back to the latest bar.
      for (const indicator of this._indicators) indicator.updateLegendValues();
      const cleared = { time: null, index: null, price: null, bar: null, point: null, paneIndex: null };
      this._crosshairCb?.(cleared);
      this.emit('crosshair:move', cleared);
    }
  };

  private readonly _onWheel = (e: WheelEvent): void => {
    this._unfreezeOverlay();
    e.preventDefault();
    const p = this._localPoint(e);
    const factor = e.deltaY < 0 ? 1.1 : 1 / 1.1;
    this._timeScale.zoomAtX(p.x, factor);
    this._maybeLoadHistory();
    this.invalidate((m) => m.invalidateGlobal(InvalidationLevel.Full));
    this._emitViewport('zoom');
  };

  /**
   * Restore the default view: fit all bars on the time axis and re-enable
   * auto-scaling on every price axis (undoing any pan/zoom or manual axis drag).
   * Same as double-clicking the chart.
   */
  public resetScale(): void {
    if (this._dataLayer.length > 0) this._timeScale.fitContent(this._dataLayer.length);
    for (const pane of this._panes) pane.priceScale.setAutoScale(true);
    this.invalidate((m) => m.invalidateGlobal(InvalidationLevel.Full));
  }

  private readonly _onDblClick = (): void => {
    this.emit('dblclick', {});
    // While a tool is armed a double-click means "finish this shape" — a
    // variable-anchor tool has no other way to end — so it must not also throw
    // the view back to its default mid-placement.
    if (!this._placementMode) this.resetScale();
  };

  // ── multi-touch pinch (zoom + two-finger pan) ─────────────────────────────
  private _beginPinch(): void {
    const pts = [...this._pointers.values()];
    this._pinch = pinchState(pts[0], pts[1]);
    this._pinchPane = pts[0].pane;
    // abort any single-pointer interaction so it doesn't fight the pinch
    this._dragging = false; this._axisDrag = null; this._dragId = null; this._pointerMoved = true;
  }

  private _updatePinch(): void {
    const pts = [...this._pointers.values()];
    if (pts.length < 2 || this._pinch === null) return;
    const cur = pinchState(pts[0], pts[1]);
    const d = pinchDelta(this._pinch, cur);
    if (d.factor !== 1) this._timeScale.zoomAtX(cur.cx, d.factor);                       // pinch → zoom time
    this._timeScale.setRightOffset(this._timeScale.rightOffset - d.dx / this._timeScale.barSpacing); // two-finger pan X
    this._panes[this._pinchPane]?.priceScale.panByPixels(d.dy);                          // two-finger pan Y
    this._pinch = cur;
    this._maybeLoadHistory();
    this.invalidate((m) => m.invalidateGlobal(InvalidationLevel.Full));
    this._emitViewport(d.factor !== 1 ? 'zoom' : 'pan');
  }

  // ── keyboard navigation (focus the chart, then arrows / +- / Home) ────────
  private readonly _onKeyDown = (e: KeyboardEvent): void => {
    this._unfreezeOverlay();
    const sc = this._shortcuts;
    if (sc === null || ShortcutManager.shouldIgnore(e.target) || !this._shortcutsActive()) return;
    const cmd = sc.resolve(e);
    if (cmd === null) return;
    let handled = this._runShortcut(cmd);
    if (!handled) handled = sc.runCustom(cmd);
    if (!handled) return;
    e.preventDefault();
    sc.emitTrigger(cmd);
    this._maybeLoadHistory();
    this.invalidate((m) => m.invalidateGlobal(InvalidationLevel.Full));
    this._updateAccessibleSummary();
  };

  /** Scope gating: hover keeps keys chart-local; global always acts. */
  private _shortcutsActive(): boolean {
    if (this._shortcuts === null) return false;
    if (this._shortcuts.scope === 'global' || this._pointerInside) return true;
    const active = this._doc.activeElement as Node | null;
    return active !== null && (active === this._container || this._container.contains?.(active) === true);
  }

  /** Execute a built-in command; returns false for unknown (custom) commands. */
  private _runShortcut(command: string): boolean {
    const ts = this._timeScale;
    switch (command) {
      case 'panLeftBar': ts.setRightOffset(ts.rightOffset - 1); return true;
      case 'panRightBar': ts.setRightOffset(ts.rightOffset + 1); return true;
      case 'panLeft': ts.setRightOffset(ts.rightOffset - 2); return true;
      case 'panRight': ts.setRightOffset(ts.rightOffset + 2); return true;
      case 'panLeftFast': ts.setRightOffset(ts.rightOffset - 10); return true;
      case 'panRightFast': ts.setRightOffset(ts.rightOffset + 10); return true;
      case 'panUp': this._panes[0]?.priceScale.panByPixels(20); return true;
      case 'panDown': this._panes[0]?.priceScale.panByPixels(-20); return true;
      case 'zoomIn': ts.zoomAtX(this._width / 2, 1.1); return true;
      case 'zoomOut': ts.zoomAtX(this._width / 2, 1 / 1.1); return true;
      case 'resetScale': this.resetScale(); return true;
      case 'fitContent': if (this._dataLayer.length > 0) ts.fitContent(this._dataLayer.length); return true;
      case 'screenshot': this.downloadScreenshot(); return true;
      case 'toggleGridVert': this.setGridOptions({ vertLines: !this._gridVert }); return true;
      case 'toggleGridHorz': this.setGridOptions({ horzLines: !this._gridHorz }); return true;
      case 'toggleCrosshairMagnet': this._crosshairMode = this._crosshairMode === 'magnet' ? 'normal' : 'magnet'; return true;
      default: return false;
    }
  }

  /**
   * Composite the full chart (all panes + overlays) and trigger a PNG download.
   * This is what the screenshot keyboard shortcut runs; call it from a toolbar
   * button for a reliable "save image" — the browser's native right-click
   * "Save image as…" captures only the topmost (transparent overlay) canvas.
   */
  public downloadScreenshot(filename = 'chart.png'): void {
    try {
      const canvas = this.takeScreenshot();
      const a = this._doc.createElement('a');
      a.download = filename;
      // The anchor must be in the document before it is clicked. A detached one
      // happens to work in Chrome but is ignored by Firefox, so the button did
      // nothing at all there.
      const attach = (href: string, revoke?: () => void): void => {
        a.href = href;
        this._doc.body?.appendChild(a);
        a.click();
        a.remove();
        if (revoke !== undefined) setTimeout(revoke, 0);
      };
      // Prefer a blob URL over `toDataURL`. A full-resolution chart on a hi-dpi
      // display is easily several MB as base64, and browsers cap how large a
      // `data:` URL they will download — past that the file arrives truncated or
      // not at all. A blob URL has no such limit and skips the base64 entirely.
      if (typeof canvas.toBlob === 'function' && typeof URL?.createObjectURL === 'function') {
        canvas.toBlob((blob) => {
          if (blob === null) return;
          const url = URL.createObjectURL(blob);
          attach(url, () => URL.revokeObjectURL(url));
        }, 'image/png');
        return;
      }
      attach(canvas.toDataURL('image/png'));
    } catch { /* ignore (tainted canvas / no DOM) */ }
  }

  /** Refresh the polite live-region summary screen readers announce. */
  private _updateAccessibleSummary(): void {
    if (this._liveRegion === null) return;
    const n = this._dataLayer.length;
    let txt = `${n} bar${n === 1 ? '' : 's'}`;
    if (this._firstDataId.value !== null && this._panes[0] !== undefined) {
      const last = this._dataLayer.lastIndexedBar(this._firstDataId.value);
      if (last !== null) txt += `, latest price ${this._panes[0].priceScale.format(last.bar.close)}`;
    }
    this._liveRegion.textContent = `Financial chart, ${txt}`;
  }

  /**
   * Track the primitive under the pointer: apply its cursor hint to the
   * container and repaint on hover enter/leave so lines/pills can render
   * hover states (they read `hoverId` off the render context).
   */
  private _setHover(hit: PrimitiveHit | null): void {
    const id = hit?.externalId ?? null;
    this._container.style.cursor = hit?.cursor ?? '';
    if (id === this._hoverId) return;
    this._hoverId = id;
    // hover-styled primitives draw on the base canvas → light repaint, no rescale
    this.invalidate((m) => m.invalidateGlobal(InvalidationLevel.Light));
    this.emit('hover', { id });
  }

  private _updateCursor(paneIndex: number, x: number, localY: number, containerY = localY): void {
    // Plot spans [leftAxisWidth, width - priceAxisWidth]; work in plot-relative x.
    const rightEdge = this._width - this._priceAxisWidth;
    const plotX = x - this._leftAxisWidth;
    const plotWidth = Math.max(0, rightEdge - this._leftAxisWidth);
    if (plotX < 0 || plotX > plotWidth) {
      this._onPointerLeave();
      return;
    }
    const pane = this._panes[paneIndex];
    const hit = pane.hitTestPrimitives(plotX, localY, this._renderContext(paneIndex === this._panes.length - 1)) ?? null;
    // A pane boundary beats a primitive hit: the divider is a thin target and
    // the legend rows sit right below one.
    if (hit === null && this._dividerAt(containerY) !== null) {
      this._setHover(null);
      this._container.style.cursor = 'row-resize';
      return;
    }
    this._setHover(hit);
    // The navigator reveals on pointer position, not on hover id — see the note
    // in time-navigator.ts. Only the bottom pane carries it.
    this._feedTimeNav(paneIndex === this._panes.length - 1 ? { x: plotX, y: localY } : null);
    let y = localY;
    const index = Math.round(this._timeScale.xToIndex(plotX));
    let hoveredBar: Bar | null = null;
    if (this._firstDataId.value !== null) {
      const bars = this._dataLayer.visibleBars(this._firstDataId.value, index, index);
      if (bars.length > 0) {
        hoveredBar = bars[0].bar;
        // Magnet only snaps within the pane that holds the price series — never
        // in the volume/indicator panes (their scale isn't a price scale).
        if (this._crosshairMode === 'magnet' && paneIndex === this._firstPaneIndex) {
          const snapped = magnetSnapPrice(pane.yToPrice(localY), hoveredBar);
          y = pane.priceScale.priceToY(snapped);
        }
      }
    }
    this._cursorPane = paneIndex;
    this._cursor = { x: plotX, y }; // plot-relative; the crosshair line is drawn inside the plot shift
    // Legend rows read the bar under the crosshair, like every charting package.
    for (const indicator of this._indicators) indicator.updateLegendValues(index);
    // global crosshair → repaint every pane's overlay (cheap; base untouched)
    this.invalidate((m) => m.invalidateGlobal(InvalidationLevel.Cursor));
    if (this._crosshairCb !== null || this._listeners.get('crosshair:move') !== undefined) {
      const time = this._dataLayer.indexToTime(index);
      const move = {
        time: time ?? null,
        index,
        price: pane.yToPrice(localY),
        bar: hoveredBar,
        point: { x, y: containerY },
        paneIndex,
        // Whether a pointer is down for this move. Placement mode swallows the
        // pan path, so this is the only way a consumer can tell a hover from a
        // drag while it is still happening — what freehand drawing samples.
        pressed: this._pointers.size > 0,
      };
      this._crosshairCb?.(move);
      this.emit('crosshair:move', move);
    }
  }

  private _maybeLoadHistory(): void {
    if (this._historyLoader === null || this._loadingHistory) return;
    const range = this._timeScale.visibleRange();
    if (range.from < 10) {
      this._loadingHistory = true;
      this.emit('lazy-load', {
        from: this._dataLayer.indexToTime(Math.round(range.from)) ?? null,
        to: this._dataLayer.indexToTime(Math.round(range.to)) ?? null,
        direction: 'backward',
      });
      this._historyLoader();
    }
  }

  private _startKinetic(velocity: number): void {
    const anim = new KineticAnimation(velocity);
    if (anim.durationMs <= 0) return;
    const start = this._now();
    let lastDist = 0;
    const step = (): void => {
      const elapsed = this._now() - start;
      const dist = anim.distanceAt(elapsed);
      const delta = dist - lastDist;
      lastDist = dist;
      this._timeScale.setRightOffset(this._timeScale.rightOffset - delta / this._timeScale.barSpacing);
      this._maybeLoadHistory();
      this.invalidate((m) => m.invalidateGlobal(InvalidationLevel.Full));
      if (!anim.finished(elapsed)) {
        this._kineticHandle = requestAnimationFrame(step);
      } else {
        this._kineticHandle = null;
      }
    };
    this._kineticHandle = requestAnimationFrame(step);
  }

  private _stopKinetic(): void {
    if (this._kineticHandle !== null) {
      cancelAnimationFrame(this._kineticHandle);
      this._kineticHandle = null;
    }
  }

  public destroy(): void {
    this._loop.stop();
    this._stopKinetic();
    for (const indicator of this._indicators) indicator.remove();
    this._indicators.length = 0;
    this._resizeObserver?.disconnect();
    this._resizeObserver = null;
    if (typeof window !== 'undefined') {
      const el = this._container;
      el.removeEventListener('pointerdown', this._onPointerDown);
      el.removeEventListener('pointermove', this._onPointerMove);
      el.removeEventListener('pointerup', this._onPointerUpNative);
      el.removeEventListener('pointercancel', this._onPointerUp);
      el.removeEventListener('pointerleave', this._onPointerLeave);
      el.removeEventListener('wheel', this._onWheel);
      el.removeEventListener('dblclick', this._onDblClick);
      el.removeEventListener('pointerenter', this._onPointerEnter);
      el.removeEventListener('contextmenu', this._onContextMenu);
      this._keyTarget?.removeEventListener('keydown', this._onKeyDown as EventListener);
      this._keyTarget = null;
    }
    this._liveRegion?.remove();
    this._liveRegion = null;
    this._container.style.cursor = ''; // drop any hover cursor hint we applied
    this._pointers.clear();
    for (const pane of this._panes) pane.destroy(); // detaches primitives + removes element
    this._panes.length = 0;
  }
}

/** Create a chart inside the given container element. */
export function createChart(container: HTMLElement, options: ChartOptions = {}): Chart {
  return new Chart(container, options);
}

/**
 * Render a shortcut combo for a tooltip: physical key codes turned into the
 * symbols a user recognises (`Equal` -> `+`, `ArrowDown` -> `↓`).
 */
function prettyCombo(combo: string): string {
  const KEYS: Record<string, string> = {
    Equal: '+', Minus: '-', NumpadAdd: '+', NumpadSubtract: '-',
    ArrowLeft: '<', ArrowRight: '>', ArrowUp: '^', ArrowDown: 'v',
  };
  return combo.split('+').map((p) => p.trim())
    .map((p) => (p === 'Mod' ? 'Ctrl' : KEYS[p] ?? p.replace(/^(Key|Digit)/, '')))
    .join(' + ');
}
