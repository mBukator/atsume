/**
 * Errors are values inside `src/core`. Nothing here throws; only adapters
 * (route handlers, CLI entry points) convert a failed Result into an exception.
 */

export interface Ok<T> {
  readonly ok: true;
  readonly value: T;
}

export interface Err<E> {
  readonly ok: false;
  readonly error: E;
}

export type Result<T, E> = Ok<T> | Err<E>;

export const ok = <T>(value: T): Ok<T> => ({ ok: true, value });
export const err = <E>(error: E): Err<E> => ({ ok: false, error });

/** A Result that carries no payload on success. */
export const unit: Ok<null> = { ok: true, value: null };

export const isOk = <T, E>(result: Result<T, E>): result is Ok<T> => result.ok;
export const isErr = <T, E>(result: Result<T, E>): result is Err<E> => !result.ok;

export const map = <T, U, E>(result: Result<T, E>, f: (value: T) => U): Result<U, E> =>
  result.ok ? ok(f(result.value)) : result;

export const mapErr = <T, E, F>(result: Result<T, E>, f: (error: E) => F): Result<T, F> =>
  result.ok ? result : err(f(result.error));

export const andThen = <T, U, E>(
  result: Result<T, E>,
  f: (value: T) => Result<U, E>,
): Result<U, E> => (result.ok ? f(result.value) : result);

export const unwrapOr = <T, E>(result: Result<T, E>, fallback: T): T =>
  result.ok ? result.value : fallback;

/** Short-circuits on the first error. */
export const collect = <T, E>(results: readonly Result<T, E>[]): Result<T[], E> => {
  const values: T[] = [];
  for (const result of results) {
    if (!result.ok) return result;
    values.push(result.value);
  }
  return ok(values);
};

/**
 * Keeps both sides. Discovery uses this: one broken page should not sink the
 * whole crawl, but the failure still has to be reported.
 */
export const partition = <T, E>(
  results: readonly Result<T, E>[],
): { readonly values: T[]; readonly errors: E[] } => {
  const values: T[] = [];
  const errors: E[] = [];
  for (const result of results) {
    if (result.ok) values.push(result.value);
    else errors.push(result.error);
  }
  return { values, errors };
};

/** Adapter boundary: this is the only sanctioned way to leave Result-land. */
export const unwrapOrThrow = <T, E>(result: Result<T, E>, toError: (error: E) => Error): T => {
  if (result.ok) return result.value;
  throw toError(result.error);
};
