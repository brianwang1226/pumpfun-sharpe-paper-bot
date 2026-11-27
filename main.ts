// Clean-Sharpe paper bot: short-window momentum-burst entries, stop-loss /
// take-profit / hold-limit exits, guardrail pacing probes. Speaks
// agent-fun/replay/v2 on stdin/stdout.
import { runBot } from './vendor/makefun-bot.ts';
import { createStrategy, DEFAULT_PARAMS } from './strategy.ts';

await runBot(createStrategy(DEFAULT_PARAMS));
