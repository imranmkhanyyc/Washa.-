export interface Clock {
  now(): Date;
}
export const systemClock: Clock = { now: () => new Date() };

/** Controllable clock for tests and simulations. */
export class FakeClock implements Clock {
  constructor(private t: number = Date.now()) {}
  now() {
    return new Date(this.t);
  }
  set(d: Date) {
    this.t = d.getTime();
  }
  advance(ms: number) {
    this.t += ms;
  }
}
