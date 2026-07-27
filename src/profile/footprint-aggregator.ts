/**
 * Streaming footprint aggregator (ARCHITECTURE.md §6A, §9.4). Ingests classified
 * trade ticks (price, qty, bid/ask) and aggregates them into footprint bars on a
 * timeframe (interval / tick-count / volume, or the host's own bar clock) — the
 * live orderflow pipeline. Incremental: the current bar updates per tick; a new
 * bar opens at the boundary.
 *
 * Requires classified bid/ask trade ticks. OpenAlgo doesn't store these by
 * default, so feed it from a live WS classifier or a tick-recorder backend.
 */
import type { FootprintBar, FootprintCell } from './profile-model';
import { bucketPrice } from './profile-model';
import type { ClassifiedTrade } from './footprint';
import type { TickTimeframe } from '../feed/tick-aggregator';

/**
 * How the aggregator closes one bar and opens the next.
 *
 * Beyond the three {@link TickTimeframe} bucketings there is `bar`, where the
 * *caller* supplies the bar time on every tick and a new column opens whenever
 * that time changes. That is the mode a chart wants. `Footprint` positions each
 * column by an exact time match against the data layer, so a column carrying a
 * time the chart does not also have is silently dropped — and self-timed
 * tick-count and volume bars are stamped with the raw time of the tick that
 * opened them, which essentially never coincides with a chart bar. Feeding the
 * chart's own bar time keeps the two grids in lockstep by construction, and the
 * footprint then inherits whatever the chart is bucketing by, tick and volume
 * bars included.
 */
export type FootprintAggregatorTimeframe = TickTimeframe | { mode: 'bar' };

export interface FootprintTick extends ClassifiedTrade {
  /** Tick time, or — in `bar` mode — the time of the chart bar it belongs to. */
  time: number;
}

export interface FootprintUpdate {
  bar: FootprintBar;
  isNew: boolean;
}

export class FootprintAggregator {
  private readonly _tf: FootprintAggregatorTimeframe;
  private readonly _tickSize: number;
  private _time = 0;
  private _cells = new Map<number, FootprintCell>();
  private _delta = 0;
  private _count = 0;
  private _volume = 0;
  private _open = false;

  /**
   * `rowTicks` widens each brick to `tickSize * rowTicks` — the same multiplier
   * the market profile uses, so an instrument's real tick stays honest while the
   * ladder stays readable. Nifty at 0.1 with 2-point bricks is `(tf, 0.1, 20)`.
   */
  public constructor(tf: FootprintAggregatorTimeframe, tickSize: number, rowTicks = 1) {
    this._tf = tf;
    this._tickSize = tickSize * Math.max(1, Math.floor(rowTicks));
  }

  private _snapshot(): FootprintBar {
    const cells = Array.from(this._cells.values()).sort((a, b) => b.price - a.price);
    return { time: this._time, cells, delta: this._delta };
  }

  public current(): FootprintBar | null {
    return this._open ? this._snapshot() : null;
  }

  private _intervalKey(time: number): number {
    if (this._tf.mode !== 'interval') return 0;
    const a = this._tf.anchorSec ?? 0;
    return a + Math.floor((time - a) / this._tf.seconds) * this._tf.seconds;
  }

  public onTick(tick: FootprintTick): FootprintUpdate {
    let startNew = !this._open;
    if (this._open) {
      if (this._tf.mode === 'bar') startNew = tick.time !== this._time;
      else if (this._tf.mode === 'interval') startNew = this._intervalKey(tick.time) !== this._time;
      else if (this._tf.mode === 'ticks') startNew = this._count >= this._tf.count;
      else startNew = this._volume >= this._tf.perBar;
    }

    if (startNew) {
      this._cells = new Map();
      this._delta = 0;
      this._count = 0;
      this._volume = 0;
      this._open = true;
      this._time = this._tf.mode === 'interval' ? this._intervalKey(tick.time) : tick.time;
    }

    const price = bucketPrice(tick.price, this._tickSize);
    let cell = this._cells.get(price);
    if (cell === undefined) { cell = { price, bidVol: 0, askVol: 0 }; this._cells.set(price, cell); }
    if (tick.side === 'bid') { cell.bidVol += tick.qty; this._delta -= tick.qty; }
    else { cell.askVol += tick.qty; this._delta += tick.qty; }
    this._count += 1;
    this._volume += tick.qty;

    return { bar: this._snapshot(), isNew: startNew };
  }
}
