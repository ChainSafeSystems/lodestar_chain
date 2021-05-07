// // Overwrite types until this issue is fixed https://github.com/alanshaw/it-pipe/issues/4
// // Original types contain
// // ```
// // export function pipe (f1: any, ...rest: any[]): any
// // ```
// // Which act as a @ts-ignore compromising type safety

// declare module "it-pipe" {
//   type Source<T> = AsyncIterable<T>;
//   type Sink<TSource, TReturn = void> = (source: Source<TSource>) => TReturn;
//   type Duplex<TSource = unknown, TReturn = unknown> = {
//     sink: Sink<TSource, TReturn>;
//     source: Source<TSource>;
//   };

//   export function pipe<A, B>(f1: A | (() => A), f2: (source: A) => B): B;

//   export function pipe<A, B, C>(f1: A | (() => A), f2: (source: A) => B, f3: (source: B) => C): C;

//   export function pipe<A, B, C, D>(
//     f1: A | (() => A),
//     f2: (source: A) => B,
//     f3: (source: B) => C,
//     f4: (source: C) => D
//   ): D;

//   export function pipe<A, B, C, D, E>(
//     f1: A | (() => A),
//     f2: (source: A) => B,
//     f3: (source: B) => C,
//     f4: (source: C) => D,
//     f5: (source: D) => E
//   ): E;

//   export function pipe<A, B, C, D, E, F>(
//     f1: A | (() => A),
//     f2: (source: A) => B,
//     f3: (source: B) => C,
//     f4: (source: C) => D,
//     f5: (source: D) => E,
//     f6: (source: E) => F
//   ): F;

//   export function pipe<A, B, C, D, E, F, G>(
//     f1: A | (() => A),
//     f2: (source: A) => B,
//     f3: (source: B) => C,
//     f4: (source: C) => D,
//     f5: (source: D) => E,
//     f6: (source: E) => F,
//     f7: (source: F) => G
//   ): G;

//   export function pipe<A, B, C, D, E, F, G, H>(
//     f1: A | (() => A),
//     f2: (source: A) => B,
//     f3: (source: B) => C,
//     f4: (source: C) => D,
//     f5: (source: D) => E,
//     f6: (source: E) => F,
//     f7: (source: F) => G,
//     f8: (source: G) => H
//   ): H;

//   export function pipe<A, B, C, D, E, F, G, H, I>(
//     f1: A | (() => A),
//     f2: (source: A) => B,
//     f3: (source: B) => C,
//     f4: (source: C) => D,
//     f5: (source: D) => E,
//     f6: (source: E) => F,
//     f7: (source: F) => G,
//     f8: (source: G) => H,
//     f9: (source: H) => I
//   ): I;

//   // First argument is array

//   export function pipe<A, B>(f1: A[], f2: (source: AsyncIterable<A>) => B): B;

//   export function pipe<A, B, C>(f1: A[], f2: (source: AsyncIterable<A>) => B, f3: (source: B) => C): C;

//   export function pipe<A, B, C, D>(
//     f1: A[],
//     f2: (source: AsyncIterable<A>) => B,
//     f3: (source: B) => C,
//     f4: (source: C) => D
//   ): D;

//   export function pipe<A, B, C, D, E>(
//     f1: A[],
//     f2: (source: AsyncIterable<A>) => B,
//     f3: (source: B) => C,
//     f4: (source: C) => D,
//     f5: (source: D) => E
//   ): E;

//   // First argument is duplex

//   export function pipe<A, R, B>(f1: Duplex<A, R>, f2: (source: AsyncIterable<A>) => B): B;

//   export function pipe<A, R, B, C>(f1: Duplex<A, R>, f2: (source: AsyncIterable<A>) => B, f3: (source: B) => C): C;

//   export function pipe<A, R, B, C, D>(
//     f1: Duplex<A, R>,
//     f2: (source: AsyncIterable<A>) => B,
//     f3: (source: B) => C,
//     f4: (source: C) => D
//   ): D;

//   export function pipe<A, R, B, C, D, E>(
//     f1: Duplex<A, R>,
//     f2: (source: AsyncIterable<A>) => B,
//     f3: (source: B) => C,
//     f4: (source: C) => D,
//     f5: (source: D) => E
//   ): E;

//   export default pipe;
// }
