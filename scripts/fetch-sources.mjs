// Refreshes the public ratings the dashboard uses to decide which news outlets count.
// Usage: node scripts/fetch-sources.mjs
// Writes data/processed/news-sources.json (committed) and raw downloads under data/raw/sources/ (not committed).
//
// An outlet's articles are shown if it is on the hand-picked list in data/outlets.json (maintained by the
// project team, with a reason for each outlet), or if one of these holds:
//   1. Wikipedia's Perennial Sources list rates it "generally reliable" in every entry for that domain.
//      https://en.wikipedia.org/wiki/Wikipedia:Reliable_sources/Perennial_sources  (CC BY-SA 4.0)
//   2. It is an intergovernmental organization: a .int domain (IANA grants .int only to treaty-based
//      intergovernmental bodies, https://www.iana.org/domains/int/policy), the United Nations (un.org),
//      or a UN system organization listed in the UN System Chief Executives Board directory
//      (https://unsceb.org/directory).
// Outlets Wikipedia never rates generally reliable are listed under "excluded" with their rating. Those
// rated generally unreliable, deprecated or blacklisted are never shown, even if hand-picked; those with
// "no consensus" or mixed ratings are shown only if hand-picked. See makeOutletChecker in news-lib.mjs.
//
// Until November 2026 an unrated outlet could also qualify with a Lin et al. (2023) quality score above
// 0.66 plus a place in the Tranco top 10,000 websites. That route let in aggregators (wn.com, aol.com,
// msn.com) and tabloids, because a domain-level score and popularity say nothing about original
// reporting, so it was replaced by the hand-picked list.

import { mkdir, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const RAW = join(ROOT, "data", "raw", "sources");
const UA = "displacement-change-monitor/1.0 (student research project; https://github.com/davidkleinrock-bot/displacement-change-monitor)";
// UN system organizations outside .int (UN System Chief Executives Board directory, https://unsceb.org/directory).
const UN_SYSTEM = [
  "un.org", "unhcr.org", "unicef.org", "wfp.org", "undp.org", "unocha.org", "unfpa.org", "unrwa.org", "ohchr.org",
  "unesco.org", "ilo.org", "fao.org", "ifad.org", "unwomen.org", "unops.org", "unep.org", "unhabitat.org", "unodc.org",
  "unaids.org", "unctad.org", "unido.org", "worldbank.org", "imf.org", "unu.edu", "unitar.org",
];
const WP_PAGES = 9; // Wikipedia:Reliable sources/Perennial sources/1 … /9
const WP_STATUS = { gr: "generally reliable", nc: "no consensus", gu: "generally unreliable", d: "deprecated", b: "blacklisted", m: "mixed" };

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const clean = (d) => d.trim().toLowerCase().replace(/^https?:\/\//, "").replace(/^www\./, "").replace(/\/.*$/, "");
const isDomain = (d) => /^[a-z0-9-]+(\.[a-z0-9-]+)+$/.test(d);

async function get(url) {
  for (let i = 1; i <= 3; i++) {
    const res = await fetch(url, { headers: { "User-Agent": UA } });
    if (res.ok) return res.text();
    if (i === 3) throw new Error(`${url}: HTTP ${res.status}`);
    await sleep(2000 * i);
  }
}

// Each table row starts `|- class="s-gr" id="..."`; its domains are the arguments of {{WP:RSPUSES|...}}.
function parseWikipedia(wikitext) {
  const rows = [];
  const parts = wikitext.split(/\n\|-\s*class="s-([a-z]+)"[^\n]*/);
  for (let i = 1; i < parts.length; i += 2) {
    const status = parts[i];
    const body = parts[i + 1].split(/\n\|\}/)[0];
    const name = (body.split("\n").find((l) => l.startsWith("| ")) || "")
      .replace(/^\|\s*/, "").replace(/\{\{[^}]*\}\}/g, "").replace(/\[\[(?:[^|\]]*\|)?([^\]]*)\]\]/g, "$1").replace(/''+/g, "").trim();
    const domains = [];
    for (const m of body.matchAll(/\{\{WP:RSPUSES\|([^}]*)\}\}/g)) {
      for (const arg of m[1].split("|")) {
        const d = clean(arg.replace(/^[a-z0-9]+=/i, ""));
        if (isDomain(d)) domains.push(d);
      }
    }
    if (domains.length) rows.push({ name, status, domains });
  }
  return rows;
}

async function main() {
  await mkdir(RAW, { recursive: true });

  console.log("Wikipedia Perennial Sources…");
  const wpRows = [];
  for (let p = 1; p <= WP_PAGES; p++) {
    const text = await get(`https://en.wikipedia.org/w/index.php?title=Wikipedia:Reliable_sources/Perennial_sources/${p}&action=raw`);
    await writeFile(join(RAW, `wikipedia-perennial-sources-${p}.wikitext`), text);
    wpRows.push(...parseWikipedia(text));
    await sleep(1000);
  }
  const counts = Object.fromEntries(Object.keys(WP_STATUS).map((s) => [s, wpRows.filter((r) => r.status === s).length]));
  console.log(`  ${wpRows.length} rated sources with domains`, counts);
  if (wpRows.length < 300) throw new Error(`Wikipedia list looks incomplete (${wpRows.length} rows); keeping the previous outlet ratings`);

  // Every Wikipedia rating per domain: some domains have several entries (by section, topic or period).
  const severity = { b: 5, d: 4, gu: 3, m: 2, nc: 1, gr: 0 };
  const wp = new Map();
  for (const r of wpRows) {
    for (const d of r.domains) {
      if (!wp.has(d)) wp.set(d, { statuses: new Set(), name: r.name, worst: r.status });
      const e = wp.get(d);
      e.statuses.add(r.status);
      if (severity[r.status] > severity[e.worst]) e.worst = r.status;
      if (r.status === "gr") e.name = r.name;
    }
  }

  const allowed = {};
  const excluded = {};
  for (const [d, w] of wp) {
    const name = w.name?.replace(/<[^>]+>|data-sort-value="[^"]*"\s*\|?/g, "").trim() || null;
    if (w.statuses.size === 1 && w.statuses.has("gr")) allowed[d] = { basis: ["wikipedia"], name };
    else if (!w.statuses.has("gr")) excluded[d] = `Wikipedia: ${WP_STATUS[w.worst] || w.worst}`;
    else excluded[d] = "Wikipedia: rated reliable only for some sections, topics or periods";
  }

  const out = {
    builtAt: new Date().toISOString(),
    definition:
      "Outlets Wikipedia's Perennial Sources list rates generally reliable, and intergovernmental or UN system organizations. The dashboard also counts the hand-picked outlets in data/outlets.json. Outlets Wikipedia rates generally unreliable, deprecated or blacklisted are never shown; those with no consensus or mixed ratings are shown only if hand-picked.",
    sources: {
      wikipedia: { title: "Wikipedia: Reliable sources/Perennial sources", url: "https://en.wikipedia.org/wiki/Wikipedia:Reliable_sources/Perennial_sources", license: "CC BY-SA 4.0", rows: wpRows.length },
      intergovernmental: { rule: "any .int domain, plus UN system organizations", policy: "https://www.iana.org/domains/int/policy", directory: "https://unsceb.org/directory" },
    },
    intergovernmental: { suffixes: [".int"], domains: UN_SYSTEM },
    allowed,
    excluded,
  };
  await mkdir(join(ROOT, "data", "processed"), { recursive: true });
  await writeFile(join(ROOT, "data", "processed", "news-sources.json"), JSON.stringify(out, null, 1));
  console.log(`Saved data/processed/news-sources.json: ${Object.keys(allowed).length} rated generally reliable, ${Object.keys(excluded).length} excluded or mixed.`);
}

main().catch((err) => {
  console.error(err.message);
  process.exit(1);
});
