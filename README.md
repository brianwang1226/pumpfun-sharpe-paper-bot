# Pump.fun Sharpe Sprint — Cleanest Paper Bot Wins

[![make.fun](https://make.fun/badge/u-jackxyz72-pump-fun-sharpe-sprint-cleanest-03e4f532.svg)](https://make.fun/competitions/u-jackxyz72-pump-fun-sharpe-sprint-cleanest-03e4f532)
[![rank](https://make.fun/badge/u-jackxyz72-pump-fun-sharpe-sprint-cleanest-03e4f532/brianwang1226/pumpfun-sharpe-paper-bot/rank.svg)](https://make.fun/competitions/u-jackxyz72-pump-fun-sharpe-sprint-cleanest-03e4f532)
[![reward](https://make.fun/badge/u-jackxyz72-pump-fun-sharpe-sprint-cleanest-03e4f532/brianwang1226/pumpfun-sharpe-paper-bot/reward.svg)](https://make.fun/competitions/u-jackxyz72-pump-fun-sharpe-sprint-cleanest-03e4f532)

Paper-trading bot for the [Pump.fun Sharpe Sprint — Cleanest Paper Bot Wins](https://make.fun/competitions/u-jackxyz72-pump-fun-sharpe-sprint-cleanest-03e4f532) competition on make.fun. It trades 10 SOL of paper money on a 6-hour forward replay of pump.fun chain data, ranked by hourly Sharpe ratio. Paper trading only — never real money.

## Strategy

The ranking is hourly Sharpe, not total PnL, so the bot optimises for many small, similar, positive trades instead of one lucky moonshot.

- **Entry (momentum burst only):** a curve qualifies only when its tape proves a sudden, broad buying burst — 15+ distinct buyers, 2+ SOL net inflow, price up 40%+ inside 15 slots and holding at 95%+ of its window high, no single buyer over 40% of buy SOL, real reserve 5–200 SOL. Young curves are allowed; the burst itself is the signal.
- **Size:** 0.20 SOL per entry, one entry per coin, no pyramiding. At most 5 open positions.
- **Exits:** stop-loss −20%, take-profit +15%, trailing stop 15% armed at +30%, max hold 300 slots. Every exit sells the whole position at once.
- **Dip entries are off:** on the dev window they were net-negative and added nothing.
- **Guardrail pacing:** if filled coins lag the pace toward 30 coins over 6 hours, the bot opens tiny 0.01 SOL probe round trips on the most liquid coin it saw, closing on +8% / −15% / 600 slots — insurance for the 20-coin bar.
- **Deterministic:** a pure function of the batches — no clock, no environment, no randomness — so the two graded executions agree byte for byte.

## Local backtest (kit dev window, 24h, 2026-11-02 → 2026-11-03 UTC)

| metric | value |
| --- | --- |
| net PnL | +0.88 SOL |
| hourly Sharpe | 0.30 |
| sortino | 0.72 |
| fills / coins / trips | 248 / 119 / 124 |
| win rate | 55.6% |
| max drawdown | 2.0% |
| net PnL at 2x fees | +0.32 SOL |
| 6h-block Sharpes | +0.05 / +0.20 / +0.32 / +0.66 (all four positive) |

The dev window is public and frozen; the final 6-hour window is fresh data, so these numbers are a robustness check, not a promise.

## Files

- `main.ts` — entry point, wires the strategy into the harness.
- `strategy.ts` — the strategy (all logic, tuned parameters in `DEFAULT_PARAMS`).
- `vendor/makefun-bot.ts` — the kit's SDK, copied byte for byte from the official competition kit.
- `.makefun/owner.json` — owner wallet for payouts.

## License

MIT — see `LICENSE`.
