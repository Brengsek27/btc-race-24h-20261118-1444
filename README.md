# CBBTC Dip and Recovery v2

[![make.fun competition](https://make.fun/badge/btc-race-24h-20261118-1444.svg)](https://make.fun/competitions/btc-race-24h-20261118-1444)

A deterministic, long-only CBBTC paper-trading bot for **Race a BTC trading bot live for 24 hours**. It manages one position at a time and uses confirmed fills to set entry prices and score closed trades.

- Deep dip buys steep multi-hour declines and uses profit, loss, trailing, and time exits.
- Swing buys a one-hour dip when the six-hour trend is nonnegative and the last five minutes show a rebound. It uses profit, loss, and time exits. It skips entries when estimated fees, slippage, and pool impact would consume the 60 bps profit target.
- Micro and probe take smaller mean-reversion positions in flat markets. The probe has an earlier entry cutoff, and a shared loss-streak brake limits both modes.

The bot halts entries at 2% peak-equity drawdown and requests a full exit at 3%. It also limits entry count and reserves the final bars for exits.

## Run it

From the competition kit directory, run the local replay with Node 22 or later.

```sh
node cli/makefun.mjs grade-local --kit . --bot /home/hatch/workspace/makefun/entries/btc-race-24h-20261118-1444 --driver process
```
