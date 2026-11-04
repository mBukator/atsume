/**
 * Imports only ever point downward.
 *
 * The tree is layered - core, shared, entities, features, widgets, views, app -
 * and the whole value of that is the direction. A layer may reach down to
 * anything beneath it and never up, and two slices of the same layer never
 * reach across to each other: the moment `entities/board` imports
 * `features/pin-to-board`, or one widget imports another, the layering is
 * decoration rather than structure, and the next person has to read the whole
 * tree to know what depends on what.
 *
 * That is a negative property, and a negative is exactly what erodes without a
 * guard - the offending import is always one line and always looks reasonable
 * at the time. So it is checked here, in the same idiom as the other
 * architecture tests in this repo, rather than in the lint config, where a
 * rule is one line to switch off.
 *
 * `core` and `shared` are deliberately not sliced: they are flat vocabularies,
 * and a primitive using a helper next to it is not a boundary being crossed.
 */

import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const SOURCE_ROOT = fileURLToPath(new URL(".", import.meta.url));

/** Low to high. An import may go left, never right. */
const LAYERS = [
    "core",
    "shared",
    "entities",
    "features",
    "widgets",
    "views",
    "app",
] as const;
type Layer = (typeof LAYERS)[number];

/** Flat layers, where a same-layer import is ordinary rather than a crossing. */
const UNSLICED: ReadonlySet<string> = new Set(["core", "shared", "app"]);

const isLayer = (value: string): value is Layer =>
    (LAYERS as readonly string[]).includes(value);

const sourceFiles = (directory: string): string[] => {
    const found: string[] = [];
    for (const entry of readdirSync(directory)) {
        const path = join(directory, entry);
        if (statSync(path).isDirectory()) {
            found.push(...sourceFiles(path));
        } else if (/\.tsx?$/.test(entry)) {
            found.push(path);
        }
    }
    return found;
};

/** `entities/board/model/board-order.ts` → `{ layer: 'entities', slice: 'board' }`. */
const placeOf = (relative: string): { layer: Layer; slice: string } | null => {
    const [layer, second] = relative.split("/");
    if (layer === undefined || !isLayer(layer)) return null;
    return { layer, slice: UNSLICED.has(layer) ? "" : (second ?? "") };
};

const IMPORT = /(?:from|import)\s*\(?\s*["'](@\/[^"']+)["']/g;

interface Offence {
    readonly from: string;
    readonly to: string;
    readonly why: string;
}

const offences = (): Offence[] => {
    const found: Offence[] = [];

    for (const path of sourceFiles(SOURCE_ROOT)) {
        const relative = path.slice(SOURCE_ROOT.length).split(/[\\/]/).join("/");
        const here = placeOf(relative);
        if (here === null) continue;

        const text = readFileSync(path, "utf8");
        for (const match of text.matchAll(IMPORT)) {
            const spec = match[1];
            if (spec === undefined) continue;
            const there = placeOf(spec.slice("@/".length));
            if (there === null) continue;

            const step = LAYERS.indexOf(there.layer) - LAYERS.indexOf(here.layer);
            if (step > 0) {
                found.push({
                    from: relative,
                    to: spec,
                    why: `${here.layer} may not import ${there.layer}`,
                });
            } else if (step === 0 && here.slice !== there.slice) {
                found.push({
                    from: relative,
                    to: spec,
                    why: `${here.layer}/${here.slice} may not import a sibling slice`,
                });
            }
        }
    }

    return found;
};

describe("the layers", () => {
    it("is looking at the real tree", () => {
        // The same sanity check the other guards carry: a walk rooted at the wrong
        // place finds nothing and passes silently, which is worse than failing.
        const files = sourceFiles(SOURCE_ROOT);
        expect(files.length).toBeGreaterThan(50);
        expect(files.some((path) => path.endsWith("job-service.ts"))).toBe(true);
    });

    it("never lets an import point upward or sideways", () => {
        const found = offences();
        const report = found.map((o) => `${o.from} -> ${o.to}  (${o.why})`);
        expect(report).toEqual([]);
    });
});
