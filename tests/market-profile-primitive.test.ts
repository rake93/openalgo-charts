import { describe, it, expect } from 'vitest';
import { MarketProfile } from '../src/profile/market-profile-primitive';
import { computeMarketProfile } from '../src/profile/market-profile';
import { istStringToUtcSeconds } from '../src/feed/time';
import type { Bar } from '../src/model/bar';
import type { PrimitiveRenderContext } from '../src/primitives/primitive';

const bar = (time: number, low: number, high: number, volume = 100): Bar => ({
  time, open: low, high, low, close: high, volume,
});

function makeResult() {
  const t0 = istStringToUtcSeconds('2024-01-15 09:15:00');
  const bars = [bar(t0, 100, 110), bar(t0 + 1800, 105, 110)];
  return { result: computeMarketProfile(bars, { tickSize: 1, session: 'day', blockMinutes: 30 }), t0, bars };
}

function recorder() {
  const calls = { fillText: 0, fillRect: 0, stroke: 0, drawImage: 0 };
  const ctx = {
    canvas: {},
    globalAlpha: 1, fillStyle: '', strokeStyle: '', lineWidth: 1, font: '', textAlign: '', textBaseline: '',
    save() {}, restore() {},
    beginPath() {}, moveTo() {}, lineTo() {},
    stroke() { calls.stroke++; },
    fillRect() { calls.fillRect++; },
    fillText() { calls.fillText++; },
  } as unknown as CanvasRenderingContext2D;
  return { ctx, calls };
}

function makeRc(startTime: number, endTime: number): PrimitiveRenderContext {
  return {
    dpr: 2,
    plotWidth: 600, plotHeight: 300, priceAxisWidth: 60,
    timeScale: { indexToX: (i: number) => 100 + i * 40 },
    priceScale: { priceToY: (p: number) => 400 - p, format: (p: number) => p.toFixed(2) },
    dataLayer: { timeToIndex: (t: number) => (t === startTime ? 0 : t === endTime ? 5 : 5) },
    theme: {},
  } as unknown as PrimitiveRenderContext;
}

describe('MarketProfile primitive', () => {
  it('renders letters and POC/VA lines without throwing', () => {
    const { result, t0 } = makeResult();
    const mp = new MarketProfile(result);
    const { ctx, calls } = recorder();
    mp.draw(ctx, makeRc(t0, t0 + 1800));
    expect(calls.fillText).toBeGreaterThan(0); // TPO letters + labels
    expect(calls.stroke).toBeGreaterThan(0);   // POC / VA / IB lines
  });

  it('draws solid blocks when letters are disabled', () => {
    const { result, t0 } = makeResult();
    const mp = new MarketProfile(result, { blockDisplay: 'blocks', showValueAreaLabels: false, showPocLabel: false });
    const { ctx, calls } = recorder();
    mp.draw(ctx, makeRc(t0, t0 + 1800));
    expect(calls.fillRect).toBeGreaterThan(0);
  });

  it('reports its price extent via autoscaleInfo', () => {
    const { result } = makeResult();
    const mp = new MarketProfile(result);
    expect(mp.autoscaleInfo()).toEqual({ min: 100, max: 110 });
  });

  it('is a no-op with no data', () => {
    const mp = new MarketProfile(null);
    const { ctx, calls } = recorder();
    mp.draw(ctx, makeRc(0, 1));
    expect(calls.fillText + calls.fillRect + calls.stroke).toBe(0);
    expect(mp.autoscaleInfo()).toBeNull();
  });
});

/** Render context whose price scale can be zoomed, so row height is testable. */
function makeScaledRc(startTime: number, endTime: number, pxPerPrice: number): PrimitiveRenderContext {
  return {
    dpr: 2,
    plotWidth: 600, plotHeight: 300, priceAxisWidth: 60,
    timeScale: { indexToX: (i: number) => 100 + i * 40 },
    priceScale: { priceToY: (p: number) => 400 - p * pxPerPrice, format: (p: number) => p.toFixed(2) },
    dataLayer: { timeToIndex: (t: number) => (t === startTime ? 0 : t === endTime ? 5 : 5) },
    theme: {},
  } as unknown as PrimitiveRenderContext;
}

/** Records the alpha each glyph was painted at, so a fade is observable. */
function alphaRecorder() {
  const letterAlphas: number[] = [];
  const rectAlphas: number[] = [];
  const ctx: Record<string, unknown> = {
    canvas: {},
    globalAlpha: 1, fillStyle: '', strokeStyle: '', lineWidth: 1, font: '', textAlign: '', textBaseline: '',
    save() {}, restore() {},
    beginPath() {}, moveTo() {}, lineTo() {}, stroke() {}, setLineDash() {},
    fillRect() { rectAlphas.push(ctx.globalAlpha as number); },
    fillText() { letterAlphas.push(ctx.globalAlpha as number); },
  };
  return { ctx: ctx as unknown as CanvasRenderingContext2D, letterAlphas, rectAlphas };
}
describe('TPO letter / brick auto transition', () => {
  // Letters and labels both call fillText, so compare against a labels-off run.
  const quiet = { showValueAreaLabels: false, showPocLabel: false, showSessionLabel: false } as const;

  it('draws letters when rows are tall enough', () => {
    const { result, t0 } = makeResult();
    const mp = new MarketProfile(result, quiet);
    const { ctx, letterAlphas } = alphaRecorder();
    mp.draw(ctx, makeScaledRc(t0, t0 + 1800, 20)); // 20px per price unit -> tall rows
    expect(letterAlphas.length).toBeGreaterThan(0);
    expect(Math.max(...letterAlphas)).toBeGreaterThan(0.9);
  });

  it('drops to bricks when rows get too short for a glyph', () => {
    const { result, t0 } = makeResult();
    const mp = new MarketProfile(result, quiet);
    const { ctx, letterAlphas, rectAlphas } = alphaRecorder();
    mp.draw(ctx, makeScaledRc(t0, t0 + 1800, 1)); // 1px per price unit -> tiny rows
    expect(letterAlphas).toHaveLength(0);   // no glyphs at all
    expect(rectAlphas.length).toBeGreaterThan(0); // but the blocks still render
  });

  it('crossfades through the threshold instead of snapping', () => {
    const { result, t0 } = makeResult();
    const mp = new MarketProfile(result, { ...quiet, minLetterHeight: 7, letterFade: 4 });
    const { ctx, letterAlphas } = alphaRecorder();
    // Row height ~9px sits inside the 7..11px fade band.
    mp.draw(ctx, makeScaledRc(t0, t0 + 1800, 9));
    expect(letterAlphas.length).toBeGreaterThan(0);
    const a = Math.max(...letterAlphas);
    expect(a).toBeGreaterThan(0);
    expect(a).toBeLessThan(1);   // partially faded, not fully on
  });

  it('explicit blockDisplay overrides the auto behaviour', () => {
    const { result, t0 } = makeResult();
    // 'letters' forces glyphs even at a row height auto would call too short.
    const forced = new MarketProfile(result, { ...quiet, blockDisplay: 'letters' });
    const r1 = alphaRecorder();
    forced.draw(r1.ctx, makeScaledRc(t0, t0 + 1800, 1));
    expect(r1.letterAlphas.length).toBeGreaterThan(0);

    // 'blocks' suppresses them even when there is plenty of room.
    const blocks = new MarketProfile(result, { ...quiet, blockDisplay: 'blocks' });
    const r2 = alphaRecorder();
    blocks.draw(r2.ctx, makeScaledRc(t0, t0 + 1800, 20));
    expect(r2.letterAlphas).toHaveLength(0);
    expect(r2.rectAlphas.length).toBeGreaterThan(0);
  });
});

describe('MarketProfile hover readout', () => {
  it('maps a pointer back to the session row under it', () => {
    const { result, t0 } = makeResult();
    const mp = new MarketProfile(result);
    const { ctx } = alphaRecorder();
    const rc = makeScaledRc(t0, t0 + 1800, 20);
    mp.draw(ctx, rc);                       // the readout needs drawn geometry
    const x = 150;                          // inside the session box (102..298)
    // `hitTest` is deliberately gone: it claimed the entire session box at
    // distance 0 and so shut out every drawing and order line over it. The
    // readout was always `hoverAt`, driven by the crosshair — that is what
    // this covers, and it is unaffected.
    const hover = mp.hoverAt(x, rc.priceScale.priceToY(110));
    expect(hover?.price).toBe(110);
    expect(hover?.level.letters).toBe('AB');
    expect(mp.hoverAt(-500, 50)).toBeNull();
  });
});
