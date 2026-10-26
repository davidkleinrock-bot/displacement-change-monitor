// Saves recent displacement headlines per country from GDELT's raw 15-minute news files.
// Usage: node scripts/fetch-news.mjs                    (normal run: reads the files since the last run)
//        NEWS_HOURS=1464 node scripts/fetch-news.mjs    (backfill: read further back, e.g. a whole window)
//        NEWS_MONTHS=2  how many calendar months of news to keep (default 2; see newsWindow in news-lib.mjs)
//        NEWS_STEP=8    read every 8th 15-minute file only (quick, sampled runs)
// Writes data/news.js → window.DISPLACEMENT_NEWS
//
// GDELT publishes every article it sees as bulk "Global Knowledge Graph" files every 15 minutes
// (http://data.gdeltproject.org/gdeltv2/). Downloading those files is how GDELT expects bulk users to
// work, so this never touches the rate-limited search API. An article is kept only if:
//   - its outlet is on data/processed/news-sources.json (rated reliable, national or international reach);
//   - its headline is about forced displacement;
//   - its headline ties it to the country it is filed under (see attributeCountries in news-lib.mjs);
//   - it is not a profile of one person, an opinion piece, a podcast or a live blog;
//   - its page opens and matches the headline, and its publication date falls in the window.
// The publisher's own summary and date are read from the article page. Nothing is written for an
// article that doesn't provide them. Earlier headlines are re-checked against the rules on every run.

import { readFile, writeFile } from "node:fs/promises";
import { inflateRawSync } from "node:zlib";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import {
  DEFAULT_MONTHS, newsWindow, checkDate, isDisplacement, isPersonalOrOpinion, buildMatchers, attributeCountries,
  cleanTitle, normTitle, dedupe, fetchArticleMeta, summarize, downloadFile,
} from "./news-lib.mjs";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const FEED = "https://data.gdeltproject.org/gdeltv2";
const MONTHS = Number(process.env.NEWS_MONTHS || DEFAULT_MONTHS);
const STEP = Math.max(1, Number(process.env.NEWS_STEP || 1));
const MAX_CATCHUP_HOURS = 72; // a normal run reads everything since the last one, up to three days
const PER_COUNTRY = 8;
const PARALLEL = 4;
const VERIFY_PARALLEL = 6;
const VERIFY_LIMIT = Number(process.env.NEWS_VERIFY_LIMIT || 1500);
const TOPIC_QUERY = "(refugees OR refugee OR displaced OR displacement OR asylum OR evacuated)";
const COL = { date: 1, source: 3, url: 4, extras: 26 }; // GKG 2.1 columns (tab-separated)

// Minimal reader for GDELT's single-file zip archives.
function unzipFirst(buf) {
  let eocd = buf.length - 22;
  while (eocd > 0 && buf.readUInt32LE(eocd) !== 0x06054b50) eocd--;
  if (eocd <= 0) throw new Error("not a zip file");
  const cd = buf.readUInt32LE(eocd + 16);
  const method = buf.readUInt16LE(cd + 10);
  const size = buf.readUInt32LE(cd + 20);
  const local = buf.readUInt32LE(cd + 42);
  const start = local + 30 + buf.readUInt16LE(local + 26) + buf.readUInt16LE(local + 28);
  const data = buf.subarray(start, start + size);
  return (method === 8 ? inflateRawSync(data) : data).toString("utf8");
}

const decode = (s) =>
  s.replace(/&amp;/g, "&").replace(/&quot;/g, '"').replace(/&#0?39;|&apos;/g, "'").replace(/&lt;/g, "<").replace(/&gt;/g, ">")
    .replace(/&#(\d+);/g, (_, n) => String.fromCodePoint(+n)).replace(/&#x([0-9a-f]+);/gi, (_, h) => String.fromCodePoint(parseInt(h, 16)))
    .replace(/\s+/g, " ").trim();
// Copy a string out of the big file text. Without this, V8 keeps each whole 15-minute file in memory
// for as long as any headline cut from it is kept, and a multi-day run runs out of memory.
const own = (s) => (s == null ? s : Buffer.from(s, "utf8").toString("utf8"));

async function readJS(path) {
  const text = await readFile(join(ROOT, path), "utf8");
  return JSON.parse(text.slice(text.indexOf("{"), text.lastIndexOf("}") + 1));
}

// Reputable outlets: the domain itself or a parent domain (edition.cnn.com → cnn.com) must be allowed,
// and none may be excluded. Returns why the outlet is allowed and its name, or null.
async function outletChecker() {
  const list = JSON.parse(await readFile(join(ROOT, "data", "processed", "news-sources.json"), "utf8"));
  return (domain) => {
    const d = (domain || "").toLowerCase().replace(/^www\./, "");
    const parts = d.split(".");
    for (let i = 0; i < parts.length - 1; i++) {
      const c = parts.slice(i).join(".");
      if (list.excluded[c]) return null;
      if (list.allowed[c]) return { basis: list.allowed[c].basis.join("+"), name: list.allowed[c].name?.replace(/\s*\(.*?\)\s*/g, " ").trim() || null };
    }
    if (list.intergovernmental.suffixes.some((s) => d.endsWith(s)) || list.intergovernmental.domains.some((x) => d === x || d.endsWith("." + x))) {
      return { basis: "intergovernmental", name: null };
    }
    return null;
  };
}

const stampToDate = (s) => new Date(Date.UTC(+s.slice(0, 4), +s.slice(4, 6) - 1, +s.slice(6, 8), +s.slice(8, 10), +s.slice(10, 12)));
function slots(lastStamp, hours, step) {
  const t = stampToDate(lastStamp).getTime();
  const out = [];
  for (let k = 0; k < Math.ceil(hours * 4); k += step) {
    const d = new Date(t - k * 15 * 60000);
    const p = (n) => String(n).padStart(2, "0");
    out.push(`${d.getUTCFullYear()}${p(d.getUTCMonth() + 1)}${p(d.getUTCDate())}${p(d.getUTCHours())}${p(d.getUTCMinutes())}00`);
  }
  return out;
}

async function pool(items, size, fn) {
  let i = 0;
  await Promise.all(Array.from({ length: size }, async () => { while (i < items.length) await fn(items[i++]); }));
}

async function main(previous) {
  const now = new Date();
  const window = newsWindow(now, MONTHS);
  const data = await readJS("data/dashboard-data.js");
  const wc = JSON.parse(await readFile(join(ROOT, "data", "raw", "geo", "world-countries.json"), "utf8"));
  const matchers = buildMatchers(data.countries, wc);
  const outlet = await outletChecker();

  const index = await (await fetch(`${FEED}/lastupdate.txt`)).text();
  const last = index.match(/(\d{14})\.gkg\.csv\.zip/)?.[1];
  if (!last) throw new Error("Could not read GDELT's lastupdate.txt");
  // Read everything since the last run, so hours between runs are never skipped.
  let hours = Number(process.env.NEWS_HOURS || 0);
  if (!hours) {
    const prev = previous?.checkedThrough;
    hours = prev ? (stampToDate(last) - stampToDate(prev)) / 3600000 : 24;
    hours = Math.min(MAX_CATCHUP_HOURS, Math.max(0.25, hours));
  }
  const stamps = slots(last, hours, STEP);
  console.log(`Window ${window.from} to ${window.to} (${MONTHS} months). Reading ${stamps.length} GDELT files (${hours.toFixed(1)} hours up to ${last}${STEP > 1 ? `, every ${STEP}th file` : ""})…`);

  const found = new Map(); // iso → candidate items
  const counts = { files: 0, missingFiles: 0, articles: 0, topical: 0, personal: 0, outlet: 0, unattributed: 0, kept: 0 };
  const leftOut = new Map();
  const handle = (text) => {
    for (const line of text.split("\n")) {
      if (!line) continue;
      const r = line.split("\t");
      counts.articles++;
      const raw = decode(r[COL.extras]?.match(/<PAGE_TITLE>(.*?)<\/PAGE_TITLE>/)?.[1] || "");
      const url = r[COL.url] || "";
      if (!raw || !isDisplacement(raw) || !/^https?:\/\//.test(url)) continue;
      counts.topical++;
      if (isPersonalOrOpinion(raw, url)) { counts.personal++; continue; }
      const domain = r[COL.source] || new URL(url).hostname;
      const o = outlet(domain);
      if (!o) { counts.outlet++; leftOut.set(leftOut.has(domain) ? domain : own(domain), (leftOut.get(domain) || 0) + 1); continue; }
      const isos = attributeCountries(raw, matchers);
      if (!isos.length) { counts.unattributed++; continue; }
      counts.kept++;
      const d = r[COL.date] || "";
      const item = { title: own(cleanTitle(raw)), url: own(url), domain: own(domain), seen: own(`${d.slice(0, 4)}-${d.slice(4, 6)}-${d.slice(6, 8)}`) };
      for (const iso of isos) {
        if (!found.has(iso)) found.set(iso, []);
        found.get(iso).push(item);
      }
    }
  };
  for (let i = 0; i < stamps.length; i += PARALLEL) {
    const batch = stamps.slice(i, i + PARALLEL);
    const bufs = await Promise.all(batch.map((s) => downloadFile(`${FEED}/${s}.gkg.csv.zip`).catch((e) => (console.log(`  ${s} skipped: ${e.message}`), null))));
    for (const buf of bufs) {
      if (!buf) { counts.missingFiles++; continue; }
      try { handle(unzipFirst(buf)); counts.files++; } catch (e) { console.log(`  a file could not be read: ${e.message}`); }
    }
    if ((i / PARALLEL) % 25 === 24) console.log(`  ${counts.files} files read, ${counts.kept} headlines kept so far`);
  }
  if (!counts.files) throw new Error("No GDELT files could be read");

  // Combine with earlier headlines, re-checking each one against today's rules and outlet list.
  const candidates = new Map();
  for (const iso of matchers.keys()) {
    const list = [...(found.get(iso) || []), ...(previous?.byCountry?.[iso] || [])].filter(
      (a) => isDisplacement(a.title) && !isPersonalOrOpinion(a.title, a.url) && outlet(a.domain) && attributeCountries(a.title, matchers).includes(iso),
    );
    if (list.length) candidates.set(iso, dedupe(list));
  }

  // Open each new article once: keep its publisher summary and date, drop dead or mismatched links.
  const checked = new Map(); // url → result, so an article filed under two countries is fetched once
  for (const prev of Object.values(previous?.byCountry || {})) for (const a of prev) if (a.link) checked.set(a.url, a);
  const toCheck = [...new Set([...candidates.values()].flat().filter((a) => !checked.has(a.url)).map((a) => a.url))];
  const byUrl = new Map([...candidates.values()].flat().map((a) => [a.url, a]));
  const verifyNow = toCheck.sort((x, y) => (byUrl.get(y).seen || "").localeCompare(byUrl.get(x).seen || "")).slice(0, VERIFY_LIMIT);
  const linkCounts = { verified: 0, unverified: 0, broken: 0, mismatched: 0, older: 0 };
  await pool(verifyNow, VERIFY_PARALLEL, async (url) => {
    const a = byUrl.get(url);
    const r = await fetchArticleMeta(url, a.title);
    const o = outlet(a.domain);
    if (r.link === "broken" || r.link === "mismatched") { linkCounts[r.link]++; checked.set(url, { drop: r.link }); return; }
    let date = a.seen || a.date, dateKind = "seen"; // headlines saved before this version only have `date`
    let description = null, publisher = o?.name || a.domain;
    if (r.link === "verified") {
      const pub = checkDate(r.meta.published, window);
      if (pub.reason === "older") { linkCounts.older++; checked.set(url, { drop: "older" }); return; }
      if (pub.date) { date = pub.date; dateKind = "published"; }
      description = summarize(r.meta.description, a.title);
      if (r.meta.siteName) publisher = r.meta.siteName;
    }
    linkCounts[r.link]++;
    checked.set(url, { title: a.title, url, domain: a.domain, basis: o?.basis, publisher, date, dateKind, description, link: r.link, ...(r.reason ? { linkNote: r.reason } : {}) });
  });

  const byCountry = {};
  for (const [iso, list] of candidates) {
    const items = list
      .map((a) => checked.get(a.url))
      .filter((a) => a && !a.drop && checkDate(a.date, window).date)
      .map((a) => ({ ...a, basis: outlet(a.domain)?.basis || a.basis }));
    const top = dedupe(items).sort((x, y) => y.date.localeCompare(x.date)).slice(0, PER_COUNTRY);
    if (top.length) byCountry[iso] = top;
  }

  const payload = {
    status: "ok",
    retrievedAt: now.toISOString(),
    lastAttempt: { at: now.toISOString(), ok: true },
    checkedThrough: last,
    window,
    source: "GDELT 2.0 Global Knowledge Graph, 15-minute files",
    sourceUrl: "https://www.gdeltproject.org/data.html",
    topic: TOPIC_QUERY,
    reputable: "Only outlets rated reliable by Wikipedia's Perennial Sources list, or by Lin et al. (2023) with national or international reach (Tranco top 10,000), or intergovernmental and UN system organizations. See data/processed/news-sources.json.",
    rules: "Headline must be about forced displacement, tie it to the country it is listed under, and not be a personal profile, opinion piece, podcast or live blog. The article page must open and match the headline, and its publication date must fall in the window.",
    searched: [...matchers.keys()].sort(),
    lastRun: { hoursRead: +hours.toFixed(2), step: STEP, filesRead: counts.files, filesMissing: counts.missingFiles, ...counts, links: linkCounts, pendingChecks: Math.max(0, toCheck.length - verifyNow.length) },
    byCountry,
  };
  await writeFile(join(ROOT, "data", "news.js"), `window.DISPLACEMENT_NEWS = ${JSON.stringify(payload)};\n`);
  console.log(`Read ${counts.files} files (${counts.missingFiles} missing), ${counts.articles.toLocaleString()} articles; peak memory ${Math.round(process.memoryUsage().rss / 1e6)} MB.`);
  console.log(`Displacement headlines ${counts.topical}: left out ${counts.personal} profiles/opinion, ${counts.outlet} from outlets not rated reliable or local, ${counts.unattributed} not tied to a country; kept ${counts.kept}.`);
  console.log(`Article pages checked ${verifyNow.length}: ${JSON.stringify(linkCounts)}${payload.lastRun.pendingChecks ? `, ${payload.lastRun.pendingChecks} left for the next run` : ""}.`);
  console.log(`Saved data/news.js: ${Object.keys(byCountry).length} of ${matchers.size} places have at least one article.`);
  const top = [...leftOut].sort((a, b) => b[1] - a[1]).slice(0, 20).map(([d, n]) => `${d} ${n}`);
  if (top.length) console.log(`Outlets with the most displacement headlines left out: ${top.join(", ")}`);
}

let previous = null;
try { previous = await readJS("data/news.js"); } catch { /* first run */ }
main(previous).catch(async (err) => {
  console.error(err.message);
  // Keep the last good headlines, and record the failure so the page can say so.
  const failed = { ...(previous || { status: "error", byCountry: {}, searched: [] }), lastAttempt: { at: new Date().toISOString(), ok: false, error: err.message } };
  try { await writeFile(join(ROOT, "data", "news.js"), `window.DISPLACEMENT_NEWS = ${JSON.stringify(failed)};\n`); } catch { /* nothing more to do */ }
  process.exit(1);
});
