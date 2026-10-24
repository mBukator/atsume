import { NextResponse } from 'next/server';
import { jobIdSchema, type JobId } from '@/core/ids';
import type { ServiceError } from '@/core/orchestrator/job-service';
import type { Result } from '@/core/result';

/**
 * The adapter boundary. Core modules return `Result`; this is the one place
 * that turns a failure into a status code, and the only place that throws.
 */

const STATUS: Readonly<Record<ServiceError['kind'], number>> = {
  'not-found': 404,
  'invalid-input': 400,
  // The request was well-formed but the job is in the wrong phase for it.
  'invalid-state': 409,
  repository: 500,
};

export const errorResponse = (error: ServiceError): NextResponse =>
  NextResponse.json(
    { error: { kind: error.kind, detail: detailOf(error) } },
    { status: STATUS[error.kind] },
  );

const detailOf = (error: ServiceError): string => {
  switch (error.kind) {
    case 'not-found':
      return `no job with id ${error.jobId}`;
    case 'invalid-input':
    case 'invalid-state':
    case 'repository':
      return error.detail;
  }
};

export const respond = <T>(
  result: Result<T, ServiceError>,
  transform: (value: T) => unknown = (value) => value,
  status = 200,
): NextResponse =>
  result.ok
    ? NextResponse.json(transform(result.value), { status })
    : errorResponse(result.error);

export const parseJobId = (raw: string): Result<JobId, ServiceError> => {
  const parsed = jobIdSchema.safeParse(raw);
  return parsed.success
    ? { ok: true, value: parsed.data }
    : { ok: false, error: { kind: 'not-found', jobId: raw } };
};

/** A malformed body is a 400, never an unhandled rejection. */
export const readJson = async (request: Request): Promise<Result<unknown, ServiceError>> => {
  try {
    const text = await request.text();
    if (text.trim() === '') return { ok: true, value: {} };
    return { ok: true, value: JSON.parse(text) as unknown };
  } catch {
    return { ok: false, error: { kind: 'invalid-input', detail: 'request body is not valid JSON' } };
  }
};

export interface RouteContext {
  readonly params: Promise<{ readonly jobId: string }>;
}

/** Next 15 hands route params in as a promise. */
export const jobIdFrom = async (context: RouteContext): Promise<Result<JobId, ServiceError>> => {
  const { jobId } = await context.params;
  return parseJobId(jobId);
};
