// Builds the list of news outlets the dashboard treats as reputable, from public rating repositories.
// Usage: node scripts/fetch-sources.mjs
// Writes data/processed/news-sources.json (committed) and raw downloads under data/raw/sources/ (not committed).
//
// Definition. An outlet's headlines are shown only if one of these holds:
//   1. Wikipedia's Perennial Sources list rates it "generally reliable" in every entry for that domain.
//      If none of its entries is "generally reliable" (no consensus, mixed, generally unreliable,
//      deprecated, blacklisted), it is excluded, whatever its score below.
//      https://en.wikipedia.org/wiki/Wikipedia:Reliable_sources/Perennial_sources  (CC BY-SA 4.0)
//   2. Wikipedia has not rated it, or rates it differently by section, topic or period (e.g. The Guardian
//      is reliable but its blogs are not), and its aggregate quality score in Lin et al. (2023) is above
//      0.66, the cut-off used to label domains "reliable" in later work with these ratings (0 = lowest,
//      1 = highest).
//      Ratings for one section of a site ("example.com/english") are not applied to the whole site.
//      Lin, Lasser, Lewandowsky, Cole, Gully, Rand & Pennycook (2023), PNAS Nexus 2(9) pgad286,
//      https://doi.org/10.1093/pnasnexus/pgad286, data: https://github.com/hauselin/domain-quality-ratings
//      Such an outlet must also have national or international reach: it must be among the 10,000
//      most-visited websites in the latest Tranco research ranking (https://tranco-list.eu). This leaves
//      out small local papers and stations that the quality ratings also cover.
//   3. It is an intergovernmental organization: a .int domain (IANA grants .int only to treaty-based
//      intergovernmental bodies, https://www.iana.org/domains/int/policy), the United Nations (un.org),
//      or a UN system organization listed in the UN System Chief Executives Board directory
//      (https://unsceb.org/directory).

import { mkdir, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const RAW = join(ROOT, "data", "raw", "sources");
const UA = "displacement-change-monitor/1.0 (student research project; https://github.com/davidkleinrock-bot/displacement-change-monitor)";
const LIN_URL = "https://raw.githubusercontent.com/hauselin/domain-quality-ratings/main/data/domain_pc1.csv";
const LIN_THRESHOLD = 0.66;
const TRANCO_LATEST = "https://tranco-list.eu/api/lists/date/latest";
const REACH_TOP = 10000;
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

  console.log("Lin et al. (2023) domain quality ratings…");
  const csv = await get(LIN_URL);
  await writeFile(join(RAW, "lin2023-domain_pc1.csv"), csv);
  const lin = new Map();
  for (const line of csv.trim().split("\n").slice(1)) {
    const [d, score] = line.split(",");
    if (!d || d.includes("/")) continue; // a rating for one section of a site, not the whole site
    const k = clean(d);
    if (score && isDomain(k) && !lin.has(k)) lin.set(k, +score);
  }
  console.log(`  ${lin.size} domains`);

  // Combine. Every Wikipedia rating per domain: some domains have several entries (by section, topic or period).
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

  console.log("Tranco ranking of the most-visited websites (for reach)…");
  const tranco = JSON.parse(await get(TRANCO_LATEST));
  const topCsv = await get(`https://tranco-list.eu/download/${tranco.list_id}/${REACH_TOP}`);
  await writeFile(join(RAW, `tranco-${tranco.list_id}-top${REACH_TOP}.csv`), topCsv);
  const reach = new Map();
  for (const line of topCsv.trim().split("\n")) {
    const [rank, d] = line.trim().split(",");
    if (d) reach.set(d.toLowerCase(), +rank);
  }
  if (reach.size < REACH_TOP * 0.9) throw new Error(`Tranco list looks incomplete (${reach.size} rows); keeping the previous outlet list`);
  console.log(`  list ${tranco.list_id}, ${reach.size} sites`);
  // Tranco ranks registrable domains, so check the domain and then its parents (edition.cnn.com → cnn.com).
  const rankOf = (d) => {
    const parts = d.split(".");
    for (let i = 0; i < parts.length - 1; i++) {
      const r = reach.get(parts.slice(i).join("."));
      if (r) return r;
    }
    return null;
  };

  const allowed = {};
  const excluded = {};
  let tooLocal = 0;
  for (const d of new Set([...wp.keys(), ...lin.keys()])) {
    const w = wp.get(d), score = lin.get(d);
    const allReliable = w && w.statuses.size === 1 && w.statuses.has("gr");
    const split = w && w.statuses.has("gr") && w.statuses.size > 1;
    if (w && !w.statuses.has("gr")) { excluded[d] = `Wikipedia: ${WP_STATUS[w.worst] || w.worst}`; continue; }
    if (split && !(score > LIN_THRESHOLD)) { excluded[d] = "Wikipedia: rated reliable only for some sections, topics or periods; Lin et al. score not above 0.66"; continue; }
    const wide = rankOf(d) != null;
    if (!allReliable && score > LIN_THRESHOLD && !wide) { tooLocal++; continue; }
    const basis = allReliable ? ["wikipedia"] : score > LIN_THRESHOLD ? ["lin2023", "tranco"] : null;
    const name = w?.name?.replace(/<[^>]+>|data-sort-value="[^"]*"\s*\|?/g, "").trim() || null;
    if (basis) allowed[d] = { basis, score: score != null ? +score.toFixed(3) : null, name, ...(split ? { wikipediaSplit: true } : {}) };
  }

  const out = {
    builtAt: new Date().toISOString(),
    definition:
      "An outlet counts as reputable if Wikipedia's Perennial Sources list rates it generally reliable; or, where Wikipedia has not rated it or rates it reliable only for some sections, topics or periods, if its Lin et al. (2023) aggregate quality score is above 0.66 and it is among the 10,000 most-visited websites in the Tranco ranking (national or international reach); or if it is an intergovernmental or UN system organization. Outlets Wikipedia never rates generally reliable (no consensus, mixed, generally unreliable, deprecated, blacklisted) are excluded.",
    sources: {
      wikipedia: { title: "Wikipedia: Reliable sources/Perennial sources", url: "https://en.wikipedia.org/wiki/Wikipedia:Reliable_sources/Perennial_sources", license: "CC BY-SA 4.0", rows: wpRows.length },
      lin2023: { title: "Lin et al. (2023), High level of correspondence across different news domain quality rating sets, PNAS Nexus 2(9)", url: "https://doi.org/10.1093/pnasnexus/pgad286", data: "https://github.com/hauselin/domain-quality-ratings", threshold: LIN_THRESHOLD, domains: lin.size },
      tranco: { title: "Tranco research ranking of the most-visited websites", url: "https://tranco-list.eu", list: tranco.list_id, listUrl: `https://tranco-list.eu/list/${tranco.list_id}/${REACH_TOP}`, created: tranco.created_on, top: REACH_TOP, leftOutAsLocal: tooLocal },
      intergovernmental: { rule: "any .int domain, plus UN system organizations", policy: "https://www.iana.org/domains/int/policy", directory: "https://unsceb.org/directory" },
    },
    intergovernmental: { suffixes: [".int"], domains: UN_SYSTEM },
    allowed,
    excluded,
  };
  await mkdir(join(ROOT, "data", "processed"), { recursive: true });
  await writeFile(join(ROOT, "data", "processed", "news-sources.json"), JSON.stringify(out, null, 1));
  console.log(`Saved data/processed/news-sources.json: ${Object.keys(allowed).length} reputable domains, ${Object.keys(excluded).length} excluded by Wikipedia, ${tooLocal} left out as local.`);
}

main().catch((err) => {
  console.error(err.message);
  process.exit(1);
});
