import { describe, expect, it } from "vitest";

import {
  isWithin,
  normalizeBrowserResultRange,
  searchHitKey,
  type SearchHit,
} from "../extensions/browser-results";

describe("browser-results", () => {
  it("builds stable keys from path, range, and kind", () => {
    const hit: SearchHit = {
      fullPath: "/root/src/file.ts",
      relativePath: "src/file.ts",
      score: 0,
      isDirectory: false,
      startLine: 2,
      endLine: 4,
    };

    expect(searchHitKey(hit)).toBe("/root/src/file.ts:2:4:file");
    expect(searchHitKey({ ...hit, isDirectory: true })).toBe("/root/src/file.ts:2:4:dir");
  });

  it("normalizes browser result ranges", () => {
    expect(normalizeBrowserResultRange(3, 1, true)).toEqual({ startLine: 1, endLine: 3 });
    expect(normalizeBrowserResultRange(2, 2, true)).toEqual({ startLine: 2 });
    expect(normalizeBrowserResultRange(undefined, 2, true)).toEqual({});
    expect(normalizeBrowserResultRange(2, 4, false)).toEqual({});
  });

  it("keeps cwd containment strict", () => {
    expect(isWithin("/tmp/project/src/index.ts", "/tmp/project")).toBe(true);
    expect(isWithin("/tmp/project", "/tmp/project")).toBe(true);
    expect(isWithin("/tmp/other/index.ts", "/tmp/project")).toBe(false);
  });
});
