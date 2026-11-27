// Clean-Sharpe paper bot for the Pump.fun Sharpe Sprint.
//
// The ranking is the hourly Sharpe ratio, not total PnL — so this bot optimises for
// many small, similar, positive trades instead of one lucky moonshot. Two entry
// families, both bought in the same small size and exited by the same rules:
//
//  - Momentum only: a curve whose tape proves a sudden, broad buying burst
//    (15+ distinct wallets, 2+ SOL net inflow, price up 40%+ inside 15 slots
//    and holding at 95%+ of its window high). Only the strongest bursts
//    qualify; weak ones are skipped. Young curves are allowed: the burst
//    itself is the signal, and the entry is small (0.20 SOL) with a wide
//    stop (20%) and a quick take-profit (15%).
//  - Dip entries are off in the tuned defaults: on the dev window they were
//    net-negative below 40 SOL of reserve and added nothing above it.
//
// Exits are deliberately boring: a stop loss against cost, a take-profit, an
// optional trailing stop that only arms once the trade is already well up, a
// hold limit. No exit on creator sell: it fired too often on noisy tapes
// and cut winners. No pyramiding: adding to a position buys the top of the
// move. Every exit sells the whole position at once.
//
// Guardrail pacing keeps the run above the 20-coin bar even in a quiet hour:
// when filled coins lag the pace, the bot opens tiny probe round trips on the
// most liquid coin it saw and closes them on a small gain, a small loss, or a
// short hold.
//
// Deterministic by construction: a pure function of the batches, no clock, no
// environment, no randomness. Iteration is over insertion-ordered maps fed by
// the batch stream, so the two graded executions agree byte for byte.

import type { Batch, Bot, BotState, OrderInput, Pubkey } from './vendor/makefun-bot.ts';

export interface Params {
  // Momentum entry: window in slots, net SOL in, buy trades, distinct buyers.
  momWindow: number;
  momMinNetSol: number;
  momMinBuys: number;
  momMinBuyers: number;
  momMinPriceUp: number;
  momNearHigh: number;
  momAccel: number;
  momMaxBuyerShare: number;
  momMinRqSol: number;
  momMaxRqSol: number;
  momMinAge: number;
  // Dip entry: lookback for the high, dip band, curve strength, flow filter.
  dipWindow: number;
  dipMin: number;
  dipMax: number;
  dipMinRqSol: number;
  dipFlowTrades: number;
  dipMinBuys: number;
  dipLastMustBeBuy: boolean;
  // Sizing and slippage.
  stakeSol: number;
  minBuySol: number;
  buySlipBps: number;
  // Exits. takeProfit 0 = off; trailArm 1 = off.
  stopLoss: number;
  takeProfit: number;
  trail: number;
  trailArm: number;
  maxHold: number;
  exitOnCreatorSell: boolean;
  cooldown: number;
  maxEntries: number;
  // Guardrail pacing: target coins over paceSecs of block time.
  targetCoins: number;
  paceSecs: number;
  probeSol: number;
  probeTake: number;
  probeStop: number;
  probeMaxHold: number;
  maxProbes: number;
}

// Defaults: chosen on the dev window for hourly Sharpe with net PnL above zero,
// preferring flat regions over the single best cell (see the sweep notes in the
// run log, not a single lucky point).
export const DEFAULT_PARAMS: Params = {
  momWindow: 15,
  momMinNetSol: 2,
  momMinBuys: 5,
  momMinBuyers: 15,
  momMinPriceUp: 0.4,
  momNearHigh: 0.95,
  momAccel: 1,
  momMaxBuyerShare: 0.4,
  momMinRqSol: 5,
  momMaxRqSol: 200,
  momMinAge: 0,
  dipWindow: 2500,
  dipMin: 0.99,
  dipMax: 1.0,
  dipMinRqSol: 25,
  dipFlowTrades: 6,
  dipMinBuys: 3,
  dipLastMustBeBuy: true,
  stakeSol: 0.2,
  minBuySol: 0.01,
  buySlipBps: 300,
  stopLoss: 0.2,
  takeProfit: 0.15,
  trail: 0.15,
  trailArm: 0.3,
  maxHold: 300,
  exitOnCreatorSell: false,
  cooldown: 150,
  maxEntries: 2,
  targetCoins: 30,
  paceSecs: 21600,
  probeSol: 0.01,
  probeTake: 0.08,
  probeStop: 0.15,
  probeMaxHold: 600,
  maxProbes: 1,
};

const LAMPORTS = 1e9;
const CURVE_FEE = 0.0125;
const BPS = 10_000;

interface Trade {
  slot: number;
  buy: boolean;
  sol: number;
  user: string;
  price: number;
}

interface Tape {
  created: number | null;
  creator: string | null;
  trades: Trade[];
  entries: number;
  lastExit: number;
  creatorSold: boolean;
}

interface Held {
  opened: number;
  peakValue: number;
  invested: number;
  exiting: boolean;
  filled: boolean;
  lastValue: number;
}

interface Probe {
  opened: number;
  peakValue: number;
  selling: boolean;
}

export function createStrategy(p: Params = DEFAULT_PARAMS): Bot {
  const tapes = new Map<Pubkey, Tape>();
  const held = new Map<Pubkey, Held>();
  const probes = new Map<Pubkey, Probe>();
  let myFills = 0;
  const myCoins = new Set<Pubkey>();
  let firstTime: number | null = null;
  let lastTime: number | null = null;

  const tapeOf = (mint: Pubkey): Tape => {
    let t = tapes.get(mint);
    if (t === undefined) {
      t = { created: null, creator: null, trades: [], entries: 0, lastExit: -1e12, creatorSold: false };
      tapes.set(mint, t);
    }
    return t;
  };

  const keep = Math.max(p.momWindow, p.dipWindow) + 5;

  /** Net recorded SOL (buys minus sells) over the last `w` slots. */
  const flow = (t: Tape, now: number, w: number): number => {
    let net = 0;
    for (let i = t.trades.length - 1; i >= 0; i--) {
      const tr = t.trades[i]!;
      if (tr.slot <= now - w) break;
      net += tr.buy ? tr.sol : -tr.sol;
    }
    return net;
  };

  /** Momentum signal on a tape at slot `now`. */
  const momentumOk = (t: Tape, now: number, rqSol: number): boolean => {
    if (rqSol < p.momMinRqSol || rqSol > p.momMaxRqSol) return false;
    if (t.created === null || now - t.created < p.momMinAge) return false;
    const from = now - p.momWindow;
    const mid = now - p.momWindow / 2;
    let buySol = 0;
    let sellSol = 0;
    let buys = 0;
    let netOld = 0;
    let netNew = 0;
    let startPrice = -1;
    let high = 0;
    let last = 0;
    const byUser = new Map<string, number>();
    for (const tr of t.trades) {
      if (tr.slot <= from) {
        startPrice = tr.price;
        continue;
      }
      if (startPrice < 0) startPrice = tr.price;
      const signed = tr.buy ? tr.sol : -tr.sol;
      if (tr.slot <= mid) netOld += signed;
      else netNew += signed;
      if (tr.buy) {
        buySol += tr.sol;
        buys++;
        byUser.set(tr.user, (byUser.get(tr.user) ?? 0) + tr.sol);
      } else {
        sellSol += tr.sol;
      }
      if (tr.price > high) high = tr.price;
      last = tr.price;
    }
    if (buys < p.momMinBuys || byUser.size < p.momMinBuyers) return false;
    if (buySol - sellSol < p.momMinNetSol) return false;
    if (startPrice <= 0) return false;
    if (last / startPrice - 1 < p.momMinPriceUp) return false;
    if (last < high * p.momNearHigh) return false;
    if (netNew <= 0 || netNew < p.momAccel * netOld) return false;
    let top = 0;
    for (const v of byUser.values()) if (v > top) top = v;
    if (top > p.momMaxBuyerShare * buySol) return false;
    return true;
  };

  /** Dip signal on a tape at slot `now`. */
  const dipOk = (t: Tape, now: number, rqSol: number): boolean => {
    if (rqSol < p.dipMinRqSol) return false;
    if (t.trades.length < p.dipFlowTrades) return false;
    let hi = 0;
    for (let i = t.trades.length - 1; i >= 0; i--) {
      const tr = t.trades[i]!;
      if (now - tr.slot > p.dipWindow) break;
      if (tr.price > hi) hi = tr.price;
    }
    if (hi <= 0) return false;
    const last = t.trades[t.trades.length - 1]!;
    const dd = 1 - last.price / hi;
    if (dd < p.dipMin || dd > p.dipMax) return false;
    let buys = 0;
    for (let i = t.trades.length - p.dipFlowTrades; i < t.trades.length; i++) {
      if (t.trades[i]!.buy) buys++;
    }
    if (buys < p.dipMinBuys) return false;
    if (p.dipLastMustBeBuy && !last.buy) return false;
    return true;
  };

  /** Liquidation value of `tokens` against (vq, vt), curve fees deducted. */
  const sellValue = (tokens: number, vq: number, vt: number): number => {
    if (tokens <= 0 || vt <= 0) return 0;
    return ((tokens * vq) / (vt + tokens) / LAMPORTS) * (1 - CURVE_FEE);
  };

  return {
    onBatch(state: BotState, batch: Batch): OrderInput[] {
      const now = batch.slot;
      const traded = new Set<Pubkey>();
      for (const f of batch.fills) {
        if (f.status === 'filled' && !f.client_id.startsWith('_')) {
          myFills++;
          myCoins.add(f.mint);
        }
      }
      for (const e of batch.events) {
        if (e.block_time !== null) {
          if (firstTime === null) firstTime = e.block_time;
          if (lastTime === null || e.block_time > lastTime) lastTime = e.block_time;
        }
        if (e.event === 'CreateEvent') {
          const t = tapeOf(e.mint);
          t.created = e.slot;
          t.creator = e.creator;
        } else if (e.event === 'TradeEvent') {
          const t = tapeOf(e.mint);
          const sol = Number(e.sol_amount) / LAMPORTS;
          t.trades.push({
            slot: e.slot,
            buy: e.is_buy,
            sol,
            user: e.user,
            price: Number(e.virtual_quote_reserves) / Number(e.virtual_token_reserves),
          });
          traded.add(e.mint);
          if (!e.is_buy && t.creator !== null && e.user === t.creator) t.creatorSold = true;
        }
      }
      for (const mint of traded) {
        const t = tapes.get(mint)!;
        let cut = 0;
        while (cut < t.trades.length && t.trades[cut]!.slot <= now - keep) cut++;
        if (cut > 0) t.trades.splice(0, cut);
      }
      const marks = new Map(batch.marks.map((m) => [m.mint, m] as const));
      const pendingByMint = new Map<Pubkey, number>();
      for (const po of state.pending.values()) pendingByMint.set(po.order.mint, (pendingByMint.get(po.order.mint) ?? 0) + 1);

      const orders: OrderInput[] = [];
      const cap = state.hello.caps.max_orders_per_batch;
      const tx = Number(state.txFeeLamports()) / LAMPORTS;

      const curveReserves = (mint: Pubkey): { vq: number; vt: number; rqSol: number } | null => {
        const mk = marks.get(mint);
        if (mk !== undefined) {
          return {
            vq: Number(mk.virtual_quote_reserves),
            vt: Number(mk.virtual_token_reserves),
            rqSol: Number(mk.real_quote_reserves) / LAMPORTS,
          };
        }
        const c = state.curves.get(mint);
        if (c === undefined) return null;
        return {
          vq: Number(c.virtual_quote_reserves),
          vt: Number(c.virtual_token_reserves),
          rqSol: Number(c.real_quote_reserves) / LAMPORTS,
        };
      };

      // Exits first: main positions.
      for (const [mint, h] of held) {
        const pos = state.positions.get(mint);
        const curve = state.curves.get(mint);
        if (pos === undefined) {
          if (!pendingByMint.has(mint)) {
            held.delete(mint);
            const t = tapeOf(mint);
            if (h.filled) t.lastExit = now;
            else t.entries--;
          }
          continue;
        }
        h.filled = true;
        if (curve === undefined || curve.complete) continue;
        const r = curveReserves(mint);
        if (r === null) continue;
        const tokens = Number(pos.token_amount);
        const value = sellValue(tokens, r.vq, r.vt) - tx;
        const cost = Number(pos.cost_lamports) / LAMPORTS;
        if (value > h.peakValue) h.peakValue = value;
        h.lastValue = value;
        let exit = h.exiting;
        const t = tapeOf(mint);
        if (!exit && value < cost * (1 - p.stopLoss)) exit = true;
        if (!exit && p.takeProfit > 0 && value >= cost * (1 + p.takeProfit)) exit = true;
        if (!exit && p.trailArm < 1 && h.peakValue >= cost * (1 + p.trailArm) && value < h.peakValue * (1 - p.trail)) exit = true;
        if (!exit && p.exitOnCreatorSell && t.creatorSold) exit = true;
        if (!exit && now - h.opened > p.maxHold) exit = true;
        if (!exit) continue;
        h.exiting = true;
        let sellPending = false;
        for (const po of state.pending.values()) {
          if (po.order.mint === mint && po.order.side === 'sell') sellPending = true;
        }
        if (sellPending) continue;
        if (orders.length >= cap) break;
        orders.push({ side: 'sell', mint, token_amount: pos.token_amount, max_slippage_bps: BPS });
      }

      // Probe round trips: sell the whole probe as soon as its buy has landed.
      for (const [mint, pr] of probes) {
        const pos = state.positions.get(mint);
        const curve = state.curves.get(mint);
        if (pos === undefined) {
          if (!pendingByMint.has(mint)) probes.delete(mint);
          continue;
        }
        if (curve === undefined || curve.complete || pendingByMint.has(mint)) continue;
        const r = curveReserves(mint);
        if (r === null) continue;
        const tokens = Number(pos.token_amount);
        const value = sellValue(tokens, r.vq, r.vt) - tx;
        const cost = Number(pos.cost_lamports) / LAMPORTS;
        if (value > pr.peakValue) pr.peakValue = value;
        const done = value >= cost * (1 + p.probeTake) || value <= cost * (1 - p.probeStop) || now - pr.opened > p.probeMaxHold;
        if (!done) continue;
        if (orders.length >= cap) break;
        orders.push({ side: 'sell', mint, token_amount: pos.token_amount, max_slippage_bps: BPS });
        if (!pr.selling) pr.selling = true;
      }

      // Entries.
      let free = Number(state.freeCashLamports()) / LAMPORTS;
      let slotsLeft = state.hello.caps.max_open_positions - state.committedPositionCount();
      for (const mint of traded) {
        if (orders.length >= cap) break;
        if (slotsLeft <= 0) break;
        const curve = state.curves.get(mint);
        if (curve === undefined || curve.complete) continue;
        if (pendingByMint.has(mint) || probes.has(mint) || held.has(mint)) continue;
        const t = tapes.get(mint)!;
        if (t.entries >= p.maxEntries || now - t.lastExit < p.cooldown) continue;
        const r = curveReserves(mint);
        if (r === null) continue;
        const signal = momentumOk(t, now, r.rqSol) || dipOk(t, now, r.rqSol);
        if (!signal) continue;
        const capSol = (Number(state.maxBuyLamports(mint)) * 97) / 100 / LAMPORTS;
        let amount = Math.min(capSol, p.stakeSol);
        if (amount > free - tx) amount = free - tx;
        if (amount < p.minBuySol || !Number.isFinite(amount)) continue;
        const lamports = BigInt(Math.floor(amount * LAMPORTS));
        if (lamports <= 0n) continue;
        orders.push({ side: 'buy', mint, quote_lamports: lamports, max_slippage_bps: p.buySlipBps });
        free -= amount + tx;
        held.set(mint, { opened: now, peakValue: 0, invested: amount, exiting: false, filled: false, lastValue: 0 });
        t.entries++;
        slotsLeft--;
      }

      // Guardrail pacing: open a probe when the coin count lags the pace.
      if (probes.size < p.maxProbes && slotsLeft > 0 && firstTime !== null && lastTime !== null) {
        const pace = Math.min(1, (lastTime - firstTime) / p.paceSecs);
        if (myCoins.size < Math.ceil(p.targetCoins * pace)) {
          const minRq = (p.probeSol * BPS) / state.hello.caps.max_order_bps_of_real_reserve;
          for (const mint of traded) {
            if (orders.length >= cap || probes.size >= p.maxProbes) break;
            if (held.has(mint) || probes.has(mint) || pendingByMint.has(mint) || state.positions.has(mint)) continue;
            if (myCoins.has(mint)) continue;
            const curve = state.curves.get(mint);
            if (curve === undefined || curve.complete) continue;
            if (Number(curve.real_quote_reserves) / LAMPORTS < minRq * 1.5) continue;
            if (free < p.probeSol + 2 * tx) break;
            orders.push({ side: 'buy', mint, quote_lamports: BigInt(Math.floor(p.probeSol * LAMPORTS)), max_slippage_bps: p.buySlipBps });
            probes.set(mint, { opened: now, peakValue: 0, selling: false });
            free -= p.probeSol + tx;
          }
        }
      }
      return orders;
    },
  };
}
