import * as cheerio from 'cheerio';
import type { RendererOptions } from '../config';
import type { ComputedBackground, NetworkRecord } from '../extract/context';
import type { Result } from '../result';

export interface RenderedPage {
  readonly url: string;
  readonly html: string;
  readonly networkLog: readonly NetworkRecord[];
  readonly computedBackgrounds: readonly ComputedBackground[];
}

export type RenderError =
  | { readonly kind: 'launch-failed'; readonly message: string }
  | { readonly kind: 'navigation-failed'; readonly url: string; readonly message: string }
  | { readonly kind: 'timeout'; readonly afterMs: number }
  | { readonly kind: 'closed' };

export interface RenderOptions {
  readonly userAgent: string;
  readonly timeoutMs: number;
  readonly networkIdleMs: number;
  readonly signal?: AbortSignal;
}

/**
 * A port. The crawler holds one of these; whether it is Chromium or a stub is
 * not the crawler's business, and the extractors never see it at all.
 */
export interface Renderer {
  render(url: string, options: RenderOptions): Promise<Result<RenderedPage, RenderError>>;
  close(): Promise<void>;
}

export type EscalationReason = 'forced' | 'empty-body' | 'no-images' | 'script-heavy' | 'spa-shell';

export type EscalationDecision =
  | { readonly escalate: false }
  | { readonly escalate: true; readonly reason: EscalationReason };

const SPA_SHELL_IDS = ['root', '__next', 'app', '__nuxt', 'svelte', 'gatsby'] as const;

/**
 * Decides whether the static parse is worth trusting. Pure and cheap: it runs
 * on every page, and launching Chromium costs about four orders of magnitude
 * more than being wrong occasionally.
 */
export const shouldEscalate = (html: string, options: RendererOptions): EscalationDecision => {
  if (options.mode === 'static-only') return { escalate: false };
  if (options.mode === 'always-render') return { escalate: true, reason: 'forced' };

  const $ = cheerio.load(html);
  const bodyText = $('body').text().replace(/\s+/g, ' ').trim();
  const imageCount = $('img, picture source, video').length;

  // A shell with a single empty mount point is a client-rendered app, whatever
  // else the markup happens to contain.
  for (const id of SPA_SHELL_IDS) {
    const mount = $(`#${id}`);
    if (mount.length > 0 && mount.children().length === 0) {
      return { escalate: true, reason: 'spa-shell' };
    }
  }

  if (bodyText.length < options.escalation.minBodyTextLength && imageCount === 0) {
    return { escalate: true, reason: 'empty-body' };
  }

  const scriptLength = $('script')
    .toArray()
    .reduce((total, element) => total + $(element).text().length, 0);
  const ratio = html.length === 0 ? 0 : scriptLength / html.length;

  if (ratio > options.escalation.maxScriptToMarkupRatio && imageCount === 0) {
    return { escalate: true, reason: 'script-heavy' };
  }

  if (imageCount < options.escalation.minImageCount && ratio > 0.3) {
    return { escalate: true, reason: 'no-images' };
  }

  return { escalate: false };
};
