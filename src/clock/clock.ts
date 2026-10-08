/**
 * Time and identity seams. Both are ports so tests can run deterministically
 * (AGENTS §3.4). The system implementations are the only ones in production.
 */

export interface Clock {
  now(): Date;
}

export interface IdGenerator {
  /** UUIDv7 — time-ordered, generated in the application (AGENTS §5). */
  uuidv7(): string;
}

export const systemClock: Clock = {
  now: () => new Date(),
};

export const uuidv7Generator: IdGenerator = {
  uuidv7: () => Bun.randomUUIDv7(),
};
