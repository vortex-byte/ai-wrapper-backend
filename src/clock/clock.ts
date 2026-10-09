export interface Clock {
  now(): Date;
}

export interface IdGenerator {
  uuidv7(): string;
}

export const systemClock: Clock = {
  now: () => new Date(),
};

export const uuidv7Generator: IdGenerator = {
  uuidv7: () => Bun.randomUUIDv7(),
};
