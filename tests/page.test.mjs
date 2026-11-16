// Run with: node --test "tests/*.test.mjs"
// The dashboard's own script lives inside index.html, so a typo there would stop the whole page without
// failing any other test. These checks compile it and confirm the news scripts' imports exist.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import vm from "node:vm";
import * as newsLib from "../scripts/news-lib.mjs";
import * as feedsLib from "../scripts/feeds-lib.mjs";

test("the page's inline script compiles", () => {
  const html = readFileSync("index.html", "utf8");
  const scripts = [...html.matchAll(/<script>([\s\S]*?)<\/script>/g)].map((m) => m[1]);
  assert.ok(scripts.length > 0);
  for (const src of scripts) assert.doesNotThrow(() => new vm.Script(src), "index.html has a syntax error in an inline script");
});

test("fetch-news.mjs imports only what the libraries export", () => {
  const src = readFileSync("scripts/fetch-news.mjs", "utf8");
  for (const [lib, mod] of [["news-lib", newsLib], ["feeds-lib", feedsLib]]) {
    const m = src.match(new RegExp(`import \\{([^}]*)\\} from "\\./${lib}\\.mjs"`));
    assert.ok(m, `fetch-news.mjs imports ${lib}`);
    for (const name of m[1].split(",").map((s) => s.trim()).filter(Boolean)) assert.ok(name in mod, `${lib}.mjs has no export ${name}`);
  }
});
