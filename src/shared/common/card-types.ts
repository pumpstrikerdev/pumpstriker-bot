// FROZEN CONTRACT (R0-CONTRACTS, round 0a; C01 section 9 item #40). Changes only by a numbered plan amendment.
// Canonical source: R\shared\common\card-types.ts; byte-identical copies are written only by R\scripts\sync-shared.ps1.
// Moved here from C03 so the round-0a bot contracts never import a round-0b file.

export interface RenderOpts { lateMs: number /* 30000 */; maxChars: number /* 4096 */ }
export interface CardText { text: string; parseMode: 'HTML' }
