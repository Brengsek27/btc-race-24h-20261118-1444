import { BPS, runBars } from './vendor/makefun-bars.ts';

type Mode = 'deep' | 'swing' | 'micro' | 'probe';

const SYMBOL = 'CBBTC';
const SIZE_PERCENT: Record<Mode, bigint> = { deep: 97n, swing: 97n, micro: 30n, probe: 15n };
const SLIPPAGE_BPS: Record<Mode, number> = { deep: 300, swing: 300, micro: 120, probe: 100 };

const closes: bigint[] = [];
let mode: Mode | null = null;
let pendingMode: Mode | null = null;
let entryPrice = 0n;
let exitMean = 0n;
let pendingMean = 0n;
let peakPrice = 0n;
let holdBars = 0;
let hadPosition = false;
let lastEntryBar = -Infinity;
let totalEntries = 0;
let microEntries = 0;
let microLossStreak = 0;
let microOffUntil = 0;
let peakEquity = 0n;
let entriesHalted = false;

function relAtLeast(price: bigint, base: bigint, bps: bigint): boolean {
  return price * BPS >= base * (BPS + bps);
}

function relAtMost(price: bigint, base: bigint, bps: bigint): boolean {
  return price * BPS <= base * (BPS + bps);
}

function abs(value: bigint): bigint {
  return value < 0n ? -value : value;
}

function closeAgo(bars: number): bigint | undefined {
  return closes.at(-1 - bars);
}

function retBps(bars: number): bigint {
  const base = closeAgo(bars)!;
  return (closeAgo(0)! - base) * BPS / base;
}

function meanLast(bars: number): bigint {
  const window = closes.slice(-bars);
  return window.reduce((sum, price) => sum + price, 0n) / BigInt(window.length);
}

function deviationBps(bars: number): bigint {
  const mean = meanLast(bars);
  return (mean - closeAgo(0)!) * BPS / mean;
}

function minLast(bars: number): bigint {
  return closes.slice(-bars).reduce((low, price) => price < low ? price : low);
}

function rangeBps(bars: number): bigint {
  const low = minLast(bars);
  const high = closes.slice(-bars).reduce((high, price) => price > high ? price : high);
  return (high - low) * BPS / low;
}

function avgAbsRetBps(bars: number): bigint {
  let sum = 0n;
  for (let barsAgo = bars; barsAgo > 0; barsAgo -= 1) {
    const base = closeAgo(barsAgo)!;
    sum += abs(closeAgo(barsAgo - 1)! - base) * BPS / base;
  }
  return (sum + BigInt(bars - 1)) / BigInt(bars);
}

function flatRegime(bar: number): boolean {
  if (bar < 120 || rangeBps(120) > 70n) return false;
  if (bar < 360) return abs(retBps(120)) <= 45n && avgAbsRetBps(30) <= 8n;
  return rangeBps(360) <= 125n && abs(retBps(360)) <= 55n && avgAbsRetBps(60) <= 9n;
}

function chooseEntry(bar: number, close: bigint): Mode | null {
  const trendBase = closeAgo(360);
  const deepBase = closeAgo(300);
  if ((trendBase !== undefined && relAtMost(close, trendBase, -400n))
    || (deepBase !== undefined && relAtMost(close, deepBase, -375n) && close >= closeAgo(15)!)) {
    return 'deep';
  }
  if (trendBase !== undefined && relAtLeast(close, trendBase, 0n)
    && relAtMost(close, closeAgo(60)!, -50n) && relAtLeast(close, closeAgo(5)!, 5n)) {
    return 'swing';
  }
  if (bar < 120 || bar < microOffUntil || microEntries >= 16
    || bar - lastEntryBar < 30 || !flatRegime(bar)) return null;

  const return60 = retBps(60);
  const notFalling = return60 >= -70n && return60 <= 40n && retBps(15) >= -30n;
  if (!notFalling) return null;
  const deviation120 = deviationBps(120);
  if (deviation120 >= 30n) return 'micro';
  if (bar >= 360 && bar < 1100 && bar - lastEntryBar >= 360
    && deviation120 >= 20n && deviationBps(240) >= 10n
    && relAtMost(close, minLast(240), 15n)) return 'probe';
  return null;
}

function shouldExit(close: bigint): boolean {
  switch (mode) {
    case 'deep':
      return relAtLeast(close, entryPrice, 150n) || relAtMost(close, entryPrice, -200n)
        || (relAtLeast(peakPrice, entryPrice, 120n) && relAtMost(close, peakPrice, -40n))
        || holdBars >= 720;
    case 'swing':
      return relAtLeast(close, entryPrice, 60n) || relAtMost(close, entryPrice, -80n) || holdBars >= 240;
    case 'micro':
      return relAtLeast(close, entryPrice, 40n) || relAtMost(close, entryPrice, -35n)
        || (relAtLeast(close, exitMean, -2n) && relAtLeast(close, entryPrice, 20n))
        || holdBars >= 180;
    case 'probe':
      return relAtLeast(close, entryPrice, 22n) || relAtMost(close, entryPrice, -55n)
        || (relAtLeast(close, exitMean, -12n) && relAtLeast(close, entryPrice, 18n))
        || holdBars >= 150;
    default:
      return false;
  }
}

function recordMicroExit(price: bigint, bar: number): void {
  if (relAtMost(price, entryPrice, 18n)) {
    microLossStreak += 1;
    if (microLossStreak === 3) microOffUntil = bar + 360;
    if (microLossStreak >= 4) microOffUntil = Infinity;
  } else {
    microLossStreak = 0;
  }
}

await runBars({
  onHello(state) {
    peakEquity = state.equity;
  },
  onBatch(state, batch) {
    if (state.warmingUp || !batch.bars.some((item) => item.symbol === SYMBOL)) return [];
    const close = state.close(SYMBOL);
    if (close === null) return [];
    const bar = closes.push(close) - 1;

    const position = state.positions.get(SYMBOL);
    const hasPosition = position !== undefined && position.qty > 0n;
    const buy = batch.fills.find((fill) => fill.symbol === SYMBOL && fill.side === 'buy');
    if (buy !== undefined) {
      if (buy.status === 'filled' && hasPosition) {
        mode = pendingMode;
        entryPrice = BigInt(buy.price);
        peakPrice = entryPrice;
        exitMean = pendingMean;
      }
      pendingMode = null;
      pendingMean = 0n;
    }

    if (hadPosition && !hasPosition) {
      const sell = batch.fills.find((fill) => fill.symbol === SYMBOL && fill.side === 'sell'
        && fill.status === 'filled');
      if (sell !== undefined && (mode === 'micro' || mode === 'probe')) {
        recordMicroExit(BigInt(sell.price), bar);
      }
      mode = null;
      holdBars = 0;
      entryPrice = 0n;
      exitMean = 0n;
      peakPrice = 0n;
    }
    hadPosition = hasPosition;

    if (state.equity > peakEquity) peakEquity = state.equity;
    if (relAtMost(state.equity, peakEquity, -200n)) entriesHalted = true;
    if (hasPosition) {
      holdBars += 1;
      if (close > peakPrice) peakPrice = close;
      if (relAtMost(state.equity, peakEquity, -300n) || shouldExit(close)) {
        return [{ side: 'sell', symbol: SYMBOL, qty: position.qty, max_slippage_bps: 300 }];
      }
      return [];
    }

    if (pendingMode !== null || entriesHalted || totalEntries >= 28 || bar > 1440 - 31) return [];
    const chosen = chooseEntry(bar, close);
    if (chosen === null) return [];
    const spend = state.cash * SIZE_PERCENT[chosen] / 100n;
    if (spend < BigInt(state.hello.fees.min_notional_quote_units)) return [];
    if (chosen === 'swing') {
      const depth = state.depthAt(SYMBOL);
      if (depth === null || depth.some((hop) => hop === 0n)) return [];
      const impact = state.impactBps(SYMBOL, spend) ?? 0n;
      const estimatedRoundTripBps = 2n * (impact + 1n
        + BigInt(state.hello.fees.fee_bps) + BigInt(state.hello.fees.slippage_bps));
      if (estimatedRoundTripBps >= 60n) return [];
    }

    pendingMode = chosen;
    pendingMean = chosen === 'micro' || chosen === 'probe' ? meanLast(120) : 0n;
    lastEntryBar = bar;
    totalEntries += 1;
    if (chosen === 'micro' || chosen === 'probe') microEntries += 1;
    return [{ side: 'buy', symbol: SYMBOL, notional_quote_units: spend, max_slippage_bps: SLIPPAGE_BPS[chosen] }];
  },
});
