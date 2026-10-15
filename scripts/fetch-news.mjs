// Saves recent displacement headlines per country from GDELT's raw 15-minute news files.
// Usage: node scripts/fetch-news.mjs            (run build-data.mjs first)
//        NEWS_HOURS=72 node scripts/fetch-news.mjs   (look further back, e.g. for a first run)
// Writes data/news.js → window.DISPLACEMENT_NEWS
//
// GDELT publishes every article it sees as bulk "Global Knowledge Graph" files every 15 minutes
// (http://data.gdeltproject.org/gdeltv2/). Downloading those files is how GDELT expects bulk users to
// work, so this never touches the rate-limited search API. For each article we keep it if its headline
// is about displacement, then file it under the countries GDELT tagged in it (and any country the
// headline names). Headlines from earlier runs are kept for 14 days, so coverage builds up day by day.

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
const MAX_COUNTRIES_PER_ARTICLE = 3;

// Headline must mention displacement. GDELT's own theme tags are too loose to rely on alone.
const TOPIC = /\b(refugees?|displace(d|ment|s)?|asylum|evacuat\w*|fled|flee(s|ing)?|exodus|idps?|internally displaced|migrants?|returnees?|deport\w*|stateless)\b/i;
// The same idea in GDELT search syntax, used by the dashboard's optional live search.
const TOPIC_QUERY = "(refugees OR refugee OR displaced OR displacement OR asylum OR evacuated)";

// GKG 2.1 columns we read (tab-separated).
const COL = { date: 1, source: 3, url: 4, locations: 9, extras: 26 };

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
    .replace(/&#(\d+);/g, (_, n) => String.fromCharCode(+n)).replace(/\s+/g, " ").trim();
const norm = (t) => t.toLowerCase().replace(/[^a-z0-9]+/g, " ").trim().slice(0, 70);
const escapeRe = (t) => t.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

async function readJS(path) {
  const text = await readFile(join(ROOT, path), "utf8");
  return JSON.parse(text.slice(text.indexOf("{"), text.lastIndexOf("}") + 1));
}

// Country name → ISO3, from UNHCR's names, world-countries names and spellings, plus GDELT's own wording.
async function countryIndex() {
  const data = await readJS("data/dashboard-data.js");
  const wc = JSON.parse(await readFile(join(ROOT, "data", "raw", "geo", "world-countries.json"), "utf8"));
  const known = new Set(data.countries.map((c) => c.id));
  const byName = new Map();
  const add = (name, iso) => { if (name && known.has(iso)) byName.set(name.toLowerCase(), iso); };
  for (const c of data.countries) add(c.name, c.id);
  for (const c of wc) {
    if (c.cca3 === "UNK") continue; // world-countries uses UNK for Kosovo; UNHCR uses it for "Unknown"
    add(c.name.common, c.cca3);
    add(c.name.official, c.cca3);
    for (const s of c.altSpellings || []) if (s.length > 3) add(s, c.cca3);
  }
  const gdelt = {
    "congo": "COG", "democratic republic of the congo": "COD", "congo, democratic republic of the": "COD",
    "burma": "MMR", "ivory coast": "CIV", "cote d'ivoire": "CIV", "turkey": "TUR", "iran": "IRN", "syria": "SYR",
    "russia": "RUS", "south korea": "KOR", "north korea": "PRK", "laos": "LAO", "vietnam": "VNM", "tanzania": "TZA",
    "bolivia": "BOL", "venezuela": "VEN", "moldova": "MDA", "gaza strip": "PSE", "west bank": "PSE", "palestine": "PSE",
    "kosovo": "SRB", "macedonia": "MKD", "swaziland": "SWZ", "czech republic": "CZE", "the bahamas": "BHS", "the gambia": "GMB",
    "united kingdom": "GBR", "united states": "USA", "east timor": "TLS", "cape verde": "CPV", "micronesia": "FSM",
  };
  for (const [n, iso] of Object.entries(gdelt)) add(n, iso);

  // Words in a headline that point at a country: its names plus demonyms ("Sudanese", "Afghan").
  const headlineTerms = [];
  for (const c of data.countries) {
    if (c.lat == null) continue;
    const w = wc.find((x) => x.cca3 === c.id);
    const words = new Set([
      ...(c.news || []).map((t) => t.replace(/"/g, "")),
      w?.name?.common,
      w?.demonyms?.eng?.m,
    ].filter((t) => t && t.length > 3));
    if (words.size) headlineTerms.push([c.id, new RegExp(`\\b(${[...words].map(escapeRe).join("|")})\\b`, "i")]);
  }
  return { byName, headlineTerms, data };
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
  const { byName, headlineTerms } = await countryIndex();
  const index = await (await fetch(`${FEED}/lastupdate.txt`)).text();
  const last = index.match(/(\d{14})\.gkg\.csv\.zip/)?.[1];
  if (!last) throw new Error("Could not read GDELT's lastupdate.txt");
  const stamps = slots(last, HOURS);
  console.log(`Reading ${stamps.length} GDELT news files (${HOURS} hours up to ${last})…`);

  // GDELT tags places with FIPS country codes. Learn FIPS → ISO3 from country-level tags, whose name we can match.
  const fipsToIso = new Map();
  const nameToIso = (raw) => {
    const n = raw.trim().toLowerCase();
    if (byName.has(n)) return byName.get(n);
    const m = n.match(/^(.+?), (.+)$/); // "congo, republic of the" → "republic of the congo"
    return m ? byName.get(`${m[2]} ${m[1]}`) ?? byName.get(m[1]) : undefined;
  };
  const found = new Map(); // ISO3 → Map(normTitle → item)
  const unmatched = new Map();
  let files = 0, articles = 0, kept = 0;

  const handle = (text) => {
    for (const line of text.split("\n")) {
      if (!line) continue;
      const r = line.split("\t");
      articles++;
      const title = decode(r[COL.extras]?.match(/<PAGE_TITLE>(.*?)<\/PAGE_TITLE>/)?.[1] || "");
      if (!title || !TOPIC.test(title) || !/^https?:\/\//.test(r[COL.url] || "")) continue;

      // Countries GDELT tagged in the article, by how often they come up.
      const counts = new Map();
      for (const loc of (r[COL.locations] || "").split(";")) {
        if (!loc) continue;
        const [type, fullname = "", fips = ""] = loc.split("#");
        let iso;
        if (type === "2" || type === "3") iso = "USA"; // US state or city
        else if (type === "1") {
          iso = nameToIso(fullname);
          if (iso && fips) fipsToIso.set(fips, iso);
        } else iso = fipsToIso.get(fips) ?? nameToIso(fullname.split(",").pop());
        if (iso) counts.set(iso, (counts.get(iso) || 0) + 1);
        else if (type === "1" && fullname) unmatched.set(fullname, (unmatched.get(fullname) || 0) + 1);
      }
      const named = new Set(headlineTerms.filter(([, re]) => re.test(title)).map(([iso]) => iso));
      const tagged = [...counts.entries()].sort((a, b) => b[1] - a[1]).slice(0, MAX_COUNTRIES_PER_ARTICLE).map(([iso]) => iso);
      const countries = new Set([...named, ...tagged]);
      if (!countries.size) continue;
      kept++;

      const d = r[COL.date] || "";
      const item = {
        title,
        url: r[COL.url],
        domain: r[COL.source] || new URL(r[COL.url]).hostname,
        date: d ? `${d.slice(0, 4)}-${d.slice(4, 6)}-${d.slice(6, 8)}` : null,
      };
      for (const iso of countries) {
        if (!found.has(iso)) found.set(iso, new Map());
        const key = norm(title);
        if (!found.get(iso).has(key)) found.get(iso).set(key, { ...item, named: named.has(iso) });
      }
    }
  };

  for (let i = 0; i < stamps.length; i += PARALLEL) {
    const batch = stamps.slice(i, i + PARALLEL);
    const bufs = await Promise.all(batch.map((s) => download(`${FEED}/${s}.gkg.csv.zip`).catch((e) => (console.log(`  ${s} skipped: ${e.message}`), null))));
    for (const buf of bufs) {
      if (!buf) continue;
      try { handle(unzipFirst(buf)); files++; } catch (e) { console.log(`  a file could not be read: ${e.message}`); }
    }
    if ((i / PARALLEL) % 6 === 5) console.log(`  ${files} files, ${kept} displacement headlines so far`);
  }
  if (!files) throw new Error("No GDELT files could be read; keeping the previous data/news.js");

  // Merge with earlier runs, keep the last 14 days, best first: headline names the country, then newest.
  let previous = {};
  try { previous = await readJS("data/news.js"); } catch { /* first run */ }
  const cutoff = new Date(Date.now() - KEEP_DAYS * 86400000).toISOString().slice(0, 10);
  const byCountry = {};
  for (const iso of new Set([...found.keys(), ...Object.keys(previous.byCountry || {})])) {
    const merged = new Map();
    for (const a of [...(found.get(iso)?.values() || []), ...(previous.byCountry?.[iso] || [])]) {
      if (a.date && a.date < cutoff) continue;
      const k = norm(a.title);
      if (!merged.has(k)) merged.set(k, a);
    }
    const list = [...merged.values()]
      .sort((a, b) => (b.named === true) - (a.named === true) || (b.date || "").localeCompare(a.date || ""))
      .slice(0, PER_COUNTRY);
    if (list.length) byCountry[iso] = list;
  }

  const payload = {
    retrievedAt: new Date().toISOString(),
    source: "GDELT 2.0 Global Knowledge Graph, 15-minute files",
    sourceUrl: "https://www.gdeltproject.org/data.html",
    window: { hours: HOURS, upTo: last, keepDays: KEEP_DAYS },
    timespan: `${KEEP_DAYS}d`,
    topic: TOPIC_QUERY,
    byCountry,
  };
  await writeFile(join(ROOT, "data", "news.js"), `window.DISPLACEMENT_NEWS = ${JSON.stringify(payload)};\n`);
  const top = [...unmatched.entries()].sort((a, b) => b[1] - a[1]).slice(0, 8).map(([n]) => n);
  console.log(`Read ${files} files, ${articles.toLocaleString()} articles; ${kept} displacement headlines.`);
  console.log(`Saved data/news.js: ${Object.keys(byCountry).length} countries with headlines.`);
  if (top.length) console.log(`Place names not matched to a country (most common): ${top.join("; ")}`);
}

main().catch((err) => {
  console.error(err.message);
  process.exit(1);
});
