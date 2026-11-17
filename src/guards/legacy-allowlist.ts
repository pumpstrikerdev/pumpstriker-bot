export type GuardId = 'G-S1' | 'G-S13' | 'G-S17';
/** Bot files that existed only until a later package scrubbed or deleted them (C00 section 5, last paragraph; plan grind #37/#38).
 *  R3-B5 scrubbed the position, cleanup, card, md-safe, redact, http-client and sol-price modules and config.ts. R4-B6 (A-80 (4))
 *  deleted the scanners and canonical-pair, removed getDexPrice and the dexscreener telemetry source, rewrote bot.ts and deleted
 *  signal-auth.test.ts, so every entry is gone. The map is empty for good: B6-T02 runs the final bot guards with no exemption. */
export const LEGACY_EXEMPTIONS: Readonly<Record<string, readonly GuardId[]>> = {};
