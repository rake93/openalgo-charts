import { darkTheme, lightTheme } from '../src/theme';
import { luminance } from '../src/render/pill';
import { describe, it, expect } from 'vitest';
import { computeVolumeProfile } from '../src/profile/volume-profile';
import { computeTpo } from '../src/profile/tpo';
import {
  computeFootprint, diagonalImbalances, cumulativeDelta, stackedImbalances, type ClassifiedTrade,
} from '../src/profile/footprint';
import { HorizontalProfile } from '../src/profile/profile-primitive';
import { Footprint, compactVol, type FootprintStatRow } from '../src/profile/footprint-primitive';
import { FootprintAggregator } from '../src/profile/footprint-aggregator';
import { priceBuckets } from '../src/profile/profile-model';
import type { Bar } from '../src/model/bar';
import type { PrimitiveRenderContext } from '../src/primitives/primitive';
import { PriceScale } from '../src/scale/price-scale';
import { TimeScale } from '../src/scale/time-scale';
import { DataLayer } from '../src/model/data-layer';
import { makeCtx, type RecordingContext } from './helpers/fake-ctx';

const bar = (time: number, o: number, h: number, l: number, c: number, v: number): Bar => ({ time, open: o, high: h, low: l, close: c, volume: v });

describe('priceBuckets', () => {
  it('spans inclusive low→high on the tick grid', () => {
    expect(priceBuckets(100, 100.2, 0.05)).toEqual([100, 100.05, 100.1, 100.15, 100.2]);
  });
});

describe('Volume Profile', () => {
  it('finds POC at the most-traded price and a 70% value area', () => {
    // bar that concentrates huge volume in a tight band around 100
    const bars = [
      bar(1, 100, 100.1, 99.9, 100, 100),
      bar(2, 100, 100.05, 99.95, 100, 5000), // dominant volume near 100
      bar(3, 101, 102, 100, 101, 100),
    ];
    const vp = computeVolumeProfile(bars, 0.05, 0.7);
    expect(vp.poc).toBeGreaterThanOrEqual(99.95);
    expect(vp.poc).toBeLessThanOrEqual(100.05);
    expect(vp.vah).toBeGreaterThanOrEqual(vp.val);
    // value area holds ~70% of volume
    const vaVol = vp.buckets.filter((b) => b.price <= vp.vah && b.price >= vp.val).reduce((s, b) => s + b.volume, 0);
    expect(vaVol).toBeGreaterThanOrEqual(vp.totalVolume * 0.7 - 1e-6);
  });

  it('handles empty input', () => {
    const vp = computeVolumeProfile([], 0.05);
    expect(vp.buckets).toHaveLength(0);
    expect(vp.totalVolume).toBe(0);
  });
});

describe('TPO / Market Profile', () => {
  it('counts periods at price, derives POC/VA and the initial balance', () => {
    const bars = [
      bar(1, 100, 101, 99, 100, 0), bar(2, 100, 101, 99, 100, 0), // period 0
      bar(3, 100, 100.5, 99.5, 100, 0), bar(4, 100, 100.5, 99.5, 100, 0), // period 1
      bar(5, 103, 104, 102, 103, 0), bar(6, 103, 104, 102, 103, 0), // period 2
    ];
    const tpo = computeTpo(bars, 2, 0.5, 0.7, 2); // 2 bars/period, IB = first 2 periods
    expect(tpo.buckets.length).toBeGreaterThan(0);
    // prices around 100 are touched by 2 periods → higher count than 103 band
    expect(tpo.poc).toBeGreaterThanOrEqual(99.5);
    expect(tpo.poc).toBeLessThanOrEqual(101);
    // IB spans the first two periods' combined range (99 .. 101)
    expect(tpo.ib.high).toBeCloseTo(101);
    expect(tpo.ib.low).toBeCloseTo(99);
  });
});

describe('Footprint & order flow', () => {
  const trades: ClassifiedTrade[] = [
    { price: 100.0, qty: 30, side: 'ask' },
    { price: 100.0, qty: 10, side: 'bid' },
    { price: 100.05, qty: 50, side: 'ask' },
    { price: 99.95, qty: 40, side: 'bid' },
  ];

  it('aggregates bid/ask per price and computes net delta', () => {
    const fp = computeFootprint(1, trades, 0.05);
    const at100 = fp.cells.find((c) => Math.abs(c.price - 100) < 1e-9)!;
    expect(at100.askVol).toBe(30);
    expect(at100.bidVol).toBe(10);
    // delta = Σ(ask − bid) = (30-10) + (50-0) + (0-40) = 20 + 50 - 40 = 30
    expect(fp.delta).toBe(30);
  });

  it('detects diagonal imbalances by ratio', () => {
    // strong ask at 100.05 vs bid at 100.0 → buy imbalance
    const fp = computeFootprint(1, trades, 0.05);
    const imb = diagonalImbalances(fp.cells, 3);
    expect(imb.some((i) => i.side === 'buy')).toBe(true);
  });

  it('cumulative delta accumulates across bars', () => {
    const bars = [
      computeFootprint(1, [{ price: 100, qty: 10, side: 'ask' }], 0.05), // +10
      computeFootprint(2, [{ price: 100, qty: 4, side: 'bid' }], 0.05),  // -4
      computeFootprint(3, [{ price: 100, qty: 6, side: 'ask' }], 0.05),  // +6
    ];
    expect(cumulativeDelta(bars)).toEqual([10, 6, 12]);
  });

  it('finds stacked imbalances of minimum length', () => {
    const cells = [
      { price: 100.15, bidVol: 1, askVol: 90 },
      { price: 100.10, bidVol: 1, askVol: 90 },
      { price: 100.05, bidVol: 1, askVol: 90 },
      { price: 100.00, bidVol: 1, askVol: 1 },
    ];
    const stacks = stackedImbalances(cells, 3, 3);
    expect(stacks.length).toBeGreaterThanOrEqual(1);
    expect(stacks[0].side).toBe('buy');
    expect(stacks[0].count).toBeGreaterThanOrEqual(3);
  });
});

describe('profile primitives render', () => {
  function rc(): PrimitiveRenderContext {
    const dl = new DataLayer();
    const id = dl.createSeries();
    dl.setSeriesData(id, [bar(1, 100, 101, 99, 100, 10), bar(2, 100, 101, 99, 100, 10)]);
    const priceScale = new PriceScale();
    priceScale.setHeight(400);
    priceScale.setPriceRange({ min: 98, max: 103 });
    const timeScale = new TimeScale();
    timeScale.setWidth(600);
    timeScale.setBaseIndex(dl.baseIndex);
    return { timeScale, priceScale, dataLayer: dl, plotWidth: 600, plotHeight: 400, priceAxisWidth: 56, dpr: 1, theme: darkTheme };
  }

  /**
   * A context with room for text: wide columns over a narrow price range, i.e. a
   * footprint as it is actually read. `rc()` spans 5 points at a 0.05 tick, so its
   * rows are ~6px and no number can legibly fit — fine for geometry assertions,
   * useless for anything about the numbers themselves.
   */
  function roomyRc(theme = darkTheme): PrimitiveRenderContext {
    const dl = new DataLayer();
    const id = dl.createSeries();
    dl.setSeriesData(id, [bar(1, 100, 101, 99, 100, 10), bar(2, 100, 101, 99, 100, 10)]);
    const priceScale = new PriceScale();
    priceScale.setHeight(400);
    priceScale.setPriceRange({ min: 99.8, max: 100.2 });
    const timeScale = new TimeScale();
    timeScale.setWidth(600);
    timeScale.setBaseIndex(dl.baseIndex);
    timeScale.setBarSpacing(90);
    return { timeScale, priceScale, dataLayer: dl, plotWidth: 600, plotHeight: 400, priceAxisWidth: 56, dpr: 1, theme };
  }

  it('HorizontalProfile draws bars + POC/VA lines', () => {
    const hp = new HorizontalProfile({
      buckets: [{ price: 100, value: 50 }, { price: 100.5, value: 20 }, { price: 101, value: 5 }],
      poc: 100, vah: 100.5, val: 100, width: 120, side: 'right', barColor: '#345', vaColor: '#456',
    });
    const { ctx, rec } = makeCtx();
    hp.draw(ctx, rc());
    expect(rec.count('fillRect')).toBeGreaterThan(0);
    expect(rec.count('stroke')).toBe(3); // POC + VAH + VAL
  });

  it('Footprint draws cells aligned to chart bars', () => {
    const r = roomyRc();
    const fp = new Footprint();
    fp.setBars([computeFootprint(1, [{ price: 100, qty: 5, side: 'ask' }, { price: 100, qty: 2, side: 'bid' }], 0.05)]);
    const { ctx, rec } = makeCtx();
    fp.draw(ctx, r);
    expect(rec.count('fillText')).toBeGreaterThan(0);
  });

  // `Footprint` positions columns by exact time match, so a self-timed
  // tick-count bar — stamped with the raw time of the tick that opened it — is
  // silently dropped. `bar` mode takes the chart's own bar time instead, which
  // is the only way the two grids stay aligned.
  it('Footprint draws bars aggregated on the chart bar clock', () => {
    const dl = new DataLayer();
    const id = dl.createSeries();
    // Two 1-minute bars, as the chart would have them.
    dl.setSeriesData(id, [bar(60, 100, 101, 99, 100, 10), bar(120, 100, 101, 99, 100, 10)]);
    const priceScale = new PriceScale();
    priceScale.setHeight(400);
    priceScale.setPriceRange({ min: 98, max: 103 });
    const timeScale = new TimeScale();
    timeScale.setWidth(600);
    timeScale.setBaseIndex(dl.baseIndex);
    const r: PrimitiveRenderContext = { timeScale, priceScale, dataLayer: dl, plotWidth: 600, plotHeight: 400, priceAxisWidth: 56, dpr: 1, theme: darkTheme };

    // The host stamps every tick with the chart bar it landed in, so ticks
    // arriving at 137s and 138s both belong to the 120s bar.
    const agg = new FootprintAggregator({ mode: 'bar' }, 0.05, 1);
    agg.onTick({ time: 120, price: 100, qty: 5, side: 'ask' });
    const u = agg.onTick({ time: 120, price: 100, qty: 2, side: 'bid' });
    expect(u.isNew).toBe(false); // same chart bar → same column
    expect(u.bar.time).toBe(120);

    const fp = new Footprint();
    fp.setBars([u.bar]);
    const { ctx, rec } = makeCtx();
    fp.draw(ctx, r);
    // A column resolved to a chart bar and was drawn. Asserting the cells rather
    // than their numbers keeps this test about placement — whether the numbers fit
    // is a separate question, settled by the column width and row height.
    expect(rec.count('roundRect')).toBeGreaterThan(0);
  });

  it('FootprintAggregator opens a new column when the chart bar advances', () => {
    const agg = new FootprintAggregator({ mode: 'bar' }, 0.05, 1);
    expect(agg.onTick({ time: 60, price: 100, qty: 5, side: 'ask' }).isNew).toBe(true);
    expect(agg.onTick({ time: 60, price: 100, qty: 1, side: 'bid' }).isNew).toBe(false);
    const next = agg.onTick({ time: 120, price: 101, qty: 3, side: 'ask' });
    expect(next.isNew).toBe(true);
    expect(next.bar.time).toBe(120);
    expect(next.bar.delta).toBe(3); // fresh column, not carried over
  });

  // Cell and stats fills are a background→accent ramp, so on a light theme they
  // come out as pale tints of white. The numerals used to be hardcoded white,
  // which made them invisible there. What matters is not that the text is dark
  // or light but that it contrasts with the fill actually painted under it, so
  // that is what this asserts — in both themes, over cells and stats alike.
  for (const [name, theme] of [['light', lightTheme], ['dark', darkTheme]] as const) {
    it(`Footprint numbers contrast with their own fill on the ${name} theme`, () => {
      const fp = new Footprint({ tickSize: 0.05, statsRows: ['volume', 'delta', 'cvd'] })
      fp.setBars([
        computeFootprint(1, [
          { price: 100, qty: 5, side: 'ask' },
          { price: 100, qty: 2, side: 'bid' },
          // A big print one row up becomes the peak, so the cells at 100 stay
          // near the pale end of the ramp — the case that used to break.
          { price: 100.05, qty: 900, side: 'ask' },
          { price: 100.05, qty: 1, side: 'bid' },
        ], 0.05),
      ])
      const { ctx, rec } = makeCtx()
      fp.draw(ctx, roomyRc(theme))

      // Ops run beginPath → roundRect → fill(background) → fillText(text), so
      // the last fill before each fillText is what the text sits on.
      let under: string | null = null
      let checked = 0
      for (const op of rec.ops) {
        if (op.type === 'fill' || op.type === 'fillRect') under = op.fillStyle ?? under
        if (op.type !== 'fillText') continue
        expect(under).not.toBeNull()
        const a = luminance(op.fillStyle ?? '#fff')
        const b = luminance(under as string)
        // WCAG contrast ratio; 3:1 is the floor for large/bold text. The bound is
        // 2.9 rather than 3.0 because a saturated *imbalanced* cell is filled with
        // the theme's own accent — white on the dark theme's buy green is 3.00:1 to
        // three figures, so the accent itself sets the floor and there is nothing
        // for this primitive to fix. Everything else clears it comfortably.
        const ratio = (Math.max(a, b) + 0.05) / (Math.min(a, b) + 0.05)
        expect(ratio).toBeGreaterThanOrEqual(2.9)
        checked += 1
      }
      expect(checked).toBeGreaterThan(0)
    })
  }

  // Zooming in enlarges the cells, so the numbers in them should grow too.
  // A fixed font meant the only way to read a footprint was to zoom until the
  // 10px text was a large enough share of the screen, which is a lot of zoom.
  it('Footprint scales its numbers to the space a cell actually has', () => {
    const bars = [
      computeFootprint(1, [
        { price: 100, qty: 500, side: 'ask' },
        { price: 100, qty: 200, side: 'bid' },
      ], 0.05),
    ]
    const sizeAt = (barSpacing: number, priceSpan: number) => {
      const dl = new DataLayer()
      const id = dl.createSeries()
      dl.setSeriesData(id, [bar(1, 100, 101, 99, 100, 10), bar(2, 100, 101, 99, 100, 10)])
      const priceScale = new PriceScale()
      priceScale.setHeight(400)
      priceScale.setPriceRange({ min: 100 - priceSpan / 2, max: 100 + priceSpan / 2 })
      const timeScale = new TimeScale()
      timeScale.setWidth(600)
      timeScale.setBaseIndex(dl.baseIndex)
      timeScale.setBarSpacing(barSpacing)
      const fp = new Footprint({ tickSize: 0.05, statsRows: [] })
      fp.setBars(bars)
      const { ctx, rec } = makeCtx()
      fp.draw(ctx, {
        timeScale, priceScale, dataLayer: dl, plotWidth: 600, plotHeight: 400,
        priceAxisWidth: 56, dpr: 1, theme: darkTheme,
      })
      const t = rec.ops.find((o) => o.type === 'fillText')
      return t?.font === undefined ? 0 : Number.parseFloat(t.font)
    }

    // Tight: modest column over a modest price range — small cells, but still
    // big enough that the numbers are drawn at all.
    const tight = sizeAt(60, 1.0)
    // Roomy: a wide column over a narrow price range — big cells.
    const roomy = sizeAt(120, 0.4)

    expect(tight).toBeGreaterThan(0)
    expect(roomy).toBeGreaterThan(tight)
  })

  /** Draw two adjacent footprint columns at a given bar spacing. */
  function twoColumns(barSpacing: number, statsRows: FootprintStatRow[] = []) {
    const dl = new DataLayer()
    const id = dl.createSeries()
    dl.setSeriesData(id, [bar(1, 100, 101, 99, 100, 10), bar(2, 100, 101, 99, 100, 10)])
    const priceScale = new PriceScale()
    priceScale.setHeight(400)
    priceScale.setPriceRange({ min: 99.5, max: 100.5 })
    const timeScale = new TimeScale()
    timeScale.setWidth(600)
    timeScale.setBaseIndex(dl.baseIndex)
    timeScale.setBarSpacing(barSpacing)
    // Gutter labels off: these cases count the per-column numbers, and a row name
    // is drawn whether or not the columns are wide enough for their values.
    const fp = new Footprint({ tickSize: 0.05, statsRows, statsLabels: false })
    fp.setBars([
      computeFootprint(1, [{ price: 100, qty: 1000, side: 'ask' }], 0.05),
      computeFootprint(2, [{ price: 100, qty: 2000, side: 'bid' }], 0.05),
    ])
    const { ctx, rec } = makeCtx()
    fp.draw(ctx, {
      timeScale, priceScale, dataLayer: dl, plotWidth: 600, plotHeight: 400,
      priceAxisWidth: 56, dpr: 1, theme: darkTheme,
    })
    return { rec, x1: timeScale.indexToX(0), x2: timeScale.indexToX(1) }
  }

  // A column wider than the bar slot lands on top of its neighbours: cells
  // collide and, worse, two stats values print over each other. The 24px floor
  // guaranteed that below ~27px of bar spacing, which is ordinary zoom.
  it('Footprint keeps a column inside its own bar slot', () => {
    for (const barSpacing of [8, 12, 17, 24, 40]) {
      const { rec, x1, x2 } = twoColumns(barSpacing)
      const boxes = rec.ops.filter((o) => o.type === 'roundRect')
      expect(boxes.length).toBeGreaterThan(0)
      const mid = (x1 + x2) / 2
      for (const b of boxes) {
        const [x, , w] = b.args
        // Every box belongs to one column or the other, never straddling.
        const belongsLeft = x + w <= mid + 0.5
        const belongsRight = x >= mid - 0.5
        expect(
          belongsLeft || belongsRight,
          `barSpacing ${barSpacing}: box ${x}..${x + w} straddles ${mid}`,
        ).toBe(true)
      }
    }
  })

  it('Footprint drops the numbers when a cell is too narrow to hold them', () => {
    // Tall rows, but a column far too narrow for even one digit: it should read
    // as a heatmap rather than print text over the neighbouring column.
    const narrow = twoColumns(8, ['volume', 'delta'])
    expect(narrow.rec.count('roundRect')).toBeGreaterThan(0)
    expect(narrow.rec.count('fillText')).toBe(0)

    // Given room, the numbers come back.
    const wide = twoColumns(90, ['volume', 'delta'])
    expect(wide.rec.count('fillText')).toBeGreaterThan(0)
  })

  // "Candle behind the cells" drew a 3px sliver five pixels to the *left* of the
  // column and never a body at all, so it read as a stray line beside the
  // footprint rather than a candle behind it — and at narrow bar spacing it landed
  // in the neighbouring bar's slot.
  it('Footprint draws the candle behind the cells, not beside them', () => {
    const r = roomyRc();
    const fp = new Footprint({ tickSize: 0.05, statsRows: [], showCandle: true });
    const fpBar = computeFootprint(1, [
      { price: 100.1, qty: 5, side: 'ask' },
      { price: 99.9, qty: 5, side: 'bid' },
    ], 0.05);
    fp.setBars([{ ...fpBar, open: 99.95, close: 100.05 }]);
    const { ctx, rec } = makeCtx();
    fp.draw(ctx, r);

    const colX = r.timeScale.indexToX(0);
    const half = (r.timeScale.barSpacing * 0.9) / 2;
    const rects = rec.ops.filter((o) => o.type === 'fillRect');
    expect(rects.length).toBeGreaterThan(0);
    // Every part of the candle sits inside the column, centred on the bar. The
    // tolerance covers the column centre being rounded to a whole device pixel.
    for (const q of rects) {
      const [x, , w] = q.args;
      expect(x).toBeGreaterThanOrEqual(colX - half - 1.5);
      expect(x + w).toBeLessThanOrEqual(colX + half + 1.5);
    }
    // A body is drawn, spanning open→close rather than only the range.
    const yOpen = r.priceScale.priceToY(99.95);
    const yClose = r.priceScale.priceToY(100.05);
    const bodyH = Math.abs(yOpen - yClose);
    expect(rects.some((q) => Math.abs(q.args[3] - bodyH) < 1.5)).toBe(true);
  });

  it('Footprint labels each stats row so the numbers can be told apart', () => {
    const r = roomyRc();
    const fp = new Footprint({ tickSize: 0.05, statsRows: ['volume', 'delta', 'cvd'] });
    fp.setBars([computeFootprint(1, [{ price: 100, qty: 7, side: 'ask' }], 0.05)]);
    const { ctx, rec } = makeCtx();
    fp.draw(ctx, r);

    // One left-aligned label per configured row, drawn in the stats gutter.
    const labels = rec.ops.filter((o) => o.type === 'fillText' && o.args[0] < 20);
    expect(labels.length).toBe(3);
  });

  it('Footprint fills diagonal imbalances saturated rather than outlining them', () => {
    const r = rc();
    // ask 30 at 100.05 dominates bid 2 one tick below -> a buy imbalance.
    const bars = [computeFootprint(1, [
      { price: 100.05, qty: 30, side: 'ask' },
      { price: 100.0, qty: 2, side: 'bid' },
    ], 0.05)];
    const plain = new Footprint({ tickSize: 0.05, imbalanceRatio: 1e9, statsRows: [] });
    plain.setBars(bars);
    const a = makeCtx();
    plain.draw(a.ctx, r);

    const hot = new Footprint({ tickSize: 0.05, imbalanceRatio: 3, statsRows: [] });
    hot.setBars(bars);
    const b = makeCtx();
    hot.draw(b.ctx, r);

    // Same geometry either way — an outline would have added strokeRect calls.
    expect(b.rec.count('strokeRect')).toBe(0);
    expect(b.rec.count('roundRect')).toBe(a.rec.count('roundRect'));
    // ...but the imbalanced cell is painted a different (saturated) colour.
    const fills = (r2: RecordingContext): (string | undefined)[] =>
      r2.ops.filter((o) => o.type === 'fill').map((o) => o.fillStyle);
    expect(fills(b.rec)).not.toEqual(fills(a.rec));
  });

  it('Footprint grades cell colour by share of the bar peak', () => {
    const r = rc();
    const fp = new Footprint({ tickSize: 0.05, imbalanceRatio: 1e9, statsRows: [] });
    fp.setBars([computeFootprint(1, [
      { price: 100.0, qty: 1, side: 'ask' },
      { price: 100.05, qty: 100, side: 'ask' },
    ], 0.05)]);
    const { ctx, rec } = makeCtx();
    fp.draw(ctx, r);
    const fills = rec.ops.filter((o) => o.type === 'fill').map((o) => o.fillStyle);
    // A quiet row and a peak row must not share a colour.
    expect(new Set(fills).size).toBeGreaterThan(1);
  });

  it('Footprint computes per-bar stats with a running CVD', () => {
    const fp = new Footprint();
    fp.setBars([
      computeFootprint(1, [{ price: 100, qty: 10, side: 'ask' }], 0.05),  // +10
      computeFootprint(2, [{ price: 100, qty: 4, side: 'bid' }], 0.05),   // -4
      computeFootprint(3, [{ price: 100, qty: 6, side: 'ask' }], 0.05),   // +6
    ]);
    const s = fp.stats();
    expect(s.map((x) => x.delta)).toEqual([10, -4, 6]);
    expect(s.map((x) => x.cvd)).toEqual([10, 6, 12]);   // running, not per-bar
    expect(s[0].volume).toBe(10);
    expect(s[0].deltaPct).toBeCloseTo(100, 6);
    expect(s[1].deltaPct).toBeCloseTo(-100, 6);
  });

  it('Footprint draws one stats row per configured metric', () => {
    // Needs the roomy context: stats values are now dropped rather than drawn
    // over the neighbouring column when they cannot fit.
    const r = roomyRc();
    const bars = [computeFootprint(1, [{ price: 100, qty: 5, side: 'ask' }], 0.05)];
    const none = new Footprint({ tickSize: 0.05, statsRows: [] });
    none.setBars(bars);
    const a = makeCtx();
    none.draw(a.ctx, r);

    // Labels off so this counts values only — the gutter names are covered by
    // their own test.
    const four = new Footprint({ tickSize: 0.05, statsLabels: false, statsRows: ['volume', 'delta', 'deltaPct', 'cvd'] });
    four.setBars(bars);
    const b = makeCtx();
    four.draw(b.ctx, r);
    expect(b.rec.count('fillText')).toBe(a.rec.count('fillText') + 4);
  });

  it('Footprint is restylable at runtime instead of needing a rebuild', () => {
    const r = rc();
    const fp = new Footprint({ tickSize: 0.05, statsRows: [] });
    fp.setBars([computeFootprint(1, [{ price: 100, qty: 5, side: 'ask' }], 0.05)]);
    const a = makeCtx();
    fp.draw(a.ctx, r);
    fp.setOptions({ buyColor: '#00ff00' });
    const b = makeCtx();
    fp.draw(b.ctx, r);
    expect(fp.options().buyColor).toBe('#00ff00');
    const fills = (r2: RecordingContext): string =>
      r2.ops.filter((o) => o.type === 'fill').map((o) => o.fillStyle).join('|');
    expect(fills(b.rec)).not.toBe(fills(a.rec));
  });

  it('Footprint drops cell numbers when rows are too short to read', () => {
    const bars = [computeFootprint(1, [
      { price: 100, qty: 5, side: 'ask' }, { price: 100.05, qty: 5, side: 'bid' },
    ], 0.05)];
    const roomy = new Footprint({ tickSize: 0.05, statsRows: [], minTextHeight: 1 });
    roomy.setBars(bars);
    const a = makeCtx();
    // Roomy context so the row height is the only thing under test — a cramped
    // column would suppress the numbers on width alone.
    roomy.draw(a.ctx, roomyRc());

    const cramped = new Footprint({ tickSize: 0.05, statsRows: [], minTextHeight: 10000 });
    cramped.setBars(bars);
    const b = makeCtx();
    cramped.draw(b.ctx, roomyRc());
    expect(a.rec.count('fillText')).toBeGreaterThan(0);
    expect(b.rec.count('fillText')).toBe(0);   // heatmap only
    expect(b.rec.count('roundRect')).toBeGreaterThan(0);
  });

  it('Footprint drives autoscale so the top and bottom rows are not clipped', () => {
    const fp = new Footprint();
    fp.setBars([computeFootprint(1, [
      { price: 100, qty: 1, side: 'ask' }, { price: 101, qty: 1, side: 'bid' },
    ], 0.5)]);
    expect(fp.autoscaleInfo()).toEqual({ min: 100, max: 101 });
  });

  it('Footprint reports the stats of the column under the pointer', () => {
    const r = rc();
    const fp = new Footprint({ tickSize: 0.05 });
    fp.setBars([computeFootprint(1, [{ price: 100, qty: 7, side: 'ask' }], 0.05)]);
    const { ctx } = makeCtx();
    fp.draw(ctx, r);                       // the readout needs the drawn geometry
    const x = r.timeScale.indexToX(0);
    // `hitTest` is deliberately gone: it claimed the full height of every column
    // at distance 0, which shut out any drawing laid over the footprint. The
    // readout was always `hoverAt` on the crosshair, and that is unaffected.
    const hover = fp.hoverAt(x, r.priceScale.priceToY(100), r);
    expect(hover?.stats.volume).toBe(7);
    expect(hover?.cell?.askVol).toBe(7);
    expect(fp.hoverAt(-500, 50, r)).toBeNull();
  });

  it('Footprint hoverAt reuses the last draw context when none is passed', () => {
    // Hosts should not have to fabricate a PrimitiveRenderContext to show a tooltip.
    const r = rc();
    const fp = new Footprint({ tickSize: 0.05 });
    fp.setBars([computeFootprint(1, [{ price: 100, qty: 7, side: 'ask' }], 0.05)]);
    const x = r.timeScale.indexToX(0);
    expect(fp.hoverAt(x, r.priceScale.priceToY(100))).toBeNull();  // nothing drawn yet
    const { ctx } = makeCtx();
    fp.draw(ctx, r);
    const hover = fp.hoverAt(x, r.priceScale.priceToY(100));
    expect(hover?.stats.volume).toBe(7);
    expect(hover?.cell?.askVol).toBe(7);
  });

  it('rowTicks widens footprint bricks without changing the tick size', () => {
    // Nifty-style: 0.1 tick, 2-point bricks -> rowTicks 20.
    const trades: ClassifiedTrade[] = [];
    for (let i = 0; i < 60; i++) {
      trades.push({ price: 24000 + i * 0.1, qty: 1, side: i % 2 === 0 ? 'ask' : 'bid' });
    }
    const fine = computeFootprint(1, trades, 0.1);
    const coarse = computeFootprint(1, trades, 0.1, 20);
    expect(fine.cells.length).toBeGreaterThan(50);
    expect(coarse.cells.length).toBeLessThan(6);
    // Rows really are 2 points apart, and no volume was lost in the regrouping.
    expect(Math.abs((coarse.cells[0].price - coarse.cells[1].price) - 2)).toBeLessThan(1e-6);
    const sum = (b: typeof fine) => b.cells.reduce((n, c) => n + c.bidVol + c.askVol, 0);
    expect(sum(coarse)).toBe(sum(fine));
  });

  it('FootprintAggregator buckets ticks onto the rowTicks grid', () => {
    const agg = new FootprintAggregator({ mode: 'interval', seconds: 60 }, 0.1, 20);
    let bar = agg.onTick({ time: 0, price: 24000.1, qty: 5, side: 'ask' }).bar;
    bar = agg.onTick({ time: 1, price: 24000.7, qty: 7, side: 'ask' }).bar;
    // Both prints round onto the same 2-point brick.
    expect(bar.cells).toHaveLength(1);
    expect(bar.cells[0].price).toBe(24000);
    expect(bar.cells[0].askVol).toBe(12);
    // A print a full brick away opens a new row.
    bar = agg.onTick({ time: 2, price: 24002.4, qty: 3, side: 'bid' }).bar;
    expect(bar.cells).toHaveLength(2);
  });

  it('compactVol formats to three significant figures', () => {
    expect(compactVol(4_530_000)).toBe('4.53M');
    expect(compactVol(13_000_000)).toBe('13M');
    expect(compactVol(30_200_000)).toBe('30.2M');
    expect(compactVol(47_100)).toBe('47.1K');
    expect(compactVol(128_000)).toBe('128K');
    expect(compactVol(3_000)).toBe('3K');
    expect(compactVol(-943_000)).toBe('-943K');
    expect(compactVol(512)).toBe('512');
  });
});
