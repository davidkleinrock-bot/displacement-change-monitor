// Saves recent displacement headlines and humanitarian reports per country.
// Usage: node scripts/fetch-news.mjs                    (normal run: reads the files since the last run)
//        NEWS_HOURS=1464 node scripts/fetch-news.mjs    (backfill: read further back, e.g. a whole window)
//        NEWS_MONTHS=2  how many calendar months of news to keep (default 2; see newsWindow in news-lib.mjs)
//        NEWS_STEP=8    read every 8th 15-minute English file only (quick, sampled runs)
//        NEWS_TR_STEP=3 read every 3rd 15-minute translated file (default: same as NEWS_STEP)
//        NEWS_TRANSLINGUAL=0  skip GDELT's translated (non-English) files
//        NEWS_BUDGET_MIN=120  stop reading GDELT files after 120 minutes (long backfills), keeping what was read
//        RELIEFWEB_APPNAME=…  ReliefWeb API appname (approved by ReliefWeb); without it, reports are skipped
// Writes data/news.js → window.DISPLACEMENT_NEWS
//
// Three kinds of source, all free:
//   1. GDELT's raw 15-minute "Global Knowledge Graph" files (http://data.gdeltproject.org/gdeltv2/): the
//      English file, and the translated file for articles GDELT finds in other languages. Spanish, French
//      and Portuguese articles are kept, with their original headline. Downloading these files is how
//      GDELT expects bulk users to work, so this never touches its rate-limited search API.
//   2. RSS feeds of hand-picked outlets (data/feeds.json), for regions GDELT covers thinly.
//   3. ReliefWeb (UN OCHA): recent displacement reports by UN agencies, NGOs and governments, tagged by
//      country by ReliefWeb's editors, through ReliefWeb's official API. The API needs an appname that
//      ReliefWeb approves; until the repository has one, this step is skipped. Reports are kept apart from
//      the news, as "humanitarian reports".
// A news article is kept only if:
//   - its outlet is on the hand-picked list in data/outlets.json, or is a UN or intergovernmental body
//     (see makeOutletChecker in news-lib.mjs);
//   - its headline is about forced displacement, and for GDELT articles GDELT's own topic tags agree;
//   - its headline ties it to the country it is filed under (see attributeCountries in news-lib.mjs);
//   - it is not a profile of one person, an opinion piece, a podcast or a live blog;
//   - its page opens and matches the headline, and its publication date falls in the window.
// The publisher's own summary and date are read from the article page. Nothing is written for an
// article that doesn't provide them. Earlier headlines are re-checked against the rules on every run.
// Spanish, French and Portuguese headlines and summaries also get an English machine translation
// (see translate.mjs); HF_CACHE_DIR sets where the translation model is kept between runs.

import { readFile, writeFile } from "node:fs/promises";
import { inflateRawSync } from "node:zlib";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import {
  DEFAULT_MONTHS, newsWindow, checkDate, isDisplacement, isCoreDisplacement, isPersonalOrOpinion, buildMatchers, attributeCountries,
  displacementThemes, sourceLanguage, makeOutletChecker, cleanTitle, dedupe, pickForCountry, fetchArticleMeta, summarize, downloadFile,
} from "./news-lib.mjs";
import { fetchFeed, reliefWebPage, RELIEFWEB_FIELDS } from "./feeds-lib.mjs";
import { translateItems, MT_MODEL } from "./translate.mjs";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const FEED = "https://data.gdeltproject.org/gdeltv2";
const MONTHS = Number(process.env.NEWS_MONTHS || DEFAULT_MONTHS);
const STEP = Math.max(1, Number(process.env.NEWS_STEP || 1));
const TR_STEP = Math.max(1, Number(process.env.NEWS_TR_STEP || STEP));
const TRANSLINGUAL = process.env.NEWS_TRANSLINGUAL !== "0";
const TR_LANGS = new Set(["es", "fr", "pt"]); // languages whose headlines the rules can read
const BUDGET_MIN = Number(process.env.NEWS_BUDGET_MIN || 0); // stop reading GDELT files after this many minutes (0 = no limit)
const DEADLINE = BUDGET_MIN ? Date.now() + BUDGET_MIN * 60000 : Infinity;
const MAX_PENDING = 6000; // articles waiting for their page to be checked, carried to the next run
const MAX_CATCHUP_HOURS = 72; // a normal run reads everything since the last one, up to three days
const PER_COUNTRY = 8;
const PER_OUTLET = 3;
const PARALLEL = 4;
const VERIFY_PARALLEL = 6;
const VERIFY_LIMIT = Number(process.env.NEWS_VERIFY_LIMIT || 1500);
const FEED_PARALLEL = 6;
const RELIEFWEB_APPNAME = process.env.RELIEFWEB_APPNAME || "";
const REPORTS_PER_COUNTRY = 5;
const REPORTS_MAX_PAGES = 5; // per search; 1,000 reports a page
const REPORTS_PAUSE_MS = 1000;
const COL = { date: 1, source: 3, url: 4, themes: 7, translation: 25, extras: 26 }; // GKG 2.1 columns (tab-separated)
// ReliefWeb searches: reports whose title is about displacement (English, Spanish, French, Portuguese), and
// reports by refugee, migration and displacement organizations (ReliefWeb short names).
const REPORTS_TITLE_QUERY = 'title:(refugee* OR displace* OR IDP* OR asylum OR returnee* OR stateless* OR "population movement" OR refugiad* OR desplazad* OR réfugié* OR déplacé* OR deslocad*)';
const REPORTS_SOURCES = ["UNHCR", "IOM", "NRC", "IDMC", "UNRWA"];

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
const hostOf = (url) => { try { return new URL(url).hostname.replace(/^www\./, ""); } catch { return ""; } };

async function readJS(path) {
  const text = await readFile(join(ROOT, path), "utf8");
  return JSON.parse(text.slice(text.indexOf("{"), text.lastIndexOf("}") + 1));
}
const readJSON = async (...p) => JSON.parse(await readFile(join(ROOT, ...p), "utf8"));

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

// How many hours a run reads: everything since the previous run (up to three days), or NEWS_HOURS.
function hoursSince(last, prev) {
  const fixed = Number(process.env.NEWS_HOURS || 0);
  if (fixed) return fixed;
  const h = prev ? (stampToDate(last) - stampToDate(prev)) / 3600000 : 24;
  return Math.min(MAX_CATCHUP_HOURS, Math.max(0.25, h));
}

// Reads one GDELT stream (English or translated) and passes every row to `handle`.
async function readGdelt(kind, previousThrough, handle, counts) {
  const tr = kind === "translated";
  const index = await (await fetch(`${FEED}/lastupdate${tr ? "-translation" : ""}.txt`)).text();
  const last = index.match(tr ? /(\d{14})\.translation\.gkg\.csv\.zip/ : /(\d{14})\.gkg\.csv\.zip/)?.[1];
  if (!last) throw new Error(`Could not read GDELT's lastupdate${tr ? "-translation" : ""}.txt`);
  const hours = hoursSince(last, previousThrough);
  const step = tr ? TR_STEP : STEP;
  const stamps = slots(last, hours, step);
  console.log(`GDELT ${kind}: reading ${stamps.length} files (${hours.toFixed(1)} hours up to ${last}${step > 1 ? `, one file in ${step}` : ""})…`);
  const c = { files: 0, missing: 0, outOfTime: 0 };
  const missingRecent = []; // listed in the last two hours but not downloadable yet
  const recentFrom = stampToDate(last).getTime() - 2 * 3600000;
  for (let i = 0; i < stamps.length; i += PARALLEL) {
    if (Date.now() > DEADLINE) { c.outOfTime = stamps.length - i; console.log(`  time budget reached: ${c.outOfTime} older ${kind} files not read`); break; }
    const batch = stamps.slice(i, i + PARALLEL);
    const bufs = await Promise.all(batch.map((s) => downloadFile(`${FEED}/${s}${tr ? ".translation" : ""}.gkg.csv.zip`).catch((e) => (console.log(`  ${s} skipped: ${e.message}`), null))));
    bufs.forEach((buf, j) => {
      if (!buf) { c.missing++; if (stampToDate(batch[j]).getTime() >= recentFrom) missingRecent.push(batch[j]); return; }
      try { handle(unzipFirst(buf), kind); c.files++; } catch (e) { console.log(`  a file could not be read: ${e.message}`); }
    });
    if ((i / PARALLEL) % 50 === 49) console.log(`  ${c.files} ${kind} files read, ${counts.kept} headlines kept so far`);
  }
  // GDELT sometimes lists a file a few minutes before it can be downloaded. A short run with nothing to
  // read yet is not a failure. The next run starts again just before the oldest recent file that was
  // missing, so files that appear late are still read (re-read files add nothing twice).
  if (!c.files && stamps.length > 4) throw new Error(`No GDELT ${kind} files could be read`);
  let readThrough = c.files ? last : previousThrough || last;
  if (c.files && missingRecent.length && step === 1) {
    const oldest = missingRecent.sort()[0];
    readThrough = slots(oldest, 0.25 * 2, 1)[1]; // the slot 15 minutes before it
    console.log(`  ${missingRecent.length} recent ${kind} file(s) not posted yet; the next run reads again from ${readThrough}`);
  }
  return { ...c, hours, step, readThrough };
}

// ReliefWeb: recent displacement reports, each filed under its main country (ReliefWeb's "primary
// country"), at most five per country, newest first. A few API calls cover every country. If ReliefWeb
// can't be reached, the earlier reports stay.
async function readReports(previous, places, window, now) {
  if (!RELIEFWEB_APPNAME) { console.log("ReliefWeb: skipped (no RELIEFWEB_APPNAME; see README)."); return { enabled: false }; }
  const prev = previous?.reports?.enabled ? previous.reports : null;
  const since = { field: "date.created", value: { from: `${window.from}T00:00:00+00:00` } };
  const base = { profile: "list", fields: { include: RELIEFWEB_FIELDS }, sort: ["date.created:desc"], limit: 1000 };
  const searches = [
    { ...base, filter: since, query: { value: REPORTS_TITLE_QUERY } },
    { ...base, filter: { operator: "AND", conditions: [since, { field: "source.shortname", value: REPORTS_SOURCES, operator: "OR" }] } },
  ];
  const seen = new Map();
  const c = { calls: 0, failed: 0, reports: 0, kept: 0, error: null };
  for (const body of searches) {
    for (let page = 0; page < REPORTS_MAX_PAGES; page++) {
      if (c.calls) await new Promise((r) => setTimeout(r, REPORTS_PAUSE_MS));
      c.calls++;
      const r = await reliefWebPage(RELIEFWEB_APPNAME, { ...body, offset: page * 1000 });
      if (!r.ok) { c.failed++; c.error = r.error; console.log(`ReliefWeb: ${r.error}`); break; }
      for (const x of r.items) if (!seen.has(x.url)) seen.set(x.url, x);
      if (r.items.length < 1000 || (page + 1) * 1000 >= (r.totalCount ?? 0)) break;
    }
  }
  if (!seen.size && c.failed) {
    const byCountry = {};
    for (const iso of places) {
      const k = (prev?.byCountry?.[iso] || []).filter((x) => checkDate(x.date, window).date);
      if (k.length) byCountry[iso] = k;
    }
    return { ...(prev || {}), enabled: true, lastRun: c, byCountry, retrievedAt: prev?.retrievedAt || null };
  }
  const placeSet = new Set(places);
  const grouped = new Map();
  for (const x of seen.values()) {
    const date = checkDate(x.published, window).date;
    if (!date || !x.primaryIso || !placeSet.has(x.primaryIso)) continue;
    if (!grouped.has(x.primaryIso)) grouped.set(x.primaryIso, []);
    grouped.get(x.primaryIso).push({ title: cleanTitle(x.title), url: x.url, date, source: x.sources.slice(0, 2).join(", ") || null, countries: x.countries.length });
  }
  const byCountry = {};
  for (const [iso, list] of grouped) {
    byCountry[iso] = dedupe(list).sort((p, q) => q.date.localeCompare(p.date)).slice(0, REPORTS_PER_COUNTRY);
    c.kept += byCountry[iso].length;
  }
  c.reports = seen.size;
  console.log(`ReliefWeb: ${c.calls} API calls (${c.failed} failed), ${c.reports} reports in the window, ${c.kept} kept for ${Object.keys(byCountry).length} places.`);
  return {
    enabled: true,
    source: "ReliefWeb API (UN OCHA)",
    sourceUrl: "https://reliefweb.int",
    rules: "Reports posted in the window whose title is about displacement or whose author is UNHCR, IOM, NRC, IDMC or UNRWA, filed under ReliefWeb's main country for the report. At most five per country, newest first.",
    retrievedAt: now.toISOString(),
    lastRun: c,
    byCountry,
  };
}

async function main(previous) {
  const now = new Date();
  const window = newsWindow(now, MONTHS);
  const data = await readJS("data/dashboard-data.js");
  const wc = await readJSON("data", "raw", "geo", "world-countries.json");
  const matchers = buildMatchers(data.countries, wc);
  const outlet = makeOutletChecker(await readJSON("data", "outlets.json"));
  const feeds = (await readJSON("data", "feeds.json")).feeds;
  const t0 = Date.now();
  const took = () => `${Math.round((Date.now() - t0) / 1000)} s`;
  console.log(`Window ${window.from} to ${window.to} (${MONTHS} months).`);

  const found = new Map(); // iso → candidate items
  const counts = { articles: 0, otherLanguage: 0, topical: 0, untagged: 0, personal: 0, outlet: 0, unattributed: 0, kept: 0 };
  const leftOut = new Map();
  const file = (item, isos) => {
    for (const iso of isos) {
      if (!found.has(iso)) found.set(iso, []);
      found.get(iso).push(item);
    }
  };
  const handle = (text, kind) => {
    for (const line of text.split("\n")) {
      if (!line) continue;
      const r = line.split("\t");
      counts.articles++;
      const lang = kind === "translated" ? sourceLanguage(r[COL.translation]) : "en";
      if (!TR_LANGS.has(lang) && lang !== "en") { counts.otherLanguage++; continue; }
      const raw = decode(r[COL.extras]?.match(/<PAGE_TITLE>(.*?)<\/PAGE_TITLE>/)?.[1] || "");
      const url = r[COL.url] || "";
      if (!raw || !isDisplacement(raw) || !/^https?:\/\//.test(url)) continue;
      counts.topical++;
      const themes = displacementThemes(r[COL.themes]);
      if (!themes.length) { counts.untagged++; continue; }
      if (isPersonalOrOpinion(raw, url)) { counts.personal++; continue; }
      const domain = r[COL.source] || hostOf(url);
      if (!outlet(domain)) { counts.outlet++; leftOut.set(leftOut.has(domain) ? domain : own(domain), (leftOut.get(domain) || 0) + 1); continue; }
      const isos = attributeCountries(raw, matchers, { domain });
      if (!isos.length) { counts.unattributed++; continue; }
      const d = r[COL.date] || "";
      counts.kept++;
      file({ title: own(cleanTitle(raw)), url: own(url), domain: own(domain), seen: own(`${d.slice(0, 4)}-${d.slice(4, 6)}-${d.slice(6, 8)}`), source: "gdelt", lang, themes: themes.map(own) }, isos);
    }
  };

  // A GDELT outage doesn't stop the feeds and ReliefWeb: the next run reads the missed files.
  let english, gdeltError = null;
  try { english = await readGdelt("English", previous?.checkedThrough, handle, counts); }
  catch (e) {
    gdeltError = e.message;
    console.log(`GDELT English files skipped this run: ${e.message}`);
    english = { files: 0, missing: 0, outOfTime: 0, hours: 0, step: STEP, readThrough: previous?.checkedThrough || null };
  }
  let translated = null;
  if (TRANSLINGUAL) {
    try { translated = await readGdelt("translated", previous?.checkedThroughTranslated, handle, counts); }
    catch (e) { console.log(`GDELT translated files skipped this run: ${e.message}`); }
  }

  console.log(`GDELT done after ${took()}.`);

  // Outlets' own feeds: only headlines with a core displacement term, since feeds carry no GDELT tags.
  const feedCounts = { feeds: feeds.length, read: 0, failed: 0, items: 0, inWindow: 0, kept: 0 };
  await pool(feeds, FEED_PARALLEL, async (f) => {
    const r = await fetchFeed(f.url);
    if (!r.ok) { feedCounts.failed++; console.log(`  feed failed (${r.error}): ${f.label}`); return; }
    feedCounts.read++;
    for (const it of r.items) {
      feedCounts.items++;
      const when = checkDate(it.published, window);
      if (!when.date) continue;
      feedCounts.inWindow++;
      if (!isCoreDisplacement(it.title) || isPersonalOrOpinion(it.title, it.link)) continue;
      const domain = hostOf(it.link) || f.domain;
      if (!outlet(domain)) continue;
      const isos = attributeCountries(it.title, matchers, { domain });
      if (!isos.length) continue;
      feedCounts.kept++;
      file({ title: cleanTitle(it.title), url: it.link, domain, seen: when.date, source: "feed", lang: f.lang }, isos);
    }
  });
  console.log(`Feeds (${took()}): ${feedCounts.read} of ${feedCounts.feeds} read (${feedCounts.failed} failed), ${feedCounts.items} items, ${feedCounts.inWindow} in the window, ${feedCounts.kept} kept.`);

  // Combine with earlier headlines, re-checking each one against today's rules and outlet list.
  // Headlines saved before November 2026 carry no source or GDELT tags; a full read finds them again.
  const stillValid = (a, iso) =>
    (a.source === "gdelt" ? isDisplacement(a.title) && a.themes?.length > 0 : a.source === "feed" ? isCoreDisplacement(a.title) : false) &&
    !isPersonalOrOpinion(a.title, a.url) && outlet(a.domain) && attributeCountries(a.title, matchers, { domain: a.domain }).includes(iso);
  const candidates = new Map();
  for (const iso of matchers.keys()) {
    const list = [...(found.get(iso) || []), ...(previous?.byCountry?.[iso] || []), ...(previous?.pending?.[iso] || [])].filter((a) => stillValid(a, iso));
    if (list.length) candidates.set(iso, dedupe(list));
  }

  // Open each new article once: keep its publisher summary and date, drop dead or mismatched links.
  const checked = new Map(); // url → result, so an article filed under two countries is fetched once
  for (const prev of Object.values(previous?.byCountry || {})) for (const a of prev) if (a.link && a.source) checked.set(a.url, a);
  const toCheck = [...new Set([...candidates.values()].flat().filter((a) => !checked.has(a.url)).map((a) => a.url))];
  const byUrl = new Map([...candidates.values()].flat().map((a) => [a.url, a]));
  const verifyNow = toCheck.sort((x, y) => (byUrl.get(y).seen || "").localeCompare(byUrl.get(x).seen || "")).slice(0, VERIFY_LIMIT);
  const linkCounts = { verified: 0, unverified: 0, broken: 0, mismatched: 0, older: 0 };
  await pool(verifyNow, VERIFY_PARALLEL, async (url) => {
    const a = byUrl.get(url);
    const r = await fetchArticleMeta(url, a.title);
    const o = outlet(a.domain);
    if (r.link === "broken" || r.link === "mismatched") { linkCounts[r.link]++; checked.set(url, { drop: r.link }); return; }
    let date = a.seen, dateKind = a.source === "feed" ? "published" : "seen"; // a feed's date is the publisher's
    let description = null, publisher = o?.name || a.domain;
    if (r.link === "verified") {
      const pub = checkDate(r.meta.published, window);
      if (pub.reason === "older") { linkCounts.older++; checked.set(url, { drop: "older" }); return; }
      if (pub.date) { date = pub.date; dateKind = "published"; }
      description = summarize(r.meta.description, a.title);
      if (r.meta.siteName && r.meta.siteName.length <= 40) publisher = r.meta.siteName; // some sites put the headline there
    }
    linkCounts[r.link]++;
    checked.set(url, {
      title: a.title, url, domain: a.domain, source: a.source, lang: a.lang, ...(a.themes ? { themes: a.themes } : {}),
      publisher, date, dateKind, description, link: r.link, ...(r.reason ? { linkNote: r.reason } : {}),
    });
  });

  console.log(`Article pages checked after ${took()}.`);
  const byCountry = {};
  for (const [iso, list] of candidates) {
    const items = list
      .map((a) => checked.get(a.url))
      .filter((a) => a && !a.drop && checkDate(a.date, window).date)
      .map((a) => {
        const o = outlet(a.domain);
        const publisher = a.publisher && a.publisher.length <= 40 ? a.publisher : o?.name || a.domain;
        return { ...a, publisher, basis: o?.basis || null, tier: o?.tier || null, outlet: o?.name || a.domain, trust: o?.level || null, owner: o?.owner || undefined, listedBy: o?.databases?.length ? o.databases : undefined };
      });
    const top = pickForCountry(dedupe(items), { max: PER_COUNTRY, perOutlet: PER_OUTLET, ignore: matchers.get(iso)?.terms || [] });
    if (top.length) byCountry[iso] = top;
  }
  // Articles not opened yet (over NEWS_VERIFY_LIMIT) wait for the next run instead of being lost.
  const pending = {};
  let pendingCount = 0;
  for (const [iso, list] of candidates) {
    const waiting = list.filter((a) => !checked.has(a.url) && checkDate(a.seen, window).date).sort((x, y) => (y.seen || "").localeCompare(x.seen || ""));
    for (const a of waiting) {
      if (pendingCount >= MAX_PENDING) break;
      (pending[iso] ||= []).push({ title: a.title, url: a.url, domain: a.domain, seen: a.seen, source: a.source, lang: a.lang, ...(a.themes ? { themes: a.themes } : {}) });
      pendingCount++;
    }
  }

  // English machine translations for the articles shown (earlier ones keep theirs).
  const translation = process.env.NEWS_TRANSLATE === "0" ? { translated: 0, skipped: 0 } : await translateItems(Object.values(byCountry).flat(), { cacheDir: process.env.HF_CACHE_DIR });
  console.log(`Translation (${took()}): ${translation.translated} articles translated${translation.skipped ? `, ${translation.skipped} not translated` : ""}.`);

  const places = [...matchers.keys()].sort();
  const reports = await readReports(previous, places, window, now);
  console.log(`ReliefWeb done after ${took()}.`);
  const byLanguage = {};
  for (const list of Object.values(byCountry)) for (const a of list) byLanguage[a.lang || "en"] = (byLanguage[a.lang || "en"] || 0) + 1;

  const payload = {
    status: "ok",
    retrievedAt: now.toISOString(),
    lastAttempt: { at: now.toISOString(), ok: true },
    checkedThrough: english.readThrough || previous?.checkedThrough || null,
    checkedThroughTranslated: translated?.readThrough || previous?.checkedThroughTranslated || null,
    window,
    source: "GDELT 2.0 Global Knowledge Graph (English and translated 15-minute files) and RSS feeds of hand-picked outlets",
    sourceUrl: "https://www.gdeltproject.org/data.html",
    languages: ["en", ...TR_LANGS],
    reputable: "Only outlets on the project's list (data/outlets.json) that were checked on 18 Nov 2026 for their own reporting (agencies, broadcasters and newspapers with correspondents, humanitarian specialists with field staff, local outlets with reporters where displacement happens). Each records its owner and which outside databases list it (Journalism Trust Initiative, ReliefWeb sources, Reuters Institute Digital News Report, EBU, Public Media Alliance, The Trust Project, press councils). UN and intergovernmental bodies count as official sources. Aggregators, press-release sites, tabloids and trade press are blocked.",
    translation: { model: MT_MODEL, by: "OPUS-MT, University of Helsinki (CC BY 4.0)", note: "English machine translations of Spanish, French and Portuguese headlines and summaries; the original is always shown first." },
    rules: "Headline must be about forced displacement (in English, Spanish, French or Portuguese), with GDELT's own refugee or displacement tags agreeing for GDELT articles; tie it to the country it is listed under; and not be a personal profile, opinion piece, podcast or live blog. The article page must open and match the headline, and its publication date must fall in the window. One copy per story; at most three per outlet and eight per country.",
    searched: places,
    lastRun: {
      at: now.toISOString(), hoursRead: +english.hours.toFixed(2), step: STEP, filesRead: english.files, filesMissing: english.missing, filesOutOfTime: english.outOfTime,
      ...(gdeltError ? { gdeltError } : {}),
      translated: translated ? { hoursRead: +translated.hours.toFixed(2), step: translated.step, filesRead: translated.files, filesMissing: translated.missing, filesOutOfTime: translated.outOfTime } : null,
      ...counts, feeds: feedCounts, links: linkCounts, translation, pendingChecks: pendingCount, byLanguage,
    },
    byCountry,
    pending,
    reports,
  };
  // Keep the record of the last run that read a whole window, since normal runs only add recent hours.
  payload.lastBackfill = english.hours >= 24 * 28 ? { ...payload.lastRun, checkedThrough: english.readThrough } : previous?.lastBackfill?.feeds ? previous.lastBackfill : null;
  await writeFile(join(ROOT, "data", "news.js"), `window.DISPLACEMENT_NEWS = ${JSON.stringify(payload)};\n`);
  console.log(`Read ${english.files} English and ${translated?.files ?? 0} translated files, ${counts.articles.toLocaleString()} articles (${counts.otherLanguage.toLocaleString()} in other languages skipped); peak memory ${Math.round(process.memoryUsage().rss / 1e6)} MB.`);
  console.log(`Displacement headlines ${counts.topical}: left out ${counts.untagged} without GDELT's displacement tags, ${counts.personal} profiles/opinion, ${counts.outlet} from outlets that don't count, ${counts.unattributed} not tied to a country; kept ${counts.kept} (plus ${feedCounts.kept} from feeds).`);
  console.log(`Article pages checked ${verifyNow.length}: ${JSON.stringify(linkCounts)}${pendingCount ? `, ${pendingCount} left for the next run` : ""}.`);
  console.log(`Saved data/news.js: ${Object.keys(byCountry).length} of ${matchers.size} places have at least one article (${JSON.stringify(byLanguage)})${reports.enabled ? `; ${Object.keys(reports.byCountry).length} have ReliefWeb reports` : ""}.`);
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
