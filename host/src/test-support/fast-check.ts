/**
 * Self-contained, zero-dependency Property-Based Testing (PBT) engine
 * compatible with the fast-check API surface (fc.assert, fc.property, arbitraries).
 */

export interface RandomGenerator {
  nextInt(min: number, max: number): number;
  nextFloat(): number;
  nextBoolean(): boolean;
  fork(): RandomGenerator;
}

/** Simple, deterministic xorshift128+ PRNG */
export class XorShift128Plus implements RandomGenerator {
  private s0: number;
  private s1: number;

  constructor(seed = Date.now()) {
    let s = (seed ^ 0xdeadbeef) >>> 0;
    this.s0 = s || 1;
    this.s1 = ((s * 1812433253 + 1) ^ 0x1337cafe) >>> 0 || 2;
  }

  private nextU32(): number {
    let x = this.s0;
    const y = this.s1;
    this.s0 = y;
    x ^= (x << 23) >>> 0;
    this.s1 = (x ^ y ^ (x >>> 17) ^ (y >>> 26)) >>> 0;
    return (this.s1 + y) >>> 0;
  }

  nextInt(min: number, max: number): number {
    if (min > max) [min, max] = [max, min];
    const range = max - min + 1;
    if (range <= 0 || range > 0xffffffff) {
      return Math.floor(this.nextFloat() * (max - min + 1)) + min;
    }
    return (this.nextU32() % range) + min;
  }

  nextFloat(): number {
    return this.nextU32() / 0x100000000;
  }

  nextBoolean(): boolean {
    return (this.nextU32() & 1) === 1;
  }

  fork(): RandomGenerator {
    const forked = new XorShift128Plus(this.nextU32());
    return forked;
  }
}

export interface Value<T> {
  readonly value: T;
  readonly context?: unknown;
}

export interface Arbitrary<T> {
  generate(rng: RandomGenerator, size?: number): Value<T>;
  shrink?(value: T, context?: unknown): Iterable<Value<T>>;
  map<U>(fn: (v: T) => U): Arbitrary<U>;
  filter(predicate: (v: T) => boolean): Arbitrary<T>;
  chain<U>(fn: (v: T) => Arbitrary<U>): Arbitrary<U>;
}

export abstract class BaseArbitrary<T> implements Arbitrary<T> {
  abstract generate(rng: RandomGenerator, size?: number): Value<T>;

  shrink?(value: T, context?: unknown): Iterable<Value<T>>;

  map<U>(fn: (v: T) => U): Arbitrary<U> {
    return new MappedArbitrary(this, fn);
  }

  filter(predicate: (v: T) => boolean): Arbitrary<T> {
    return new FilteredArbitrary(this, predicate);
  }

  chain<U>(fn: (v: T) => Arbitrary<U>): Arbitrary<U> {
    return new ChainedArbitrary(this, fn);
  }
}

class MappedArbitrary<T, U> extends BaseArbitrary<U> {
  constructor(
    private readonly source: Arbitrary<T>,
    private readonly fn: (v: T) => U,
  ) {
    super();
  }

  generate(rng: RandomGenerator, size?: number): Value<U> {
    const src = this.source.generate(rng, size);
    return { value: this.fn(src.value), context: src.context };
  }

  *shrink(value: U, context?: unknown): Iterable<Value<U>> {
    if (this.source.shrink) {
      for (const sh of this.source.shrink(undefined as unknown as T, context)) {
        yield { value: this.fn(sh.value), context: sh.context };
      }
    }
  }
}

class FilteredArbitrary<T> extends BaseArbitrary<T> {
  constructor(
    private readonly source: Arbitrary<T>,
    private readonly predicate: (v: T) => boolean,
  ) {
    super();
  }

  generate(rng: RandomGenerator, size?: number): Value<T> {
    for (let attempts = 0; attempts < 100; attempts++) {
      const val = this.source.generate(rng, size);
      if (this.predicate(val.value)) return val;
    }
    throw new Error("Unable to satisfy filter predicate after 100 attempts");
  }

  *shrink(value: T, context?: unknown): Iterable<Value<T>> {
    if (this.source.shrink) {
      for (const sh of this.source.shrink(value, context)) {
        if (this.predicate(sh.value)) yield sh;
      }
    }
  }
}

class ChainedArbitrary<T, U> extends BaseArbitrary<U> {
  constructor(
    private readonly source: Arbitrary<T>,
    private readonly fn: (v: T) => Arbitrary<U>,
  ) {
    super();
  }

  generate(rng: RandomGenerator, size?: number): Value<U> {
    const src = this.source.generate(rng, size);
    const innerArb = this.fn(src.value);
    return innerArb.generate(rng, size);
  }
}

class IntegerArbitrary extends BaseArbitrary<number> {
  constructor(
    private readonly min = -0x7fffffff,
    private readonly max = 0x7fffffff,
  ) {
    super();
  }

  generate(rng: RandomGenerator): Value<number> {
    return { value: rng.nextInt(this.min, this.max) };
  }

  *shrink(value: number): Iterable<Value<number>> {
    const target = this.min <= 0 && this.max >= 0 ? 0 : this.min;
    if (value === target) return;
    const diff = target - value;
    const step = Math.trunc(diff / 2);
    if (step !== 0) {
      yield { value: value + step };
    }
    yield { value: target };
  }
}

class BooleanArbitrary extends BaseArbitrary<boolean> {
  generate(rng: RandomGenerator): Value<boolean> {
    return { value: rng.nextBoolean() };
  }

  *shrink(value: boolean): Iterable<Value<boolean>> {
    if (value === true) yield { value: false };
  }
}

class ConstantArbitrary<T> extends BaseArbitrary<T> {
  constructor(private readonly val: T) {
    super();
  }
  generate(): Value<T> {
    return { value: this.val };
  }
}

class ConstantFromArbitrary<T> extends BaseArbitrary<T> {
  constructor(private readonly values: readonly T[]) {
    super();
    if (values.length === 0) throw new Error("constantFrom requires at least one value");
  }

  generate(rng: RandomGenerator): Value<T> {
    const idx = rng.nextInt(0, this.values.length - 1);
    return { value: this.values[idx]!, context: idx };
  }

  *shrink(value: T, context?: unknown): Iterable<Value<T>> {
    const idx = typeof context === "number" ? context : this.values.indexOf(value);
    if (idx > 0) {
      yield { value: this.values[0]!, context: 0 };
    }
  }
}

class StringArbitrary extends BaseArbitrary<string> {
  constructor(
    private readonly minLength = 0,
    private readonly maxLength = 30,
    private readonly charGen?: (rng: RandomGenerator) => string,
  ) {
    super();
  }

  generate(rng: RandomGenerator): Value<string> {
    const len = rng.nextInt(this.minLength, this.maxLength);
    let s = "";
    for (let i = 0; i < len; i++) {
      if (this.charGen) {
        s += this.charGen(rng);
      } else {
        const code = rng.nextInt(32, 126);
        s += String.fromCharCode(code);
      }
    }
    return { value: s };
  }

  *shrink(value: string): Iterable<Value<string>> {
    if (value.length > this.minLength) {
      const half = Math.max(this.minLength, Math.floor(value.length / 2));
      yield { value: value.slice(0, half) };
      if (this.minLength === 0) yield { value: "" };
    }
  }
}

class ArrayArbitrary<T> extends BaseArbitrary<T[]> {
  constructor(
    private readonly elementArb: Arbitrary<T>,
    private readonly minLength = 0,
    private readonly maxLength = 10,
  ) {
    super();
  }

  generate(rng: RandomGenerator, size?: number): Value<T[]> {
    const len = rng.nextInt(this.minLength, this.maxLength);
    const arr: T[] = [];
    for (let i = 0; i < len; i++) {
      arr.push(this.elementArb.generate(rng, size).value);
    }
    return { value: arr };
  }

  *shrink(value: T[]): Iterable<Value<T[]>> {
    if (value.length > this.minLength) {
      const half = Math.max(this.minLength, Math.floor(value.length / 2));
      yield { value: value.slice(0, half) };
      if (this.minLength === 0) yield { value: [] };
    }
    for (let i = 0; i < value.length; i++) {
      if (this.elementArb.shrink) {
        for (const sh of this.elementArb.shrink(value[i]!)) {
          const next = [...value];
          next[i] = sh.value;
          yield { value: next };
        }
      }
    }
  }
}

class RecordArbitrary<T extends Record<string, unknown>> extends BaseArbitrary<T> {
  constructor(private readonly shapes: { [K in keyof T]: Arbitrary<T[K]> }) {
    super();
  }

  generate(rng: RandomGenerator, size?: number): Value<T> {
    const result = {} as T;
    for (const key of Object.keys(this.shapes) as (keyof T)[]) {
      result[key] = this.shapes[key]!.generate(rng, size).value;
    }
    return { value: result };
  }

  *shrink(value: T): Iterable<Value<T>> {
    for (const key of Object.keys(this.shapes) as (keyof T)[]) {
      const arb = this.shapes[key]!;
      if (arb.shrink) {
        for (const sh of arb.shrink(value[key])) {
          const next = { ...value, [key]: sh.value };
          yield { value: next };
        }
      }
    }
  }
}

class OneOfArbitrary<T> extends BaseArbitrary<T> {
  private readonly arbs: Arbitrary<T>[];

  constructor(...arbs: Arbitrary<T>[]) {
    super();
    if (arbs.length === 0) throw new Error("oneof requires at least one arbitrary");
    this.arbs = arbs;
  }

  generate(rng: RandomGenerator, size?: number): Value<T> {
    const idx = rng.nextInt(0, this.arbs.length - 1);
    return this.arbs[idx]!.generate(rng, size);
  }

  *shrink(value: T, context?: unknown): Iterable<Value<T>> {
    for (const arb of this.arbs) {
      if (arb.shrink) {
        try {
          yield* arb.shrink(value, context);
        } catch {
          // ignore
        }
      }
    }
  }
}

class TupleArbitrary<T extends readonly unknown[]> extends BaseArbitrary<T> {
  constructor(private readonly arbs: { [K in keyof T]: Arbitrary<T[K]> }) {
    super();
  }

  generate(rng: RandomGenerator, size?: number): Value<T> {
    const arr = (this.arbs as Arbitrary<unknown>[]).map((a) => a.generate(rng, size).value);
    return { value: arr as unknown as T };
  }

  *shrink(value: T): Iterable<Value<T>> {
    const arbs = this.arbs as Arbitrary<unknown>[];
    const valArr = value as unknown as unknown[];
    for (let i = 0; i < arbs.length; i++) {
      const arb = arbs[i];
      if (arb && typeof arb.shrink === "function") {
        for (const sh of arb.shrink(valArr[i])) {
          const copy = [...valArr];
          copy[i] = sh.value;
          yield { value: copy as unknown as T };
        }
      }
    }
  }
}

export interface AssertOptions {
  numRuns?: number;
  seed?: number;
  verbose?: boolean;
}

export interface Property<TArgs extends readonly unknown[]> {
  run(args: TArgs): boolean | void | Promise<boolean | void>;
  readonly arbitraries: { [K in keyof TArgs]: Arbitrary<TArgs[K]> };
}

export function property<TArgs extends readonly unknown[]>(
  ...argsAndPredicate: [...{ [K in keyof TArgs]: Arbitrary<TArgs[K]> }, (...args: TArgs) => boolean | void | Promise<boolean | void>]
): Property<TArgs> {
  const predicate = argsAndPredicate[argsAndPredicate.length - 1] as (...args: TArgs) => boolean | void | Promise<boolean | void>;
  const arbitraries = argsAndPredicate.slice(0, -1) as unknown as { [K in keyof TArgs]: Arbitrary<TArgs[K]> };
  return {
    run: (args: TArgs) => predicate(...args),
    arbitraries,
  };
}

export async function assertAsync<TArgs extends readonly unknown[]>(
  prop: Property<TArgs>,
  options: AssertOptions = {},
): Promise<void> {
  const numRuns = options.numRuns ?? 100;
  const seed = options.seed ?? Date.now();
  const rng = new XorShift128Plus(seed);

  for (let run = 0; run < numRuns; run++) {
    const tupleValues = prop.arbitraries.map((arb) => arb.generate(rng, run)) as unknown as Value<unknown>[];
    const rawArgs = tupleValues.map((v) => v.value) as unknown as TArgs;

    try {
      const result = await prop.run(rawArgs);
      if (result === false) {
        throw new Error(`Property returned false on run ${run + 1}/${numRuns}`);
      }
    } catch (err) {
      // Shrinking phase
      let bestArgs = rawArgs;
      let shrinkAttempts = 0;

      for (let i = 0; i < prop.arbitraries.length && shrinkAttempts < 20; i++) {
        const arb = prop.arbitraries[i]!;
        if (!arb.shrink) continue;
        for (const sh of arb.shrink(bestArgs[i])) {
          shrinkAttempts++;
          const candidateArgs = [...bestArgs] as unknown as TArgs;
          (candidateArgs as unknown as unknown[])[i] = sh.value;
          try {
            const shRes = await prop.run(candidateArgs);
            if (shRes === false) {
              bestArgs = candidateArgs;
              break;
            }
          } catch {
            bestArgs = candidateArgs;
            break;
          }
        }
      }

      const counterexample = JSON.stringify(bestArgs, null, 2);
      const message = `Property failed after ${run + 1} tests (seed: ${seed})\nCounterexample: ${counterexample}\nCaused by: ${err instanceof Error ? err.stack ?? err.message : String(err)}`;
      const error = new Error(message);
      (error as unknown as { seed: number; counterexample: unknown }).seed = seed;
      (error as unknown as { seed: number; counterexample: unknown }).counterexample = bestArgs;
      throw error;
    }
  }
}

export function assertSync<TArgs extends readonly unknown[]>(
  prop: Property<TArgs>,
  options: AssertOptions = {},
): void {
  const numRuns = options.numRuns ?? 100;
  const seed = options.seed ?? Date.now();
  const rng = new XorShift128Plus(seed);

  for (let run = 0; run < numRuns; run++) {
    const tupleValues = prop.arbitraries.map((arb) => arb.generate(rng, run)) as unknown as Value<unknown>[];
    const rawArgs = tupleValues.map((v) => v.value) as unknown as TArgs;

    try {
      const result = prop.run(rawArgs);
      if (result === false) {
        throw new Error(`Property returned false on run ${run + 1}/${numRuns}`);
      }
      if (result instanceof Promise) {
        throw new Error("Use assertAsync for asynchronous properties");
      }
    } catch (err) {
      let bestArgs = rawArgs;
      let shrinkAttempts = 0;

      for (let i = 0; i < prop.arbitraries.length && shrinkAttempts < 20; i++) {
        const arb = prop.arbitraries[i]!;
        if (!arb.shrink) continue;
        for (const sh of arb.shrink(bestArgs[i])) {
          shrinkAttempts++;
          const candidateArgs = [...bestArgs] as unknown as TArgs;
          (candidateArgs as unknown as unknown[])[i] = sh.value;
          try {
            const shRes = prop.run(candidateArgs);
            if (shRes === false) {
              bestArgs = candidateArgs;
              break;
            }
          } catch {
            bestArgs = candidateArgs;
            break;
          }
        }
      }

      const counterexample = JSON.stringify(bestArgs, null, 2);
      const message = `Property failed after ${run + 1} tests (seed: ${seed})\nCounterexample: ${counterexample}\nCaused by: ${err instanceof Error ? err.stack ?? err.message : String(err)}`;
      const error = new Error(message);
      (error as unknown as { seed: number; counterexample: unknown }).seed = seed;
      (error as unknown as { seed: number; counterexample: unknown }).counterexample = bestArgs;
      throw error;
    }
  }
}

export const fc = {
  assert: (prop: Property<any>, options?: AssertOptions) => {
    return assertSync(prop, options);
  },
  assertAsync,
  property,
  integer: (constraints?: { min?: number; max?: number }): Arbitrary<number> =>
    new IntegerArbitrary(constraints?.min ?? -1000, constraints?.max ?? 1000),
  nat: (max?: number): Arbitrary<number> => new IntegerArbitrary(0, max ?? 1000),
  boolean: (): Arbitrary<boolean> => new BooleanArbitrary(),
  constant: <T>(val: T): Arbitrary<T> => new ConstantArbitrary(val),
  constantFrom: <T>(...values: readonly T[]): Arbitrary<T> => new ConstantFromArbitrary(values),
  string: (constraints?: { minLength?: number; maxLength?: number }): Arbitrary<string> =>
    new StringArbitrary(constraints?.minLength ?? 0, constraints?.maxLength ?? 30),
  asciiString: (constraints?: { minLength?: number; maxLength?: number }): Arbitrary<string> =>
    new StringArbitrary(constraints?.minLength ?? 0, constraints?.maxLength ?? 30, (rng) =>
      String.fromCharCode(rng.nextInt(32, 126)),
    ),
  fullUnicodeString: (constraints?: { minLength?: number; maxLength?: number }): Arbitrary<string> =>
    new StringArbitrary(constraints?.minLength ?? 0, constraints?.maxLength ?? 30, (rng) => {
      const kind = rng.nextInt(0, 4);
      if (kind === 0) return String.fromCharCode(rng.nextInt(32, 126)); // ASCII
      if (kind === 1) return String.fromCharCode(rng.nextInt(0x4e00, 0x9fff)); // CJK
      if (kind === 2) return String.fromCharCode(rng.nextInt(0x0400, 0x04ff)); // Cyrillic
      if (kind === 3) return ["\n", "\r\n", "\t", "  "][rng.nextInt(0, 3)]!; // whitespace
      return "✨🎮🌾";
    }),
  multilineString: (constraints?: { minLength?: number; maxLength?: number }): Arbitrary<string> =>
    new StringArbitrary(constraints?.minLength ?? 1, constraints?.maxLength ?? 50, (rng) => {
      const pool = "abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789 \t\n\r\n.,!?-_";
      return pool[rng.nextInt(0, pool.length - 1)]!;
    }),
  array: <T>(arb: Arbitrary<T>, constraints?: { minLength?: number; maxLength?: number }): Arbitrary<T[]> =>
    new ArrayArbitrary(arb, constraints?.minLength ?? 0, constraints?.maxLength ?? 10),
  record: <T extends Record<string, unknown>>(shape: { [K in keyof T]: Arbitrary<T[K]> }): Arbitrary<T> =>
    new RecordArbitrary(shape),
  tuple: <T extends readonly unknown[]>(...arbs: { [K in keyof T]: Arbitrary<T[K]> }): Arbitrary<T> =>
    new TupleArbitrary(arbs),
  oneof: <T>(...arbs: Arbitrary<T>[]): Arbitrary<T> => new OneOfArbitrary(...arbs),
  option: <T>(arb: Arbitrary<T>, options?: { nil?: null | undefined }): Arbitrary<T | null | undefined> => {
    const nilVal = options?.nil === undefined ? undefined : options.nil;
    return new OneOfArbitrary(arb, new ConstantArbitrary(nilVal as any));
  },
  dictionary: <T>(keyArb: Arbitrary<string>, valArb: Arbitrary<T>): Arbitrary<Record<string, T>> => {
    return new ArrayArbitrary(new TupleArbitrary([keyArb, valArb] as const), 0, 10).map((pairs) => {
      const rec: Record<string, T> = {};
      for (const [k, v] of pairs) {
        rec[k] = v;
      }
      return rec;
    });
  },
  jsonValue: (): Arbitrary<unknown> => {
    const primitives: Arbitrary<unknown>[] = [
      new StringArbitrary(0, 20),
      new IntegerArbitrary(-100, 100),
      new BooleanArbitrary(),
      new ConstantArbitrary(null),
    ];
    return new OneOfArbitrary(...primitives);
  },
  json: (): Arbitrary<string> => {
    return fc.jsonValue().map((v) => JSON.stringify(v));
  },
};

export default fc;
