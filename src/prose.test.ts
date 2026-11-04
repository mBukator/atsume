/**
 * Text in this repository uses hyphens, never em or en dashes.
 *
 * That covers comments, docs, commit-facing files and the strings a person
 * reads in the interface. It is a house rule shared with the other projects,
 * and like every rule here that is a negative, it erodes without a guard: a
 * dash is one keystroke on some keyboards and the default of every
 * autocorrecting editor. So it is checked by reading the tree.
 *
 * Captured fixtures are exempt. They are real pages, compared byte for byte,
 * and a test that needs to name a dash from one builds it from its code point.
 */

import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const ROOT = fileURLToPath(new URL("..", import.meta.url));

/** Directories that are generated, local, or captured from elsewhere. */
const SKIPPED_DIRECTORIES = new Set([
    "node_modules",
    ".next",
    ".atsume",
    ".git",
    "fixtures",
]);

/** Files that are generated or quoted verbatim from elsewhere. */
const SKIPPED_FILES = new Set(["package-lock.json", "LICENSE", "next-env.d.ts"]);

const TEXT = /\.(ts|tsx|mjs|js|json|md|css|yml|yaml)$/;
/**
 * The characters, and the escapes that spell them in source: a JavaScript
 * escape or an HTML entity renders the same dash. Built from code points, so
 * this file does not contain what it looks for.
 */
const BACKSLASH = String.fromCharCode(92);
const DASH = new RegExp(
    [
        `[${String.fromCharCode(0x2013, 0x2014)}]`,
        `${BACKSLASH}${BACKSLASH}u201[34]`,
        "&[mn]dash;",
        "&#821[12];",
    ].join("|"),
    "i"
);

const textFiles = (directory: string): string[] => {
    const found: string[] = [];
    for (const entry of readdirSync(directory)) {
        const path = join(directory, entry);
        if (statSync(path).isDirectory()) {
            if (!SKIPPED_DIRECTORIES.has(entry)) found.push(...textFiles(path));
        } else if (TEXT.test(entry) && !SKIPPED_FILES.has(entry)) {
            found.push(path);
        }
    }
    return found;
};

describe("prose", () => {
    it("uses hyphens, never em or en dashes", () => {
        const offenders = textFiles(ROOT).flatMap((path) =>
            readFileSync(path, "utf8")
                .split("\n")
                .flatMap((line, index) =>
                    DASH.test(line)
                        ? [`${relative(ROOT, path).split(sep).join("/")}:${index + 1}`]
                        : []
                )
        );
        expect(offenders).toEqual([]);
    });
});
