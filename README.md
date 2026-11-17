# Pumpstriker Bots — Self-Hosted Solana Trading Bot

[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](LICENSE)
[![TypeScript](https://img.shields.io/badge/TypeScript-5-blue.svg)](tsconfig.json)
[![Node](https://img.shields.io/badge/Node-%E2%89%A520.18.1-brightgreen.svg)](package.json)
[![Self--hosted](https://img.shields.io/badge/Self--hosted-your%20keys%2C%20your%20machine-orange.svg)](#-security-design)

> A self-hosted Telegram trading bot for Solana memecoins. Manage wallets, fire buys / sells, monitor positions with TP / SL / TSL — all from your own Telegram chat. **You own the keys. You run the bot. Your keys are stored encrypted on your machine, and the bot talks only to the services listed under "Network exposure" below.**

Built for traders who want a transparent, auditable execution tool — every line of the bot's code is in this repo.

🌐 **Website: [pumpstriker.fun](https://pumpstriker.fun)**

---

## What this repository is

This repository is the PumpStriker Telegram bot. It is MIT-licensed (see `LICENSE`) and complete for manual trading: wallets,
buys and sells, positions with TP / SL / TSL, Send SOL, the backrun rebates and the rent-recovery check all work with the bot alone.
The **PumpStriker Engine**, which decides what is a signal, is a separate, closed-source product. It is not in this repository, it
is optional, and it never receives a key: the bot sends it reports and a heartbeat (see "The Engine link" below). These features
need the Engine: signal cards and auto-buy, `/check` and `/report`, the GMGN skill commands and their 🔬 buttons, market cap and
liquidity on the position cards, and the wallet link routes of the Engine dashboard.

---

## Why open source?

A trading bot handles your **private keys** and your **money**. You should never trust a closed-source bot that asks for either.

Pumpstriker Bots is published in full so you can:

- **Audit** the wallet encryption scheme before you import a key (it's [AES-256-GCM with a key derived from `WALLET_ENC_KEY`, or from your `TG_BOT_TOKEN` when that is unset](#-security-design)).
- **Verify** where your keys and data go: keys are stored encrypted on your machine, the bot talks only to the services listed under "Network exposure", and a key you generate or import in Telegram passes through your Telegram chat (see "Authorities & key flow").
- **Run it yourself** — no SaaS, no subscription, no telemetry. Just `npm install`, your own Telegram bot token and your own Helius and Jupiter API keys.
- **Modify it** for your own strategy.

The MIT license lets you fork, modify, or redistribute. The only thing we ask is that you read the [security section](#-security-design) before you import a wallet.

---

## ✨ Features

### Wallet management
- Up to **3 wallets per user**. Create new, import an existing private key, rename, or set as default.
- Private keys stored **AES-256-GCM encrypted** on disk in `data/wallets.json`. The key is derived with scrypt from `WALLET_ENC_KEY`, or from `TG_BOT_TOKEN` when that is unset.
- **🎲 Generate New** sends the new private key to your Telegram chat once, as a message the bot does not delete; to import, you paste
  the key into the chat and the bot deletes that message before it reads the key. There is no passcode and no key export.

### Trade execution
- **Three-tier smart router** ([src/execution/router.ts](src/execution/router.ts)):
  1. PumpFun direct (pre-graduation tokens — bonding curve)
  2. PumpSwap direct (post-graduation pools)
  3. Jupiter aggregator (final catch-all for any Solana token)

  Tier 1 is on (`PF_DIRECT_ENABLED` in `src/execution/pumpfun-swap.ts`): the bot builds pump.fun's own buy or sell for a pre-graduation token itself, verifies and simulates it, and only then signs it; PumpPortal is not used. Tier 2 is switched off (`PUMPSWAP_DIRECT_ENABLED`, since A-93g): it refuses before it reads or builds anything. A graduated token, any other token and any trade the direct route refuses go through Jupiter in the same call.
- A pump.fun direct trade is checked against what was asked for and simulated before it is signed ([src/execution/tx-verify.ts](src/execution/tx-verify.ts)). A Jupiter trade is checked for price impact and fee and simulated before it is signed; its swap instructions are Jupiter's own, and the `/swap/v1/swap` fallback is signed as Jupiter built it.
- **Helius Sender** when you turn Anti-MEV on (off by default; each send tips 0.0002 SOL to one of ten Helius tip accounts). With Anti-MEV off, the signed transaction goes to Helius RPC, Alchemy (when set) and four public RPCs at once.
- **Dynamic priority fees** via Helius `getPriorityFeeEstimate` on the pump.fun direct route (`PRIORITY_FEE_LEVEL_SNIPE`, default `VeryHigh`); Jupiter trades use Jupiter's fee (Anti-MEV on) or your priority-fee setting.
- **Fills are read from the chain** — the bot reports what a buy or sell really delivered, not what the quote promised.

### Position monitor
- A live card per token that refreshes every 5 seconds: the worth of your bag with the source of the price and its age, market cap and liquidity from the Engine (each with its age), live PnL.
- A figure the bot does not know is shown as "—", never as 0.
- Per-position **TP / SL / TSL** orders that you set yourself from the card.
- Inline buttons on every position card: sell 25 % / 50 % / 100 %, slippage, tip, anti-MEV, limits.
- The positions live in `data/positions-v2.json`; one exit engine manages them all.
- A cleanup sweep every 10 minutes verifies the on-chain token balance and prunes phantom positions.

### Helius Backrun Rebates
- Toggle on, set your wallet, and 50 % of any MEV captured from your trades pays to **your wallet** in the same block as the swap.
- There is **no default wallet**: rebates do nothing until you set a wallet of your own, with `/rebates` in Telegram (set the wallet,
  then turn it on) or with `HELIUS_MARKETING_WALLET` in `.env` (`ENABLE_BACKRUN_REBATES` is `1` by default).
- `/rebates` saves its setting in `settings.json` in the bot data folder (`BOT_DATA_DIR`, default `./data`), the same file the send
  path reads. Once that file has a rebates section, only `/rebates` counts and the two `.env` values are ignored; any setting you
  save in Telegram writes that section (OFF unless you turned rebates on there).
- Helius keeps the other 50 %.
- Zero added latency — the auction runs in parallel to the normal RPC path.
- See [Helius docs](https://www.helius.dev/docs/sending-transactions/backrun-rebates).

### Token report (`/check <CA>`, `/report <CA>`)
- The report is built from the Engine's snapshot of the token: name, market cap, liquidity, venue.
- Every value shows how old it is. A value the Engine does not know is "—".
- The bot itself calls no risk-report site, no price site and no market-data API.

### Signals and auto-buy
The PumpStriker Engine decides what is a signal. It sends each signal to the bot over a private, authenticated link; the bot
shows the card in Telegram and, only when you have armed it, can buy. The bot scores nothing and filters nothing by score.
- **Card filter** — the signal-settings menu holds the lowest grade that is sent to your chat as a card (`A`, `B` or `C`; default `B`).
- **Auto-buy is OFF by default.** Turn it on from Telegram with `/autobuy`: `dryrun <ARM>` first (nothing is ever sent), and `on <ARM>` only
  after the Engine reports a PASS for that arm and you type the confirmation it asks for. `off` stops it at once.
- **`BOT_DRY_RUN=1` by default** — auto-buy builds and signs, then stops; nothing is sent. Your own buys and sells are not affected.
- **One auto-buy per token, ever.** A second signal for a token the bot already signalled is shown but never bought again.
- **Caps** — at most 3 buys per hour, 20 per day, 5 open positions, SOL per day = 20 × the buy amount, a SOL reserve of 0.03 for exit fees,
  and a price-impact cap of 15 % per buy. The env may lower a limit; a higher value is logged as a deviation.
- **Circuit breakers** — repeated failed sends or a long run of buys without a sell pause auto-buy until you send `/autobuy resume`.
- **Stale price guard** — a signal whose entry price is older than 5 seconds is skipped.
- **Duplicate guard** — never opens a second position in a mint you already hold.

### Auto-buy trading-session window (start / stop time)
Restrict **auto-buy** to the market hours you actually trade — while your signal cards keep
arriving around the clock. From the signal settings → **⏰ Auto-Buy Session** pick a session preset —
**🇺🇸 USA** (08:00–17:00 New York), **🇪🇺 Europe** (08:00–17:00 London) or **🌏 Asia**
(09:00–18:00 Tokyo) — or set a custom start time, stop time and IANA timezone
(e.g. `Europe/Paris`). Notes:
- **📡 Signal cards are never gated** — you still receive every card (at or above your grade filter) 24/7 and can always buy
  manually from its buttons; the window only decides whether *auto-buy* spends money.
- **OFF by default** — out of the box the bot behaves exactly as before (24/7).
- **Overnight windows wrap midnight** — a `22:00 → 06:00` window is valid.
- **🚨 Exits ignore the window** — selling and safety exits always run.
- **Fail-open** — a malformed time or timezone never silently blocks trading.

### Exits and safety breakers
- **One exit engine** manages every open position, bought by auto-buy or by hand. Signal positions follow the exit policy
  (`EXIT_POLICY_ID`, default `EA`); manual positions follow your own SL / TP / TSL orders and a −25 % floor.
- **Failure policy** — a take-profit sell retries at escalating slippage; a protective sell never waits for a breaker, gets the
  guaranteed-exit slippage and, if it still fails, locks the position out and tells you in Telegram.
- **Landed-check before every retry** — a sell is never sent twice while the first one may still land.
- **Hard-rug detector** — a drop of `HARD_RUG_DROP_PCT` (default 40 %) in the quoted value between two consecutive checks fires an
  immediate max-slippage "RUG-DUMP" sell, even while the position is still green. `HARD_RUG_DROP_PCT=0` turns off only that trigger.
- **Auto-buy circuit breaker** and **per-mint failed-tx breaker** — back off a mint that keeps reverting.

### Telegram UX
- Inline keyboards for every action — no command memorization required.
- Settings stored per user in `data/settings.json` (schema 2; an older file is migrated once, with a backup).
- **💰 Get Your UnclaimedSol** — rent-recovery check powered by
  [UnclaimedSol](https://unclaimedsol.com). Tap the main-menu button → the bot scans your
  default wallet **on-chain** (read-only) for old token accounts — empty ones plus
  dust-holding ones — and shows the real claimable SOL, using the same rent arithmetic the
  UnclaimedSol dashboard uses. A **💸 Claim on UnclaimedSol** button opens their hosted
  claim flow, where you connect the wallet and claim; the bot never builds or signs any
  transaction for this feature — see
  [`src/execution/unclaimedsol.ts`](src/execution/unclaimedsol.ts). The claim button carries the
  project's own partner key by default (`UCS_PARTNER_KEY=pump-striker`): UnclaimedSol pays the PumpStriker project 20 % of
  UnclaimedSol's own fee on claims made through it. Set `UCS_PARTNER_KEY` to your own key to change that; an empty value keeps the project's key.
  The rent-recovery analysis of a *connected browser wallet* is a different
  feature: the Engine runs it, and the bot makes no UnclaimedSol API call for it (see
  [Wallet link routes](#wallet-link-routes-the-browser-wallet-of-the-engine-dashboard)).

---

## 🚀 Quick start

### 1. Prerequisites

- **Node.js 20.18.1+** (LTS recommended; the oldest version the locked dependencies accept)
- **npm** (ships with Node)
- A **funded Solana wallet** (the bot is non-custodial — you import the key into the bot's encrypted local store)
- A **Telegram account**

### 2. Create your bot on @BotFather

1. Open Telegram, search for `@BotFather`, start a chat.
2. Send `/newbot`.
3. Choose a name (shown in chats) and a username (must end in `bot`, e.g. `MyTraderBot`).
4. BotFather replies with a token like `123456789:AAH-…`. **Copy it.**
5. **Restrict the bot to you only** — send `/setjoingroups` → choose your bot → `Disable`.

### 3. Get your Telegram user_id

- Open Telegram, search for `@userinfobot`, start a chat.
- It replies with your numeric `id` (positive number). Copy it.

### 4. Get a free Helius key and a Jupiter API key

- Sign up at [helius.dev](https://helius.dev) → Dashboard → New API key.
- Copy the key.
- Create a Jupiter Developer Platform **server key** with the Swap permission (where: see `JUPITER_API_KEY` in `.env.example`).
  Without it every trade that goes through Jupiter is refused with "JUPITER_API_KEY missing".

### 5. Install + configure

```bash
git clone https://github.com/pumpstrikerdev/pumpstriker-bot.git
cd pumpstriker-bot
npm install

cp .env.example .env
# Edit .env — fill in TG_BOT_TOKEN, TG_CHAT_ID, HELIUS_KEY and JUPITER_API_KEY
# With the PumpStriker Engine, also SIGNAL_SHARED_SECRET. Everything else is optional.
```

### 6. Run the bot

```bash
npm run bot
```

On Windows you can also double-click `start-tg-bot.bat` (it checks for `node_modules` and `.env`
first). When you also run the PumpStriker Engine, start the **Engine first**, then the bot:
both read the same `SIGNAL_SHARED_SECRET`, and after changing it you restart the Engine before the bot.

You should see:

```
[hh:mm:ss] ✓ [pos-cleanup] scheduled — every 10 minutes
[hh:mm:ss] ✓ [sender-keepalive] started → https://sender.helius-rpc.com/ping every 45000ms
[hh:mm:ss] ✓ Bot events endpoint: http://127.0.0.1:3748/v1/events
[hh:mm:ss] ✓ TG commands set ✓
[hh:mm:ss] ✓ 🦅 Pumpstriker Bots running
```

The boot log also names the contract version, the exit policy, whether the bot is in dry-run and the auto-buy state. It never prints a secret.

Now open your bot in Telegram and send `/menu`. You're live.

### 7. Import a wallet

From the main menu → **👛 Wallets** → **🎲 Generate New** (generates a fresh keypair and sends its private key to the chat once, in a
message the bot does not delete: back the key up, then delete that message) or **➕ Import Wallet** (paste a base58 private key; the
bot deletes your message before it reads the key).

Fund the wallet from your existing one.

---

## 📋 Telegram commands

| Command | Description |
|---|---|
| `/start` | Same as `/menu`; `/start <CA>` opens the token card with buy and sell buttons (the dashboard deep link) |
| `/menu` | 🎯 Main inline-keyboard menu |
| `/wallet` | 👛 Show your default wallet + its balance |
| `/positions` | 📊 Open positions with live PnL |
| `/orders` | 🕔 Active limit orders (TP / SL / TSL) |
| `/buy <CA> [SOL_amount]` | 🟢 Buy a token. Defaults to your signal buy amount. |
| `/sell <CA> [%]` | 🔴 Sell a token. Defaults to 100 %. |
| `/import` | 🔐 Import a wallet private key (base58); the key message is deleted first |
| `/rebates` | 🦑 Configure Helius Backrun Rebates |
| `/importsettings` | ♻️ Bring back the settings an update dropped, from an old-format file in the bot data folder (a backup of `settings.json` comes first) |
| `/check <CA>` | 🛡 Token report from the Engine's snapshot |
| `/autobuy [status\|dryrun <ARM>\|on <ARM>\|off\|resume]` | 🤖 The auto-buy gate (off by default) |

### GMGN skill commands (need the PumpStriker Engine)

These commands call the Engine's `/api/skills/*` routes at `ENGINE_URL` (default
`http://127.0.0.1:1002`) with the link secret; the bot itself holds no GMGN key. Signal cards also get a
🔬 button row for the same skills. Like every other command they are owner-only and private-chat-only.
After an upgrade, restart the bot once so Telegram registers the new command menu.

| Command | Description |
|---|---|
| `/report <CA>` | Token report with the age of every value |
| `/dd <CA>` | Due-diligence score |
| `/pattern <CA> [15m]` | Chart pattern |
| `/holders <CA>` | Holder analysis |
| `/dev <CA>` | Dev score |
| `/devinfo <CA>` | Dev info (launches, best mcap, still holding) |
| `/hot` | GMGN hot list |
| `/wallet <addr>` | Wallet dossier (`/wallet` alone still shows your default wallet) |
| `/review <wallet> [1d\|7d\|30d\|all]` | Wallet review |
| `/balance <wallet> <CA>` | Wallet token balance |
| `/surge` | Screened price-surge signals |
| `/migrated` | Migrated token quality screen |
| `/calls` | GMGN call-outs: who is calling which token |
| `/caller <wallet>` | GMGN caller record (the call-outs one wallet made in the last 30 days, as numbers) |
| `/feeds` | Signal journal: GMGN feeds next to our signals (today and yesterday, UTC) |
| `/watchlist` | GMGN watchlist tokens |
| `/swings` | Watchlist price swings |
| `/search <query>` | Token / wallet search |

`/narrative`, `/news`, `/radar`, `/tracked`, `/pftrending` and `/vetting` were removed: they have no handler and no menu entry, and nothing reaches the Engine for them.

---

## 🔐 Security design

### Wallet encryption

Every private key is encrypted before being written to disk
([`src/bot/wallet-crypto.ts`](src/bot/wallet-crypto.ts)):

```
key        = scrypt(WALLET_ENC_KEY || TG_BOT_TOKEN, fresh 16-byte salt per wallet, N=2^15, r=8, p=1)
ciphertext = aes-256-gcm(key, fresh 12-byte iv, private_key)
```

`WALLET_ENC_KEY` is optional. When it is unset the key comes from your bot token. Wallets in the
older format (sha256-derived key) are still readable — both `WALLET_ENC_KEY` and `TG_BOT_TOKEN` are
tried — and are upgraded at startup, after a `data/wallets.json.bak-<time>` backup. The encrypted
payload lives in `data/wallets.json`. Without the secret, the file is useless. With it, anything that
can read the file can also decrypt it — so:

- **Never commit `data/wallets.json`** (it's in [`.gitignore`](.gitignore) already).
- **Never share your `TG_BOT_TOKEN` or `WALLET_ENC_KEY`** — the token controls the bot, and whichever secret is in use decrypts your saved keys.
- **Rotating the bot token (UNSAFE older advice removed: never set `WALLET_ENC_KEY` to the old token):** follow this sequence. While `TG_BOT_TOKEN` is still the old token, set `WALLET_ENC_KEY` to a NEW random secret of at least 32 characters, start the bot once and check the log shows `[wallets] upgraded N wallet(s)` and no "could not be decrypted" warning, back up your private keys offline and move the `wallets.json.bak-*` files offline (they stay encrypted under the old token), and only then rotate `TG_BOT_TOKEN`.

### Owner-only, private-chat-only

The bot answers only `TG_CHAT_ID`, only in its private chat, and only new messages and button
presses ([`src/bot/access-control.ts`](src/bot/access-control.ts)). Groups, edited messages, channel
posts and inline queries are ignored, so a group id in `TG_CHAT_ID` no longer works. Make sure your
bot is **not in any group** (`/setjoingroups → Disable` in BotFather).

### Secrets in chat and logs

- Private keys and seed phrases pasted anywhere are deleted on sight; `/import` deletes the key
  message first ([`src/bot/secret-guard.ts`](src/bot/secret-guard.ts)).
- Logs and chat error texts are redacted ([`src/lib/redact.ts`](src/lib/redact.ts)).
- Token and wallet names lose the Markdown characters `` * _ ` [ ] ``; an alert Telegram cannot
  parse is resent as plain text ([`src/bot/md-safe.ts`](src/bot/md-safe.ts)).

### Trading guards

[`src/bot/trade-guards.ts`](src/bot/trade-guards.ts) validates every buy/sell path: slippage
0.1–50 %, priority fee 0–5,000,000, retries 1–5, keyboards of at most 8 buttons, addresses and
amounts checked (`/sell CA 1OO` is refused instead of selling 100 %), one buy at a time per wallet and
token, and forged buttons are dropped. The auto-buy limits (`AUTO_BUY_MAX_PER_HOUR`, `AUTO_BUY_MAX_PER_DAY`,
`AUTO_BUY_MAX_SOL_PER_DAY`, `AUTO_BUY_MAX_OPEN_POSITIONS`, `AUTO_BUY_RESERVE_SOL`) have code defaults; the env can
lower them. Auto-buy itself stays off until you arm it with `/autobuy`.

### Engine link authentication

The Engine pushes its events to `POST http://127.0.0.1:${BOT_PORT}/v1/events` with
`Authorization: Bearer <SIGNAL_SHARED_SECRET>` ([`src/link/events-server.ts`](src/link/events-server.ts)). The secret must be
at least 32 characters and the same value in the Engine's `.env`. While it is missing or short, the link refuses everything and the
bot warns at startup (log and Telegram). Requests are also refused for: a browser `Origin` or `Sec-Fetch-*` header (403), a
non-loopback `Host` (403), a non-JSON body (415), a body over 32 KB (413), bad JSON (400) or a failed field validation (400).
The bot answers `202` before it does any trading or Telegram work, and drops an event it has already seen. The six wallet link routes
(below) sit behind exactly the same checks; every other path answers 404.

### Known limitations

These points are still open in the code:

- **🎲 Generate New** shows the new private key in a Telegram message, and the bot does not delete that message.
- `WALLET_ENC_KEY` is optional: without it, the key that encrypts your wallets is derived from `TG_BOT_TOKEN`.
- The bot sets no Windows access rights (ACLs) on its data folder; the file mode 0600 it gives `wallets.json` only counts on Linux and macOS.
- `/buy` and `/sell` act at once, with no confirmation step, and `/buy` has no maximum amount.
- The **Confirm Buy** and **Confirm Sell** switches in the Buy and Sell settings are not used yet: turning them on adds no confirmation.
- **📤 Send SOL** sends at once, with no confirmation step and no maximum amount.
- Forwarded messages are accepted, also in the address and private-key prompts.

### Network exposure

- The bot's HTTP endpoint (`/v1/events` and the six `/v1/wallet` routes) binds to `127.0.0.1` (loopback) only — it is **not reachable from your LAN or the public internet**.
- Outbound, the bot talks to these services only:
  - **Telegram Bot API** (`api.telegram.org`): everything in your chat with the bot, including a private key you paste in or that **🎲 Generate New** sends you.
  - **Helius**: the RPC `mainnet.helius-rpc.com` (your `HELIUS_KEY` is in the URL) for chain reads, priority-fee estimates and signed
    transactions; the Sender `sender.helius-rpc.com/fast` (`HELIUS_SENDER_URL`) for signed transactions, each with a 0.0002 SOL tip to
    a Helius tip account, plus a `/ping` keep-alive every 45 s (`ENABLE_SENDER_KEEPALIVE`, `SENDER_KEEPALIVE_MS`). With a rebate wallet
    of your own set, the Helius sends carry its address (`rebate-address`).
  - **Alchemy** (`solana-mainnet.g.alchemy.com`), only when `ALCHEMY_API_KEY` is set: chain reads and signed transactions.
  - **Four public Solana RPCs**, built in as fallbacks: `api.mainnet-beta.solana.com`, `solana-mainnet.core.chainstack.com`,
    `solana.publicnode.com` and `rpc.ankr.com/solana`. They get chain reads when the lanes above fail or are not set, and the
    multi-RPC send (used whenever a transaction does not go through the Sender) gives them your signed transactions too.
  - **Jupiter** (`api.jup.ag`, `JUP_API_BASE`): quotes and swap builds, with your `JUPITER_API_KEY` and your wallet address as the taker; with `JUP_ORDER_FALLBACK` or `USE_JUPITER_V3` on (both off by default), also your signed transaction (`/swap/v2/execute`).
  - **pump.fun** (`frontend-api-v3.pump.fun`, `PUMPFUN_API_BASE`): a token address only, as a fallback when the chain read does not tell
    whether a token is still on its bonding curve. PumpPortal (`PUMPPORTAL_BASE`) is configured but no code path calls it.
  - **The PumpStriker Engine** at `ENGINE_URL` (default `http://127.0.0.1:1002`, your own machine): the bot's reports (cards sent,
    buys, opened and closed positions, exit legs, contract violations; free text redacted first), a heartbeat every 15 s (the default wallet's id, address and SOL balance, the bot username, the
    RPC provider label and health, the auto-buy state and caps used, the open-position count, the card grade filter and the exit-policy
    versions), the token, price and arm reads, and the skill commands. Never a key.
  - **UnclaimedSol** (`unclaimedsol.com`), only when you tap 💰 Get Your UnclaimedSol: an attribution ping carrying your default
    wallet's public address and the partner key (`src/execution/unclaimedsol.ts`). The wallet link routes make no UnclaimedSol call:
    the Engine runs the analysis of a connected wallet.
- Links the bot shows you (GMGN, Jupiter, Solscan, the UnclaimedSol claim page) are opened by your Telegram app; the bot does not fetch them.
- No price site, no risk-report site, no analytics, no usage telemetry.

### Authorities & key flow

- The bot never asks for your seed phrase. Only individual private keys.
- The bot signs transactions locally; only the signed transaction is sent, to Helius Sender or the RPC lanes above (or to Jupiter's `/swap/v2/execute` when one of its two opt-in switches is on).
- A private key passes through Telegram in two cases: **🎲 Generate New** sends the new key from your machine to your chat as a
  message (it stays on Telegram's servers until you delete it), and to import a key you paste it into the chat, where the bot
  deletes the message before it reads the key. Apart from that no key leaves your machine; the PumpStriker Engine never receives one.
- The Helius RPC URL embeds your `HELIUS_KEY` as a query parameter (this is Helius's design — there is no alternative auth on their RPC). Don't share screen recordings that leak the URL.

---

## 📁 Project layout

```
pumpstriker-bot/
├── src/
│   ├── app.ts                    ⭐ The wiring: events server, intake, auto-buy, exit engine, outbox, send queue
│   ├── bot/                      Telegram bot — main entry
│   │   ├── bot.ts                ⭐ Main process: wallets · commands · menus · manual buy/sell · settings
│   │   ├── skill-commands.ts     The GMGN skill commands (call the Engine's /api/skills/*)
│   │   ├── access-control.ts     Owner-only / private-chat-only gate
│   │   ├── secret-guard.ts       Deletes pasted private keys / seed phrases
│   │   ├── wallet-crypto.ts      scrypt + AES-256-GCM wallet storage
│   │   ├── trade-guards.ts       Input validation, buy lock, auto-buy caps and limits
│   │   ├── settings-migrate.ts   settings.json → schema 2 (idempotent, backup first)
│   │   ├── md-safe.ts            Markdown-safe names
│   │   ├── session-window.ts     Trading-session start/stop window (unit-tested)
│   │   ├── position-card.ts
│   │   ├── position-cleanup.ts   10-min sweep, prunes phantom positions
│   │   └── position-monitor.ts   5-s live position card
│   ├── link/                     Engine ↔ bot link: events server, inbox, outbox, Engine client
│   ├── wallet-link/              The six wallet link routes (unsigned builds for the Engine's browser wallet): routes.ts, handler.ts
│   ├── intake/                   One handler per Engine event (signal, cancel, alert, arms, ops)
│   ├── autobuy/                  The auto-buy decision, guards, state and /autobuy commands
│   ├── exits/                    The one exit engine, positions store, manual orders, failure policy
│   ├── tg/                       Card builders and the paced Telegram send queue
│   ├── data/
│   │   └── rebate-settings.ts    Reads the /rebates setting from settings.json in the bot data folder
│   ├── execution/
│   │   ├── router.ts             ⭐ 3-tier smart router
│   │   ├── jupiter.ts            Jupiter quote / swap + Sender + multi-RPC
│   │   ├── pumpfun-swap.ts       Pre-grad direct bonding-curve swap (on: PF_DIRECT_ENABLED)
│   │   ├── pumpswap-swap.ts      Post-grad direct AMM swap (off: PUMPSWAP_DIRECT_ENABLED)
│   │   ├── tx-verify.ts          Checks a built transaction before it is signed
│   │   ├── fills.ts              Reads what a buy or sell really delivered
│   │   ├── close-account.ts      Closes an empty token account and returns the rent
│   │   ├── onchain-quote.ts      Quotes from the curve or pool on chain
│   │   ├── unclaimedsol.ts       Read-only rent-recovery scan + UnclaimedSol partner link (unit-tested)
│   │   └── blockhash-cache.ts    Pre-warmed blockhash cache
│   ├── lib/
│   │   ├── redact.ts             Secret redaction for logs and chat errors
│   │   └── http-client.ts        undici HTTP/2 keepalive fetch wrapper
│   ├── shared/                   Link contract, card renderer and exit policy shared with the Engine (synced copies, never edited here)
│   ├── shared-tests/             Tests of the shared code
│   ├── guards/                   Static guards over the source tree (run with the tests)
│   ├── config.ts                 Env-var loader (incl. the WALLET_* keys of the wallet link routes)
│   └── logger.ts                 Structured console logger
├── scripts/
│   ├── migrate-positions-v2.ts   Old positions and limit orders → the exit engine (dry run by default)
│   ├── cutover-bot-data.ts       Archives the old bot's data files (move, never delete; never wallets.json)
│   └── import-old-settings.ts    One-shot re-import of old settings, the script twin of /importsettings
├── test-fixtures/                Recorded chain data and fixtures of the tests
├── data/                         Runtime state (wallets, settings, positions) — never committed
├── logs/                         Empty placeholder (the bot logs to the console only) — never committed
├── .env.example
├── start-tg-bot.bat              Windows launcher
├── package.json
├── tsconfig.json
├── vitest.config.ts
├── LICENSE
├── SECURITY.md
└── README.md
```

The bot is a compact, auditable TypeScript codebase — **no scoring, no scanners
that hunt tokens for you.** It executes; the Engine (or you) decides what to trade.

---

## ⚙️ Configuration reference

All variables live in `.env`. The bot reads them on startup. See [`.env.example`](.env.example) for the full list with inline comments.

### Required

| Variable | Purpose |
|---|---|
| `TG_BOT_TOKEN` | From `@BotFather` |
| `TG_CHAT_ID` | Your numeric Telegram user_id |
| `HELIUS_KEY` | Free from [helius.dev](https://helius.dev) |
| `JUPITER_API_KEY` | Jupiter Developer Platform server key (Swap permission). Without it every trade that goes through Jupiter is refused ("JUPITER_API_KEY missing"): every token that is not on a pump.fun bonding curve, and every trade the direct route refuses. |

Needed only together with the PumpStriker Engine:

| Variable | Purpose |
|---|---|
| `SIGNAL_SHARED_SECRET` | The Engine ↔ bot link secret; ≥ 32 chars, the same value in the Engine's `.env`. Unset or shorter = the link refuses everything; manual trading is not affected. |

### Common toggles

| Variable | Default | Purpose |
|---|---|---|
| `BOT_DRY_RUN` | `1` | `1` = auto-buy builds and signs but sends nothing. Your own buys and sells are not affected. |
| `BOT_PORT` | `3748` | Local port of the events endpoint (`127.0.0.1` only) |
| `ENGINE_URL` | `http://127.0.0.1:1002` | The Engine's HTTP API (token reads, skill commands) |
| `BOT_DATA_DIR` | `./data` | Folder of `wallets.json`, `settings.json`, `positions-v2.json`, … |
| `ENABLE_BACKRUN_REBATES` | `1` | On, but rebates do nothing until you set a wallet of your own (`HELIUS_MARKETING_WALLET` or `/rebates`) |
| `HELIUS_MARKETING_WALLET` | *(empty)* | Your own wallet for the backrun rebates. There is no default wallet. |
| `ENABLE_DYNAMIC_PRIORITY_FEE` | `1` | Set `0` for fixed 50 k µLamports |
| `PRIORITY_FEE_LEVEL_NORMAL` | `High` | `Medium / High / VeryHigh` |
| `PRIORITY_FEE_LEVEL_SNIPE` | `VeryHigh` | Used on pre-grad PumpFun snipes |
| `USE_JUPITER_V3` | `0` | Jupiter v3 atomic order+execute (gated tier) |
| `JUP_ORDER_FALLBACK` | `off` | `off` / `sell` / `both`: after Jupiter `/swap/v2/build` finds no route, try ONE `/swap/v2/order` + `/execute` (OKX, Dflow or Metis; refused unless the wallet is the only signer and fee payer, the fee is bounded and the simulation moves only what was asked). Costs Jupiter's platform fee (0.5% on tokens under 24 h). |

### Wallet encryption and auto-buy safety

| Variable | Default | Purpose |
|---|---|---|
| `WALLET_ENC_KEY` | *(unset → `TG_BOT_TOKEN`)* | Wallet encryption secret. Never set it to the old token (unsafe); follow the rotation sequence under "Wallet encryption" before rotating `TG_BOT_TOKEN`. |
| `AUTO_BUY_MAX_PER_HOUR` / `_PER_DAY` / `_SOL_PER_DAY` | `3` / `20` / 20 × buy amount | Auto-buy caps. The env may lower them; a higher value is logged as a deviation. |
| `AUTO_BUY_MAX_OPEN_POSITIONS` | `5` | Most open positions auto-buy may hold. |
| `AUTO_BUY_RESERVE_SOL` | `0.03` | SOL kept back for exit fees; auto-buy skips below `buyAmount` + reserve. |
| `AUTOBUY_STALE_MS` | `5000` | A signal whose entry price is older than this at the buy is skipped. |
| `AUTOBUY_MAX_IMPACT_PCT` | `15` | A route whose own price impact is higher is refused. |
| `AUTOBUY_PAUSE_AFTER_FAILS` | `3` | Failed sends in a row that pause auto-buy. |
| `HARD_RUG_DROP_PCT` | `40` | % drop between two checks that triggers a max-slippage rug dump. `0` = off. |
| `UCS_PARTNER_KEY` | `pump-striker` | UnclaimedSol partner key (public attribution key). The default is the PumpStriker project's own; set your own to change it. |

### Wallet link routes

| Variable | Default | Purpose |
|---|---|---|
| `WALLET_LINK_ROUTES` | `1` | `0` = the six `/v1/wallet` routes are not mounted (they answer 404). |
| `WALLET_RPC_DAILY_CALL_CAP` | `3000` | Wallet RPC calls per UTC day, all wallet traffic together. Over it, the bot answers `rpc-budget`. |
| `WALLET_RPC_MAX_PER_SEC` | `4` (1-10) | Calls per second for all wallet traffic together. It delays wallet calls only, never auto-buy or the exits. |
| `WALLET_FILL_POLL_MS` | `2000` (≥ 1500) | How often a fill read polls the transaction. |
| `WALLET_TX_MAX_BYTES` | `1100` (≤ 1132) | Largest serialized wallet transaction; a larger one is refused (`tx-too-large`). |
| `WALLET_PRIORITY_MIN_MICROLAMPORTS` / `_MAX_` | `10000` / `1000000` (max ≤ 1000000) | The compute-unit price range of a wallet transaction; the bot sets the limit and the price and the dialog shows the fee before the wallet opens. |

A value outside its range is ignored and the default is used. There is no SOL maximum, slippage or price-impact key in the bot: those are typed per trade in the dashboard.

Leave `ALCHEMY_API_KEY` unset unless that endpoint works: when it is set, the blockhash cache uses Alchemy first, with no
runtime failover, and Alchemy becomes the first failover lane of the pooled RPC reads (after Helius).

---

## 📡 The Engine link

The Engine sends the bot a small set of events (a new signal, a cancel, an exit alert, the auto-buy arm status, an ops alert) to
`POST http://127.0.0.1:${BOT_PORT}/v1/events` (default port `3748`), and the bot reports back what it did with each one: card sent or
filtered, buy skipped / dry-run / submitted / confirmed, every exit leg, every closed position. Both directions use the same
`SIGNAL_SHARED_SECRET`.

For each new signal the bot does, in this order:

1. Decides whether auto-buy would buy (arm, caps, stale price, session window, balance) and, when it does, sends the buy.
2. Shows the card in Telegram if the signal's grade is at or above your card filter. A card that is older than
   `TG_REPLAY_MAX_AGE_MS` (10 minutes, measured from the decision) is not sent; one older than `TG_LATE_MS` (30 s) carries a LATE banner.
   Cards are paced at `TG_PACE_MAX_PER_10MIN` per 10 minutes; alerts and ops messages are not paced.
3. If auto-buy opened a position, starts the exit engine on it.

A failure on the buy side never costs the card, and a failure on the card side never touches a buy.

Without the Engine the bot is still 100 % usable for manual trading.

### Wallet link routes (the browser wallet of the Engine dashboard)

The Engine's dashboard can connect a browser wallet and trade from it. The bot's part is small and one-way: it builds an **unsigned**
transaction for the connected wallet (that wallet is the only signer and the fee payer), verifies it, simulates it, and reads the chain.
The bot **never signs and never sends** anything for these flows, holds no key of that wallet, and sends no Telegram message for them:
nothing moves without the wallet's own approval. The bot's own wallets, its keys and the auto-buy rules and defaults are untouched.

Six synchronous routes ([`src/wallet-link/`](src/wallet-link/)) sit beside `/v1/events`, behind the same link authentication as above
(bearer `SIGNAL_SHARED_SECRET`, loopback `Host` on the bot port, no browser markers, JSON, 32 KB):

| Route | Answers within | What it does |
|---|---|---|
| `POST /v1/wallet/quote` | 12 s | Builds the unsigned buy or sell, checks it and simulates it; answers the bytes with everything the confirmation step shows (bound, fees, simulated change, balance). |
| `POST /v1/wallet/fill` | 60 s | Reads the transaction the wallet signed and answers what the chain says happened (confirmed, failed, unverified, not landed). |
| `POST /v1/wallet/find` | 12 s | Looks for up to three transactions of the wallet that match a trade whose outcome the wallet reported as unknown. |
| `POST /v1/wallet/balances` | 8 s | Reads the wallet's SOL and token balances as exact strings. |
| `POST /v1/wallet/close-quote` | 10 s | Builds the unsigned close of empty token accounts, or of the wrapped-SOL account. |
| `POST /v1/wallet/close-fill` | 60 s | Reads a close the wallet signed. |

How a request is handled:

- A body that is not exactly what the link contract allows is a `400`; the reason names the field and never echoes the input.
- **The limits are the owner's, per trade.** The SOL amount is typed in every dialog (the bot has no fixed maximum; an optional cap
  `WALLET_TRADE_MAX_SOL` lives in the Engine). Slippage defaults to 30 % for buys and sells and is set per trade; a route whose own
  price impact is above the trade's limit (default 15 %, set per trade) is refused. The bot re-checks all of it on what it built: the
  slippage in the bytes, the price impact, the optional spend cap, the amount, and that the most the transaction can take is in the wallet.
- A refusal (`impact-above-limit`, `insufficient-sol`, `amount-above-cap`, `price-moved`, `build-timeout`, `rpc-budget`, ...) carries a
  reason and **no transaction bytes**. A build that takes longer than its budget is answered `build-timeout` and nothing else.
- Wallet reads use the wallet RPC lane (`HELIUS_KEY_WALLET`, else `HELIUS_KEY`) behind a daily call cap and a global per-second bucket
  (`WALLET_RPC_DAILY_CALL_CAP`, `WALLET_RPC_MAX_PER_SEC`), so wallet work cannot delay auto-buy or the exits. The routes never touch the
  positions, auto-buy, the exit engine, the send queue or Telegram.
- Graduated tokens are built through Jupiter while the direct PumpSwap route is off; there is no PumpPortal route for the wallet.
- The bot makes no UnclaimedSol API call here: the Engine runs the rent-recovery analysis of a connected wallet. The bot's
  `src/execution/unclaimedsol.ts` (the partner link of the Telegram button) is unchanged.
- `WALLET_LINK_ROUTES=0` leaves the routes out: they answer 404 like any unknown path. The boot log says "wallet link routes on" or "off",
  never an address or a key.

### Upgrading from the previous bot

The old bot kept its positions in `data/positions.json` and its limit orders in `data/orders.json`. Two scripts move them over; both are
dry runs unless you pass `--execute`, and neither touches `wallets.json` or any `.env*` file:

```bash
npm run migrate-positions-v2 -- --from <absolute data folder> --state cutover-state.json
npm run cutover-bot-data -- --data-dir <absolute data folder> --state cutover-state.json
```

The first turns each open position you chose to migrate into a position the exit engine manages, with its limit orders copied
unchanged. The second moves the old files to `_archive-<date>/` with a sha256 manifest, and refuses while an open position is neither
migrated nor acknowledged as "leave unmanaged" (unless you pass `--accept-unmigrated`). Exit codes: 0 ok (a dry run included), 1 refused
with nothing written, 2 usage or environment error.

---

## 🐛 Troubleshooting

### `npm install` fails on Windows

The bot has no required native add-on. If an optional one (`bufferutil`, `utf-8-validate`) fails to build, the install still works; installing **Visual Studio Build Tools 2022** with the "Desktop development with C++" workload removes the warning.

### Bot starts but does nothing in Telegram

- Did you `/start` the bot at least once? Telegram requires it for the first message.
- Is `TG_CHAT_ID` correct? Get it from `@userinfobot`. **It must be your numeric ID, not your username.**
- Is the bot in a group? Make sure `/setjoingroups → Disable` in BotFather, then DM the bot directly.

### No signal cards arrive

- Is the Engine running, and is `SIGNAL_SHARED_SECRET` the same, and at least 32 characters, in both `.env` files? Restart the Engine first, then the bot.
- Is your card filter (signal settings) set higher than the grades the Engine is sending?

### `Invalid HELIUS_KEY` on swap attempts

- Check your key at [helius.dev → Dashboard](https://helius.dev/dashboard).
- Free tier has a daily quota — heavy snipes can exhaust it. Set `HELIUS_KEY_BOT` to a second key for trading-only.

### `multi-rpc: tx reverted on-chain: {"InstructionError":[3,{"Custom":6025}]}`

That's PumpFun's slippage-exceeded error. The token's price moved more than your slippage tolerance between quote and execution. Either increase slippage from the Buy Settings menu or accept the miss.

---

## 🌐 Links & Community

- **Website & full 9-chapter setup guide** — [pumpstriker.fun](https://pumpstriker.fun)
- **Telegram** — [@BathyrDEV](https://t.me/BathyrDEV)
- **X (Twitter)** — [@BathyrDev](https://x.com/BathyrDev)
- **YouTube** — [@BathyrHunter](https://www.youtube.com/@BathyrHunter)
- **Reddit** — [u/bathyrdev](https://www.reddit.com/user/bathyrdev)
- **Contact** — bathyrdev@pumpstriker.fun
- **Rent recovery partner** — [UnclaimedSol](https://unclaimedsol.com)
- **Issues / feature requests** — use the GitHub Issues tab of this repo

---

## 🛡 Disclaimer

Pumpstriker Bots is provided **as is**, with no warranty, under the [MIT license](LICENSE). Trading memecoins is high-risk. You can lose every cent you put into this bot.

**You are responsible for**:
- The funds in any wallet you import.
- The security of your bot token and your `.env` file.
- Complying with the laws in your jurisdiction.

The maintainers cannot recover lost funds, leaked keys, or compromised servers. Run the bot on a machine you control. Read the code before you trust it.

---

## 🤝 Contributing

Issues and PRs welcome. Before opening a PR:

1. Run `npm run typecheck` and `npm test` — both must pass. `npm test` refuses to run in a folder that holds `.env` or
   `data/wallets.json`, on purpose: run it in a clean clone.
2. Don't commit anything from `data/` (encrypted wallets) or `.env`.
3. Keep the bot **standalone** — no scoring code, no market-data scrapers.

If you're proposing a new feature that touches the wallet or trade-execution path, please open an issue first to discuss the security implications.

---

**MIT licensed · No warranties · Your keys, your bot, your responsibility.**
