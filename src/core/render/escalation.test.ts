import { describe, expect, it } from 'vitest';
import { rendererOptionsSchema } from '../config';
import { shouldEscalate } from './renderer';

const auto = rendererOptionsSchema.parse({});

const page = (body: string): string => `<!doctype html><html><body>${body}</body></html>`;

const prose = 'Lorem ipsum dolor sit amet, consectetur adipiscing elit. '.repeat(10);

describe('shouldEscalate', () => {
  it('leaves a normal content page on the static path', () => {
    const html = page(`<p>${prose}</p><img src="/a.jpg"><img src="/b.jpg"><img src="/c.jpg">`);
    expect(shouldEscalate(html, auto)).toEqual({ escalate: false });
  });

  it('escalates an empty SPA shell even when the markup is otherwise plausible', () => {
    const html = page(`<div id="root"></div><p>${prose}</p>`);
    expect(shouldEscalate(html, auto)).toEqual({ escalate: true, reason: 'spa-shell' });
  });

  it('recognises the common framework mount points', () => {
    for (const id of ['root', '__next', 'app', '__nuxt']) {
      expect(shouldEscalate(page(`<div id="${id}"></div>`), auto).escalate).toBe(true);
    }
  });

  it('does not treat a populated mount point as a shell', () => {
    const html = page(`<div id="root"><p>${prose}</p><img src="/a.jpg"><img src="/b.jpg"><img src="/c.jpg"></div>`);
    expect(shouldEscalate(html, auto)).toEqual({ escalate: false });
  });

  it('escalates a body with almost no text and no media', () => {
    expect(shouldEscalate(page('<div></div>'), auto)).toEqual({
      escalate: true,
      reason: 'empty-body',
    });
  });

  it('escalates a page that is mostly script and shows no media', () => {
    const html = page(`<p>${prose}</p><script>${'x'.repeat(5_000)}</script>`);
    expect(shouldEscalate(html, auto)).toEqual({ escalate: true, reason: 'script-heavy' });
  });

  it('trusts a script-heavy page that already shows plenty of images', () => {
    const images = Array.from({ length: 8 }, (_value, index) => `<img src="/${index}.jpg">`).join('');
    const html = page(`<p>${prose}</p>${images}<script>${'x'.repeat(5_000)}</script>`);
    expect(shouldEscalate(html, auto)).toEqual({ escalate: false });
  });

  it('honours static-only regardless of how thin the page looks', () => {
    const options = rendererOptionsSchema.parse({ mode: 'static-only' });
    expect(shouldEscalate(page('<div id="root"></div>'), options)).toEqual({ escalate: false });
  });

  it('honours always-render regardless of how rich the page looks', () => {
    const options = rendererOptionsSchema.parse({ mode: 'always-render' });
    const html = page(`<p>${prose}</p><img src="/a.jpg"><img src="/b.jpg"><img src="/c.jpg">`);
    expect(shouldEscalate(html, options)).toEqual({ escalate: true, reason: 'forced' });
  });

  it('respects a tuned threshold', () => {
    const strict = rendererOptionsSchema.parse({ escalation: { minBodyTextLength: 10_000 } });
    expect(shouldEscalate(page(`<p>${prose}</p>`), strict).escalate).toBe(true);
  });

  it('counts picture sources and videos as media, not just img', () => {
    const html = page(
      `<p>${prose}</p><picture><source srcset="/a.avif"><source srcset="/b.webp"></picture><video src="/c.mp4"></video>`,
    );
    expect(shouldEscalate(html, auto)).toEqual({ escalate: false });
  });
});
