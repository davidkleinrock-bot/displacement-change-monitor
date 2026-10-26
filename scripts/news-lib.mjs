// Pure logic for the news feature, shared by fetch-news.mjs and the tests in tests/news.test.mjs.
// Nothing here reads files or the network except fetchArticleMeta and downloadFile, which take the
// fetch function as a parameter so tests can simulate failures.

// ---------- Time window ----------
// Default: the previous two calendar months, counted back from today's date and including today.
// On 25 Oct 2026 that is 25 Aug 2026 to 25 Oct 2026. If the earlier month is shorter, the start day is
// clamped to its last day (31 Dec → 31 Oct; 30 Apr → 28 or 29 Feb). All dates are UTC calendar dates.
export const DEFAULT_MONTHS = 2;

export const isoDay = (d) => d.toISOString().slice(0, 10);

export function newsWindow(now = new Date(), months = DEFAULT_MONTHS) {
  const y = now.getUTCFullYear(), m = now.getUTCMonth(), day = now.getUTCDate();
  const first = new Date(Date.UTC(y, m - months, 1));
  const lastDay = new Date(Date.UTC(first.getUTCFullYear(), first.getUTCMonth() + 1, 0)).getUTCDate();
  const from = new Date(Date.UTC(first.getUTCFullYear(), first.getUTCMonth(), Math.min(day, lastDay)));
  return { from: isoDay(from), to: isoDay(now), months };
}

// Checks an article date against the window. Returns { date } or { reason } when it can't be used.
export function checkDate(value, window) {
  if (!value) return { reason: "missing" };
  const t = Date.parse(value);
  if (Number.isNaN(t)) return { reason: "invalid" };
  const date = new Date(t).toISOString().slice(0, 10);
  if (date > window.to) return { reason: "future" };
  if (date < window.from) return { reason: "older" };
  return { date };
}

// ---------- Is this headline about forced displacement? ----------
// Core terms count on their own. "Fled", "evacuated" and similar count only with a conflict word or a
// sense of scale, so wildfire evacuations and suspects "fleeing" are left out. Deadly or mass migrant
// crossings count. Job "displacement" and emigration of the wealthy do not.
const CORE = /\b(refugees?|internally displaced|idps?|asylum|stateless(ness)?|returnees?)\b/i;
const LOOSE = /\b(displace(d|ment|s)|forcibly)\b/i;
// Evacuating diplomats, troops or foreign citizens is not forced displacement either.
const NOT_FORCED = /\b(AI|automation|jobs?|workers?|workforce|labou?r market|billionaires?|millionaires?|wealthy|tax(es)?|tourists?|investors?|expats?|retirees|stocks?|shares|diplomats?|embass(y|ies)|citizens|nationals|staff|personnel)\b/i;
const FLIGHT = /\b(fle(e|es|eing|d)|evacuat\w*|exodus|uproot\w*)\b/i;
const CONFLICT = /\b(wars?|fighting|violence|conflict|attacks?|bombing|bombardment|shelling|air ?strikes?|offensive|clashes|siege|gangs?|militias?|rebels?|famine|massacres?|genocide|persecution|troops|army|militants?|insurgents?|occupation)\b/i;
// Scale means real magnitudes ("230,000", "20M", "thousands"), not any number ("2 detained").
const SCALE = /\b(\d{1,3}(,\d{3})+|\d{3,}|\d+(\.\d+)?\s?(k|m|million|thousand)|thousands|millions?|hundreds|tens of thousands)\b/i;
const CROSSING = /\bmigrants?\b.*\b(boat|shipwreck|drown\w*|dead|died|deaths|missing|capsiz\w*|sinks?|sank)\b|\b(boat|shipwreck|drown\w*|dead|died|deaths|missing|capsiz\w*|sinks?|sank)\b.*\bmigrants?\b/i;

export const isDisplacement = (t) =>
  CORE.test(t) ||
  (!NOT_FORCED.test(t) && (LOOSE.test(t) || (FLIGHT.test(t) && (CONFLICT.test(t) || SCALE.test(t))) || CROSSING.test(t)));

// Profiles of one person, opinion and other sections a brief can't cite as reporting.
const PERSONAL = [
  /^['"‘“]?(she|he|they|i|we|my|our|his|her|their|meet)\b/i,
  /\b(she|he)('s| is| was| has| had)\b/i,
  /:\s*['"‘“]?(she|he|they|i|we)\s/i, // "'Betrayal': She fought…"
  /^from\b.+\bto\b/i,
  /\b(a|an|one)\s+(\w+\s)?(woman|man|mother|mom|father|dad|boy|girl|teen|teenager|student|nurse|family|couple|child|grandmother|grandfather|pastor)\b/i,
  /\b(his|her) (story|journey|life|family|wife|husband|son|daughter|mother|father|dream)\b/i,
];
const SECTION_TITLE = /^(opinion|editorial|podcast|letters?|column|commentary|live|watch|video|photos?|review|quiz)\b\s*[:|–-]/i;
const SECTION_URL = /\/(opinion|opinions|editorials?|letters?|obituar\w*|podcasts?|sports?|lifestyle|life-?style|entertainment|arts?|culture|food|travel|commentisfree|comment|blogs?|videos?|live|liveblog|live-news)\//i;
export const isPersonalOrOpinion = (title, url = "") =>
  PERSONAL.some((re) => re.test(title)) || SECTION_TITLE.test(title) || SECTION_URL.test(url);

// ---------- Which country is a headline about? ----------
export const escapeRe = (t) => t.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

// Extra names people and newsrooms use, including places that stand for a country's crisis.
export const ALIASES = {
  AFG: ["Afghanistan", "Afghan", "Afghans", "Kabul", "Taliban"],
  ARE: ["UAE", "Emirati"],
  BGD: ["Bangladesh", "Bangladeshi", "Cox's Bazar", "Cox’s Bazar"],
  CIV: ["Ivory Coast", "Côte d'Ivoire", "Cote d'Ivoire", "Côte d’Ivoire", "Ivorian"],
  COD: ["Democratic Republic of the Congo", "Democratic Republic of Congo", "DR Congo", "D.R. Congo", "DRC", "Congo-Kinshasa", "eastern Congo", "Goma", "North Kivu", "South Kivu", "Ituri", "Congo", "Congolese"],
  COG: ["Republic of the Congo", "Congo-Brazzaville", "Brazzaville"],
  CZE: ["Czech Republic", "Czechia"],
  DOM: ["Dominican Republic", "Dominican"],
  ETH: ["Ethiopia", "Ethiopian", "Tigray", "Tigrayan", "Amhara"],
  GBR: ["UK", "U.K.", "Britain", "British", "United Kingdom"],
  GEO: ["Georgia", "Georgian", "Tbilisi"],
  HTI: ["Haiti", "Haitian", "Port-au-Prince"],
  KOR: ["South Korea", "South Korean"],
  MMR: ["Myanmar", "Burma", "Burmese", "Rohingya", "Rakhine"],
  MOZ: ["Mozambique", "Mozambican", "Cabo Delgado"],
  NGA: ["Nigeria", "Nigerian", "Borno"],
  PRK: ["North Korea", "North Korean"],
  PSE: ["Gaza", "Gazan", "West Bank", "Palestine", "Palestinian"],
  SDN: ["Sudan", "Sudanese", "Darfur", "Khartoum", "El Fasher", "Kordofan"],
  SOM: ["Somalia", "Somali", "Mogadishu"],
  SSD: ["South Sudan", "South Sudanese"],
  SYR: ["Syria", "Syrian", "Idlib", "Aleppo"],
  TUR: ["Turkey", "Türkiye", "Turkiye", "Turkish"],
  UKR: ["Ukraine", "Ukrainian", "Kyiv", "Kharkiv", "Donbas"],
  USA: ["United States", "U.S.", "US", "USA", "American"],
  VEN: ["Venezuela", "Venezuelan"],
  YEM: ["Yemen", "Yemeni", "Houthi"],
};
// Names that also belong to someone else. The same word is never filed under two countries.
const GUARDS = {
  Sudan: { before: ["South "] },
  Sudanese: { before: ["South "] },
  Guinea: { before: ["New ", "Equatorial ", "Papua New "], after: ["-Bissau", " Bissau"] },
  Guinean: { before: ["Equatorial ", "Papua New ", "New "] },
  Niger: { after: [" Delta", "-Delta", " State", " River"] },
  Korea: { before: ["North ", "South "] },
  Korean: { before: ["North ", "South "] },
  Ireland: { before: ["Northern "] },
  American: { before: ["Latin ", "South ", "Central ", "North ", "African ", "Native ", "Asian ", "Arab "] },
  British: { after: [" Columbia"] },
  Indian: { before: ["American ", "Native "], after: [" Ocean"] },
  Congo: { before: ["Republic of the ", "Republic of ", "DR ", "D.R. ", "Democratic Republic of the ", "Democratic Republic of ", "eastern "], after: ["-Brazzaville", "-Kinshasa"] },
  Macedonian: { before: ["Greek "] },
};
// Shared demonyms go to the state that dominates displacement reporting.
const SHARED_DEMONYM = { Congolese: "COD", Dominican: "DOM" };
// Capitalized abbreviations that must match exactly ("US", not "us").
const CASE_SENSITIVE = new Set(["US", "USA", "UK", "UAE", "DRC", "U.S.", "U.K."]);
// Headlines where a name means somewhere else.
const TITLE_EXCLUDE = {
  GEO: /\b(Atlanta|Savannah|Augusta|Macon|Kemp|Fulton County|Georgia (State|Tech|Bulldogs|Power)|Georgia's (governor|legislature)|Ga\.)\b/i,
  JOR: /\b(Michael Jordan|Jordan River|Jordan Peterson|Air Jordan)\b/i,
};

function pattern(term) {
  const g = GUARDS[term] || {};
  const before = (g.before || []).map((b) => `(?<!${escapeRe(b)})`).join("");
  const after = (g.after || []).map((a) => `(?!${escapeRe(a)})`).join("");
  return `(?<![\\p{L}\\p{N}])${before}${escapeRe(term)}(?:s|['’]s)?${after}(?![\\p{L}\\p{N}])`;
}

// Builds one matcher per country from its names, the world-countries file and the aliases above.
export function buildMatchers(countries, worldCountries) {
  const wcBy = new Map(worldCountries.filter((w) => w.cca3 !== "UNK").map((w) => [w.cca3, w]));
  const taken = new Map(); // term → iso, so a word is never filed under two countries
  const terms = new Map();
  const add = (iso, t) => {
    if (!t) return;
    t = t.replace(/"/g, "").trim();
    if (t.length < 4 && !CASE_SENSITIVE.has(t)) return;
    const owner = SHARED_DEMONYM[t];
    if (owner && owner !== iso) return;
    const key = t.toLowerCase();
    if (taken.has(key) && taken.get(key) !== iso) return;
    taken.set(key, iso);
    if (!terms.has(iso)) terms.set(iso, new Set());
    terms.get(iso).add(t);
  };
  // Aliases first, so they claim shared words before generic names do.
  for (const [iso, list] of Object.entries(ALIASES)) for (const t of list) add(iso, t);
  for (const c of countries) {
    if (c.lat == null) continue; // Unknown origin, Stateless, Tibetan: not places
    const w = wcBy.get(c.id);
    for (const t of [...(c.news || []), w?.name?.common, w?.demonyms?.eng?.m, w?.demonyms?.eng?.f]) add(c.id, t);
    if (!/\(|Rep\.|Dem\.|,/.test(c.name)) add(c.id, c.name); // UNHCR's name when it reads like everyday usage
  }
  const matchers = new Map();
  for (const [iso, set] of terms) {
    const all = [...set];
    const insensitive = all.filter((t) => !CASE_SENSITIVE.has(t)).map(pattern);
    const sensitive = all.filter((t) => CASE_SENSITIVE.has(t)).map(pattern);
    matchers.set(iso, {
      iso,
      terms: all,
      ci: insensitive.length ? new RegExp(insensitive.join("|"), "giu") : null,
      cs: sensitive.length ? new RegExp(sensitive.join("|"), "gu") : null,
      exclude: TITLE_EXCLUDE[iso] || null,
    });
  }
  return matchers;
}

const NOUNS = /^(?:['’]s)?(?:[\s,:;–-]+[\p{L}'’-]+){0,3}?[\s,:;–-]+['"‘“]?(refugees?|asylum(?:[- ]seekers?)?|migrants?|idps?|displaced|displacement|returnees?|civilians|families|people|residents|evacuees|children|women|exodus|influx|camps?|crisis|stateless|minorit(?:y|ies)|population|returns?|fle(?:e|es|eing|d)|forced|seek(?:s|ing)? asylum)\b/iu;
const PREPS = /\b(in|from|into|out of|inside|across|to|toward|towards|off|near|along|at|leave|leaving|left|flee|flees|fleeing|fled|returns? to|returning to|returned to|back to|within|of)\s+(?:the\s+)?(?:[\p{L}-]+\s+)?$/iu;

function findMatches(m, title) {
  const out = [];
  for (const re of [m.ci, m.cs]) {
    if (!re) continue;
    re.lastIndex = 0;
    for (const hit of title.matchAll(re)) out.push({ start: hit.index, end: hit.index + hit[0].length });
  }
  return out;
}

// Files a headline under the countries it is about. A country counts when the headline ties it to
// displaced people ("Sudanese refugees", "fled Sudan", "in Chad"). If no country is tied that way and
// exactly one country is named, it goes there. Otherwise it is not filed: a passing mention is not enough.
export function attributeCountries(title, matchers) {
  const hits = [];
  for (const m of matchers.values()) {
    if (m.exclude && m.exclude.test(title)) continue;
    const found = findMatches(m, title);
    if (!found.length) continue;
    const strong = found.some(({ start, end }) => NOUNS.test(title.slice(end, end + 80)) || PREPS.test(title.slice(Math.max(0, start - 50), start)));
    hits.push({ iso: m.iso, strong });
  }
  const strong = hits.filter((h) => h.strong).map((h) => h.iso);
  if (strong.length) return strong;
  return hits.length === 1 ? [hits[0].iso] : [];
}

// ---------- Duplicates ----------
// Drops a trailing " | Section | Outlet" or " – Outlet" so syndicated copies of one story compare equal.
export function cleanTitle(title) {
  const parts = title.split(/\s+[|–—]\s+|\s+-\s+(?=[^-]+$)/);
  const head = parts[0].trim();
  return head.split(/\s+/).length >= 4 ? head : title.trim();
}
export const normTitle = (t) => cleanTitle(t).toLowerCase().normalize("NFKD").replace(/[^a-z0-9]+/g, " ").trim().slice(0, 80);

export function dedupe(items) {
  const seen = new Map();
  for (const a of items) {
    const k = normTitle(a.title);
    const prev = seen.get(k);
    // Keep the copy with a verified link and summary, then the earliest.
    const score = (x) => (x.link === "verified" ? 2 : 0) + (x.description ? 1 : 0);
    if (!prev || score(a) > score(prev) || (score(a) === score(prev) && (a.date || "") < (prev.date || ""))) seen.set(k, a);
  }
  return [...seen.values()];
}

// ---------- Publisher pages: summary, date, working link ----------
const decodeEntities = (s) =>
  s.replace(/&#x([0-9a-f]+);/gi, (_, h) => String.fromCodePoint(parseInt(h, 16)))
    .replace(/&#(\d+);/g, (_, n) => String.fromCodePoint(+n))
    .replace(/&quot;/g, '"').replace(/&apos;|&#39;/g, "'").replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&nbsp;/g, " ").replace(/&amp;/g, "&")
    .replace(/\s+/g, " ").trim();

export function parseArticleMeta(html) {
  const meta = {};
  for (const tag of html.matchAll(/<meta\b[^>]*>/gi)) {
    const attr = (n) => tag[0].match(new RegExp(`\\b${n}\\s*=\\s*("([^"]*)"|'([^']*)')`, "i"));
    const keyM = attr("property") || attr("name") || attr("itemprop");
    const valM = attr("content");
    if (!keyM || !valM) continue;
    const key = (keyM[2] ?? keyM[3]).toLowerCase();
    if (!(key in meta)) meta[key] = decodeEntities(valM[2] ?? valM[3]);
  }
  let ldDate = null, ldHeadline = null;
  for (const s of html.matchAll(/<script[^>]+application\/ld\+json[^>]*>([\s\S]*?)<\/script>/gi)) {
    try {
      const walk = (o) => {
        if (!o || typeof o !== "object") return;
        if (Array.isArray(o)) return o.forEach(walk);
        if (!ldDate && typeof o.datePublished === "string") ldDate = o.datePublished;
        if (!ldHeadline && typeof o.headline === "string") ldHeadline = o.headline;
        if (o["@graph"]) walk(o["@graph"]);
      };
      walk(JSON.parse(s[1].trim()));
    } catch { /* malformed JSON-LD is common; ignore it */ }
  }
  const titleTag = html.match(/<title[^>]*>([\s\S]*?)<\/title>/i)?.[1];
  return {
    title: meta["og:title"] || meta["twitter:title"] || (ldHeadline && decodeEntities(ldHeadline)) || (titleTag && decodeEntities(titleTag)) || null,
    description: meta["og:description"] || meta["description"] || meta["twitter:description"] || null,
    siteName: meta["og:site_name"] || null,
    published: meta["article:published_time"] || ldDate || meta["datepublished"] || meta["pubdate"] || meta["parsely-pub-date"] || meta["sailthru.date"] || meta["dc.date.issued"] || meta["date"] || null,
  };
}

export function summarize(text, title = "", max = 220) {
  if (!text) return null;
  const t = decodeEntities(text);
  if (t.length < 40 || normTitle(t) === normTitle(title)) return null;
  if (t.length <= max) return t;
  return t.slice(0, max).replace(/\s+\S*$/, "") + "…";
}

const STOP = new Set("a an the of to in on for and or with by at from as is are was were be after over into amid says said".split(" "));
const words = (t) => new Set(normTitle(t).split(" ").filter((w) => w.length > 2 && !STOP.has(w)));
export function titleOverlap(a, b) {
  const A = words(a), B = words(b);
  if (!A.size || !B.size) return 0;
  let n = 0;
  for (const w of A) if (B.has(w)) n++;
  return n / Math.min(A.size, B.size);
}

export const USER_AGENT = "Mozilla/5.0 (compatible; displacement-change-monitor/1.0; +https://github.com/davidkleinrock-bot/displacement-change-monitor)";

// Opens the article. "broken": the page is gone (404/410). "mismatched": the link lands on a different
// story or the homepage. "unverified": the site blocked us, timed out or failed; the link is kept but
// marked. "verified": the page loaded and matches the headline.
export async function fetchArticleMeta(url, title, { fetchImpl = fetch, timeoutMs = 12000 } = {}) {
  let res;
  try {
    res = await fetchImpl(url, { redirect: "follow", headers: { "User-Agent": USER_AGENT, Accept: "text/html" }, signal: AbortSignal.timeout(timeoutMs) });
  } catch (err) {
    return { link: "unverified", reason: err.name === "TimeoutError" ? "timeout" : "network error" };
  }
  if (res.status === 404 || res.status === 410) return { link: "broken", reason: `HTTP ${res.status}` };
  if (!res.ok) return { link: "unverified", reason: `HTTP ${res.status}` };
  let html = "";
  try { html = (await res.text()).slice(0, 600000); } catch { return { link: "unverified", reason: "unreadable page" }; }
  try {
    const finalPath = new URL(res.url || url).pathname;
    if ((finalPath === "/" || finalPath === "") && new URL(url).pathname.length > 1) return { link: "mismatched", reason: "redirected to the homepage" };
  } catch { /* keep going */ }
  const meta = parseArticleMeta(html);
  if (meta.title && titleOverlap(meta.title, title) < 0.3) return { link: "mismatched", reason: "page headline does not match", pageTitle: meta.title };
  return { link: "verified", meta };
}

// ---------- GDELT files ----------
export async function downloadFile(url, { fetchImpl = fetch, tries = 3, pauseMs = 3000 } = {}) {
  for (let attempt = 1; attempt <= tries; attempt++) {
    try {
      const res = await fetchImpl(url, { signal: AbortSignal.timeout(60000) });
      if (res.status === 404) return null; // GDELT occasionally skips a 15-minute slot
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      return Buffer.from(await res.arrayBuffer());
    } catch (err) {
      if (attempt === tries) throw err;
      await new Promise((r) => setTimeout(r, pauseMs * attempt));
    }
  }
}

// What the page should say for a country, given the news file (or its absence).
export function newsState(news, iso) {
  if (!news) return { state: "not-loaded", message: "News could not be loaded." };
  if (!(news.searched || []).includes(iso)) return { state: "not-searched", message: "News is not searched for this row." };
  const items = news.byCountry?.[iso] || [];
  if (items.length) return { state: "found", items };
  return { state: "none", message: "No relevant news found in the selected period." };
}
