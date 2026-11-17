/**
 * plan-apply.ts (A-115, CARD-MENU spec section 6.4 rules 5 and 6): changing the plan of OPEN positions, only on the owner's confirmed tap.
 *
 *   - "♻️ Apply to open positions" puts the CURRENT grade plan on the real open positions of that grade. A position is skipped (with the
 *     reason) while a sell of it is in flight (the shared SellMutex), a sent sell is not resolved yet (pending_sigs), it is locked out after
 *     failed sells, its exit is finishing (close_pending) or a cancel exit runs. Applying keeps the basis, the peak, the legs already done
 *     (a take-profit id already done stays done), the sold fraction and the opening time; it changes only the plan and the policy stamp.
 *   - "✋ Switch to my own orders" (a buy from a signal card only) removes the plan: the position runs the manual path (the owner's TP / SL /
 *     TSL orders, the −25% floor, R0) from its current state.
 * Editing a preset never changes an open position by itself: positions keep the snapshot they were opened with.
 */
import type { Grade } from '../shared/common/ids';
import { sellKey, type SellMutex } from './failure-policy';
import type { PositionsStoreV2, StoredPosition } from './positions-store';
import { policyAsPlan, type ActivePolicy, type ExitPlanSnapshot } from './presets';

export interface ApplyCandidate { position: StoredPosition; skip: string | null }

const isReal = (p: StoredPosition): boolean => p.closed_at === null && !p.dry_run && /^\d+$/.test(p.tokens) && BigInt(p.tokens) > 0n;
/** A position that runs a plan (a signal position, or a buy from a signal card); plain manual buys keep the owner's orders. */
export const runsPlan = (p: StoredPosition): boolean => p.origin === 'signal' || p.exit_plan !== undefined;

/** Why a plan change must wait for this position, or null. */
export function applySkipReason(p: StoredPosition, mutex: Pick<SellMutex, 'has'>): string | null {
  if (mutex.has(sellKey(p.ca, p.wallet_id))) return 'a sell is in flight';
  if (p.pending_sigs.length > 0) return 'a sent sell is not resolved yet';
  if (p.lockouts.length > 0 && p.lockout_until !== null) return 'locked out after failed sells';
  if (p.close_pending !== null) return 'its exit is finishing';
  if (p.cancel_pending) return 'a cancel exit is running';
  return null;
}

/** The real open plan positions of `grade` (the snapshot's grade, else the grade of the signal), each with its skip reason. */
export function applyCandidates(store: Pick<PositionsStoreV2, 'listOpen'>, grade: Grade, gradeOf: (p: StoredPosition) => Grade | null, mutex: Pick<SellMutex, 'has'>,
  only?: (p: StoredPosition) => boolean): ApplyCandidate[] {
  return store.listOpen().filter(isReal).filter(runsPlan)
    .filter(p => (p.exit_plan?.grade ?? gradeOf(p)) === grade)
    .filter(p => only === undefined || only(p))
    .map(p => ({ position: p, skip: applySkipReason(p, mutex) }));
}

/** The plan stamp of `snapshot` (null = the active policy: a signal position drops its snapshot, a card buy is stamped with the policy). */
function patchFor(p: StoredPosition, snapshot: ExitPlanSnapshot | null, active: ActivePolicy, grade: Grade): Partial<StoredPosition> {
  if (snapshot !== null) return { exit_plan: snapshot, policy_id: snapshot.policy.id, policy_version: snapshot.policy.version };
  if (p.origin === 'signal') return { exit_plan: undefined, policy_id: active.id, policy_version: active.version };
  const plan: ExitPlanSnapshot = { source: 'policy', grade, rev: null, policy: policyAsPlan(active) };
  return { exit_plan: plan, policy_id: plan.policy.id, policy_version: plan.policy.version };
}

/** Applies the plan to every candidate without a skip reason (re-checked at the moment of the change). */
export function applyPlan(store: Pick<PositionsStoreV2, 'get' | 'update'>, candidates: readonly ApplyCandidate[], snapshot: ExitPlanSnapshot | null,
  active: ActivePolicy, grade: Grade, mutex: Pick<SellMutex, 'has'>): { applied: string[]; skipped: Array<{ id: string; ca: string; why: string }> } {
  const applied: string[] = [];
  const skipped: Array<{ id: string; ca: string; why: string }> = [];
  for (const c of candidates) {
    const cur = store.get(c.position.position_id);
    if (cur === undefined || cur.closed_at !== null) { skipped.push({ id: c.position.position_id, ca: c.position.ca, why: 'closed meanwhile' }); continue; }
    const why = applySkipReason(cur, mutex);
    if (why !== null) { skipped.push({ id: cur.position_id, ca: cur.ca, why }); continue; }
    store.update(cur.position_id, patchFor(cur, snapshot, active, grade));
    applied.push(cur.position_id);
  }
  return { applied, skipped };
}

/** ✋ Switch to my own orders: a card-buy position leaves its plan for the manual path. Refused for a signal (auto-buy) position. */
export function switchToOwnOrders(store: Pick<PositionsStoreV2, 'get' | 'update'>, positionId: string, mutex: Pick<SellMutex, 'has'>): { ok: true } | { ok: false; why: string } {
  const p = store.get(positionId);
  if (p === undefined || p.closed_at !== null) return { ok: false, why: 'the position is closed' };
  if (p.origin !== 'manual' || p.exit_plan === undefined) return { ok: false, why: 'only a buy from a signal card can switch to your own orders' };
  const why = applySkipReason(p, mutex);
  if (why !== null) return { ok: false, why };
  store.update(positionId, { exit_plan: undefined, policy_id: 'MANUAL', policy_version: null, floor_base: null });
  return { ok: true };
}
