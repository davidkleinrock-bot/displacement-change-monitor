// Run with: node --test tests/
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import {
  newsWindow, checkDate, isDisplacement, isPersonalOrOpinion, buildMatchers, attributeCountries,
  cleanTitle, normTitle, dedupe, parseArticleMeta, summarize, fetchArticleMeta, downloadFile, newsState,
} from "../scripts/news-lib.mjs";

const readJS = (p) => { const s = readFileSync(p, "utf8"); return JSON.parse(s.slice(s.indexOf("{"), s.lastIndexOf("}") + 1)); };
const data = readJS("data/dashboard-data.js");
const matchers = buildMatchers(data.countries, JSON.parse(readFileSync("data/raw/geo/world-countries.json", "utf8")));
const about = (t) => attributeCountries(t, matchers).sort();

test("window: two calendar months back from today, inclusive", () => {
  assert.deepEqual(newsWindow(new Date("2026-10-25T15:00:00Z")), { from: "2026-08-25", to: "2026-10-25", months: 2 });
  assert.equal(newsWindow(new Date("2026-12-31T00:00:00Z")).from, "2026-10-31");
  assert.equal(newsWindow(new Date("2026-04-30T12:00:00Z")).from, "2026-02-28"); // clamped to the end of February
  assert.equal(newsWindow(new Date("2028-04-30T12:00:00Z")).from, "2028-02-29"); // leap year
  assert.equal(newsWindow(new Date("2026-01-15T12:00:00Z")).from, "2025-11-15"); // crosses the year
  assert.equal(newsWindow(new Date("2026-10-25T23:59:59Z"), 1).from, "2026-09-25"); // configurable
});

test("dates: both ends included; earlier, future, invalid and missing rejected", () => {
  const w = { from: "2026-08-25", to: "2026-10-25" };
  assert.deepEqual(checkDate("2026-08-25T00:00:00Z", w), { date: "2026-08-25" });
  assert.deepEqual(checkDate("2026-10-25T23:59:59Z", w), { date: "2026-10-25" });
  assert.deepEqual(checkDate("2026-08-24T23:59:59Z", w), { reason: "older" });
  assert.deepEqual(checkDate("2026-10-26T00:00:01Z", w), { reason: "future" });
  assert.deepEqual(checkDate("2026-10-20T22:58:14+05:30", w), { date: "2026-10-20" }); // offsets convert to UTC
  assert.deepEqual(checkDate("not a date", w), { reason: "invalid" });
  assert.deepEqual(checkDate(null, w), { reason: "missing" });
});

test("topic: forced displacement in, look-alikes out", () => {
  for (const t of ["UN says more than 230,000 displaced by fighting in Yemen since August", "Millions of Ukrainians Could Flee Again This Winter: UN", "At least 12 dead after migrant boat sinks off Gambia", "7,000 Nigerian refugees return home in 2026"]) assert.ok(isDisplacement(t), t);
  for (const t of ["U.S. troops and diplomats evacuating Middle East posts, sources say", "Suspected insurgents attack Mozambique wildlife camp, US citizens evacuated", "Houses near US air force base in UK evacuated after 2 detained"]) assert.ok(!isDisplacement(t), t);
  for (const t of ["Zelenskyy warns 20M Ukrainians could flee to Europe if Russia wins war", "Thousands evacuated as floods hit northern Nigeria", "1,200 families flee Goma"]) assert.ok(isDisplacement(t), t);
  for (const t of ["Brush fires spark in Southern California, prompting evacuation orders", "Pickering murder suspect flees Canada, police say", "AI will not bring about displacement in public service", "It's not just billionaires fleeing Britain—a record 69,300 workers have left the U.K."]) assert.ok(!isDisplacement(t), t);
});

test("profiles, opinion and section pages are left out", () => {
  assert.ok(isPersonalOrOpinion("She fled Ukraine to safety in Alberta. Now, she's worried"));
  assert.ok(isPersonalOrOpinion("From Liberian refugee to Montana's first Black mayor"));
  assert.ok(isPersonalOrOpinion("'Betrayal': She fought drug traffickers in Honduras, but was denied U.S. asylum"));
  assert.ok(isPersonalOrOpinion("Opinion: Welcoming refugees is what Jesus commands us to do"));
  assert.ok(isPersonalOrOpinion("Gaza refugees and the West", "https://example.com/opinion/2026/10/gaza"));
  assert.ok(!isPersonalOrOpinion("Sudanese refugees pour into eastern Chad", "https://example.com/world/africa/sudan"));
});

test("countries: names inside other names don't match", () => {
  assert.deepEqual(about("South Sudan refugees flee renewed fighting"), ["SSD"]);
  assert.deepEqual(about("Fighting in Papua New Guinea displaces thousands"), ["PNG"]);
  assert.deepEqual(about("Guinea-Bissau asylum seekers stranded"), ["GNB"]);
  assert.deepEqual(about("Oil spill in Niger Delta displaces villagers"), []);
  assert.deepEqual(about("Congo-Brazzaville floods displace thousands"), ["COG"]);
  assert.deepEqual(about("Latin American migrants stranded after shipwreck"), []);
});

test("countries: aliases, abbreviations and shared demonyms", () => {
  assert.deepEqual(about("DR Congo: M23 advance displaces 100,000 near Goma"), ["COD"]);
  assert.deepEqual(about("Congolese refugees arrive in Uganda"), ["COD", "UGA"]);
  assert.deepEqual(about("Rohingya refugees in Cox’s Bazar face ration cuts"), ["BGD", "MMR"]);
  assert.deepEqual(about("UK to cut asylum hotel use, says Home Office"), ["GBR"]);
  assert.deepEqual(about("Thousands displaced in Darfur as RSF advances"), ["SDN"]);
  assert.deepEqual(about("us and them: asylum debate heats up in Ireland"), ["IRL"]); // lower-case "us" is not the US
  assert.deepEqual(about("US refugee admissions fall to record low"), ["USA"]); // the Oct 23 snapshot had no US articles because "US" wasn't matched
});

test("countries: the displaced country wins over a passing mention", () => {
  assert.deepEqual(about("Israel’s Yellow Line in Gaza advances, leaving displaced with nowhere to go"), ["PSE"]);
  assert.deepEqual(about("Zelenskyy warns 20M Ukrainians could flee to Europe if Russia wins war"), ["UKR"]);
  assert.deepEqual(about("Sudanese refugees pour into eastern Chad"), ["SDN", "TCD"]);
  assert.deepEqual(about("Georgia asylum seekers detained near Atlanta, officials say"), []); // the US state
  assert.deepEqual(about("Thousands displaced in Georgia after strikes near Tbilisi"), ["GEO"]);
  assert.deepEqual(about("Greece proposes EU emergency migration mechanism with 30-day asylum suspension"), ["GRC"]);
});

test("duplicates: syndicated copies collapse to one, best-documented copy kept", () => {
  assert.equal(cleanTitle("Israel's Yellow Line in Gaza advances, leaving displaced | Israel-Palestine conflict News | Al Jazeera"), "Israel's Yellow Line in Gaza advances, leaving displaced");
  assert.equal(normTitle("AP gets exclusive look at drone - Idaho State Journal"), normTitle("AP gets exclusive look at drone – Winnipeg Free Press"));
  const kept = dedupe([
    { title: "Thousands flee fighting in Sudan - Outlet A", url: "a", date: "2026-10-01" },
    { title: "Thousands flee fighting in Sudan | Outlet B", url: "b", date: "2026-10-02", link: "verified", description: "x".repeat(50) },
    { title: "Different story about Chad refugees", url: "c", date: "2026-10-03" },
  ]);
  assert.equal(kept.length, 2);
  assert.equal(kept.find((a) => a.url !== "c").url, "b");
});

test("publisher pages: summary, site name and date are read; short or repeated summaries dropped", () => {
  const html = `<html><head><title>Ignored</title>
    <meta property="og:title" content="Thousands flee fighting in Sudan">
    <meta name="description" content="Aid groups say 30,000 people have crossed into Chad this week as fighting spreads across Darfur, straining camps.">
    <meta property="og:site_name" content="Reuters">
    <script type="application/ld+json">{"@graph":[{"@type":"NewsArticle","datePublished":"2026-10-20T12:58:49Z"}]}</script></head></html>`;
  const m = parseArticleMeta(html);
  assert.equal(m.siteName, "Reuters");
  assert.equal(m.published, "2026-10-20T12:58:49Z");
  assert.match(summarize(m.description, m.title), /^Aid groups say 30,000/);
  assert.equal(summarize("Too short", "x"), null);
  assert.equal(summarize("Thousands flee fighting in Sudan", "Thousands flee fighting in Sudan"), null);
  assert.ok(summarize("word ".repeat(80), "t").length <= 221);
});

const fakeFetch = (respond) => async (url, opts) => respond(url, opts);
const response = (status, body = "", url = "https://news.example/world/story") => ({ status, ok: status >= 200 && status < 300, url, text: async () => body, arrayBuffer: async () => new TextEncoder().encode(body).buffer });

test("links: dead, mismatched, blocked and failing pages are told apart", async () => {
  const title = "Thousands flee fighting in Sudan";
  const page = `<meta property="og:title" content="Thousands flee fighting in Sudan as RSF advances"><meta property="article:published_time" content="2026-10-20T10:00:00Z">`;
  assert.equal((await fetchArticleMeta("https://n.example/a", title, { fetchImpl: fakeFetch(() => response(404)) })).link, "broken");
  assert.equal((await fetchArticleMeta("https://n.example/a", title, { fetchImpl: fakeFetch(() => response(410)) })).link, "broken");
  assert.equal((await fetchArticleMeta("https://n.example/a", title, { fetchImpl: fakeFetch(() => response(503)) })).link, "unverified");
  assert.equal((await fetchArticleMeta("https://n.example/a", title, { fetchImpl: fakeFetch(() => response(403)) })).link, "unverified");
  const timeout = await fetchArticleMeta("https://n.example/a", title, { fetchImpl: fakeFetch(() => { const e = new Error("t"); e.name = "TimeoutError"; throw e; }) });
  assert.deepEqual(timeout, { link: "unverified", reason: "timeout" });
  assert.equal((await fetchArticleMeta("https://n.example/a", title, { fetchImpl: fakeFetch(() => { throw new TypeError("fetch failed"); }) })).reason, "network error");
  assert.equal((await fetchArticleMeta("https://n.example/a/b", title, { fetchImpl: fakeFetch(() => response(200, page, "https://n.example/")) })).link, "mismatched");
  assert.equal((await fetchArticleMeta("https://n.example/a", title, { fetchImpl: fakeFetch(() => response(200, `<meta property="og:title" content="Football results from the weekend">`)) })).link, "mismatched");
  const ok = await fetchArticleMeta("https://n.example/a", title, { fetchImpl: fakeFetch(() => response(200, page)) });
  assert.equal(ok.link, "verified");
  assert.equal(ok.meta.published, "2026-10-20T10:00:00Z");
});

test("GDELT files: a missing slot is skipped, repeated server errors fail loudly", async () => {
  assert.equal(await downloadFile("u", { fetchImpl: fakeFetch(() => response(404)), pauseMs: 0 }), null);
  await assert.rejects(downloadFile("u", { fetchImpl: fakeFetch(() => response(500)), pauseMs: 0 }), /HTTP 500/);
  let calls = 0;
  const flaky = fakeFetch(() => (++calls < 2 ? response(502) : response(200, "zipdata")));
  assert.equal((await downloadFile("u", { fetchImpl: flaky, pauseMs: 0 })).toString(), "zipdata");
});

test("empty results are distinguished from failures and unsearched rows", () => {
  const news = { searched: ["SDN", "TUV"], byCountry: { SDN: [{ title: "t" }] } };
  assert.equal(newsState(null, "SDN").state, "not-loaded");
  assert.equal(newsState(news, "UNK").state, "not-searched");
  assert.equal(newsState(news, "TUV").state, "none");
  assert.equal(newsState(news, "TUV").message, "No relevant news found in the selected period.");
  assert.equal(newsState(news, "SDN").state, "found");
});
