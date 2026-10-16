// Saves recent displacement headlines per country from GDELT's raw 15-minute news files.
// Usage: node scripts/fetch-news.mjs            (run build-data.mjs first)
//        NEWS_HOURS=72 node scripts/fetch-news.mjs   (look further back, e.g. for a first run)
// Writes data/news.js → window.DISPLACEMENT_NEWS
//
// GDELT publishes every article it sees as bulk "Global Knowledge Graph" files every 15 minutes
// (http://data.gdeltproject.org/gdeltv2/). Downloading those files is how GDELT expects bulk users to
// work, so this never touches the rate-limited search API. An article is kept only if:
//   - its outlet is on data/processed/news-sources.json (rated reliable, national or international reach);
//   - its headline is about forced displacement (see isDisplacement below);
//   - its headline names the country it is filed under, or that country's people;
//   - it is not a profile of one person, an opinion piece, a podcast or a live blog.
// Headlines from earlier runs are re-checked and kept for 14 days, so coverage builds up day by day.

import { readFile, writeFile } from "node:fs/promises";
import { inflateRawSync } from "node:zlib";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const FEED = "https://data.gdeltproject.org/gdeltv2";
const HOURS = Number(process.env.NEWS_HOURS || 24);
const KEEP_DAYS = 14;
const PER_COUNTRY = 8;
const PARALLEL = 4;
// Headline must be about forced displacement. GDELT's own theme tags are too loose to rely on.
// Core terms count on their own. Words like "fled" or "evacuated" count only with a conflict word or a
// sense of scale, so wildfire evacuations and suspects "fleeing" are left out. Deadly or mass migrant
// crossings count; other migration and deportation stories do not.
const CORE = /\b(refugees?|internally displaced|idps?|asylum|stateless(ness)?|returnees?)\b/i;
// Looser words ("displacement", "fled") also describe job losses, emigration of the wealthy and so on.
const LOOSE = /\b(displace(d|ment|s)|forcibly)\b/i;
const NOT_FORCED = /\b(AI|automation|jobs?|workers?|workforce|labou?r market|billionaires?|millionaires?|wealthy|tax(es)?|tourists?|investors?|expats?|retirees|stocks?|shares)\b/i;
const FLIGHT = /\b(fle(e|es|eing|d)|evacuat\w*|exodus|uproot\w*)\b/i;
const CONFLICT = /\b(wars?|fighting|violence|conflict|attacks?|bombing|bombardment|shelling|air ?strikes?|offensive|clashes|siege|gangs?|militias?|rebels?|famine|massacres?|genocide|persecution|troops|army|militants?|insurgents?|occupation)\b/i;
const SCALE = /\b(\d[\d,.]*|thousands|millions?|hundreds|tens of thousands)\b/i;
const CROSSING = /\bmigrants?\b.*\b(boat|shipwreck|drown\w*|dead|died|deaths|missing|capsiz\w*|sinks?|sank)\b|\b(boat|shipwreck|drown\w*|dead|died|deaths|missing|capsiz\w*|sinks?|sank)\b.*\bmigrants?\b/i;
const isDisplacement = (t) =>
  CORE.test(t) ||
  (!NOT_FORCED.test(t) && (LOOSE.test(t) || (FLIGHT.test(t) && (CONFLICT.test(t) || SCALE.test(t))) || CROSSING.test(t)));
// Profiles of one person, opinion and other sections a brief can't cite as reporting.
const PERSONAL = [
  /^['"‘“]?(she|he|they|i|we|my|our|his|her|their|meet)\b/i,
  /\b(she|he)('s| is| was| has| had)\b/i,
  /^from\b.+\bto\b/i,
  /\b(a|an|one)\s+(\w+\s)?(woman|man|mother|mom|father|dad|boy|girl|teen|teenager|student|nurse|family|couple|child|grandmother|grandfather|pastor)\b/i,
  /\b(his|her) (story|journey|life|family|wife|husband|son|daughter|mother|father|dream)\b/i,
];
const SECTION_TITLE = /^(opinion|editorial|podcast|letters?|column|commentary|live|watch|video|photos?|review|quiz)\b\s*[:|–-]/i;
const SECTION_URL = /\/(opinion|opinions|editorials?|letters?|obituar\w*|podcasts?|sports?|lifestyle|life-?style|entertainment|arts?|culture|food|travel|commentisfree|comment|blogs?|videos?|live|liveblog|live-news)\//i;
const isPersonalOrOpinion = (title, url) => PERSONAL.some((re) => re.test(title)) || SECTION_TITLE.test(title) || SECTION_URL.test(url || "");
// The same idea in GDELT search syntax, used by the dashboard's optional live search.
const TOPIC_QUERY = "(refugees OR refugee OR displaced OR displacement OR asylum OR evacuated)";

// GKG 2.1 columns we read (tab-separated).
const COL = { date: 1, source: 3, url: 4, extras: 26 };

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

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

async function download(url) {
  for (let attempt = 1; attempt <= 3; attempt++) {
    try {
      const res = await fetch(url, { signal: AbortSignal.timeout(60000) });
      if (res.status === 404) return null; // GDELT occasionally skips a 15-minute slot
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      return Buffer.from(await res.arrayBuffer());
    } catch (err) {
      if (attempt === 3) throw err;
      await sleep(3000 * attempt);
    }
  }
}

const decode = (s) =>
  s.replace(/&amp;/g, "&").replace(/&quot;/g, '"').replace(/&#0?39;|&apos;/g, "'").replace(/&lt;/g, "<").replace(/&gt;/g, ">")
    .replace(/&#(\d+);/g, (_, n) => String.fromCodePoint(+n)).replace(/&#x([0-9a-f]+);/gi, (_, h) => String.fromCodePoint(parseInt(h, 16)))
    .replace(/\s+/g, " ").trim();
// Copy a string out of the big file text. Without this, V8 keeps each whole 15-minute file in memory
// for as long as any headline cut from it is kept, and a multi-day run runs out of memory.
const own = (s) => (s == null ? s : Buffer.from(s, "utf8").toString("utf8"));
const norm = (t) => t.toLowerCase().replace(/[^a-z0-9]+/g, " ").trim().slice(0, 70);
const escapeRe = (t) => t.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

// Reputable outlets: the domain itself or a parent domain (edition.cnn.com → cnn.com) must be allowed,
// and none may be excluded. Returns why the outlet is allowed, or null.
async function reputableChecker() {
  const list = JSON.parse(await readFile(join(ROOT, "data", "processed", "news-sources.json"), "utf8"));
  return (domain) => {
    const d = (domain || "").toLowerCase().replace(/^www\./, "");
    const parts = d.split(".");
    for (let i = 0; i < parts.length - 1; i++) {
      const candidate = parts.slice(i).join(".");
      if (list.excluded[candidate]) return null;
      if (list.allowed[candidate]) return list.allowed[candidate].basis.join("+");
    }
    if (list.intergovernmental.suffixes.some((s) => d.endsWith(s))) return "intergovernmental";
    if (list.intergovernmental.domains.some((x) => d === x || d.endsWith("." + x))) return "intergovernmental";
    return null;
  };
}

async function readJS(path) {
  const text = await readFile(join(ROOT, path), "utf8");
  return JSON.parse(text.slice(text.indexOf("{"), text.lastIndexOf("}") + 1));
}

// Words in a headline that point at a country: its names plus demonyms ("Sudanese", "Afghans").
async function headlineTerms() {
  const data = await readJS("data/dashboard-data.js");
  const wc = JSON.parse(await readFile(join(ROOT, "data", "raw", "geo", "world-countries.json"), "utf8"));
  const terms = new Map();
  for (const c of data.countries) {
    if (c.lat == null) continue; // Unknown origin, Stateless, Tibetan: not places
    const w = wc.find((x) => x.cca3 === c.id);
    const words = new Set([
      ...(c.news || []).map((t) => t.replace(/"/g, "")),
      w?.name?.common,
      w?.demonyms?.eng?.m,
    ].filter((t) => t && t.length > 3));
    // Singular or plural: "South African", "South Africans".
    if (words.size) terms.set(c.id, new RegExp(`\\b(${[...words].map(escapeRe).join("|")})s?\\b`, "i"));
  }
  return terms;
}

function slots(lastStamp, hours) {
  // lastStamp like 20261015054500; step back in 15-minute slots.
  const t = Date.UTC(+lastStamp.slice(0, 4), +lastStamp.slice(4, 6) - 1, +lastStamp.slice(6, 8), +lastStamp.slice(8, 10), +lastStamp.slice(10, 12));
  const out = [];
  for (let k = 0; k < hours * 4; k++) {
    const d = new Date(t - k * 15 * 60000);
    const p = (n) => String(n).padStart(2, "0");
    out.push(`${d.getUTCFullYear()}${p(d.getUTCMonth() + 1)}${p(d.getUTCDate())}${p(d.getUTCHours())}${p(d.getUTCMinutes())}00`);
  }
  return out;
}

async function main() {
  const terms = await headlineTerms();
  const reputable = await reputableChecker();
  const index = await (await fetch(`${FEED}/lastupdate.txt`)).text();
  const last = index.match(/(\d{14})\.gkg\.csv\.zip/)?.[1];
  if (!last) throw new Error("Could not read GDELT's lastupdate.txt");
  const stamps = slots(last, HOURS);
  console.log(`Reading ${stamps.length} GDELT news files (${HOURS} hours up to ${last})…`);

  const found = new Map(); // ISO3 → Map(normTitle → item)
  const counts = { files: 0, articles: 0, topical: 0, personal: 0, outlet: 0, unnamed: 0, kept: 0 };
  const leftOut = new Map(); // outlet → displacement headlines left out, for reviewing the outlet rules

  const handle = (text) => {
    for (const line of text.split("\n")) {
      if (!line) continue;
      const r = line.split("\t");
      counts.articles++;
      const title = decode(r[COL.extras]?.match(/<PAGE_TITLE>(.*?)<\/PAGE_TITLE>/)?.[1] || "");
      const url = r[COL.url] || "";
      if (!title || !isDisplacement(title) || !/^https?:\/\//.test(url)) continue;
      counts.topical++;
      if (isPersonalOrOpinion(title, url)) { counts.personal++; continue; }
      const domain = r[COL.source] || new URL(url).hostname;
      const basis = reputable(domain);
      if (!basis) { counts.outlet++; leftOut.set(leftOut.has(domain) ? domain : own(domain), (leftOut.get(domain) || 0) + 1); continue; }
      // File it only under countries the headline itself names; GDELT's location tags catch passing mentions.
      const countries = [...terms].filter(([, re]) => re.test(title)).map(([iso]) => iso);
      if (!countries.length) { counts.unnamed++; continue; }
      counts.kept++;

      const d = r[COL.date] || "";
      const item = {
        title: own(title),
        url: own(url),
        domain: own(domain),
        basis: own(basis),
        date: d ? own(`${d.slice(0, 4)}-${d.slice(4, 6)}-${d.slice(6, 8)}`) : null,
      };
      for (const iso of countries) {
        if (!found.has(iso)) found.set(iso, new Map());
        const key = own(norm(title));
        if (!found.get(iso).has(key)) found.get(iso).set(key, item);
      }
    }
  };

  for (let i = 0; i < stamps.length; i += PARALLEL) {
    const batch = stamps.slice(i, i + PARALLEL);
    const bufs = await Promise.all(batch.map((s) => download(`${FEED}/${s}.gkg.csv.zip`).catch((e) => (console.log(`  ${s} skipped: ${e.message}`), null))));
    for (const buf of bufs) {
      if (!buf) continue;
      try { handle(unzipFirst(buf)); counts.files++; } catch (e) { console.log(`  a file could not be read: ${e.message}`); }
    }
    if ((i / PARALLEL) % 6 === 5) console.log(`  ${counts.files} files, ${counts.kept} headlines kept so far`);
  }
  if (!counts.files) throw new Error("No GDELT files could be read; keeping the previous data/news.js");

  // Merge with earlier runs and keep the last 14 days, newest first. Earlier headlines are re-checked
  // against today's rules and outlet list, so tightening a rule also cleans what is already saved.
  let previous = {};
  try { previous = await readJS("data/news.js"); } catch { /* first run */ }
  const cutoff = new Date(Date.now() - KEEP_DAYS * 86400000).toISOString().slice(0, 10);
  const byCountry = {};
  for (const iso of new Set([...found.keys(), ...Object.keys(previous.byCountry || {})])) {
    const merged = new Map();
    for (const a of [...(found.get(iso)?.values() || []), ...(previous.byCountry?.[iso] || [])]) {
      if (a.date && a.date < cutoff) continue;
      if (!isDisplacement(a.title) || isPersonalOrOpinion(a.title, a.url) || !terms.get(iso)?.test(a.title)) continue;
      const basis = reputable(a.domain);
      if (!basis) continue;
      const k = norm(a.title);
      if (!merged.has(k)) merged.set(k, { title: a.title, url: a.url, domain: a.domain, basis, date: a.date });
    }
    const list = [...merged.values()].sort((a, b) => (b.date || "").localeCompare(a.date || "")).slice(0, PER_COUNTRY);
    if (list.length) byCountry[iso] = list;
  }

  const payload = {
    retrievedAt: new Date().toISOString(),
    source: "GDELT 2.0 Global Knowledge Graph, 15-minute files",
    sourceUrl: "https://www.gdeltproject.org/data.html",
    window: { hours: HOURS, upTo: last, keepDays: KEEP_DAYS },
    timespan: `${KEEP_DAYS}d`,
    topic: TOPIC_QUERY,
    reputable: "Only outlets rated reliable by Wikipedia's Perennial Sources list, or by Lin et al. (2023) with national or international reach (Tranco top 10,000), or intergovernmental and UN system organizations. See data/processed/news-sources.json.",
    rules: "Headline must be about forced displacement, name the country it is filed under, and not be a personal profile, opinion piece, podcast or live blog.",
    byCountry,
  };
  await writeFile(join(ROOT, "data", "news.js"), `window.DISPLACEMENT_NEWS = ${JSON.stringify(payload)};\n`);
  console.log(`Read ${counts.files} files, ${counts.articles.toLocaleString()} articles (peak memory ${Math.round(process.memoryUsage().rss / 1e6)} MB).`);
  console.log(`Displacement headlines: ${counts.topical}. Left out: ${counts.personal} profiles/opinion, ${counts.outlet} from outlets not rated reliable or local, ${counts.unnamed} not naming a country. Kept: ${counts.kept}.`);
  console.log(`Saved data/news.js: ${Object.keys(byCountry).length} countries with headlines.`);
  const top = [...leftOut].sort((a, b) => b[1] - a[1]).slice(0, 25).map(([d, n]) => `${d} ${n}`);
  if (top.length) console.log(`Outlets with the most displacement headlines left out: ${top.join(", ")}`);
}

main().catch((err) => {
  console.error(err.message);
  process.exit(1);
});
