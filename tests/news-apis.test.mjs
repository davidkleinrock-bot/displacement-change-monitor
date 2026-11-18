// Run with: node --test "tests/*.test.mjs"
// Media Cloud and NewsData.io clients, tested against their documented response shapes with a simulated
// fetch (no keys exist yet), and the rules that decide which of their articles are filed.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { buildMatchers, makeOutletChecker, READ_LANGS } from "../scripts/news-lib.mjs";
import * as apisLib from "../scripts/news-apis-lib.mjs";
import {
  utcIso, retryAfterMs, getJson, weekUsage, dayUsage,
  MEDIACLOUD_API, mediaCloudQuery, mediaCloudStoryUrl, parseMediaCloudStories, pickMediaCloudSource, parseQueryRate, planMediaCloud, readMediaCloud,
  NEWSDATA_API, NEWSDATA_QUERIES, newsDataQueries, newsDataLanguage, parseNewsData, newsDataPage, readNewsData, fileApiItems, acceptedDomains,
} from "../scripts/news-apis-lib.mjs";

const readJS = (p) => { const s = readFileSync(p, "utf8"); return JSON.parse(s.slice(s.indexOf("{"), s.lastIndexOf("}") + 1)); };
const readJSON = (p) => JSON.parse(readFileSync(p, "utf8"));
const response = (status, body, headers = {}) => ({
  status, ok: status >= 200 && status < 300,
  text: async () => (typeof body === "string" ? body : JSON.stringify(body)),
  headers: { get: (k) => headers[k.toLowerCase()] ?? null },
});
const noSleep = () => { const waits = []; const fn = async (ms) => { waits.push(ms); }; fn.waits = waits; return fn; };
const WINDOW = { from: "2026-09-18", to: "2026-11-18", months: 2 };

// ---------- Shared helpers ----------
test("dates without an offset are UTC; Retry-After in seconds or as a date", () => {
  assert.equal(utcIso("2026-11-17 10:05:00"), "2026-11-17T10:05:00.000Z");
  assert.equal(utcIso("2026-11-17"), "2026-11-17T00:00:00.000Z");
  assert.equal(utcIso("2026-11-17T10:05:00+02:00"), "2026-11-17T08:05:00.000Z");
  assert.equal(utcIso(""), null);
  assert.equal(utcIso("soon"), null);
  assert.equal(utcIso(null), null);
  assert.equal(retryAfterMs("30"), 30000);
  assert.equal(retryAfterMs("Wed, 18 Nov 2026 10:00:10 GMT", Date.parse("2026-11-18T10:00:00Z")), 10000);
  assert.equal(retryAfterMs(null), null);
});

test("getJson: backs off on 429 and retries; 500, bad JSON and network errors never throw", async () => {
  let n = 0;
  const sleep = noSleep();
  const r = await getJson("https://api.example/x", { sleep, backoffMs: 1000, fetchImpl: async () => (++n === 1 ? response(429, "", { "retry-after": "7" }) : response(200, { a: 1 })) });
  assert.equal(r.ok, true);
  assert.deepEqual(r.json, { a: 1 });
  assert.equal(r.attempts, 2);
  assert.deepEqual(sleep.waits, [7000]); // Retry-After wins over the backoff
  const s2 = noSleep();
  const always429 = await getJson("https://api.example/x", { sleep: s2, retries: 2, backoffMs: 1000, fetchImpl: async () => response(429, "") });
  assert.equal(always429.ok, false);
  assert.equal(always429.status, 429);
  assert.equal(always429.attempts, 3);
  assert.deepEqual(s2.waits, [1000, 2000]); // doubling backoff
  assert.equal((await getJson("https://api.example/x", { sleep: noSleep(), retries: 1, fetchImpl: async () => response(500, "oops") })).error, "HTTP 500");
  assert.equal((await getJson("https://api.example/x", { fetchImpl: async () => response(200, "<html>not json") })).error, "unreadable response");
  assert.equal((await getJson("https://api.example/x", { sleep: noSleep(), retries: 0, fetchImpl: async () => { throw new TypeError("fetch failed"); } })).error, "network error");
  assert.equal((await getJson("https://api.example/x", { retries: 0, fetchImpl: async () => { const e = new Error("t"); e.name = "TimeoutError"; throw e; } })).error, "timeout");
  assert.equal((await getJson("https://api.example/x", { fetchImpl: async () => response(404, { detail: "no" }) })).attempts, 1); // 4xx is not retried
});

test("ledgers: rolling 7 days for Media Cloud, rolling 24 hours for NewsData", () => {
  const now = Date.parse("2026-11-18T12:00:00Z");
  assert.deepEqual(weekUsage({ "2026-11-18": 5, "2026-11-12": 10, "2026-11-11": 99 }, now), { today: 5, week: 15 });
  assert.deepEqual(dayUsage({ "2026-11-18T11": 3, "2026-11-18T00": 2, "2026-11-17T13": 4, "2026-11-17T12": 50 }, now), { today: 5, last24h: 9 });
});

// ---------- Media Cloud ----------
test("Media Cloud: documented story-list shape, pagination token and language", () => {
  const json = {
    stories: [
      { id: "abc", title: "  Thousands flee  Goma ", url: "https://www.aljazeera.com/news/2026/11/17/goma", language: "en", media_name: "aljazeera.com", media_url: "aljazeera.com", publish_date: "2026-11-17", indexed_date: "2026-11-17T12:00:00.123456" },
      { id: "def", title: "Refugiados en Cúcuta", url: "https://elpais.com/a", language: "es", media_url: "elpais.com", publish_date: "2026-11-16T08:00:00", indexed_date: null },
      { id: "x", title: "", url: "https://elpais.com/b", language: "es" },
      { id: "y", title: "No link", url: "ftp://x", language: "en" },
      { id: "z", title: "No date, no language", url: "https://bbc.co.uk/z", publish_date: null },
    ],
    pagination_token: "MTczMTg0",
  };
  const { items, token } = parseMediaCloudStories(json);
  assert.equal(token, "MTczMTg0");
  assert.deepEqual(items[0], { title: "Thousands flee Goma", url: "https://www.aljazeera.com/news/2026/11/17/goma", domain: "aljazeera.com", published: "2026-11-17T00:00:00.000Z", lang: "en" });
  assert.equal(items[1].published, "2026-11-16T08:00:00.000Z");
  assert.equal(items.length, 3);
  assert.deepEqual([items[2].published, items[2].lang], [null, null]);
  assert.equal(parseMediaCloudStories({ stories: [], pagination_token: null }).token, null);
  assert.deepEqual(parseMediaCloudStories(null), { items: [], token: null });
});

test("Media Cloud: title query in six languages, place names, language filter, length cap", () => {
  const q = mediaCloudQuery(["Sudan", "Sudanese", "South Sudan", "soudanais", "US"]);
  assert.match(q, /^article_title:\(refugee\* OR displaced/);
  assert.match(q, /language:\(en OR es OR fr OR pt/);
  assert.match(q, /article_title:\(sudan\* OR sudanese\* OR "South Sudan" OR soudanais\* OR "US"\)$/);
  for (const t of ["refugiad*", "réfugié*", "deslocad*", "لاجئ*", "беженц*"]) assert.ok(q.includes(t), t);
  assert.match(mediaCloudQuery(["Sudan"], ["en", "ar"]), /language:\(en OR ar\)/);
  const long = mediaCloudQuery(Array.from({ length: 2000 }, (_, i) => `Placename${String.fromCharCode(97 + (i % 26))}${i}`.replace(/\d/g, (d) => "abcdefghij"[d])));
  assert.ok(long.length <= 16384);
  assert.equal(mediaCloudQuery([]), null);
  const url = new URL(mediaCloudStoryUrl({ q: "a", start: "2026-09-18", end: "2026-11-18", ss: [1, 2], pageSize: 1000, token: "t1" }));
  assert.equal(url.origin + url.pathname, `${MEDIACLOUD_API}search/story-list`);
  assert.deepEqual(Object.fromEntries(url.searchParams), { q: "a", start: "2026-09-18", end: "2026-11-18", platform: "onlinenews-mediacloud", ss: "1,2", page_size: "1000", pagination_token: "t1" });
});

test("Media Cloud: directory match is the exact domain, not a section of it; query rate", () => {
  const json = { count: 3, next: null, results: [{ id: 5, name: "bbc.co.uk", url_search_string: "bbc.co.uk/news/*" }, { id: 6, name: "abbc.co.uk" }, { id: 7, name: "BBC.co.uk", url_search_string: null }] };
  assert.equal(pickMediaCloudSource(json, "bbc.co.uk"), 7);
  assert.equal(pickMediaCloudSource({ results: [] }, "bbc.co.uk"), null);
  assert.equal(parseQueryRate({ params: { "query-rate": "2/m" } }), 2);
  assert.equal(parseQueryRate({ params: { "query-rate": "100/m" } }), 10); // never above 10, as the official client
  assert.equal(parseQueryRate({}), 2);
});

test("Media Cloud: places with no or few articles first, once a UTC day, whole window then since last search", () => {
  const now = new Date("2026-11-18T09:00:00Z");
  const state = { places: { SDN: { last: "2026-11-18T01:00:00Z" }, VEN: { last: "2026-11-10T05:00:00Z" }, COL: { last: "2026-09-19T00:00:00Z" } } };
  const plan = planMediaCloud(state, { places: ["SDN", "TCD", "VEN", "HTI", "COL"], counts: { SDN: 0, TCD: 3, VEN: 1, HTI: 0, COL: 1 }, now, window: WINDOW, overlapDays: 2 });
  assert.deepEqual(plan.map((p) => p.iso), ["HTI", "COL", "VEN", "TCD"]); // SDN was searched today
  assert.deepEqual(plan.find((p) => p.iso === "HTI"), { iso: "HTI", start: "2026-09-18", end: "2026-11-18", last: "", count: 0 });
  assert.equal(plan.find((p) => p.iso === "VEN").start, "2026-11-08");
  assert.equal(plan.find((p) => p.iso === "COL").start, "2026-09-18"); // never before the window
});

// A simulated Media Cloud: a directory, the per-minute rate and a story list with two pages for Chad.
function fakeMediaCloud({ fail = {} } = {}) {
  const calls = [];
  const fetchImpl = async (url, opts) => {
    const u = new URL(url);
    calls.push({ path: u.pathname.replace("/api/", ""), params: Object.fromEntries(u.searchParams), auth: opts.headers.Authorization });
    const path = u.pathname.replace("/api/", "");
    if (fail[path]) return fail[path](calls.length);
    if (path === "sources/sources/") {
      const name = u.searchParams.get("name");
      const ids = { "aljazeera.com": 101, "bbc.co.uk": 102 };
      return response(200, { count: 1, next: null, previous: null, results: ids[name] ? [{ id: ids[name], name, label: name, url_search_string: null, platform: "online_news" }] : [] });
    }
    if (path === "search/api-params") return response(200, { params: { "api-python-client": "5.2.0", "query-rate": "2/m" } });
    if (path === "search/story-list") {
      const q = u.searchParams.get("q");
      if (q.includes("chad*")) {
        if (!u.searchParams.get("pagination_token")) return response(200, { stories: [{ id: "1", title: "Sudanese refugees cross into Chad", url: "https://www.aljazeera.com/c1", language: "en", media_url: "aljazeera.com", publish_date: "2026-11-15" }], pagination_token: "p2" });
        return response(200, { stories: [{ id: "2", title: "Tchad : des milliers de réfugiés soudanais", url: "https://bbc.co.uk/c2", language: "fr", media_url: "bbc.co.uk", publish_date: "2026-10-01" }], pagination_token: null });
      }
      return response(200, { stories: [{ id: "3", title: `Story for ${q.slice(-30)}`, url: `https://bbc.co.uk/${calls.length}`, language: "en", publish_date: "2026-11-17" }], pagination_token: null });
    }
    return response(404, { detail: "not found" });
  };
  return { calls, fetchImpl };
}
const MC_PLACES = [{ iso: "SDN", terms: ["Sudan", "Sudanese"] }, { iso: "TCD", terms: ["Chad", "Chadian", "Tchad"] }, { iso: "VEN", terms: ["Venezuela", "Venezuelan"] }];
const MC_DOMAINS = ["aljazeera.com", "bbc.co.uk", "nosuch.example"];

test("Media Cloud: without a key nothing is requested and the saved state is kept", async () => {
  const saved = { places: { SDN: { last: "2026-11-01T00:00:00Z" } }, usage: { "2026-11-17": 4 } };
  const r = await readMediaCloud({ key: "", state: saved, places: MC_PLACES, window: WINDOW, fetchImpl: async () => assert.fail("no request without a key") });
  assert.deepEqual(r.counts, { enabled: false, skipped: "no key" });
  assert.equal(r.state, saved);
  assert.deepEqual(r.items, []);
});

test("Media Cloud: looks up outlets, then searches places within the budget, paging and pacing", async () => {
  const mc = fakeMediaCloud();
  const sleep = noSleep();
  const now = new Date("2026-11-18T09:00:00Z");
  const r = await readMediaCloud({ key: "k123", state: null, places: MC_PLACES, counts: { SDN: 8, TCD: 0, VEN: 2 }, domains: MC_DOMAINS, window: WINDOW, now, config: { maxCalls: 3 }, fetchImpl: mc.fetchImpl, sleep });
  assert.ok(mc.calls.every((c) => c.auth === "Token k123"));
  assert.deepEqual(mc.calls.filter((c) => c.path === "sources/sources/").map((c) => c.params.name), MC_DOMAINS);
  const searches = mc.calls.filter((c) => c.path === "search/story-list");
  assert.equal(searches.length, 3); // Chad (2 pages), then Venezuela; Sudan has the most articles and waits
  assert.ok(searches.every((c) => c.params.ss === "101,102" && c.params.start === "2026-09-18" && c.params.end === "2026-11-18" && c.params.platform === "onlinenews-mediacloud"));
  assert.equal(searches[1].params.pagination_token, "p2");
  assert.match(searches[2].params.q, /venezuela\*/);
  assert.deepEqual(sleep.waits, [30500, 30500]); // two searches a minute
  assert.deepEqual(Object.keys(r.state.places).sort(), ["TCD", "VEN"]);
  assert.deepEqual(r.state.sources["nosuch.example"], { id: null, at: "2026-11-18" });
  assert.equal(r.counts.units, 3 * 2 + 3); // directory calls count 2 each, searches 1
  assert.deepEqual(r.state.usage, { "2026-11-18": 9 });
  assert.equal(r.counts.places, 2);
  assert.equal(r.items.length, 3);
  assert.deepEqual(r.items[1], { title: "Tchad : des milliers de réfugiés soudanais", url: "https://bbc.co.uk/c2", domain: "bbc.co.uk", published: "2026-10-01T00:00:00.000Z", lang: "fr" });

  // Later the same day: only Sudan is left; no more lookups.
  const mc2 = fakeMediaCloud();
  const r2 = await readMediaCloud({ key: "k123", state: r.state, places: MC_PLACES, counts: { SDN: 8, TCD: 0, VEN: 2 }, domains: MC_DOMAINS, window: WINDOW, now: new Date("2026-11-18T15:00:00Z"), config: { maxCalls: 3 }, fetchImpl: mc2.fetchImpl, sleep: noSleep() });
  assert.equal(mc2.calls.filter((c) => c.path === "sources/sources/").length, 0);
  assert.deepEqual(mc2.calls.filter((c) => c.path === "search/story-list").map((c) => c.params.q.match(/(\w+)\*\)$/)?.[1]), ["sudanese"]);
  assert.equal(r2.state.usage["2026-11-18"], 10);

  // Next day: Chad again, from two days before its last search, not the whole window.
  const mc3 = fakeMediaCloud();
  const r3 = await readMediaCloud({ key: "k123", state: r2.state, places: MC_PLACES, counts: { SDN: 8, TCD: 0, VEN: 2 }, domains: MC_DOMAINS, window: WINDOW, now: new Date("2026-11-19T02:00:00Z"), config: { maxCalls: 1 }, fetchImpl: mc3.fetchImpl, sleep: noSleep() });
  const s3 = mc3.calls.filter((c) => c.path === "search/story-list");
  assert.equal(s3.length, 1);
  assert.match(s3[0].params.q, /chad\*/);
  assert.equal(s3[0].params.start, "2026-11-16");
  assert.equal(r3.counts.truncated, 1); // the budget ran out with a page left
  assert.equal(r3.state.places.TCD.last, "2026-11-19T02:00:00.000Z");
});

test("Media Cloud: searching waits until every outlet is looked up; lookups spread over runs", async () => {
  const now = new Date("2026-11-18T09:00:00Z");
  const mc = fakeMediaCloud();
  const r = await readMediaCloud({ key: "k", places: MC_PLACES, domains: MC_DOMAINS, window: WINDOW, now, config: { lookups: 2 }, fetchImpl: mc.fetchImpl, sleep: noSleep() });
  assert.equal(r.counts.waitingForSources, 1);
  assert.equal(mc.calls.filter((c) => c.path === "search/story-list").length, 0);
  const mc2 = fakeMediaCloud();
  const r2 = await readMediaCloud({ key: "k", state: r.state, places: MC_PLACES, domains: MC_DOMAINS, window: WINDOW, now, config: { lookups: 2, maxCalls: 1 }, fetchImpl: mc2.fetchImpl, sleep: noSleep() });
  assert.deepEqual(mc2.calls.filter((c) => c.path === "sources/sources/").map((c) => c.params.name), ["nosuch.example"]);
  assert.equal(mc2.calls.filter((c) => c.path === "search/story-list").length, 1);
  assert.equal(r2.counts.waitingForSources, undefined);
  // 30 days later, a few entries are looked up again.
  const mc3 = fakeMediaCloud();
  await readMediaCloud({ key: "k", state: r2.state, places: MC_PLACES, domains: MC_DOMAINS, window: WINDOW, now: new Date("2026-12-18T09:00:00Z"), config: { refreshLookups: 2, maxCalls: 0 }, fetchImpl: mc3.fetchImpl, sleep: noSleep() });
  assert.equal(mc3.calls.filter((c) => c.path === "sources/sources/").length, 2);
});

test("Media Cloud: daily and 7-day caps across runs", async () => {
  const now = new Date("2026-11-18T09:00:00Z");
  const mc = fakeMediaCloud();
  const full = { sources: { "aljazeera.com": { id: 101, at: "2026-11-17" } }, usage: { "2026-11-14": 2000, "2026-11-17": 1000 } };
  const r = await readMediaCloud({ key: "k", state: full, places: MC_PLACES, domains: ["aljazeera.com"], window: WINDOW, now, fetchImpl: mc.fetchImpl, sleep: noSleep() });
  assert.equal(r.counts.skipped, "quota");
  assert.equal(mc.calls.length, 0);
  // A week later the old days no longer count; the budget is whatever is left under the caps.
  const mc2 = fakeMediaCloud();
  const r2 = await readMediaCloud({ key: "k", state: { ...full, usage: { "2026-11-14": 2000, "2026-11-17": 999 } }, places: MC_PLACES, domains: ["aljazeera.com"], window: WINDOW, now, fetchImpl: mc2.fetchImpl, sleep: noSleep() });
  assert.equal(mc2.calls.filter((c) => c.path === "search/story-list").length, 1); // 3,000 − 2,999
  assert.equal(r2.counts.usedWeek, 3000);
  const mc3 = fakeMediaCloud();
  const r3 = await readMediaCloud({ key: "k", state: { ...full, usage: { "2026-11-18": 429 } }, places: MC_PLACES, domains: ["aljazeera.com"], window: WINDOW, now, fetchImpl: mc3.fetchImpl, sleep: noSleep() });
  assert.equal(r3.counts.searches, 1); // daily cap 430
});

test("Media Cloud: 429, 500 and bad JSON are counted, never thrown; the place is tried again next run", async () => {
  const now = new Date("2026-11-18T09:00:00Z");
  const state = { sources: { "aljazeera.com": { id: 101, at: "2026-11-17" } } };
  for (const [label, fail, stops] of [
    ["429", () => response(429, ""), true],
    ["500", () => response(500, "Server Error"), false],
    ["bad JSON", () => response(200, "<html>"), false],
  ]) {
    const mc = fakeMediaCloud({ fail: { "search/story-list": fail } });
    const r = await readMediaCloud({ key: "k", state, places: MC_PLACES, domains: ["aljazeera.com"], window: WINDOW, now, fetchImpl: mc.fetchImpl, sleep: noSleep() });
    assert.equal(r.counts.places, 0, label);
    assert.ok(r.counts.failed >= 1, label);
    assert.deepEqual(r.state.places, {}, label);
    assert.equal(r.counts.failed === 1, stops, label); // a 429 after backoff stops the run's searches
  }
  const mc = fakeMediaCloud({ fail: { "sources/sources/": () => response(403, { detail: "Invalid token." }) } });
  const r = await readMediaCloud({ key: "bad", places: MC_PLACES, domains: MC_DOMAINS, window: WINDOW, now, fetchImpl: mc.fetchImpl, sleep: noSleep() });
  assert.equal(mc.calls.length, 1); // a refused key stops at once
  assert.match(r.counts.error, /HTTP 403/);
});

// ---------- NewsData.io ----------
test("NewsData: language names map to ISO 639-1 codes", () => {
  assert.equal(newsDataLanguage("english"), "en");
  assert.equal(newsDataLanguage("Arabic"), "ar");
  assert.equal(newsDataLanguage("russian"), "ru");
  assert.equal(newsDataLanguage("portuguese"), "pt");
  assert.equal(newsDataLanguage("fr"), "fr");
  assert.equal(newsDataLanguage("klingon"), null);
  assert.equal(newsDataLanguage(null), null);
});

test("NewsData: documented response shape, duplicates and nextPage", () => {
  const json = {
    status: "success", totalResults: 41,
    results: [
      { article_id: "a".repeat(32), title: "Sudanese refugees reach Chad", link: "https://www.aljazeera.com/n1", source_id: "aljazeera", source_name: "Al Jazeera", source_url: "https://www.aljazeera.com", language: "english", country: ["qatar"], pubDate: "2026-11-17 22:15:00", pubDateTZ: "UTC", duplicate: false },
      { article_id: "b".repeat(32), title: "نزوح آلاف السودانيين إلى تشاد", link: "https://www.aljazeera.net/n2", source_url: "https://www.aljazeera.net", language: "arabic", pubDate: "2026-11-17 20:00:00", pubDateTZ: "UTC", duplicate: false },
      { article_id: "c".repeat(32), title: "Copy", link: "https://x.example/c", language: "english", pubDate: "2026-11-17 20:00:00", duplicate: true },
      { article_id: "d".repeat(32), title: "Local time", link: "https://y.example/d", language: "spanish", pubDate: "2026-11-17 23:30:00", pubDateTZ: "America/Bogota" },
    ],
    nextPage: "1731880000123456789",
  };
  const r = parseNewsData(json);
  assert.equal(r.nextPage, "1731880000123456789");
  assert.equal(r.totalResults, 41);
  assert.deepEqual(r.items[0], { title: "Sudanese refugees reach Chad", url: "https://www.aljazeera.com/n1", domain: "aljazeera.com", published: "2026-11-17T22:15:00.000Z", lang: "en" });
  assert.equal(r.items[1].lang, "ar");
  assert.equal(r.items.length, 3);
  assert.equal(r.items[2].published, "2026-11-17T00:00:00.000Z"); // not UTC: only the date is used
  assert.equal(parseNewsData({ status: "success", results: [], nextPage: null }).nextPage, null);
});

test("NewsData: queries fit the free plan (100 bytes), one or more per language, Arabic and Russian included", () => {
  for (const lang of ["en", "es", "fr", "pt", "ar", "ru"]) assert.ok(NEWSDATA_QUERIES[lang]?.length, lang);
  for (const [lang, list] of Object.entries(NEWSDATA_QUERIES)) for (const q of list) {
    assert.ok(Buffer.byteLength(q, "utf8") <= 100, `${lang}: ${q} is ${Buffer.byteLength(q, "utf8")} bytes`);
    assert.equal((q.match(/"/g) || []).length % 2, 0, `${lang}: unbalanced quotes`);
  }
  assert.deepEqual([...new Set(newsDataQueries(["en", "ar"]).map((q) => q.lang))], ["en", "ar"]);
  assert.ok(newsDataQueries(READ_LANGS).every((q) => READ_LANGS.includes(q.lang)));
});

// A simulated NewsData: each query has three pages of articles going back in time.
function fakeNewsData({ status = null, body = null } = {}) {
  const calls = [];
  const fetchImpl = async (url, opts) => {
    const u = new URL(url);
    calls.push({ params: Object.fromEntries(u.searchParams), key: opts.headers["X-ACCESS-KEY"] });
    if (status) return response(status, body ?? { status: "error", results: { message: "x", code: "ServerError" } });
    const page = Number(u.searchParams.get("page") || 0);
    const lang = u.searchParams.get("language");
    const hour = 22 - page * 6; // pages go back six hours each
    return response(200, {
      status: "success", totalResults: 30,
      results: [{ article_id: `${lang}${page}`.padEnd(32, "0"), title: `${lang} article ${page}`, link: `https://www.aljazeera.com/${lang}/${u.searchParams.get("qInTitle").length}/${page}`, language: { en: "english", es: "spanish", fr: "french", pt: "portuguese", ar: "arabic", ru: "russian" }[lang], pubDate: `2026-11-17 ${String(hour).padStart(2, "0")}:00:00`, pubDateTZ: "UTC", duplicate: false }],
      nextPage: page < 2 ? String(page + 1) : null,
    });
  };
  return { calls, fetchImpl };
}

test("NewsData: without a key nothing is requested and the saved state is kept", async () => {
  const saved = { usage: { "2026-11-18T01": 5 } };
  const r = await readNewsData({ key: "", state: saved, fetchImpl: async () => assert.fail("no request without a key") });
  assert.deepEqual(r.counts, { enabled: false, skipped: "no key" });
  assert.equal(r.state, saved);
});

test("NewsData: key in the header, title search per language, per-run budget, languages take turns", async () => {
  const now = new Date("2026-11-18T09:00:00Z");
  let clock = now.getTime();
  const nd = fakeNewsData();
  const r = await readNewsData({ key: "nd-key", now, clock: () => clock, langs: READ_LANGS, config: { maxCredits: 4, maxPages: 3 }, fetchImpl: nd.fetchImpl, sleep: noSleep() });
  assert.ok(nd.calls.every((c) => c.key === "nd-key" && !("apikey" in c.params)));
  assert.ok(nd.calls.every((c) => c.params.removeduplicate === "1" && c.params.qInTitle && !c.params.q));
  assert.equal(nd.calls.length, 4);
  assert.deepEqual(nd.calls.map((c) => c.params.page ?? null), [null, "1", "2", null]); // first query pages back fully
  assert.equal(r.counts.credits, 4);
  assert.equal(r.state.recent.length, 4);
  assert.equal(r.items.length, 4);
  const firstIds = Object.keys(r.state.queries);
  // Next run (an hour later): the queries never run go first.
  clock += 3600000;
  const nd2 = fakeNewsData();
  const r2 = await readNewsData({ key: "nd-key", state: r.state, now: new Date(clock), clock: () => clock, langs: READ_LANGS, config: { maxCredits: 30, maxPages: 1 }, fetchImpl: nd2.fetchImpl, sleep: noSleep() });
  const order = nd2.calls.map((c) => `${c.params.language}:${c.params.qInTitle}`);
  const all = newsDataQueries(READ_LANGS);
  assert.equal(nd2.calls.length, all.length);
  assert.ok(firstIds.every((id) => order.indexOf(`${id.split(":")[0]}:${all.find((q) => q.id === id).q}`) === order.length - firstIds.length + firstIds.indexOf(id)));
  assert.deepEqual(r2.counts.languages.sort(), [...READ_LANGS].sort());
});

test("NewsData: a query stops paging once it reaches what it saw last time", async () => {
  const now = new Date("2026-11-18T09:00:00Z");
  const nd = fakeNewsData();
  // The newest article seen last time was at 20:00; overlap 3 h → stop at the page reaching 17:00 or earlier.
  const state = { queries: { "en:0": { last: "2026-11-18T05:00:00Z", newest: "2026-11-17T20:00:00.000Z" } } };
  const r = await readNewsData({ key: "k", state, now, clock: () => now.getTime(), langs: ["en"], config: { maxPages: 3, overlapHours: 3 }, fetchImpl: nd.fetchImpl, sleep: noSleep() });
  const en0 = nd.calls.filter((c) => c.params.qInTitle === NEWSDATA_QUERIES.en[0]);
  assert.equal(en0.length, 2); // page 0 at 22:00, page 1 at 16:00 → caught up
  assert.equal(r.state.queries["en:0"].newest, "2026-11-17T22:00:00.000Z");
});

test("NewsData: 24-hour cap and 15-minute window are kept across runs", async () => {
  const now = new Date("2026-11-18T09:00:00Z");
  const nd = fakeNewsData();
  const busy = { usage: { "2026-11-18T08": 100, "2026-11-17T12": 80 } };
  const r = await readNewsData({ key: "k", state: busy, now, clock: () => now.getTime(), langs: READ_LANGS, fetchImpl: nd.fetchImpl, sleep: noSleep() });
  assert.equal(r.counts.skipped, "quota");
  assert.equal(nd.calls.length, 0);
  // The 80 credits from yesterday 12:00 UTC drop out of the 24 hours at 12:00 today.
  const later = new Date("2026-11-18T12:30:00Z");
  const nd2 = fakeNewsData();
  const r2 = await readNewsData({ key: "k", state: busy, now: later, clock: () => later.getTime(), langs: READ_LANGS, config: { maxCredits: 5 }, fetchImpl: nd2.fetchImpl, sleep: noSleep() });
  assert.equal(r2.counts.credits, 5);
  // A run five minutes after a run that used 26 credits may use only 4 more.
  const recent = Array.from({ length: 26 }, () => "2026-11-18T12:25:00.000Z");
  const nd3 = fakeNewsData();
  const r3 = await readNewsData({ key: "k", state: { recent }, now: later, clock: () => later.getTime(), langs: READ_LANGS, config: { maxCredits: 24 }, fetchImpl: nd3.fetchImpl, sleep: noSleep() });
  assert.equal(r3.counts.credits, 4);
  // The per-run budget and caps can't be set above the free plan's limits.
  const nd4 = fakeNewsData();
  const r4 = await readNewsData({ key: "k", now: later, clock: () => later.getTime(), langs: READ_LANGS, config: { maxCredits: 500, maxPages: 3 }, fetchImpl: nd4.fetchImpl, sleep: noSleep() });
  assert.ok(r4.counts.credits <= 30);
});

test("NewsData: spent credits stop at once; 500, bad JSON and errors in the body never throw", async () => {
  const now = new Date("2026-11-18T09:00:00Z");
  const run = (fake) => readNewsData({ key: "k", now, clock: () => now.getTime(), langs: READ_LANGS, fetchImpl: fake.fetchImpl, sleep: noSleep() });
  const spent = fakeNewsData({ status: 429, body: { status: "error", results: { message: "API limit exceeded", code: "ApiLimitExceeded" } } });
  const r = await run(spent);
  assert.equal(spent.calls.length, 1); // not retried, and no other query is tried
  assert.match(r.counts.error, /ApiLimitExceeded/);
  assert.equal(r.counts.credits, 1);
  const busy = fakeNewsData({ status: 429, body: { status: "error", results: { message: "Too many", code: "RateLimitExceeded" } } });
  assert.equal((await run(busy)).counts.failed, 1);
  assert.equal(busy.calls.length, 2); // one retry after backoff, then stop
  const down = fakeNewsData({ status: 500 });
  const r3 = await run(down);
  assert.equal(r3.counts.failed, newsDataQueries(READ_LANGS).length); // each query fails on its own
  assert.deepEqual(r3.items, []);
  const garbled = { calls: [], fetchImpl: async () => response(200, "<html>") };
  assert.equal((await run(garbled)).counts.queries, 0);
  const errorBody = await newsDataPage("k", { q: "a", lang: "en" }, { fetchImpl: async () => response(200, { status: "error", results: { message: "bad", code: "UnsupportedQueryLength" } }) });
  assert.deepEqual([errorBody.ok, errorBody.error], [false, "API error UnsupportedQueryLength"]);
  const url = new URL(spent.calls[0] ? `${NEWSDATA_API}?${new URLSearchParams(spent.calls[0].params)}` : NEWSDATA_API);
  assert.equal(url.origin + url.pathname, "https://newsdata.io/api/1/latest");
});

// ---------- Filing ----------
const data = readJS("data/dashboard-data.js");
const matchers = buildMatchers(data.countries, readJSON("data/raw/geo/world-countries.json"));
const curated = readJSON("data/outlets.json");
const outlet = makeOutletChecker(curated);

test("filing: items failing the window, language, topic, outlet or place rules are dropped", () => {
  assert.ok(outlet("aljazeera.com"), "test outlet counts");
  assert.ok(!outlet("wn.com"), "test aggregator is blocked");
  const good = { title: "Thousands of Sudanese refugees cross into Chad", url: "https://www.aljazeera.com/a", domain: "aljazeera.com", published: "2026-11-17T10:00:00.000Z", lang: "en" };
  const items = [
    good,
    { ...good, url: "https://www.aljazeera.com/old", published: "2026-08-01T00:00:00Z" },
    { ...good, url: "https://www.aljazeera.com/nodate", published: null },
    { ...good, url: "https://www.aljazeera.com/de", lang: "de" },
    { ...good, url: "https://www.aljazeera.com/nolang", lang: null },
    { ...good, url: "https://www.aljazeera.com/sport", title: "Sudan beat Chad in World Cup qualifier" },
    { ...good, url: "https://www.aljazeera.com/opinion/x", title: "Opinion: Sudanese refugees in Chad deserve better" },
    { ...good, url: "https://wn.com/x", domain: "wn.com" },
    { ...good, url: "https://www.aljazeera.com/none", title: "Refugees face a harsh winter in camps" },
  ];
  const { kept, counts } = fileApiItems(items, { window: WINDOW, outlet, matchers, langs: ["en", "es", "fr", "pt", "ar", "ru"] });
  assert.equal(kept.length, 1);
  assert.equal(kept[0].item, good);
  assert.equal(kept[0].date, "2026-11-17");
  assert.ok(kept[0].isos.includes("SDN"));
  assert.deepEqual(counts, { inWindow: 7, otherLanguage: 2, offTopic: 2, outlet: 1, unattributed: 1, kept: 1 });
  // A language outside the rules' list is dropped even when the headline would pass.
  assert.equal(fileApiItems([good], { window: WINDOW, outlet, matchers, langs: ["es"] }).counts.otherLanguage, 1);
});

test("filing: Media Cloud's source filter gets only outlets the outlet rule accepts", () => {
  const domains = acceptedDomains(curated, outlet);
  assert.ok(domains.length > 100);
  assert.ok(domains.every((d) => outlet(d)));
  assert.ok(domains.includes("aljazeera.com"));
  assert.ok(!domains.some((d) => curated.block?.[d]));
});

test("fetch-news.mjs imports only what news-apis-lib.mjs exports", () => {
  const src = readFileSync("scripts/fetch-news.mjs", "utf8");
  const m = src.match(/import \{([^}]*)\} from "\.\/news-apis-lib\.mjs"/);
  assert.ok(m, "fetch-news.mjs imports news-apis-lib");
  for (const name of m[1].split(",").map((s) => s.trim()).filter(Boolean)) assert.ok(name in apisLib, `news-apis-lib.mjs has no export ${name}`);
});
