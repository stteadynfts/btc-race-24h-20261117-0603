// Dip-bounce scalper for the cbBTC 24h race (agent-fun/bars-replay/v1).
//
// Idea: Bitcoin on a 1-minute Orca pool is noisy and mean-reverts over
// tens of minutes. We wait for a sharp 30-minute drop that has just
// started to turn back up, buy it with the full cash balance, and exit
// on a take-profit, a stop-loss, or a maximum holding time. One open
// position at most; no leverage, no shorts, no network, no clock.
//
// Every decision uses only the closes the harness has already sent, so
// two runs on the same window produce the same orders byte for byte.

import { runBars } from './vendor/makefun-bars.ts';
import type { BarsState, Batch } from './vendor/makefun-bars.ts';

const SYMBOL = 'CBBTC';

// Entry: 30-bar close-to-close fall of at least DIP_BPS, with the last
// 5-bar return no longer falling (the bounce has started).
const DIP_BPS = 80; // 0.80% fall over 30 bars
const BOUNCE_WINDOW = 5; // bars for the bounce check
const LOOKBACK = 30; // bars for the dip check

// Exit: take profit, stop loss, or the holding-time cap, whichever first.
// A minimum hold keeps us from being shaken out by the very next bar;
// the cap (4h) keeps a stale position from riding the window to the end.
const TAKE_PROFIT_BPS = 150; // +1.50% from the fill price
const STOP_LOSS_BPS = 80; // -0.80% from the fill price
const MAX_HOLD_BARS = 240; // 4 hours
const MIN_HOLD_BARS = 8;

// Orders are filled at the next bar's open; the modelled slippage plus
// the pool impact on a full-size trade is well under this bound, while
// a genuine gap open is refused rather than chased.
const MAX_SLIPPAGE_BPS = 100;

// Closes seen so far, as plain numbers in USDC (price_scale applied).
const closes: number[] = [];
// Fill price of the open position, in USDC; 0 while flat.
let entryPrice = 0;
// Bars held since the entry fill.
let heldBars = 0;

function closeOf(state: BarsState): number | null {
  const raw = state.close(SYMBOL);
  if (raw === null) return null;
  const sym = state.symbols.get(SYMBOL);
  const scale = sym === undefined ? 5 : sym.price_scale;
  return Number(raw) / 10 ** scale;
}

function retNow(back: number): number | null {
  if (closes.length <= back) return null;
  const now = closes[closes.length - 1];
  const then = closes[closes.length - 1 - back];
  if (then <= 0) return null;
  return (now - then) / then;
}

await runBars({
  onBatch(state: BarsState, batch: Batch) {
    // Learn from this batch's fills first: an entry fill sets our cost
    // basis, an exit fill clears it.
    for (const fill of batch.fills) {
      if (fill.symbol !== SYMBOL || fill.status !== 'filled') continue;
      if (fill.side === 'buy') {
        const sym = state.symbols.get(SYMBOL);
        const scale = sym === undefined ? 5 : sym.price_scale;
        entryPrice = Number(fill.price) / 10 ** scale;
        heldBars = 0;
      } else if (fill.side === 'sell') {
        entryPrice = 0;
        heldBars = 0;
      }
    }

    const close = closeOf(state);
    if (close === null) return [];
    closes.push(close);

    const pos = state.positions.get(SYMBOL);
    const qty = pos === undefined ? 0n : pos.qty;

    // Flat: look for a dip that has started to bounce.
    if (qty === 0n) {
      if (state.warmingUp) return [];
      const dip = retNow(LOOKBACK);
      const bounce = retNow(BOUNCE_WINDOW);
      if (dip === null || bounce === null) return [];
      if (dip * 10000 <= -DIP_BPS && bounce >= 0) {
        const spend = state.cash < state.weightRoom(SYMBOL) ? state.cash : state.weightRoom(SYMBOL);
        if (spend <= 0n) return [];
        return [{ side: 'buy', symbol: SYMBOL, notional_quote_units: spend, max_slippage_bps: MAX_SLIPPAGE_BPS }];
      }
      return [];
    }

    // Holding: count the bar, then check the exits.
    heldBars += 1;
    if (entryPrice <= 0) return [];
    const gainBps = ((close - entryPrice) / entryPrice) * 10000;
    if (heldBars >= MIN_HOLD_BARS && (gainBps >= TAKE_PROFIT_BPS || gainBps <= -STOP_LOSS_BPS || heldBars >= MAX_HOLD_BARS)) {
      return [{ side: 'sell', symbol: SYMBOL, qty, max_slippage_bps: MAX_SLIPPAGE_BPS }];
    }
    return [];
  },
});
