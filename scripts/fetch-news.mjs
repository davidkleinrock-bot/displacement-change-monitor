// Saves recent displacement headlines per country from the GDELT DOC 2.0 API.
// Usage: node scripts/fetch-news.mjs        (run build-data.mjs first; it picks the countries)
// Writes data/news.js → window.DISPLACEMENT_NEWS
// GDELT asks for no more than one request every 5 seconds and blocks an address for about a minute
// when it sees more, so requests are spaced out and a block is waited out. Progress is saved after
// every country, and countries that still fail keep their previous headlines.

import { readFile, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const GDELT = "https://api.gdeltproject.org/api/v2/doc/doc";
const TOPIC = "(refugees OR refugee OR displaced OR displacement OR asylum OR evacuated)";
const TIMESPAN = "14d";
const PER_COUNTRY = 8;
const PAUSE_MS = 8000;
const BLOCK_WAIT_MS = 65000;
const MAX_MINUTES = Number(process.env.NEWS_MAX_MINUTES || 40);

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function buildQuery(terms) {
  const place = terms.length > 1 ? `(${terms.join(" OR ")})` : terms[0];
  return `${place} ${TOPIC} sourcelang:english`;
}

async function search(terms) {
  const qs = new URLSearchParams({
    query: buildQuery(terms),
    mode: "artlist",
    format: "json",
    maxrecords: String(PER_COUNTRY * 2),
    timespan: TIMESPAN,
    sort: "hybridrel",
  });
  let last = "";
  for (let attempt = 1; attempt <= 3; attempt++) {
    try {
      const res = await fetch(`${GDELT}?${qs}`, { signal: AbortSignal.timeout(30000) });
      const text = await res.text();
      if (res.ok && text.trim().startsWith("{")) return JSON.parse(text).articles || [];
      if (res.ok && !text.trim()) return []; // GDELT answers an empty body when nothing matched
      last = `HTTP ${res.status}: ${text.slice(0, 80).trim()}`;
    } catch (err) {
      last = err.cause?.code || err.message; // GDELT drops connections when it is busy
    }
    if (attempt < 3) await sleep(BLOCK_WAIT_MS); // wait out GDELT's block before trying again
  }
  throw new Error(`GDELT did not answer after 3 tries (${last})`);
}

// Same story syndicated across outlets shows up many times; keep the first of each title.
function tidy(articles) {
  const seen = new Set();
  const out = [];
  for (const a of articles) {
    if (!/^https?:\/\//.test(a.url || "")) continue;
    const title = (a.title || "").replace(/\s+([:,;.!?])/g, "$1").replace(/\s{2,}/g, " ").trim();
    const norm = title.toLowerCase().replace(/[^a-z0-9]+/g, " ").slice(0, 60);
    if (!title || seen.has(norm)) continue;
    seen.add(norm);
    const d = a.seendate || "";
    out.push({
      title,
      url: a.url,
      domain: a.domain || new URL(a.url).hostname,
      date: d ? `${d.slice(0, 4)}-${d.slice(4, 6)}-${d.slice(6, 8)}` : null,
    });
    if (out.length >= PER_COUNTRY) break;
  }
  return out;
}

async function readPrevious() {
  try {
    const text = await readFile(join(ROOT, "data", "news.js"), "utf8");
    return JSON.parse(text.slice(text.indexOf("{"), text.lastIndexOf("}") + 1));
  } catch {
    return {};
  }
}

async function main() {
  const targets = JSON.parse(await readFile(join(ROOT, "data", "processed", "news-targets.json"), "utf8"));
  const previous = await readPrevious();
  const started = Date.now();
  // Start from the previous headlines so nothing disappears if this run is cut short.
  const byCountry = { ...(previous.byCountry || {}) };
  const checkedAt = { ...(previous.checkedAt || {}) };
  const save = () => writeFile(join(ROOT, "data", "news.js"), `window.DISPLACEMENT_NEWS = ${JSON.stringify({
    retrievedAt: new Date().toISOString(),
    checkedAt,
    source: "GDELT DOC 2.0 API",
    sourceUrl: "https://blog.gdeltproject.org/gdelt-doc-2-0-api-debuts/",
    timespan: TIMESPAN,
    topic: TOPIC,
    byCountry,
  })};
`);
  let failed = 0, fetched = 0;
  for (const [i, t] of targets.entries()) {
    if ((Date.now() - started) / 60000 > MAX_MINUTES) {
      console.log(`  Stopping after ${MAX_MINUTES} minutes; the rest keep their previous headlines.`);
      break;
    }
    try {
      byCountry[t.id] = tidy(await search(t.terms));
      checkedAt[t.id] = new Date().toISOString();
      fetched++;
      await save();
      console.log(`  ${String(i + 1).padStart(2)}/${targets.length} ${t.id} ${byCountry[t.id].length} articles`);
    } catch (err) {
      failed++;
      console.log(`  ${t.id} skipped: ${err.message}`);
    }
    await sleep(PAUSE_MS);
  }
  if (!fetched) throw new Error("No news search succeeded; keeping the previous data/news.js");
  console.log(`Saved data/news.js (${fetched} countries refreshed, ${failed} kept from before or empty)`);
}

main().catch((err) => {
  console.error(err.message);
  process.exit(1);
});
