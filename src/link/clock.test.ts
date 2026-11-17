// R1-B1: the injected clock of the link modules.
import { describe, expect, it } from 'vitest';
import { FakeClock, systemClock } from './clock';

describe('clock', () => {
  it('runs due timers in (time, creation) order, lets a timer arm another inside the window, and honours clearTimeout', async () => {
    const clock = new FakeClock(1_000);
    const log: string[] = [];
    clock.setTimeout(() => { log.push('b@50'); }, 50);
    clock.setTimeout(() => { log.push('a@10'); clock.setTimeout(() => { log.push('c@10+20'); }, 20); }, 10);
    const cancelled = clock.setTimeout(() => { log.push('never'); }, 30);
    clock.clearTimeout(cancelled);
    clock.setTimeout(() => { log.push('same@50'); }, 50);
    await clock.advance(49);
    expect(log).toEqual(['a@10', 'c@10+20']);
    expect(clock.now()).toBe(1_049);
    await clock.advance(1);
    expect(log).toEqual(['a@10', 'c@10+20', 'b@50', 'same@50']);
    expect(clock.pendingTimers()).toBe(0);
  });

  it('sleeps until advanced, rejects a bad advance and a bad start, and the system clock tells real time', async () => {
    const clock = new FakeClock(0);
    let woke = false;
    void clock.sleep(100).then(() => { woke = true; });
    await clock.advance(99);
    expect(woke).toBe(false);
    await clock.advance(1);
    expect(woke).toBe(true);
    await expect(clock.advance(-1)).rejects.toThrow(RangeError);
    expect(() => new FakeClock(Number.NaN)).toThrow(RangeError);
    const before = new Date().getTime();
    expect(systemClock.now()).toBeGreaterThanOrEqual(before);
    let fired = false;
    const h = systemClock.setTimeout(() => { fired = true; }, 1);
    await systemClock.sleep(20);
    expect(fired).toBe(true);
    systemClock.clearTimeout(h);
  });
});
