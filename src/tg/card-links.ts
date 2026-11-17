// A-115 (CARD-MENU spec section 2.6): the link line of a signal card, built by the bot ONLY (nothing link-shaped for these hosts lives in
// shared/**: the Engine guard G-S2 and the dashboard bundle check ban them there). Fixed templates; the CA must pass the base58 check or no
// link is built. Display links only: nothing here is ever fetched.
//
// DEX (the old card's first link) is NOT built: the bot guard G-S13 bans that host's name on every line of src/**. Decision D1 of the spec
// (a numbered guard amendment with one display-link exception for this file) is the orchestrator's / owner's; until it is approved the
// card prints GMGN · JUP. The host is never obfuscated to dodge the guard.

const BASE58_RE = /^[1-9A-HJ-NP-Za-km-z]{32,44}$/;

export interface CardLink { label: string; url: string }

/** GMGN and JUP links of a token, or [] for a CA that is not base58. */
export function cardLinks(ca: string): CardLink[] {
  if (typeof ca !== 'string' || !BASE58_RE.test(ca)) return [];
  return [
    { label: 'GMGN', url: `https://gmgn.ai/sol/token/${ca}` },
    { label: 'JUP', url: `https://jup.ag/swap/SOL-${ca}` },
  ];
}
