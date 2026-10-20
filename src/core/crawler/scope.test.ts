import { beforeEach, describe, expect, it } from 'vitest';
import { crawlOptionsSchema } from '../config';
import { type Db, openDatabase } from '../db/open';
import { JobRepository } from '../db/repository';
import { jobConfigSchema } from '../config';
import type { JobId } from '../ids';
import { Frontier } from './frontier';
import { HostRateLimiter } from './rate-limiter';
import { decideScope, extractLinks, readMetaRobots } from './scope';
import { ManualClock } from '../testing';

const T0 = 1_700_000_000_000;
const SEED = 'https://a.test/start';
const options = crawlOptionsSchema.parse({ maxDepth: 2 });

describe('decideScope', () => {
  it('admits same-host URLs within the depth limit', () => {
    expect(decideScope('https://a.test/page', 1, SEED, options).kind).toBe('in-scope');
  });

  it('rejects anything past the depth limit', () => {
    expect(decideScope('https://a.test/page', 3, SEED, options)).toEqual({
      kind: 'too-deep',
      depth: 3,
    });
  });

  it('rejects other hosts by default, including subdomains', () => {
    expect(decideScope('https://cdn.a.test/page', 1, SEED, options).kind).toBe('off-origin');
    expect(decideScope('https://b.test/page', 1, SEED, options).kind).toBe('off-origin');
  });

  it('admits an allowlisted host once same-origin is off', () => {
    const relaxed = crawlOptionsSchema.parse({
      sameOriginOnly: false,
      additionalHosts: ['cdn.a.test'],
    });
    expect(decideScope('https://cdn.a.test/img', 1, SEED, relaxed).kind).toBe('in-scope');
    expect(decideScope('https://other.test/img', 1, SEED, relaxed).kind).toBe('off-origin');
  });

  it('ignores the allowlist while same-origin is on', () => {
    const strict = crawlOptionsSchema.parse({ additionalHosts: ['cdn.a.test'] });
    expect(decideScope('https://cdn.a.test/img', 1, SEED, strict).kind).toBe('off-origin');
  });
});

describe('extractLinks', () => {
  it('resolves relative hrefs against the page URL and dedupes', () => {
    const html = `<a href="/one">1</a><a href="two">2</a><a href="/one#frag">again</a>`;
    expect(extractLinks(html, 'https://a.test/dir/index.html').sort()).toEqual([
      'https://a.test/dir/two',
      'https://a.test/one',
    ]);
  });

  it('honours <base href>', () => {
    const html = `<head><base href="https://cdn.a.test/assets/"></head><body><a href="x.html">x</a></body>`;
    expect(extractLinks(html, 'https://a.test/page')).toEqual(['https://cdn.a.test/assets/x.html']);
  });

  it('skips non-navigable schemes and bare fragments', () => {
    const html = `
      <a href="mailto:x@a.test">m</a>
      <a href="javascript:void(0)">j</a>
      <a href="tel:+420123">t</a>
      <a href="data:text/html,x">d</a>
      <a href="#top">f</a>
      <a href="">empty</a>
      <a href="/real">r</a>`;
    expect(extractLinks(html, 'https://a.test/')).toEqual(['https://a.test/real']);
  });

  it('picks up area hrefs from image maps', () => {
    const html = `<map><area href="/mapped"></map>`;
    expect(extractLinks(html, 'https://a.test/')).toEqual(['https://a.test/mapped']);
  });

  it('returns nothing for markup with no links', () => {
    expect(extractLinks('<p>text</p>', 'https://a.test/')).toEqual([]);
  });
});

describe('readMetaRobots', () => {
  it('reads noindex and nofollow', () => {
    expect(readMetaRobots('<meta name="robots" content="noindex, nofollow">')).toEqual({
      noindex: true,
      nofollow: true,
    });
  });

  it('treats none as both', () => {
    expect(readMetaRobots('<meta name="googlebot" content="NONE">')).toEqual({
      noindex: true,
      nofollow: true,
    });
  });

  it('defaults to permissive', () => {
    expect(readMetaRobots('<p>nothing here</p>')).toEqual({ noindex: false, nofollow: false });
  });
});

describe('HostRateLimiter', () => {
  it('spaces successive requests to one host', async () => {
    const clock = new ManualClock(T0);
    const limiter = new HostRateLimiter(clock, 250);

    await limiter.acquire('a.test', null);
    expect(clock.now()).toBe(T0);
    await limiter.acquire('a.test', null);
    expect(clock.now()).toBe(T0 + 250);
    await limiter.acquire('a.test', null);
    expect(clock.now()).toBe(T0 + 500);
  });

  it('does not make one host wait on another', async () => {
    const clock = new ManualClock(T0);
    const limiter = new HostRateLimiter(clock, 250);

    await limiter.acquire('a.test', null);
    await limiter.acquire('b.test', null);
    expect(clock.now()).toBe(T0);
  });

  it('lets robots Crawl-delay raise the floor but never lower it', () => {
    const limiter = new HostRateLimiter(new ManualClock(T0), 250);
    expect(limiter.delayFor(2_000)).toBe(2_000);
    expect(limiter.delayFor(10)).toBe(250);
    expect(limiter.delayFor(null)).toBe(250);
  });

  it('pushes a penalised host out to the given time', async () => {
    const clock = new ManualClock(T0);
    const limiter = new HostRateLimiter(clock, 0);

    limiter.penalise('a.test', T0 + 5_000);
    await limiter.acquire('a.test', null);
    expect(clock.now()).toBe(T0 + 5_000);
  });
});

describe('Frontier', () => {
  let db: Db;
  let jobId: JobId;
  let frontier: Frontier;

  beforeEach(() => {
    db = openDatabase(':memory:');
    const repo = new JobRepository(db);
    const config = jobConfigSchema.parse({ seedUrl: SEED, output: { directory: '/tmp/out' } });
    jobId = repo.createJob(config, T0).id;
    frontier = new Frontier(db, jobId);
  });

  it('enqueues once per normalized URL', () => {
    expect(frontier.enqueue('https://a.test/p?b=2&a=1', 0, null, T0)).toBe('queued');
    expect(frontier.enqueue('https://a.test/p?a=1&b=2#x', 0, null, T0)).toBe('duplicate');
    expect(frontier.queueDepth()).toBe(1);
  });

  it('rejects URLs it cannot normalize', () => {
    expect(frontier.enqueue('javascript:void(0)', 0, null, T0)).toBe('invalid');
  });

  it('claims shallowest first', () => {
    frontier.enqueue('https://a.test/deep', 2, null, T0);
    frontier.enqueue('https://a.test/shallow', 0, null, T0 + 1);

    expect(frontier.claim()?.url).toBe('https://a.test/shallow');
    expect(frontier.claim()?.url).toBe('https://a.test/deep');
    expect(frontier.claim()).toBeNull();
  });

  it('does not hand the same entry to two callers', () => {
    frontier.enqueue('https://a.test/one', 0, null, T0);
    const first = frontier.claim();
    const second = frontier.claim();

    expect(first).not.toBeNull();
    expect(second).toBeNull();
  });

  it('tallies outcomes by state', () => {
    frontier.enqueue('https://a.test/a', 0, null, T0);
    frontier.enqueue('https://a.test/b', 0, null, T0);
    frontier.enqueue('https://a.test/c', 0, null, T0);
    frontier.enqueue('https://a.test/d', 0, null, T0);

    const a = frontier.claim();
    const b = frontier.claim();
    const c = frontier.claim();
    if (a === null || b === null || c === null) throw new Error('setup failed');

    frontier.markFetched(a.id, { httpStatus: 200, contentType: 'text/html', renderMode: 'static' }, T0);
    frontier.markFailed(b.id, 'HTTP 500', 500, T0);
    frontier.markSkipped(c.id, 'skipped-robots', 'disallowed by /', T0);

    expect(frontier.counts()).toEqual({
      queued: 1,
      fetching: 0,
      visited: 1,
      failed: 1,
      skipped: 1,
    });
  });

  it('returns pages abandoned mid-fetch to the queue', () => {
    frontier.enqueue('https://a.test/a', 0, null, T0);
    frontier.claim();
    expect(frontier.queueDepth()).toBe(0);

    // A fresh process finding rows a dead one left behind.
    expect(new Frontier(db, jobId).requeueStale()).toBe(1);
    expect(frontier.queueDepth()).toBe(1);
  });

  it('keeps frontiers of different jobs separate', () => {
    const repo = new JobRepository(db);
    const other = repo.createJob(
      jobConfigSchema.parse({ seedUrl: SEED, output: { directory: '/tmp/out' } }),
      T0,
    );
    frontier.enqueue('https://a.test/a', 0, null, T0);

    expect(new Frontier(db, other.id).queueDepth()).toBe(0);
    expect(frontier.queueDepth()).toBe(1);
  });
});
