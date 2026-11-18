// News APIs for the news feature: Media Cloud and NewsData.io, two extra sources of candidate headlines
// next to GDELT and the outlet feeds. Here: the two clients, the queries, the quota ledgers that
// fetch-news.mjs keeps in data/news.js between runs, and the rules that decide which returned articles
// are filed (the same rules as for feed items). Nothing here reads files. The clients take the fetch,
// sleep and clock functions as parameters so tests can simulate the APIs, failures and time, and they
// never throw: a failing API is counted and the run carries on with the other sources.
//
// Both APIs need a key, which the repository keeps as a GitHub secret. Without one, the source is
// skipped and its saved state is kept unchanged.
import { USER_AGENT, READ_LANGS, isoDay, checkDate, isCoreDisplacement, isPersonalOrOpinion, attributeCountries } from "./news-lib.mjs";

const wait = (ms) => new Promise((r) => setTimeout(r, ms));
const DAY_MS = 86400000;
export const hostOf = (url) => { try { return new URL(url).hostname.toLowerCase().replace(/^www\./, ""); } catch { return ""; } };
const isHttp = (u) => typeof u === "string" && /^https?:\/\//i.test(u.trim());
const cleanText = (s) => (typeof s === "string" ? s.replace(/\s+/g, " ").trim() : "");

// Dates without an offset ("2026-11-17", "2026-11-17 10:00:00") are UTC in both APIs. Date.parse would
// read a date-time without an offset as local time, so the offset is added before parsing.
export function utcIso(value) {
  if (typeof value !== "string" || !value.trim()) return null;
  let s = value.trim();
  if (/^\d{4}-\d{2}-\d{2}[T ]\d{2}:\d{2}(?::\d{2}(?:\.\d+)?)?$/.test(s)) s = s.replace(" ", "T") + "Z";
  const t = Date.parse(s);
  return Number.isNaN(t) ? null : new Date(t).toISOString();
}

// Retry-After: seconds, or an HTTP date.
export function retryAfterMs(value, now = Date.now()) {
  if (value == null || value === "") return null;
  if (/^\d+$/.test(String(value).trim())) return Number(value) * 1000;
  const t = Date.parse(value);
  return Number.isNaN(t) ? null : Math.max(0, t - now);
}

// One GET request returning JSON, with a timeout and backoff on HTTP 429 (and 5xx): it waits for
// Retry-After, else backoffMs, 2×backoffMs…, at most maxWaitMs, then tries again up to `retries` times.
// `attempts` is how many requests were sent, for the quota ledgers. Never throws.
export async function getJson(url, { headers = {}, fetchImpl = fetch, sleep = wait, timeoutMs = 30000, retries = 2, backoffMs = 5000, maxWaitMs = 120000, giveUp = () => false } = {}) {
  for (let attempt = 0; ; attempt++) {
    const attempts = attempt + 1;
    let res, text;
    try {
      res = await fetchImpl(url, { headers: { "User-Agent": USER_AGENT, Accept: "application/json", ...headers }, redirect: "follow", signal: AbortSignal.timeout(timeoutMs) });
      text = await res.text();
    } catch (e) {
      const r = { ok: false, error: e?.name === "TimeoutError" ? "timeout" : "network error", attempts };
      if (attempt >= retries) return r;
      await sleep(Math.min(backoffMs * 2 ** attempt, maxWaitMs));
      continue;
    }
    let json;
    try { json = text ? JSON.parse(text) : undefined; } catch { json = undefined; }
    if (res.ok) {
      if (json === undefined || json === null || typeof json !== "object") return { ok: false, status: res.status, error: "unreadable response", attempts };
      return { ok: true, status: res.status, json, headers: res.headers, attempts };
    }
    const r = { ok: false, status: res.status, json: json ?? null, error: `HTTP ${res.status}`, attempts };
    if (!(res.status === 429 || res.status >= 500) || giveUp(r) || attempt >= retries) return r;
    const ra = retryAfterMs(res.headers?.get?.("retry-after"));
    await sleep(Math.min(ra ?? backoffMs * 2 ** attempt, maxWaitMs));
  }
}

// ---------- Quota ledgers ----------
// Calls are counted in buckets keyed by UTC day ("2026-11-18") or UTC hour ("2026-11-18T13"). Caps are
// checked over a rolling period (7 days for Media Cloud, 24 hours for NewsData). A rolling period always
// contains the calendar week or day in any time zone, so whenever the provider resets its counter, the
// cap holds for it too.
const dayKey = (t) => new Date(t).toISOString().slice(0, 10);
const hourKey = (t) => new Date(t).toISOString().slice(0, 13);
export function addUsage(buckets = {}, key, n, keep) {
  const out = { ...buckets, [key]: (buckets[key] || 0) + n };
  for (const k of Object.keys(out)) if (!keep(k)) delete out[k];
  return out;
}
// Media Cloud: { today, week } from day buckets; week = the last 7 UTC days including today.
export function weekUsage(days = {}, now = Date.now()) {
  const today = dayKey(now), from = dayKey(now - 6 * DAY_MS);
  let week = 0;
  for (const [k, n] of Object.entries(days)) if (k >= from && k <= today) week += n;
  return { today: days[today] || 0, week };
}
const keepDays = (now) => (k) => k >= dayKey(now - 13 * DAY_MS);
// NewsData: { today, last24h } from hour buckets.
export function dayUsage(hours = {}, now = Date.now()) {
  const today = dayKey(now), from = hourKey(now - 23 * 3600000), to = hourKey(now);
  let last24h = 0, utcToday = 0;
  for (const [k, n] of Object.entries(hours)) {
    if (k >= from && k <= to) last24h += n;
    if (k.slice(0, 10) === today) utcToday += n;
  }
  return { today: utcToday, last24h };
}
const keepHours = (now) => (k) => k >= hourKey(now - 47 * 3600000);

// ---------- Media Cloud ----------
// Media Cloud's online news search (MIT, UMass Amherst, Northeastern): https://search.mediacloud.org
// Endpoints, auth and parameters follow the official Python client, github.com/mediacloud/api-client
// (mediacloud/api.py: SearchApi.story_list, DirectoryApi.source_list, BaseApi.api_params), and the server
// code it calls, github.com/mediacloud/web-search (mcweb/backend/search/views.py, utils.py,
// sources/api.py) and github.com/mediacloud/mc-providers (mc_providers/onlinenews.py):
//   - Auth: header "Authorization: Token <key>".
//   - GET search/story-list?q=…&start=YYYY-MM-DD&end=YYYY-MM-DD&platform=onlinenews-mediacloud&ss=<source ids>
//     &cs=<collection ids>&page_size=1000&pagination_token=… → { stories: [{ id, title, url, language,
//     media_name, media_url, publish_date, indexed_date }], pagination_token }. Users who aren't staff must
//     give `ss` or `cs`. `start`/`end` filter the publication date. Pages hold up to 1,000 stories, newest
//     indexed first; `pagination_token` is null on the last page. Queries are at most 16,384 characters.
//   - Query syntax (https://www.mediacloud.org/documentation/query-guide): AND/OR in capitals, "phrases",
//     trailing * wildcards, `article_title:` for titles and `language:` with ISO 639-1 codes.
//   - GET sources/sources/?name=<domain> → { count, next, results: [{ id, name, url_search_string, … }] };
//     a source's name is its domain.
//   - GET search/api-params → { params: { "query-rate": "2/m" } }, the per-minute limit for this key; the
//     official client reads it and never goes above 10 a minute.
//   - Quota (https://mediacloud.org/documentation/faqs): 4,000 requests a week by default, counted per
//     calendar week. Each search call counts 1 and each directory call 2 (web-search sources/api.py,
//     DIRECTORY_HITS); api-params counts nothing. Searches are limited to 2 a minute for regular users.
export const MEDIACLOUD_API = "https://search.mediacloud.org/api/";
export const MEDIACLOUD_PLATFORM = "onlinenews-mediacloud";
export const MEDIACLOUD_MAX_QUERY = 16384;
export const MEDIACLOUD_DIRECTORY_COST = 2;
export const MEDIACLOUD_DEFAULTS = {
  maxCalls: 30,        // quota units of searching per run (1 per search page)
  lookups: 60,         // outlet domains looked up in Media Cloud's directory per run (2 units each)
  refreshLookups: 5,   // of those, domains looked up again because their entry is older than refreshDays
  refreshDays: 30,
  dailyCap: 430,       // quota units per UTC day (3,000 / 7)
  weeklyCap: 3000,     // quota units over the last 7 days; Media Cloud's limit is 4,000 a week
  maxPages: 2,         // pages of 1,000 stories per place query
  pageSize: 1000,
  overlapDays: 2,      // a repeat query starts this many days before the previous one, for stories indexed late
  maxMinutes: 25,      // stop starting new searches after this long
  collections: [],     // Media Cloud collection ids to search as well (optional)
};

// Title words for displacement in the six languages the rules read. Retrieval only: the rules in
// news-lib.mjs decide what is kept. Lower case; a trailing * matches any ending.
export const MEDIACLOUD_TOPIC_TERMS = [
  "refugee*", "displaced", "displacement", "idp", "idps", "asylum", "stateless*", "returnee*", "fled", "flee*", "evacuat*", "exodus", "uproot*",
  "refugiad*", "desplazad*", "desplazamiento*", "asilo", "apátrida*", "apatrida*", "éxodo", "exodo", "huyen", "huyeron",
  "réfugié*", "refugie*", "déplacé*", "deplace*", "asile", "apatride*", "exode", "fuient",
  "deslocad*", "deslocamento*", "êxodo",
  "لاجئ*", "اللاجئ*", "نازح*", "النازح*", "نزوح", "النزوح", "لجوء", "اللجوء", "تهجير", "مهجر*", "المهجر*",
  "беженц*", "беженк*", "переселенц*", "вынужденн*", "убежищ*", "эвакуац*",
];

// A place name as a query term: one word becomes a lower-case prefix search (so "Syrian" also finds
// "Syrians"); anything else becomes a quoted phrase.
const placeTerm = (t) => {
  const s = String(t).replace(/["\\]/g, "").trim();
  if (!s) return null;
  return /^\p{L}{4,}$/u.test(s) ? `${s.toLowerCase()}*` : `"${s}"`;
};

export function mediaCloudQuery(placeNames, langs = READ_LANGS, { maxLength = MEDIACLOUD_MAX_QUERY } = {}) {
  const head = `article_title:(${MEDIACLOUD_TOPIC_TERMS.join(" OR ")}) AND language:(${langs.join(" OR ")}) AND article_title:(`;
  const terms = [];
  let len = head.length + 1;
  for (const t of [...new Set((placeNames || []).map(placeTerm).filter(Boolean))]) {
    const add = (terms.length ? 4 : 0) + t.length;
    if (len + add > maxLength) break;
    terms.push(t);
    len += add;
  }
  return terms.length ? `${head}${terms.join(" OR ")})` : null;
}

export function mediaCloudStoryUrl({ q, start, end, ss = [], cs = [], pageSize = 1000, token = null }) {
  const p = new URLSearchParams({ q, start, end, platform: MEDIACLOUD_PLATFORM });
  if (ss.length) p.set("ss", ss.join(","));
  if (cs.length) p.set("cs", cs.join(","));
  if (pageSize) p.set("page_size", String(pageSize));
  if (token) p.set("pagination_token", token);
  return `${MEDIACLOUD_API}search/story-list?${p}`;
}

export function parseMediaCloudStories(json) {
  const items = [];
  for (const s of Array.isArray(json?.stories) ? json.stories : []) {
    const title = cleanText(s?.title), url = typeof s?.url === "string" ? s.url.trim() : "";
    if (!title || !isHttp(url)) continue;
    const lang = typeof s.language === "string" ? s.language.trim().toLowerCase().slice(0, 2) : "";
    items.push({ title, url, domain: hostOf(url) || String(s.media_url || s.media_name || "").toLowerCase().replace(/^www\./, ""), published: utcIso(s.publish_date), lang: /^[a-z]{2}$/.test(lang) ? lang : null });
  }
  return { items, token: typeof json?.pagination_token === "string" && json.pagination_token ? json.pagination_token : null };
}

// The source whose name is exactly the domain, not a section of it (those carry a url_search_string).
export function pickMediaCloudSource(json, domain) {
  const d = domain.toLowerCase();
  const hit = (Array.isArray(json?.results) ? json.results : []).find((s) => String(s?.name || "").toLowerCase() === d && !s.url_search_string && Number.isInteger(s.id));
  return hit ? hit.id : null;
}

export function parseQueryRate(json, max = 10, fallback = 2) {
  const m = String(json?.params?.["query-rate"] ?? "").match(/^(\d+)\/m$/);
  return m && +m[1] > 0 ? Math.min(+m[1], max) : fallback;
}

// Places to search this run, best first: places with no saved articles, then those with fewest, then
// those searched longest ago. A place is searched at most once a UTC day. The first search covers the
// whole window; later ones start overlapDays before the previous search.
export function planMediaCloud(state = {}, { places, counts = {}, now = new Date(), window, overlapDays = 2 }) {
  const today = isoDay(now);
  const out = [];
  for (const iso of places) {
    const last = state.places?.[iso]?.last || "";
    if (last.slice(0, 10) === today) continue;
    let start = window.from;
    if (last) {
      const s = isoDay(new Date(Date.parse(last.slice(0, 10)) - overlapDays * DAY_MS));
      if (s > start) start = s;
    }
    out.push({ iso, start, end: today, last, count: counts[iso] || 0 });
  }
  return out.sort((a, b) => a.count - b.count || a.last.localeCompare(b.last) || a.iso.localeCompare(b.iso));
}

// Reads Media Cloud for this run. `places` is [{ iso, terms }] (terms: the place's names, from
// buildMatchers); `counts` is { iso: articles saved }; `domains` the outlet domains the outlet rule
// accepts. Returns { state, items, counts }.
// Searches are limited to the accepted outlets through Media Cloud's source filter: each domain is looked
// up once in its directory (and again after refreshDays), and searching starts when every domain has
// been looked up, so a place's first search covers the whole window with every outlet.
export async function readMediaCloud({ key, state: prev = null, places = [], counts = {}, domains = [], window, now = new Date(), config = {}, fetchImpl = fetch, sleep = wait, clock = Date.now, log = () => {} }) {
  if (!key) return { state: prev, items: [], counts: { enabled: false, skipped: "no key" } };
  const cfg = { ...MEDIACLOUD_DEFAULTS, ...config };
  const t0 = clock();
  const st = { sources: { ...(prev?.sources || {}) }, places: { ...(prev?.places || {}) }, usage: { ...(prev?.usage || {}) } };
  const used = weekUsage(st.usage, now.getTime());
  const c = { enabled: true, calls: 0, units: 0, lookups: 0, searches: 0, places: 0, items: 0, failed: 0, truncated: 0, error: null, usedToday: used.today, usedWeek: used.week };
  let left = Math.max(0, Math.min(cfg.dailyCap - used.today, cfg.weeklyCap - used.week));
  const spend = (n) => { st.usage = addUsage(st.usage, dayKey(now.getTime()), n, keepDays(now.getTime())); left -= n; c.units += n; };
  const headers = { Authorization: `Token ${key}` };
  const finish = () => {
    const u = weekUsage(st.usage, now.getTime());
    c.usedToday = u.today; c.usedWeek = u.week;
    const unique = [...new Map(items.map((x) => [x.url, x])).values()]; // one copy per article
    return { state: st, items: unique, counts: { ...c, items: unique.length } };
  };
  const items = [];
  const stopOn = (r) => r.status === 401 || r.status === 403 || r.status === 429;
  if (left <= 0) { c.skipped = "quota"; log(`Media Cloud: skipped, quota used (${used.today} today, ${used.week} in 7 days).`); return finish(); }

  // 1. Outlet domains → Media Cloud source ids.
  const want = [...new Set(domains.map((d) => d.toLowerCase()))].sort();
  const today = isoDay(now);
  const stale = (e) => Date.parse(today) - Date.parse(e.at || "1970-01-01") >= cfg.refreshDays * DAY_MS;
  const missing = want.filter((d) => !st.sources[d]);
  const old = want.filter((d) => st.sources[d] && stale(st.sources[d])).sort((a, b) => (st.sources[a].at || "").localeCompare(st.sources[b].at || ""));
  const todo = [...missing.slice(0, cfg.lookups), ...old.slice(0, Math.max(0, Math.min(cfg.refreshLookups, cfg.lookups - missing.length)))];
  let halt = false;
  for (const d of todo) {
    if (left < MEDIACLOUD_DIRECTORY_COST) break;
    const r = await getJson(`${MEDIACLOUD_API}sources/sources/?name=${encodeURIComponent(d)}&limit=50`, { headers, fetchImpl, sleep, retries: 1, backoffMs: 30000 });
    c.calls += r.attempts; c.lookups++;
    spend(MEDIACLOUD_DIRECTORY_COST * r.attempts);
    if (!r.ok) { c.failed++; c.error = `directory: ${r.error}`; if (stopOn(r)) { halt = true; break; } continue; }
    st.sources[d] = { id: pickMediaCloudSource(r.json, d), at: today };
  }
  if (halt) { log(`Media Cloud: stopped (${c.error}).`); return finish(); }
  const notLooked = want.filter((d) => !st.sources[d]).length;
  c.sources = want.filter((d) => st.sources[d]?.id).length;
  if (notLooked && !cfg.collections.length) {
    c.waitingForSources = notLooked;
    log(`Media Cloud: ${c.lookups} outlet domains looked up, ${notLooked} still to look up before searching starts.`);
    return finish();
  }
  const ss = want.map((d) => st.sources[d]?.id).filter(Number.isInteger);
  if (!ss.length && !cfg.collections.length) { c.error ||= "no outlet found in Media Cloud's directory"; return finish(); }

  // 2. The key's per-minute limit (free to ask), then one search per place.
  const rate = await getJson(`${MEDIACLOUD_API}search/api-params`, { headers, fetchImpl, sleep, retries: 0 });
  c.calls += rate.attempts;
  const perMinute = rate.ok ? parseQueryRate(rate.json) : 2;
  const pauseMs = Math.ceil(60000 / perMinute) + 500;
  c.perMinute = perMinute;
  const terms = new Map(places.map((p) => [p.iso, p.terms]));
  let searched = 0, stop = false;
  for (const p of planMediaCloud(st, { places: places.map((x) => x.iso), counts, now, window, overlapDays: cfg.overlapDays })) {
    if (stop || left < 1 || c.searches >= cfg.maxCalls || clock() - t0 > cfg.maxMinutes * 60000) break;
    const q = mediaCloudQuery(terms.get(p.iso));
    if (!q) continue;
    let token = null, ok = true, n = 0;
    for (let page = 0; page < cfg.maxPages; page++) {
      if (left < 1 || c.searches >= cfg.maxCalls) { ok = page > 0; break; }
      if (searched++) await sleep(pauseMs);
      const r = await getJson(mediaCloudStoryUrl({ q, start: p.start, end: p.end, ss, cs: cfg.collections, pageSize: cfg.pageSize, token }), { headers, fetchImpl, sleep, retries: 2, backoffMs: pauseMs, timeoutMs: 60000 });
      c.calls += r.attempts; c.searches += r.attempts;
      spend(r.attempts);
      if (!r.ok) { ok = false; c.failed++; c.error = `search: ${r.error}`; if (stopOn(r)) stop = true; break; }
      const parsed = parseMediaCloudStories(r.json);
      items.push(...parsed.items);
      n += parsed.items.length;
      token = parsed.token;
      if (!token) break;
    }
    if (!ok) continue;
    if (token) c.truncated++;
    st.places[p.iso] = { last: now.toISOString(), stories: n, from: p.start };
    c.places++;
  }
  log(`Media Cloud: ${c.searches} searches for ${c.places} places, ${new Set(items.map((x) => x.url)).size} stories (${c.failed} failed calls; ${c.units} quota units this run, ${weekUsage(st.usage, now.getTime()).week} in 7 days).`);
  return finish();
}

// ---------- NewsData.io ----------
// NewsData.io latest-news API. Request and response shapes from its official OpenAPI description,
// https://newsdata.io/openapi.json (documentation: https://newsdata.io/documentation), and its official
// Python client, github.com/newsdataapi/python-client (src/newsdataapi/client.py):
//   - GET https://newsdata.io/api/1/latest with the key in the X-ACCESS-KEY header (or ?apikey=).
//   - qInTitle: words in the title, AND by default, OR, NOT, "phrases" and parentheses, no wildcards;
//     at most 100 characters on the free plan. language: up to 5 ISO 639-1 codes. removeduplicate=1.
//     page: the previous response's nextPage. size: at most 10 on the free plan (the default).
//   - Response { status: "success", totalResults, results: [{ article_id, title, link, language
//     (a name, e.g. "english"), pubDate ("YYYY-MM-DD HH:MM:SS", UTC unless `timezone` is given),
//     pubDateTZ, source_id, source_name, source_url, duplicate, … }], nextPage (null on the last page) }.
//     Errors: { status: "error", results: { message, code } }; 429 for rate limits and spent credits
//     (codes RateLimitExceeded, ApiLimitExceeded, ApiKeyLimitExceeded).
//   - Each call costs 1 credit and returns up to 10 articles. Free plan (https://newsdata.io/pricing):
//     200 credits a day, 30 credits per 15 minutes, articles from the past 48 hours only, 12 hours late.
//     So only recent articles can be read; the history builds up run by run.
export const NEWSDATA_API = "https://newsdata.io/api/1/latest";
export const NEWSDATA_DEFAULTS = {
  maxCredits: 24,   // per run
  windowCap: 30,    // credits in any 15 minutes (the free plan's limit)
  dailyCap: 180,    // credits in any 24 hours (the free plan allows 200 a day)
  maxPages: 3,      // pages of 10 articles per query per run
  overlapHours: 3,  // a query stops paging back this long before the newest article it saw last time
  pauseMs: 1000,    // between calls, as in the official client
};
export const NEWSDATA_HARD_LIMITS = { windowCap: 30, dailyCap: 199 };

// NewsData gives languages as names. Codes are ISO 639-1.
export const NEWSDATA_LANGUAGES = {
  english: "en", spanish: "es", french: "fr", portuguese: "pt", arabic: "ar", russian: "ru",
  german: "de", italian: "it", dutch: "nl", turkish: "tr", ukrainian: "uk", persian: "fa", urdu: "ur", hindi: "hi",
  bengali: "bn", chinese: "zh", japanese: "ja", korean: "ko", indonesian: "id", malay: "ms", swahili: "sw", polish: "pl",
};
export function newsDataLanguage(value) {
  const s = String(value ?? "").trim().toLowerCase();
  if (/^[a-z]{2}$/.test(s)) return s;
  return NEWSDATA_LANGUAGES[s] || null;
}

// Title searches per language, each at most 100 bytes in UTF-8 (the free plan's limit is 100 characters;
// counting bytes stays inside it however NewsData counts). NewsData has no wildcards, so plural forms
// are listed. Retrieval only: the rules in news-lib.mjs decide what is kept.
export const NEWSDATA_QUERIES = {
  en: ['refugee OR refugees OR "asylum seekers" OR "asylum seeker" OR IDPs OR stateless', 'displaced OR displacement OR "fled their homes" OR exodus OR returnees'],
  es: ['refugiados OR desplazados OR "solicitantes de asilo" OR "desplazamiento forzado"'],
  fr: ['réfugiés OR déplacés OR "demandeurs d\'asile" OR "droit d\'asile" OR apatrides'],
  pt: ['refugiados OR deslocados OR "requerentes de asilo" OR "pedidos de asilo"'],
  ar: ["لاجئين OR اللاجئين OR نازحين OR النازحين OR النزوح", "اللجوء OR لاجئون OR المهجرين OR تهجير"],
  ru: ["беженцы OR беженцев OR переселенцы OR переселенцев", "беженцам OR убежища OR вынужденных"],
};
export function newsDataQueries(langs = READ_LANGS) {
  return langs.flatMap((lang) => (NEWSDATA_QUERIES[lang] || []).map((q, i) => ({ id: `${lang}:${i}`, lang, q })));
}

export function parseNewsData(json) {
  const items = [];
  for (const a of Array.isArray(json?.results) ? json.results : []) {
    const title = cleanText(a?.title), url = typeof a?.link === "string" ? a.link.trim() : "";
    if (!title || !isHttp(url) || a.duplicate === true) continue;
    const tz = a.pubDateTZ;
    const published = !tz || /^(?:UTC|GMT|Etc\/UTC)$/i.test(tz) ? utcIso(a.pubDate) : utcIso(String(a.pubDate || "").slice(0, 10));
    items.push({ title, url, domain: hostOf(url) || hostOf(a.source_url || ""), published, lang: newsDataLanguage(a.language) });
  }
  return { items, nextPage: json?.nextPage ? String(json.nextPage) : null, totalResults: Number.isFinite(json?.totalResults) ? json.totalResults : null };
}

export function newsDataUrl({ q, lang, page = null }) {
  const p = new URLSearchParams({ qInTitle: q, language: lang, removeduplicate: "1" });
  if (page) p.set("page", page);
  return `${NEWSDATA_API}?${p}`;
}

const SPENT = new Set(["ApiLimitExceeded", "ApiKeyLimitExceeded"]);
export async function newsDataPage(key, params, { fetchImpl = fetch, sleep = wait, timeoutMs = 30000, retries = 1, backoffMs = 60000 } = {}) {
  const r = await getJson(newsDataUrl(params), { headers: { "X-ACCESS-KEY": key }, fetchImpl, sleep, timeoutMs, retries, backoffMs, maxWaitMs: 60000, giveUp: (x) => SPENT.has(x.json?.results?.code) });
  const code = r.json?.results?.code || null;
  if (!r.ok) return { ok: false, status: r.status, error: code ? `${r.error} ${code}` : r.error, code, attempts: r.attempts };
  if (r.json.status !== "success") return { ok: false, status: r.status, error: `API error ${code || r.json.status || ""}`.trim(), code, attempts: r.attempts };
  return { ok: true, status: r.status, attempts: r.attempts, ...parseNewsData(r.json) };
}

// Reads NewsData for this run: the queries run longest ago go first, so languages take turns when the
// budget is short. Each query pages back until it reaches what it saw last time. Returns
// { state, items, counts }.
export async function readNewsData({ key, state: prev = null, langs = READ_LANGS, now = new Date(), config = {}, fetchImpl = fetch, sleep = wait, clock = Date.now, log = () => {} }) {
  if (!key) return { state: prev, items: [], counts: { enabled: false, skipped: "no key" } };
  const cfg = { ...NEWSDATA_DEFAULTS, ...config };
  cfg.windowCap = Math.min(cfg.windowCap, NEWSDATA_HARD_LIMITS.windowCap);
  cfg.dailyCap = Math.min(cfg.dailyCap, NEWSDATA_HARD_LIMITS.dailyCap);
  cfg.maxCredits = Math.min(cfg.maxCredits, cfg.windowCap);
  const st = { usage: { ...(prev?.usage || {}) }, recent: [...(prev?.recent || [])], queries: { ...(prev?.queries || {}) } };
  const inWindow = () => { const from = clock() - 15 * 60000; st.recent = st.recent.filter((t) => Date.parse(t) > from); return st.recent.length; };
  const used = dayUsage(st.usage, now.getTime());
  const c = { enabled: true, credits: 0, queries: 0, items: 0, failed: 0, error: null, usedToday: used.today, used24h: used.last24h, languages: [] };
  const items = [];
  const finish = () => {
    const u = dayUsage(st.usage, now.getTime());
    c.usedToday = u.today; c.used24h = u.last24h;
    const unique = [...new Map(items.map((x) => [x.url, x])).values()]; // one copy per article
    return { state: st, items: unique, counts: { ...c, items: unique.length } };
  };
  const canSpend = () => c.credits < cfg.maxCredits && dayUsage(st.usage, now.getTime()).last24h < cfg.dailyCap && inWindow() < cfg.windowCap;
  if (!canSpend()) { c.skipped = "quota"; log(`NewsData: skipped, credits used (${used.last24h} in 24 hours, ${inWindow()} in 15 minutes).`); return finish(); }
  const spend = (n) => {
    st.usage = addUsage(st.usage, hourKey(now.getTime()), n, keepHours(now.getTime()));
    for (let i = 0; i < n; i++) st.recent.push(new Date(clock()).toISOString());
    c.credits += n;
  };
  const queries = newsDataQueries(langs).sort((a, b) => (st.queries[a.id]?.last || "").localeCompare(st.queries[b.id]?.last || "") || a.id.localeCompare(b.id));
  let calls = 0, stop = false;
  for (const qy of queries) {
    if (stop || !canSpend()) break;
    const prevQ = st.queries[qy.id] || {};
    const floor = prevQ.newest ? Date.parse(prevQ.newest) - cfg.overlapHours * 3600000 : -Infinity;
    let page = null, newest = prevQ.newest || null, ok = true;
    for (let n = 0; n < cfg.maxPages; n++) {
      if (!canSpend()) { ok = n > 0; break; }
      if (calls++) await sleep(cfg.pauseMs);
      const r = await newsDataPage(key, { q: qy.q, lang: qy.lang, page }, { fetchImpl, sleep });
      spend(r.attempts);
      if (!r.ok) {
        ok = false; c.failed++; c.error = `${qy.id}: ${r.error}`;
        if (r.status === 401 || r.status === 403 || r.status === 429 || SPENT.has(r.code)) stop = true;
        break;
      }
      items.push(...r.items);
      for (const it of r.items) if (it.published && (!newest || it.published > newest)) newest = it.published;
      const oldest = Math.min(...r.items.map((it) => Date.parse(it.published || "") || Infinity));
      page = r.nextPage;
      if (!page || oldest <= floor) break;
    }
    if (!ok) continue;
    st.queries[qy.id] = { last: now.toISOString(), newest };
    c.queries++;
    if (!c.languages.includes(qy.lang)) c.languages.push(qy.lang);
  }
  log(`NewsData: ${c.queries} queries (${c.languages.join(", ") || "none"}), ${c.credits} credits, ${new Set(items.map((x) => x.url)).size} articles (${c.failed} failed; ${dayUsage(st.usage, now.getTime()).last24h} credits in 24 hours).`);
  return finish();
}

// ---------- Filing ----------
// The feed rules: published in the window, in a language the rules read, a core displacement headline
// that is not a profile or opinion piece, an outlet that counts, and at least one place in the headline.
// Returns { kept: [{ item, date, isos }], counts }.
export function fileApiItems(items, { window, outlet, matchers, langs = READ_LANGS }) {
  const counts = { inWindow: 0, otherLanguage: 0, offTopic: 0, outlet: 0, unattributed: 0, kept: 0 };
  const kept = [];
  for (const it of items) {
    const when = checkDate(it.published, window);
    if (!when.date) continue;
    counts.inWindow++;
    if (!it.lang || !langs.includes(it.lang)) { counts.otherLanguage++; continue; }
    if (!isCoreDisplacement(it.title) || isPersonalOrOpinion(it.title, it.url)) { counts.offTopic++; continue; }
    if (!it.domain || !outlet(it.domain)) { counts.outlet++; continue; }
    const isos = attributeCountries(it.title, matchers, { domain: it.domain });
    if (!isos.length) { counts.unattributed++; continue; }
    counts.kept++;
    kept.push({ item: it, date: when.date, isos });
  }
  return { kept, counts };
}

// Outlet domains for Media Cloud's source filter: every listed domain the outlet rule accepts.
export function acceptedDomains(curated, outlet) {
  const all = [...Object.keys(curated?.allow || {}), ...(curated?.intergovernmental?.domains || [])];
  return [...new Set(all.map((d) => d.toLowerCase().replace(/^www\./, "")))].filter((d) => outlet(d)).sort();
}
