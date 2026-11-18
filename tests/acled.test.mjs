// Run with: node --test "tests/*.test.mjs"
// ACLED conflict and protest event counts: sign-in, paging, counting, country codes, the off state, failures,
// and the page's ACLED item. ACLED is never contacted: a fake server answers as ACLED's documentation describes.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import vm from "node:vm";
import {
  credentialsFromEnv, getToken, makeReader, readWindow, findLatestMonth, periodsFor, periodLabel, addMonths, lastDay,
  buildIsoMap, mapCountry, aggregate, change, topTypes, parseFile, serialize, isFresh, newer, offState, TOKEN_URL, READ_URL,
} from "../scripts/acled-lib.mjs";
import { run } from "../scripts/fetch-acled.mjs";

const NOW = new Date("2026-11-18T12:00:00Z");
const CREDS = { ACLED_USERNAME: "analyst@example.edu", ACLED_PASSWORD: "s3cret-pass" };

// ---------- A fake ACLED API ----------

let seq = 0;
const ev = (date, country, iso, type, fatalities = 0) => ({ event_id_cnty: `X${++seq}`, event_date: date, iso, country, event_type: type, fatalities: String(fatalities) });

// Events from Jul to Nov 2025, as a Research-level account would see them on 18 Nov 2026 (12-month lag).
function sampleRows() {
  seq = 0;
  const rows = [];
  // Filler so every day has events worldwide (findLatestMonth checks a month's last day).
  for (let d = new Date("2025-06-01T00:00:00Z"); d <= new Date("2025-11-18T00:00:00Z"); d = new Date(d.getTime() + 864e5))
    rows.push(ev(d.toISOString().slice(0, 10), "Mexico", 484, "Protests"));
  // Syria: previous period (Jul–Aug) 3 events, current (Sep–Oct) 5 events.
  rows.push(ev("2025-07-03", "Syria", 760, "Battles", 4), ev("2025-08-10", "Syria", 760, "Protests"), ev("2025-08-31", "Syria", 760, "Riots", 1));
  rows.push(ev("2025-09-01", "Syria", 760, "Battles", 2), ev("2025-09-15", "Syria", 760, "Battles", 3), ev("2025-10-02", "Syria", 760, "Explosions/Remote violence", 7));
  rows.push(ev("2025-10-20", "Syria", 760, "Violence against civilians", 1), ev("2025-10-31", "Syria", 760, "Protests"));
  // Kosovo goes to Serbia's record; Taiwan and Mayotte have no dashboard row.
  rows.push(ev("2025-09-09", "Kosovo", 0, "Protests"), ev("2025-10-01", "Serbia", 688, "Protests"));
  rows.push(ev("2025-09-12", "Taiwan", 158, "Protests"), ev("2025-10-12", "Mayotte", 175, "Riots"));
  // Sudan: events only in the previous period, so "No events recorded" for the current one.
  rows.push(ev("2025-07-20", "Sudan", 729, "Battles", 10));
  return rows;
}

function fakeAcled({ rows = sampleRows(), tokenStatus = 200, readStatus = 200, cursor = true, failReadsAfter = Infinity } = {}) {
  const calls = { token: [], read: [], other: [] };
  const f = async (url, opts = {}) => {
    url = String(url);
    if (url === TOKEN_URL) {
      calls.token.push(Object.fromEntries(new URLSearchParams(opts.body)));
      if (tokenStatus !== 200) return new Response(JSON.stringify({ error: "invalid_grant", error_description: "The user credentials were incorrect." }), { status: tokenStatus });
      return Response.json({ token_type: "Bearer", expires_in: 86400, access_token: "tok-123", refresh_token: "ref-456" });
    }
    if (url.startsWith(READ_URL + "?")) {
      const q = new URL(url).searchParams;
      calls.read.push({ q, auth: opts.headers?.Authorization });
      if (calls.read.length > failReadsAfter) return new Response("Service Unavailable", { status: 503 });
      if (readStatus !== 200) return new Response("error", { status: readStatus });
      if (opts.headers?.Authorization !== "Bearer tok-123") return new Response("{}", { status: 401 });
      let sel = rows;
      const date = q.get("event_date");
      if (q.get("event_date_where") === "BETWEEN") { const [a, b] = date.split("|"); sel = rows.filter((r) => r.event_date >= a && r.event_date <= b); }
      else if (date) sel = rows.filter((r) => r.event_date === date);
      const limit = Number(q.get("limit") || 5000);
      const fields = (q.get("fields") || "").split("|").filter(Boolean);
      const pick = (r) => (fields.length ? Object.fromEntries(fields.map((k) => [k, r[k]])) : r);
      if (cursor) {
        const at = Number(q.get("cursor") || 0);
        const data = sel.slice(at, at + limit).map(pick);
        return Response.json({ status: 200, success: true, last_update: 12, count: null, messages: [], data, next_cursor: at + limit < sel.length ? at + limit : null });
      }
      const page = Number(q.get("page") || 1);
      return Response.json({ status: 200, success: true, count: null, messages: [], data: sel.slice((page - 1) * limit, page * limit).map(pick) });
    }
    calls.other.push(url);
    return new Response("Not found", { status: 404 });
  };
  return { fetch: f, calls };
}

const tmp = () => mkdtempSync(join(tmpdir(), "acled-test-"));
const load = (file) => parseFile(readFileSync(file, "utf8"));
const quiet = () => {};

// ---------- Credentials and off state ----------

test("credentials come only from ACLED_USERNAME and ACLED_PASSWORD", () => {
  assert.equal(credentialsFromEnv({}), null);
  assert.equal(credentialsFromEnv({ ACLED_USERNAME: "a@b.org" }), null);
  assert.equal(credentialsFromEnv({ ACLED_USERNAME: " ", ACLED_PASSWORD: "x" }), null);
  assert.deepEqual(credentialsFromEnv(CREDS), { username: "analyst@example.edu", password: "s3cret-pass" });
});

test("without credentials: no request, an 'off' file, and the run finishes normally", async () => {
  const dir = tmp();
  const { fetch: f, calls } = fakeAcled();
  const out = join(dir, "acled.js");
  const r = await run({ env: {}, fetch: f, now: NOW, outFile: out, log: quiet });
  assert.equal(r.status, "off");
  assert.equal(calls.token.length + calls.read.length + calls.other.length, 0);
  const data = load(out);
  assert.equal(data.status, "off");
  assert.deepEqual(data.countries, {});
  assert.match(readFileSync(out, "utf8"), /^\/\/ ACLED[\s\S]*window\.ACLED_DATA = \{/);
  // Same bytes every run, so it isn't re-committed hourly.
  assert.equal(serialize(offState()), readFileSync(out, "utf8"));
  rmSync(dir, { recursive: true });
});

// ---------- Sign-in ----------

test("sign-in posts the documented OAuth fields and returns the access token", async () => {
  const { fetch: f, calls } = fakeAcled();
  const token = await getToken({ username: "analyst@example.edu", password: "s3cret-pass" }, { fetch: f });
  assert.equal(token, "tok-123");
  assert.deepEqual(calls.token[0], { username: "analyst@example.edu", password: "s3cret-pass", grant_type: "password", client_id: "acled", scope: "authenticated" });
});

test("a refused sign-in throws a message with ACLED's reason and never the password", async () => {
  const { fetch: f } = fakeAcled({ tokenStatus: 401 });
  await assert.rejects(getToken({ username: "a@b.edu", password: "s3cret-pass" }, { fetch: f }), (err) => {
    assert.match(err.message, /HTTP 401.*credentials were incorrect/);
    assert.doesNotMatch(err.message, /s3cret/);
    return true;
  });
});

// ---------- Reading and paging ----------

test("reads send the Bearer token and keep '|' unencoded, as in ACLED's examples", async () => {
  const { fetch: f, calls } = fakeAcled();
  const get = makeReader("tok-123", { fetch: f, wait: 0 });
  await get({ event_date: "2025-09-01|2025-10-31", event_date_where: "BETWEEN", limit: 1 });
  assert.equal(calls.read[0].auth, "Bearer tok-123");
  assert.equal(calls.read[0].q.get("_format"), "json");
});

test("cursor paging reads every page until next_cursor is null, without duplicates", async () => {
  const rows = sampleRows();
  const { fetch: f, calls } = fakeAcled({ rows });
  const get = makeReader("tok-123", { fetch: f, wait: 0 });
  const { rows: got, pages } = await readWindow(get, "2025-07-01", "2025-10-31", { pageSize: 25 });
  const expected = rows.filter((r) => r.event_date >= "2025-07-01" && r.event_date <= "2025-10-31").length;
  assert.equal(got.length, expected);
  assert.equal(new Set(got.map((r) => r.event_id_cnty)).size, expected);
  assert.equal(pages, Math.ceil(expected / 25));
  assert.deepEqual(calls.read.map((c) => c.q.get("cursor")), Array.from({ length: pages }, (_, i) => String(i * 25)));
  assert.equal(calls.read[0].q.get("fields"), "event_id_cnty|event_date|iso|country|event_type|fatalities");
});

test("when a response has no cursor, paging falls back to page numbers", async () => {
  const rows = sampleRows();
  const { fetch: f, calls } = fakeAcled({ rows, cursor: false });
  const get = makeReader("tok-123", { fetch: f, wait: 0 });
  const { rows: got } = await readWindow(get, "2025-07-01", "2025-10-31", { pageSize: 25 });
  assert.equal(got.length, rows.filter((r) => r.event_date >= "2025-07-01" && r.event_date <= "2025-10-31").length);
  assert.equal(calls.read.at(-1).q.get("page"), String(calls.read.length));
});

test("a 503 is retried once; a second failure throws", async () => {
  const { fetch: f } = fakeAcled({ failReadsAfter: 0 });
  const get = makeReader("tok-123", { fetch: f, wait: 0 });
  await assert.rejects(get({ limit: 1 }), /HTTP 503/);
  assert.equal(get.calls(), 2);
});

test("success:false in a 200 response is an error", async () => {
  const f = async () => Response.json({ status: 403, success: false, error: { message: "Access denied" }, data: [] });
  const get = makeReader("t", { fetch: f, wait: 0 });
  await assert.rejects(get({ limit: 1 }), /Access denied/);
});

// ---------- Months and periods ----------

test("month arithmetic and labels", () => {
  assert.equal(addMonths("2026-01", -1), "2025-12");
  assert.equal(addMonths("2025-11", 3), "2026-02");
  assert.equal(lastDay("2024-02"), "2024-02-29");
  assert.equal(lastDay("2025-09"), "2025-09-30");
  assert.equal(periodLabel("2025-09", "2025-10"), "Sep–Oct 2025");
  assert.equal(periodLabel("2025-12", "2026-01"), "Dec 2025–Jan 2026");
  const p = periodsFor("2026-01");
  assert.deepEqual(p.current, { from: "2025-12-01", to: "2026-01-31", months: ["2025-12", "2026-01"], label: "Dec 2025–Jan 2026" });
  assert.deepEqual(p.previous, { from: "2025-10-01", to: "2025-11-30", months: ["2025-10", "2025-11"], label: "Oct–Nov 2025" });
});

test("the newest complete month follows the account's lag", async () => {
  const { fetch: f } = fakeAcled(); // data through 18 Nov 2025
  const get = makeReader("tok-123", { fetch: f, wait: 0 });
  const r = await findLatestMonth(get, NOW);
  assert.equal(r.month, "2025-10"); // Nov 2025 has no 30 Nov yet
  assert.equal(r.probes, 13);
  // A full-access account on 18 Nov 2026, with data through 14 Nov: October 2026.
  const recent = [ev("2026-10-31", "Mexico", 484, "Protests"), ev("2026-11-14", "Mexico", 484, "Protests")];
  const g2 = makeReader("tok-123", { fetch: fakeAcled({ rows: recent }).fetch, wait: 0 });
  assert.equal((await findLatestMonth(g2, NOW)).month, "2026-10");
  // Nothing at all: null after the probe limit, not an endless loop.
  const g3 = makeReader("tok-123", { fetch: fakeAcled({ rows: [] }).fetch, wait: 0 });
  assert.deepEqual(await findLatestMonth(g3, NOW, 4), { month: null, probes: 4, restrictions: null });
});

// ---------- Country codes ----------

const world = JSON.parse(readFileSync("data/raw/geo/world-countries.json", "utf8"));
const dashIds = (() => {
  const ctx = { window: {} };
  vm.runInNewContext(readFileSync("data/dashboard-data.js", "utf8"), ctx);
  return ctx.window.DISPLACEMENT_DATA.countries.map((c) => c.id);
})();

test("ACLED's numeric ISO codes map to the dashboard's country ids", () => {
  const m = buildIsoMap(world, dashIds);
  assert.equal(m.get(760), "SYR");
  assert.equal(m.get(729), "SDN");
  assert.equal(m.get(180), "COD");
  assert.equal(m.get(275), "PSE");
  assert.equal(m.get(4), "AFG"); // "004" in world-countries
  assert.equal(m.get(158), undefined); // Taiwan: no dashboard row
  assert.ok(![...m.values()].includes("UNK")); // world-countries' UNK is Kosovo; UNHCR's is "Unknown origin"
  assert.equal(mapCountry({ country: "Kosovo", iso: 0 }, m), "SRB");
  assert.equal(mapCountry({ country: "Syria", iso: "760" }, m), "SYR");
  assert.equal(mapCountry({ country: "Nowhere", iso: null }, m), null);
});

// ---------- Counting ----------

test("events and fatalities are counted by country, period and event type", () => {
  const P = periodsFor("2025-10");
  const agg = aggregate(sampleRows(), P, buildIsoMap(world, dashIds));
  const syr = agg.countries.SYR;
  assert.deepEqual(syr.previous, { events: 3, fatalities: 5, types: { Battles: 1, "Explosions/Remote violence": 0, "Violence against civilians": 0, Protests: 1, Riots: 1, "Strategic developments": 0 } });
  assert.deepEqual(syr.current, { events: 5, fatalities: 13, types: { Battles: 2, "Explosions/Remote violence": 1, "Violence against civilians": 1, Protests: 1, Riots: 0, "Strategic developments": 0 } });
  assert.equal(agg.countries.SRB.current.events, 2);
  assert.deepEqual(agg.countries.SRB.includes, ["Kosovo"]);
  assert.equal(agg.countries.SDN.current.events, 0);
  assert.equal(agg.countries.SDN.previous.fatalities, 10);
  assert.deepEqual(agg.unmapped, [{ place: "Mayotte (iso 175)", events: 1 }, { place: "Taiwan (iso 158)", events: 1 }]);
  assert.ok(agg.outside > 0); // June and November filler is outside the four months
});

test("change and top event types", () => {
  assert.deepEqual(change(5, 3), { abs: 2, pct: (2 / 3) * 100 });
  assert.deepEqual(change(0, 4), { abs: -4, pct: -100 });
  assert.deepEqual(change(7, 0), { abs: 7, pct: null });
  assert.deepEqual(topTypes({ Battles: 2, Protests: 2, Riots: 5, "Strategic developments": 0 }), [{ type: "Riots", events: 5 }, { type: "Battles", events: 2 }, { type: "Protests", events: 2 }]);
  assert.deepEqual(topTypes({}), []);
});

// ---------- A whole run ----------

test("a full run writes only totals, with the periods, coverage and unmatched places", async () => {
  const dir = tmp();
  const out = join(dir, "acled.js");
  const { fetch: f, calls } = fakeAcled();
  const r = await run({ env: CREDS, fetch: f, now: NOW, outFile: out, wait: 0, log: quiet });
  assert.equal(r.status, "ok");
  const data = load(out);
  assert.equal(data.status, "ok");
  assert.equal(data.latestMonth, "2025-10");
  assert.equal(data.periods.current.label, "Sep–Oct 2025");
  assert.equal(data.periods.previous.label, "Jul–Aug 2025");
  assert.equal(data.countries.SYR.current.events, 5);
  assert.ok(data.covered.includes("SDN") && data.covered.includes("MEX"));
  assert.equal(data.unmapped.length, 2);
  // No event rows or event fields in the published file.
  const text = readFileSync(out, "utf8");
  assert.doesNotMatch(text, /event_id_cnty|event_date|X\d+|"notes"|"actor1"/);
  assert.doesNotMatch(text, /s3cret|tok-123/);
  // One sign-in, 13 month probes, one page for the window.
  assert.equal(calls.token.length, 1);
  assert.equal(calls.read.length, 14);
  assert.equal(data.run.requests, 15);
  rmSync(dir, { recursive: true });
});

test("at most one pull a day: a fresh file is kept without asking ACLED", async () => {
  const dir = tmp();
  const out = join(dir, "acled.js");
  await run({ env: CREDS, fetch: fakeAcled().fetch, now: NOW, outFile: out, wait: 0, log: quiet });
  const before = readFileSync(out, "utf8");
  const second = fakeAcled();
  const r = await run({ env: CREDS, fetch: second.fetch, now: new Date(NOW.getTime() + 5 * 3600e3), outFile: out, wait: 0, log: quiet });
  assert.equal(r.status, "kept");
  assert.equal(second.calls.token.length + second.calls.read.length, 0);
  assert.equal(readFileSync(out, "utf8"), before);
  const third = fakeAcled();
  await run({ env: CREDS, fetch: third.fetch, now: new Date(NOW.getTime() + 21 * 3600e3), outFile: out, wait: 0, log: quiet });
  assert.equal(third.calls.token.length, 1);
  rmSync(dir, { recursive: true });
});

test("the live site's copy is used when it is newer than the repo's", async () => {
  const dir = tmp();
  const out = join(dir, "acled.js");
  writeFileSync(out, serialize(offState()));
  const live = { status: "ok", retrievedAt: "2026-11-18T08:00:00Z", checkedAt: "2026-11-18T08:00:00Z", periods: periodsFor("2025-10"), countries: { SYR: {} }, covered: ["SYR"] };
  const fake = fakeAcled();
  const f = async (url, o) => (String(url) === "https://example.org/site/data/acled.js" ? new Response(serialize(live)) : fake.fetch(url, o));
  const r = await run({ env: { ...CREDS, SITE_URL: "https://example.org/site/" }, fetch: f, now: NOW, outFile: out, wait: 0, log: quiet });
  assert.equal(r.status, "kept");
  assert.equal(fake.calls.token.length, 0);
  assert.equal(load(out).retrievedAt, "2026-11-18T08:00:00Z");
  rmSync(dir, { recursive: true });
});

test("API failures never throw: an error file without counts, or the previous counts with a note", async () => {
  const dir = tmp();
  const out = join(dir, "acled.js");
  // Wrong password, nothing saved before.
  let r = await run({ env: CREDS, fetch: fakeAcled({ tokenStatus: 401 }).fetch, now: NOW, outFile: out, wait: 0, log: quiet });
  assert.equal(r.status, "error");
  let data = load(out);
  assert.equal(data.status, "error");
  assert.deepEqual(data.countries, {});
  assert.doesNotMatch(readFileSync(out, "utf8"), /s3cret/);
  // Within 6 hours of a failure, no new attempt.
  const quietRun = fakeAcled();
  assert.equal((await run({ env: CREDS, fetch: quietRun.fetch, now: new Date(NOW.getTime() + 3600e3), outFile: out, wait: 0, log: quiet })).status, "kept");
  assert.equal(quietRun.calls.token.length, 0);
  // A good run, then ACLED down a day later: the counts stay and the failure is noted.
  await run({ env: CREDS, fetch: fakeAcled().fetch, now: new Date(NOW.getTime() + 7 * 3600e3), outFile: out, wait: 0, log: quiet });
  const later = new Date(NOW.getTime() + 31 * 3600e3);
  r = await run({ env: CREDS, fetch: fakeAcled({ readStatus: 500 }).fetch, now: later, outFile: out, wait: 0, log: quiet });
  assert.equal(r.status, "error");
  data = load(out);
  assert.equal(data.status, "ok");
  assert.equal(data.countries.SYR.current.events, 5);
  assert.equal(data.lastAttempt.ok, false);
  assert.match(data.lastAttempt.message, /HTTP 500/);
  // The network itself failing.
  const boom = async () => { throw new TypeError("fetch failed"); };
  r = await run({ env: { ...CREDS, ACLED_FORCE: "1" }, fetch: boom, now: later, outFile: out, wait: 0, log: quiet });
  assert.equal(r.status, "error");
  assert.match(r.message, /fetch failed/);
  rmSync(dir, { recursive: true });
});

test("freshness and choosing between two saved files", () => {
  const ok = { status: "ok", checkedAt: "2026-11-18T00:00:00Z", retrievedAt: "2026-11-18T00:00:00Z" };
  assert.equal(isFresh(ok, new Date("2026-11-18T19:00:00Z")), true);
  assert.equal(isFresh(ok, new Date("2026-11-18T21:00:00Z")), false);
  assert.equal(isFresh({ ...ok, lastAttempt: { ok: false } }, new Date("2026-11-18T07:00:00Z")), false);
  assert.equal(isFresh(offState(), NOW), false);
  assert.equal(newer(ok, { status: "error", checkedAt: "2026-11-19T00:00:00Z" }), ok);
  const later = { ...ok, checkedAt: "2026-11-18T05:00:00Z" };
  assert.equal(newer(ok, later), later);
  assert.equal(newer(null, ok), ok);
  assert.equal(parseFile("garbage"), null);
});

// ---------- The page's ACLED item ----------

function pageView() {
  const html = readFileSync("index.html", "utf8");
  const src = [...html.matchAll(/<script>([\s\S]*?)<\/script>/g)].map((m) => m[1]).find((s) => s.includes("window.ACLED_VIEW ="));
  assert.ok(src, "index.html defines window.ACLED_VIEW in its own inline script");
  const ctx = { window: {} };
  vm.runInNewContext(src, ctx);
  return ctx.window.ACLED_VIEW;
}

test("the page loads data/acled.js and has the ACLED methods note and source", () => {
  const html = readFileSync("index.html", "utf8");
  assert.match(html, /<script src="data\/acled\.js"><\/script>/);
  assert.match(html, /<section id="about-acled" hidden>/);
  assert.match(html, /<li><a href="https:\/\/acleddata\.com"[^>]*>Armed Conflict Location &amp; Event Data \(ACLED\)<\/a>/);
});

test("the country item: period, total and change, top types, fatalities, link and caveat", async () => {
  const V = pageView();
  const dir = tmp();
  const out = join(dir, "acled.js");
  await run({ env: CREDS, fetch: fakeAcled().fetch, now: NOW, outFile: out, wait: 0, log: quiet });
  const A = load(out);
  const html = V.panelHtml(A, "SYR");
  assert.match(html, /<h3>Conflict and protest events \(ACLED\)<\/h3>/);
  assert.match(html, /Events, Sep–Oct 2025<\/dt><dd>5<\/dd>/);
  assert.match(html, /Change from Jul–Aug 2025 \(3 events\)<\/dt><dd><span class="glyph up"[^>]*>▲<\/span> \+2 <small>\(\+66\.7%\)<\/small>/);
  assert.match(html, /Most common: Battles 2 · Explosions\/Remote violence 1 · Violence against civilians 1/);
  assert.match(html, /Reported fatalities<\/dt><dd>13 <small>\(Jul–Aug 2025: 5\)<\/small>/);
  assert.match(html, /href="https:\/\/acleddata\.com"/);
  assert.match(html, /not displacement/);
  assert.match(html, /data read 18 Nov 2026/);
  assert.match(html, /older than the news above/); // a year behind: the Research-level lag
  // Kosovo noted under Serbia; covered with no events; not covered; off.
  assert.match(V.panelHtml(A, "SRB"), /Includes events ACLED records under Kosovo\./);
  assert.match(V.panelHtml(A, "SDN"), /<b>No events recorded<\/b> in Sep–Oct 2025\. Jul–Aug 2025: 1 event\./);
  assert.equal(V.panelHtml(A, "TIB"), "");
  assert.equal(V.panelHtml(offState(), "SYR"), "");
  assert.equal(V.panelHtml({ status: "error", countries: {} }, "SYR"), "");
  assert.equal(V.panelHtml(undefined, "SYR"), "");
  assert.equal(V.on(A), true);
  assert.equal(V.on(offState()), false);
  rmSync(dir, { recursive: true });
});

test("the country item escapes text and handles a fall and recent months", () => {
  const V = pageView();
  const A = {
    status: "ok", retrievedAt: "2026-11-18T06:00:00Z", periods: periodsFor("2026-10"), covered: ["AAA"],
    countries: { AAA: { current: { events: 2, fatalities: 0, types: { "<b>x</b>": 2 } }, previous: { events: 4, fatalities: 1, types: {} } } },
  };
  A.periods.current.label = "<i>Sep–Oct</i>";
  const html = V.panelHtml(A, "AAA");
  assert.doesNotMatch(html, /<i>|<b>x/);
  assert.match(html, /&lt;i&gt;Sep–Oct&lt;\/i&gt;/);
  assert.match(html, /glyph down[^>]*>▼<\/span> −2 <small>\(−50\.0%\)/);
  assert.doesNotMatch(html, /Most common/); // unknown types are not listed
  assert.doesNotMatch(html, /older than the news/); // October data on 18 Nov is current
});
