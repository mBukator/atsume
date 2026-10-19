/**
 * A robots.txt parser following RFC 9309, plus the two widely-honoured
 * extensions the RFC leaves out: `Crawl-delay` and `Sitemap`.
 *
 * Everything here is pure. Fetching and caching live in `robots-registry.ts`.
 */

export interface RobotsRule {
  readonly allow: boolean;
  readonly pattern: string;
}

export interface RobotsGroup {
  readonly agents: readonly string[];
  readonly rules: readonly RobotsRule[];
  readonly crawlDelayMs: number | null;
}

export interface RobotsTxt {
  readonly groups: readonly RobotsGroup[];
  readonly sitemaps: readonly string[];
}

interface MutableGroup {
  agents: string[];
  rules: RobotsRule[];
  crawlDelayMs: number | null;
}

const splitDirective = (line: string): { field: string; value: string } | null => {
  const withoutComment = line.split('#')[0] ?? '';
  const colon = withoutComment.indexOf(':');
  if (colon === -1) return null;
  const field = withoutComment.slice(0, colon).trim().toLowerCase();
  const value = withoutComment.slice(colon + 1).trim();
  return field === '' ? null : { field, value };
};

export const parseRobots = (text: string): RobotsTxt => {
  const groups: MutableGroup[] = [];
  const sitemaps: string[] = [];
  let current: MutableGroup | null = null;
  // Consecutive `User-agent` lines share one rule block; the first rule after
  // them closes the block so the next agent line starts a fresh group.
  let acceptingAgents = false;

  for (const line of text.split(/\r?\n/)) {
    const directive = splitDirective(line);
    if (directive === null) continue;
    const { field, value } = directive;

    if (field === 'sitemap') {
      if (value !== '') sitemaps.push(value);
      continue;
    }

    if (field === 'user-agent') {
      if (current === null || !acceptingAgents) {
        current = { agents: [], rules: [], crawlDelayMs: null };
        groups.push(current);
        acceptingAgents = true;
      }
      if (value !== '') current.agents.push(value.toLowerCase());
      continue;
    }

    if (current === null) continue;
    acceptingAgents = false;

    if (field === 'allow' || field === 'disallow') {
      // An empty `Disallow:` is the documented way to say "allow everything";
      // as a rule it would match every path, so it is dropped instead.
      if (value === '') continue;
      current.rules.push({ allow: field === 'allow', pattern: value });
      continue;
    }

    if (field === 'crawl-delay') {
      const seconds = Number.parseFloat(value);
      if (Number.isFinite(seconds) && seconds >= 0) {
        current.crawlDelayMs = Math.round(seconds * 1000);
      }
    }
  }

  return { groups, sitemaps };
};

/** `Atsume/0.1 (local tool)` -> `atsume`. */
export const productToken = (userAgent: string): string => {
  const head = userAgent.trim().split(/[\s/]/)[0] ?? userAgent;
  return head.toLowerCase();
};

/**
 * The most specific group wins: an exact product-token match beats a prefix
 * match, and anything beats the `*` catch-all.
 */
export const selectGroup = (robots: RobotsTxt, userAgent: string): RobotsGroup | null => {
  const token = productToken(userAgent);
  let best: RobotsGroup | null = null;
  let bestLength = -1;
  let wildcard: RobotsGroup | null = null;

  for (const group of robots.groups) {
    for (const agent of group.agents) {
      if (agent === '*') {
        wildcard ??= group;
        continue;
      }
      if (token.startsWith(agent) && agent.length > bestLength) {
        best = group;
        bestLength = agent.length;
      }
    }
  }

  return best ?? wildcard;
};

const patternToRegex = (pattern: string): RegExp => {
  const anchored = pattern.endsWith('$');
  const body = anchored ? pattern.slice(0, -1) : pattern;
  const escaped = body.replace(/[.+?^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '.*');
  return new RegExp(`^${escaped}${anchored ? '$' : ''}`);
};

const regexCache = new Map<string, RegExp>();

const compiled = (pattern: string): RegExp => {
  const cached = regexCache.get(pattern);
  if (cached !== undefined) return cached;
  const built = patternToRegex(pattern);
  regexCache.set(pattern, built);
  return built;
};

export type RobotsDecision =
  | { readonly kind: 'allowed' }
  | { readonly kind: 'disallowed'; readonly pattern: string };

/**
 * Longest matching pattern wins; a tie goes to Allow. `path` must be the
 * percent-encoded path plus query, which is what the rules are written against.
 */
export const isPathAllowed = (group: RobotsGroup | null, path: string): RobotsDecision => {
  if (group === null) return { kind: 'allowed' };

  let winner: RobotsRule | null = null;
  let winnerLength = -1;

  for (const rule of group.rules) {
    if (!compiled(rule.pattern).test(path)) continue;
    const length = rule.pattern.endsWith('$') ? rule.pattern.length - 1 : rule.pattern.length;
    if (length > winnerLength || (length === winnerLength && rule.allow)) {
      winner = rule;
      winnerLength = length;
    }
  }

  if (winner === null || winner.allow) return { kind: 'allowed' };
  return { kind: 'disallowed', pattern: winner.pattern };
};

export const pathAndQuery = (url: string): string => {
  try {
    const parsed = new URL(url);
    return `${parsed.pathname}${parsed.search}`;
  } catch {
    return '/';
  }
};
