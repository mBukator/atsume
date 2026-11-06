/**
 * Headers for a response whose bytes came from a site this app does not control.
 *
 * A preview or media route serves another host's file from this app's own
 * origin, under whatever content type that host claimed. In an `<img>` or a
 * `<video>` that is harmless. Opened as a page, with "open image in new tab",
 * an HTML file or an SVG carrying a script would run as this origin, and from
 * there it could drive the whole API.
 *
 * `sandbox` makes such a page script-less and gives it an opaque origin of its
 * own, and `nosniff` stops a browser from deciding a mislabelled file is
 * something more dangerous than it says. A browser applies neither when the
 * bytes load as an image or a video, so the grid is unaffected.
 */
export const UNTRUSTED_BYTES_HEADERS: Readonly<Record<string, string>> = {
    "content-security-policy": "sandbox",
    "x-content-type-options": "nosniff",
};
