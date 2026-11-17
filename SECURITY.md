# Security Policy

PumpStriker handles **private keys and real funds**. Security reports are taken seriously.

## Reporting a vulnerability

Please **do not open a public issue** for security vulnerabilities. Instead, use GitHub's
[private vulnerability reporting](../../security/advisories/new) on this repository, or write to
bathyrdev@pumpstriker.fun.
You'll get a response as quickly as possible, and credit in the fix notes if you want it.

## Scope

Reports are especially welcome for:

- Wallet-encryption weaknesses (scrypt with a per-wallet salt + `AES-256-GCM`, in `src/bot/wallet-crypto.ts`)
- Any path where a private key, seed, or bot token could leave the machine (beyond the known one: a key generated or imported
  in Telegram passes through your Telegram chat, see the README)
- Transaction-building bugs that could sign something the user didn't intend
- Injection via Telegram input or the bot's local HTTP routes (`POST /v1/events` and the six `POST /v1/wallet/*` routes)

## Out of scope

- Trading losses from market conditions, slippage, or rugs — this is a high-risk trading tool
- Issues requiring an already-compromised host machine
- Third-party services the bot uses (Telegram, Helius, Alchemy, Jupiter, pump.fun, UnclaimedSol, the public Solana RPCs) — report to them directly

## Hardening checklist for operators

- Never commit or share your `.env` or anything in `data/`
- Run the bot on a machine only you control; the bot's HTTP routes bind to localhost (`127.0.0.1`) only
- Use a dedicated trading wallet — never your main holdings
- Read the Security Design section of the [README](README.md) before importing a key
