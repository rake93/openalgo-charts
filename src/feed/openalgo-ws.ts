/**
 * OpenAlgo WebSocket adapter (ARCHITECTURE.md §10, C2). Speaks the documented
 * OpenAlgo WS proxy protocol (default port 8765, or wss://host/ws in production):
 *
 *   1. authenticate: { action:'authenticate', api_key }
 *   2. subscribe   : { action:'subscribe', symbol, exchange, mode }   mode 1=LTP 2=Quote 3=Depth
 *                    (Depth adds depth_level, e.g. 5/20/30/50)
 *   3. server pushes { type:'market_data', mode, topic:'SYM.EXCH', data:{...} }
 *   4. heartbeat   : server 'ping' → client 'pong' (30s)
 *
 * Maps inbound LTP / Quote / Depth into typed callbacks the chart consumes
 * (candle builder, last price, DOM ladder). The socket is injectable so the
 * adapter is unit-testable with a fake socket and no network.
 */
import type { MarketDepth } from './types';
import { epochMsToUtcSeconds } from './time';

export type WsMode = 'LTP' | 'Quote' | 'Depth';

/** Socket lifecycle reported by `onState`. */
export type WsState = 'connecting' | 'open' | 'closed' | 'error' | 'reconnecting';

/** A non-market-data control frame (auth / subscribe ack, or a server error). */
export interface WsControlMessage {
  type?: string;
  status?: string;
  message?: string;
  [k: string]: unknown;
}

/** OpenAlgo numeric data modes (websockets-format.md §Data Modes). */
const MODE_NUMBER: Record<WsMode, number> = { LTP: 1, Quote: 2, Depth: 3 };

/** Minimal socket surface (the browser WebSocket satisfies this). */
export interface SocketLike {
  send(data: string): void;
  close(): void;
  onopen: (() => void) | null;
  onclose: (() => void) | null;
  onerror?: (() => void) | null;
  onmessage: ((ev: { data: string }) => void) | null;
  /** 1 === OPEN (browser WebSocket.OPEN). Used to gate sends. */
  readyState?: number;
}

export type SocketFactory = (url: string) => SocketLike;

export interface OpenAlgoWsConfig {
  url: string; // e.g. ws://127.0.0.1:8765 (or wss://host/ws)
  apiKey: string;
  socketFactory?: SocketFactory;
  /**
   * Auto-reconnect after an unexpected close: re-authenticate and resubscribe
   * every active subscription, with exponential backoff. Enabled by default;
   * `close()` is treated as intentional and never reconnects.
   */
  reconnect?: { enabled?: boolean; baseDelayMs?: number; maxDelayMs?: number; maxAttempts?: number };
}

export interface LtpEvent {
  symbol: string;
  exchange: string;
  ltp: number;
  ltq?: number;
  /** Cumulative day volume (Quote mode) — feeds the candle builder's day-delta mode. */
  volume?: number;
  timeSec: number;
}

/** Pure: the auth handshake message that must precede any subscription. */
export function formatAuthenticate(apiKey: string): string {
  return JSON.stringify({ action: 'authenticate', api_key: apiKey });
}

/** Pure: subscribe to the account-level order-update stream (no symbols/modes). */
export function formatSubscribeOrders(): string {
  return JSON.stringify({ action: 'subscribe_orders' });
}

export function formatUnsubscribeOrders(): string {
  return JSON.stringify({ action: 'unsubscribe_orders' });
}

/**
 * Real-time order lifecycle event from the `subscribe_orders` stream — fills,
 * partial fills, rejections, cancellations, pushed by the broker (or by the
 * sandbox engine in analyze mode).
 */
export interface OrderUpdateEvent {
  orderId: string;
  symbol: string;
  exchange: string;
  action: 'BUY' | 'SELL';
  quantity: number;
  price: number;
  /** Undefined when the broker reports 0 (plain LIMIT/MARKET). */
  triggerPrice?: number;
  pricetype: string;
  product: string;
  /** Lowercase OpenAlgo status: open | trigger pending | complete | rejected | cancelled | ... */
  status: string;
  filledQuantity: number;
  pendingQuantity: number;
  averagePrice: number;
  /** Broker RMS/OMS text when rejected. */
  rejectionReason: string;
  /** 'live' for broker events, 'analyze' for sandbox events. */
  mode: string;
}

/** Pure: parse an inbound `order_update` frame; null for any other message. */
export function parseOrderUpdate(raw: unknown): OrderUpdateEvent | null {
  if (typeof raw !== 'object' || raw === null) return null;
  const m = raw as Record<string, unknown>;
  if (m.type !== 'order_update') return null;
  const num = (v: unknown): number => {
    if (typeof v === 'number') return v;
    if (typeof v === 'string' && v.trim() !== '') { const n = Number(v); return Number.isNaN(n) ? 0 : n; }
    return 0;
  };
  const str = (v: unknown): string => (typeof v === 'string' ? v : '');
  const trig = num(m.trigger_price);
  return {
    orderId: str(m.orderid),
    symbol: str(m.symbol),
    exchange: str(m.exchange),
    action: m.action === 'SELL' ? 'SELL' : 'BUY',
    quantity: num(m.quantity),
    price: num(m.price),
    triggerPrice: trig > 0 ? trig : undefined,
    pricetype: str(m.pricetype) === '' ? 'LIMIT' : str(m.pricetype),
    product: str(m.product),
    status: str(m.order_status).toLowerCase(),
    filledQuantity: num(m.filled_quantity),
    pendingQuantity: num(m.pending_quantity),
    averagePrice: num(m.average_price),
    rejectionReason: str(m.rejection_reason),
    mode: str(m.mode),
  };
}

/**
 * Pure: build a subscribe message — `{ action, symbol, exchange, mode }`, where
 * `mode` is the numeric OpenAlgo data mode. Depth subscriptions may request a
 * `depth_level` (broker-dependent: 5/20/30/50).
 */
export function formatSubscribe(mode: WsMode, symbol: string, exchange: string, depthLevel?: number): string {
  const msg: Record<string, unknown> = { action: 'subscribe', symbol, exchange, mode: MODE_NUMBER[mode] };
  if (mode === 'Depth' && depthLevel !== undefined) msg.depth_level = depthLevel;
  return JSON.stringify(msg);
}

export function formatUnsubscribe(mode: WsMode, symbol: string, exchange: string): string {
  return JSON.stringify({ action: 'unsubscribe', symbol, exchange, mode: MODE_NUMBER[mode] });
}

interface DepthLevel { price: number; quantity: number; orders?: number }
interface RawData {
  symbol?: string;
  exchange?: string;
  ltp?: number;
  last_price?: number;
  last_quantity?: number;
  last_trade_quantity?: number;
  ltq?: number;
  volume?: number; // cumulative day volume (Quote and Depth modes)
  oi?: number;
  open_interest?: number;
  total_buy_quantity?: number;
  total_sell_quantity?: number;
  average_price?: number;
  atp?: number;
  timestamp?: number | string;
  depth?: { buy?: DepthLevel[]; sell?: DepthLevel[] };
}

/**
 * Last-traded quantity, under whichever name the broker adapter emits.
 *
 * OpenAlgo's adapters never settled on one spelling: `last_quantity` is by far
 * the most common (Zerodha, Angel's snap-quote mode, Dhan, Flattrade, Shoonya
 * and the rest of the Noren family), Angel's quote mode and the Five Paisa /
 * Upstox adapters say `last_trade_quantity`, and the XTS-derived ones say `ltq`.
 * Reading only one of the three silently zeroed the order flow on most brokers.
 */
function lastTradedQty(d: RawData): number | undefined {
  return d.last_quantity ?? d.last_trade_quantity ?? d.ltq;
}
interface RawMsg {
  type?: string;
  mode?: number;
  topic?: string;
  data?: RawData;
}

/** Coerce a WS timestamp (epoch s/ms or ISO-8601 string) to UTC seconds. */
function toSec(ts: number | string | undefined): number {
  if (typeof ts === 'number') return ts > 1e12 ? epochMsToUtcSeconds(ts) : Math.floor(ts);
  if (typeof ts === 'string' && ts.trim() !== '') {
    const ms = Date.parse(ts); // ISO-8601 with 'Z' is unambiguous UTC
    if (!Number.isNaN(ms)) return Math.floor(ms / 1000);
  }
  return 0;
}

/** True if the inbound frame is a heartbeat ping (plain "ping" or { type:'ping' }). */
export function isPing(raw: unknown): boolean {
  if (raw === 'ping') return true;
  return typeof raw === 'object' && raw !== null && (raw as { type?: string }).type === 'ping';
}

/**
 * Pure: classify + normalise an inbound message into an LTP or Depth event.
 * Payload fields live under `data` per the protocol, but the parser also
 * tolerates a flat shape for resilience across broker adapters.
 */
export function parseMessage(raw: unknown): { kind: 'ltp'; event: LtpEvent } | { kind: 'depth'; symbol: string; exchange: string; depth: MarketDepth } | null {
  if (typeof raw !== 'object' || raw === null) return null;
  const m = raw as RawMsg & RawData;
  const d: RawData = m.data ?? m;
  const symbol = d.symbol ?? '';
  const exchange = d.exchange ?? '';
  if (d.depth && (d.depth.buy || d.depth.sell)) {
    const bids = (d.depth.buy ?? []).map((b) => ({ price: b.price, qty: b.quantity }));
    const asks = (d.depth.sell ?? []).map((a) => ({ price: a.price, qty: a.quantity }));
    const ltp = d.ltp ?? d.last_price ?? (bids[0]?.price ?? 0);
    // A tradeable symbol subscribes to Depth alone (its payload embeds the LTP),
    // so everything a consumer needs per-message has to ride along here: the
    // traded quantity for the live order flow, and open interest / book totals /
    // VWAP for the exact side of a direction readout. Left `undefined` when the
    // adapter does not send them — a missing field is not a zero.
    return {
      kind: 'depth', symbol, exchange,
      depth: {
        bids, asks, ltp,
        ltq: lastTradedQty(d),
        volume: d.volume,
        oi: d.oi ?? d.open_interest,
        totalBuyQty: d.total_buy_quantity,
        totalSellQty: d.total_sell_quantity,
        atp: d.average_price ?? d.atp,
      },
    };
  }
  const price = d.ltp ?? d.last_price;
  if (typeof price === 'number') {
    return { kind: 'ltp', event: { symbol, exchange, ltp: price, ltq: lastTradedQty(d), volume: d.volume, timeSec: toSec(d.timestamp) } };
  }
  return null;
}

export class OpenAlgoWsFeed {
  private readonly _config: OpenAlgoWsConfig;
  private readonly _factory: SocketFactory;
  private _sock: SocketLike | null = null;
  private _open = false;
  private readonly _queue: string[] = [];
  private readonly _ltpCbs = new Set<(e: LtpEvent) => void>();
  private readonly _depthCbs = new Set<(symbol: string, exchange: string, depth: MarketDepth) => void>();
  private readonly _stateCbs = new Set<(state: WsState) => void>();
  private readonly _controlCbs = new Set<(msg: WsControlMessage) => void>();
  private readonly _orderCbs = new Set<(e: OrderUpdateEvent) => void>();
  private _ordersSubscribed = false;
  // Active subscriptions, replayed on reconnect. Keyed by mode:symbol:exchange.
  private readonly _subs = new Map<string, { mode: WsMode; symbol: string; exchange: string; depthLevel?: number }>();
  private _userClosed = false;
  private _attempts = 0;
  private _reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  private _resubscribeOnOpen = false;
  private readonly _rc: { enabled: boolean; baseDelayMs: number; maxDelayMs: number; maxAttempts: number };

  public constructor(config: OpenAlgoWsConfig) {
    this._config = config;
    const f = config.socketFactory
      ?? ((url: string) => new WebSocket(url) as unknown as SocketLike);
    this._factory = f;
    const r = config.reconnect ?? {};
    this._rc = {
      enabled: r.enabled ?? true,
      baseDelayMs: r.baseDelayMs ?? 1000,
      maxDelayMs: r.maxDelayMs ?? 30000,
      maxAttempts: r.maxAttempts ?? Infinity,
    };
  }

  public connect(): void {
    if (this._sock !== null) return;
    this._emitState('connecting');
    const sock = this._factory(this._config.url);
    sock.onmessage = (ev): void => this._dispatch(ev.data);
    sock.onopen = (): void => this._onOpen();
    sock.onclose = (): void => this._onClose();
    sock.onerror = (): void => this._emitState('error');
    this._sock = sock;
    // Some sockets connect synchronously (readyState OPEN) before onopen fires.
    if (sock.readyState === 1) this._onOpen();
  }

  /** Subscribe to socket lifecycle (connecting / open / closed / error). */
  public onState(cb: (state: WsState) => void): () => void {
    this._stateCbs.add(cb);
    return () => this._stateCbs.delete(cb);
  }

  /** Subscribe to control frames — auth / subscribe acks and server errors. */
  public onControl(cb: (msg: WsControlMessage) => void): () => void {
    this._controlCbs.add(cb);
    return () => this._controlCbs.delete(cb);
  }

  private _emitState(s: WsState): void {
    for (const cb of this._stateCbs) cb(s);
  }

  /** Authenticate first, then flush any queued subscriptions (protocol order). */
  private _onOpen(): void {
    if (this._open) return;
    this._open = true;
    this._attempts = 0; // a successful open resets the backoff
    this._emitState('open');
    this._sock?.send(formatAuthenticate(this._config.apiKey));
    this._flush();
    if (this._resubscribeOnOpen) {
      this._resubscribeOnOpen = false;
      for (const s of this._subs.values()) this._sock?.send(formatSubscribe(s.mode, s.symbol, s.exchange, s.depthLevel));
      if (this._ordersSubscribed) this._sock?.send(formatSubscribeOrders());
    }
  }

  private _onClose(): void {
    this._open = false;
    this._emitState('closed');
    this._maybeReconnect();
  }

  /** Schedule a reconnect with exponential backoff unless the user closed us. */
  private _maybeReconnect(): void {
    if (this._userClosed || !this._rc.enabled || this._attempts >= this._rc.maxAttempts) return;
    const n = this._attempts++;
    const delay = Math.min(this._rc.maxDelayMs, this._rc.baseDelayMs * 2 ** n);
    this._emitState('reconnecting');
    this._reconnectTimer = setTimeout(() => {
      this._reconnectTimer = null;
      this._sock = null;
      this._open = false;
      this._resubscribeOnOpen = this._subs.size > 0 || this._ordersSubscribed;
      this.connect();
    }, delay);
  }

  /** Send now if open; otherwise queue until onopen (browsers throw on send-before-open). */
  private _send(msg: string): void {
    if (this._sock !== null && this._open) this._sock.send(msg);
    else this._queue.push(msg);
  }

  private _flush(): void {
    if (this._sock === null) return;
    for (const msg of this._queue) this._sock.send(msg);
    this._queue.length = 0;
  }

  public onLtp(cb: (e: LtpEvent) => void): () => void {
    this._ltpCbs.add(cb);
    return () => this._ltpCbs.delete(cb);
  }

  public onDepth(cb: (symbol: string, exchange: string, depth: MarketDepth) => void): () => void {
    this._depthCbs.add(cb);
    return () => this._depthCbs.delete(cb);
  }

  public subscribe(mode: WsMode, symbol: string, exchange: string, depthLevel?: number): void {
    this._subs.set(`${mode}:${symbol}:${exchange}`, { mode, symbol, exchange, depthLevel });
    this._send(formatSubscribe(mode, symbol, exchange, depthLevel));
  }

  public unsubscribe(mode: WsMode, symbol: string, exchange: string): void {
    this._subs.delete(`${mode}:${symbol}:${exchange}`);
    this._send(formatUnsubscribe(mode, symbol, exchange));
  }

  /** Subscribe to real-time order updates (fills / cancels / rejections). Account-level; replayed on reconnect. */
  public onOrderUpdate(cb: (e: OrderUpdateEvent) => void): () => void {
    this._orderCbs.add(cb);
    return () => this._orderCbs.delete(cb);
  }

  public subscribeOrders(): void {
    this._ordersSubscribed = true;
    this._send(formatSubscribeOrders());
  }

  public unsubscribeOrders(): void {
    this._ordersSubscribed = false;
    this._send(formatUnsubscribeOrders());
  }

  public close(): void {
    this._userClosed = true; // intentional: never auto-reconnect after this
    if (this._reconnectTimer !== null) { clearTimeout(this._reconnectTimer); this._reconnectTimer = null; }
    this._sock?.close();
    this._sock = null;
    this._open = false;
    this._queue.length = 0;
  }

  private _dispatch(data: string): void {
    let raw: unknown;
    try { raw = JSON.parse(data); } catch { raw = data; } // heartbeats may be plain text
    if (isPing(raw)) { this._sock?.send(JSON.stringify({ action: 'pong' })); return; }
    const orderUpdate = parseOrderUpdate(raw);
    if (orderUpdate !== null) {
      for (const cb of this._orderCbs) cb(orderUpdate);
      return;
    }
    const parsed = parseMessage(raw);
    if (parsed === null) {
      // Non-market-data frame (auth / subscribe ack, or a server error) → surface it.
      if (typeof raw === 'object' && raw !== null) for (const cb of this._controlCbs) cb(raw as WsControlMessage);
      return;
    }
    if (parsed.kind === 'ltp') for (const cb of this._ltpCbs) cb(parsed.event);
    else for (const cb of this._depthCbs) cb(parsed.symbol, parsed.exchange, parsed.depth);
  }
}
