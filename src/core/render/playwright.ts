import type { Browser, BrowserContext, Page, Response } from 'playwright';
import type { ComputedBackground, NetworkRecord } from '../extract/context';
import { err, ok, type Result } from '../result';
import type { RenderedPage, RenderError, Renderer, RenderOptions } from './renderer';

/**
 * Chromium is launched lazily and kept alive for the whole job: startup is
 * roughly a second, and a crawl that escalates on twenty pages should pay that
 * once rather than twenty times.
 */
export class PlaywrightRenderer implements Renderer {
  private browser: Browser | null = null;
  private closed = false;

  constructor(private readonly headless = true) {}

  private async browserInstance(): Promise<Result<Browser, RenderError>> {
    if (this.closed) return err({ kind: 'closed' });
    if (this.browser !== null) return ok(this.browser);

    try {
      // Imported here so a static-only crawl never loads the driver, and so a
      // machine without `npx playwright install` still runs the fast path.
      const { chromium } = await import('playwright');
      this.browser = await chromium.launch({ headless: this.headless });
      return ok(this.browser);
    } catch (cause) {
      return err({
        kind: 'launch-failed',
        message: cause instanceof Error ? cause.message : 'could not launch Chromium',
      });
    }
  }

  async render(url: string, options: RenderOptions): Promise<Result<RenderedPage, RenderError>> {
    const browser = await this.browserInstance();
    if (!browser.ok) return browser;

    let context: BrowserContext | null = null;
    try {
      context = await browser.value.newContext({
        userAgent: options.userAgent,
        javaScriptEnabled: true,
      });
      const page = await context.newPage();

      const networkLog: NetworkRecord[] = [];
      const seen = new Set<string>();

      page.on('response', (response: Response) => {
        const responseUrl = response.url();
        if (seen.has(responseUrl) || !responseUrl.startsWith('http')) return;
        seen.add(responseUrl);

        const headers = response.headers();
        const length = Number(headers['content-length'] ?? '');
        networkLog.push({
          url: responseUrl,
          resourceType: response.request().resourceType(),
          contentType: headers['content-type'] ?? null,
          contentLength: Number.isFinite(length) && length > 0 ? length : null,
          status: response.status(),
        });
      });

      const response = await page.goto(url, {
        waitUntil: 'domcontentloaded',
        timeout: options.timeoutMs,
      });
      if (response === null) {
        return err({ kind: 'navigation-failed', url, message: 'no response' });
      }

      // Lazy-loaded media usually arrives after the initial paint, so settle
      // for a quiet network rather than the load event.
      await page
        .waitForLoadState('networkidle', { timeout: options.networkIdleMs })
        .catch(() => undefined);

      const html = await page.content();
      const computedBackgrounds = await readComputedBackgrounds(page);

      return ok({ url: page.url(), html, networkLog, computedBackgrounds });
    } catch (cause) {
      const message = cause instanceof Error ? cause.message : 'render failed';
      if (message.toLowerCase().includes('timeout')) {
        return err({ kind: 'timeout', afterMs: options.timeoutMs });
      }
      return err({ kind: 'navigation-failed', url, message });
    } finally {
      await context?.close().catch(() => undefined);
    }
  }

  async close(): Promise<void> {
    this.closed = true;
    const browser = this.browser;
    this.browser = null;
    await browser?.close().catch(() => undefined);
  }
}

/**
 * Reads `background-image` off every element. This is the only way to see a
 * background applied by a stylesheet rule rather than an inline style.
 */
const readComputedBackgrounds = async (page: Page): Promise<ComputedBackground[]> =>
  page.evaluate<ComputedBackground[]>(() => {
    const results: ComputedBackground[] = [];
    const seen = new Set<string>();

    for (const element of Array.from(document.querySelectorAll('*')).slice(0, 5000)) {
      const value = window.getComputedStyle(element).backgroundImage;
      if (value === '' || value === 'none' || seen.has(value)) continue;
      seen.add(value);

      const tag = element.tagName.toLowerCase();
      const id = element.id === '' ? '' : `#${element.id}`;
      const cls = element.classList.length === 0 ? '' : `.${element.classList[0] ?? ''}`;
      results.push({ value, selector: `${tag}${id}${cls}` });
    }

    return results;
  });
