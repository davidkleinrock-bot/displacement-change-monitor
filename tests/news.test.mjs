// Run with: node --test "tests/*.test.mjs"
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import {
  newsWindow, checkDate, isDisplacement, isCoreDisplacement, isPersonalOrOpinion, buildMatchers, attributeCountries,
  displacementThemes, sourceLanguage, makeOutletChecker, clusterEvents, pickForCountry,
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

// ---------- Rules added 16 Nov 2026 after auditing the live panel ----------

test("topic: Spanish, French and Portuguese headlines; false friends left out", () => {
  for (const t of ["Miles de desplazados por la violencia en el Catatumbo", "Des milliers de déplacés fuient les combats au Nord-Kivu",
    "Refugiados venezuelanos chegam a Roraima", "Solicitantes de asilo esperan en Tapachula", "Réfugiés soudanais : l'afflux continue au Tchad"]) assert.ok(isDisplacement(t), t);
  for (const t of ["Le match déplacé à samedi soir", "Inauguran asilo de ancianos en Lima"]) assert.ok(!isCoreDisplacement(t), t);
  assert.ok(isCoreDisplacement("Miles de refugiados cruzan la frontera"));
  assert.ok(!isCoreDisplacement("Thousands flee fighting in Sudan")); // feeds need a core term; GDELT articles have topic tags
});

test("topic: look-alikes from the 16 Nov audit are left out", () => {
  for (const t of ["At least 300 schools evacuated in Italy after email bomb alerts", "Seniors displaced by fatal fire in Fort Frances, Ont.",
    "Australia's IDP Education rejects Blackstone's sweetened takeover bid", "Oman carries out medical evacuation of 10 crew members after tanker attack",
    "Nigerian man who fled US in 2019 arrested at US airport"]) assert.ok(!isDisplacement(t), t);
  assert.ok(isDisplacement("Thousands evacuated as floods hit northern Nigeria")); // still counts
  assert.ok(isPersonalOrOpinion("Russian man swims from Kaliningrad to Lithuania in failed asylum attempt"));
  assert.ok(isPersonalOrOpinion("Lula calls Flavio Bolsonaro fleeing Brazil 'shameful' as aide confirms political asylum"));
  assert.ok(!isPersonalOrOpinion("Student visas for refugees cut by half"));
});

test("GDELT tags and languages", () => {
  assert.deepEqual(displacementThemes("TAX_FNCACT;REFUGEES;EVACUATION;WB_740_FORCED_DISPLACEMENT;REFUGEES"), ["REFUGEES", "WB_740_FORCED_DISPLACEMENT"]);
  assert.deepEqual(displacementThemes("EVACUATION;IMMIGRATION;EPU_CATS_MIGRATION_FEAR_FEAR"), []);
  assert.deepEqual(displacementThemes(undefined), []);
  assert.equal(sourceLanguage("srclc:spa;eng:GT-SPA 1.0"), "es");
  assert.equal(sourceLanguage("srclc:fra;eng:GT-FRA 1.0"), "fr");
  assert.equal(sourceLanguage(""), "en");
  assert.equal(sourceLanguage("srclc:ara;eng:GT-ARA 1.0"), null);
});

test("countries: names in Spanish, French and Portuguese, with the same guards", () => {
  assert.deepEqual(about("Refugiados venezolanos en Colombia"), ["COL", "VEN"]);
  assert.deepEqual(about("Des milliers de déplacés au Soudan du Sud"), ["SSD"]);
  assert.deepEqual(about("Réfugiés soudanais au Tchad"), ["SDN", "TCD"]);
  assert.deepEqual(about("Miles de haitianos huyen de la violencia"), ["HTI"]);
  assert.deepEqual(about("Papúa Nueva Guinea: miles de desplazados por un deslizamiento"), ["PNG"]);
  assert.deepEqual(about("Haïti : des milliers de déplacés à Port-au-Prince"), ["HTI"]);
});

test("countries: misfires from the 16 Nov audit", () => {
  assert.ok(!about("Asylum seekers displaced in Fort Frances, Ontario").includes("FRA"));
  assert.ok(!about("Asylum seekers moved to Jamaica Plain shelter").includes("JAM"));
  assert.deepEqual(about("Dutch Safety Board warns 7,000 asylum children at risk"), ["NLD"]);
  assert.ok(about("Israeli raids displace hundreds of Palestinians in Hebron").includes("PSE"));
  assert.deepEqual(attributeCountries("Niger IDPs say returning home is priority", matchers, { domain: "punchng.com" }), []);
  assert.deepEqual(attributeCountries("Niger IDPs say returning home is priority", matchers, { domain: "rfi.fr" }), ["NER"]);
});

test("one event takes one slot; one outlet can't fill a country's list", () => {
  const boat = (domain, date, title = "At least 139 migrants dead after boat from Djibouti to Yemen capsizes") => ({ title, url: `${domain}/${date}`, domain, date, link: "verified" });
  const kept = clusterEvents([
    boat("a.com", "2026-11-10"),
    boat("b.com", "2026-11-11", "At least 139 migrants dead as boat from Djibouti capsizes off Yemen"),
    boat("c.com", "2026-11-10"),
    boat("d.com", "2026-11-12", "UNHCR warns of new arrivals in Djibouti"),
  ]);
  assert.equal(kept.length, 2);
  const titles = ["Rains flood camps in eastern Chad", "WFP cuts rations for Sudanese refugees", "New arrivals at Adre crossing", "Measles outbreak in Ourang camp", "Chad opens new settlement near Abeche"];
  const sameOutlet = titles.map((title, i) => ({ title, url: `u${i}`, domain: "same.com", date: `2026-11-0${i + 1}` }));
  const picked = pickForCountry(sameOutlet, { perOutlet: 3 });
  assert.equal(picked.length, 3);
  assert.equal(picked[0].date, "2026-11-05"); // newest first
});

test("outlets: only the hand-picked list and UN bodies count; blocks win", () => {
  const curated = {
    allow: { "thenewhumanitarian.org": { name: "The New Humanitarian", tier: "humanitarian", lang: "en" }, "radiotamazuj.org": { name: "Radio Tamazuj", tier: "regional" } },
    block: { "variety.com": "Entertainment trade press", "yahoo.com": "Aggregator" },
    intergovernmental: { suffixes: [".int"], domains: ["un.org"] },
  };
  const outlet = makeOutletChecker(curated);
  assert.equal(outlet("thenewhumanitarian.org").tier, "humanitarian");
  assert.equal(outlet("www.radiotamazuj.org").basis, "curated");
  assert.equal(outlet("nytimes.com"), null); // not on the list: no outside rating list is used
  assert.equal(outlet("wn.com"), null);
  assert.equal(outlet("variety.com"), null);
  assert.equal(outlet("news.yahoo.com"), null);
  assert.equal(outlet("iom.int").basis, "intergovernmental");
  assert.equal(outlet("news.un.org").basis, "intergovernmental");
  assert.equal(outlet("example.com"), null);
});

test("the real outlet and feed lists are consistent", () => {
  const curated = JSON.parse(readFileSync("data/outlets.json", "utf8"));
  const feeds = JSON.parse(readFileSync("data/feeds.json", "utf8")).feeds;
  const outlet = makeOutletChecker(curated);
  for (const d of Object.keys(curated.allow)) {
    assert.ok(!curated.block[d], `${d} is both allowed and blocked`);
    assert.ok(curated.tiers[curated.allow[d].tier], `${d} has an unknown tier`);
    assert.ok(curated.allow[d].why, `${d} has no reason`);
    assert.ok(!/wikipedia/i.test(curated.allow[d].why), `${d}'s reason relies on Wikipedia`);
    assert.ok(curated.levels[curated.allow[d].check?.level], `${d} has no outlet-test result`);
    assert.ok(!curated.excluded[d], `${d} is both allowed and excluded`);
  }
  for (const [d, x] of Object.entries(curated.excluded)) assert.ok(x.reason && outlet(d) === null, `${d} is excluded without a reason, or still counts`);
  // The two tests: a church-owned paper and state-controlled channels fail; a local outlet that doesn't
  // publish its owner but states its independence and has its own reporters passes, marked as such.
  for (const d of ["csmonitor.com", "aljazeera.com", "channelnewsasia.com", "theconversation.com"]) assert.equal(outlet(d), null, d);
  assert.equal(outlet("radiotamazuj.org").level, "owner-not-published");
  assert.equal(outlet("www.bbc.co.uk").level, "checked");
  assert.ok(outlet("punchng.com").databases.length > 0);
  assert.equal(outlet("news.un.org").level, "official");
  for (const d of ["wn.com", "aol.com", "msn.com", "yahoo.com", "metro.co.uk", "seekingalpha.com", "reliefweb.int"]) assert.equal(outlet(d), null, d);
  for (const f of feeds) {
    assert.match(f.url, /^https:\/\//, f.url);
    assert.ok(outlet(f.domain), `feed outlet ${f.domain} does not count`);
    assert.ok(["en", "es", "fr", "pt"].includes(f.lang), f.url);
  }
});

// ---------- Cases from the independent review of 16 Nov 2026 ----------

test("topic: words that also mean 'travelled', old-age homes and one person's asylum are left out", () => {
  for (const t of ["Cientos de aficionados argentinos desplazados a Qatar", "Militares desplazados a la frontera con Venezuela",
    "Les supporters marseillais déplacés à Lisbonne", "Les trois lynx retrouvés morts avaient été déplacés",
    "Incendio en asilo de adultos mayores en Guatemala deja cinco muertos", "Wildfire prompts evacuations for homes within 5 miles in Malibu",
    "Huyen 200 reos de una cárcel en Ecuador", "Les super riches fuient le Royaume-Uni face à la fiscalité", "Simulacro de evacuación en 300 escuelas"]) assert.ok(!isDisplacement(t), t);
  assert.ok(isPersonalOrOpinion("Evo Morales pide asilo en México"));
  assert.ok(isPersonalOrOpinion("El exvicepresidente de Bolivia destapa el porqué de su asilo en México"));
});

test("topic: real displacement in the four languages, including arrests mentioned in passing", () => {
  for (const t of ["Haiti: 10,000 flee Cabaret as gangs attack; two suspects arrested", "Displaced families in Goma say M23 arrested dozens of young men",
    "Mais de 100 mil pessoas fugiram da violência no Haiti", "Plus de 100 000 personnes ont fui les violences au Soudan",
    "Más de 100.000 personas han huido de la violencia en Haití", "La guerra al sur de Venezuela que desplaza a los indígenas",
    "Miles de desplazados por la violencia en el Catatumbo", "Desplazados internos en Birmania"]) assert.ok(isDisplacement(t), t);
});

test("countries: translated names that are everyday words or other places", () => {
  assert.deepEqual(about("L'administration américaine suspend l'accueil des réfugiés"), ["USA"]);
  assert.deepEqual(about("ACNUR convoca una reunión de emergencia sobre refugiados sudaneses"), ["SDN"]);
  assert.deepEqual(about("Equipo de refugiados gana medalla de bronce"), []);
  assert.deepEqual(about("Police fire stun grenades at refugees protesting in camp"), []);
  assert.deepEqual(about("Asylum seekers wait years for family reunion visas"), []);
  assert.deepEqual(about("Mauricio Macri pide ayuda para los refugiados"), []);
  assert.ok(!about("Desplazados en Cartagena de Indias").includes("IND"));
  assert.deepEqual(about("Rohingya genocide case opens at ICJ in The Hague"), ["MMR"]);
  assert.deepEqual(about("Refugiados en Irlanda del Norte"), ["GBR"]);
  assert.ok(about("Refugiados sírios no Líbano").includes("SYR"));
  assert.ok(about("Refugiados palestinos en Líbano").includes("PSE"));
});

test("countries: a list of host countries keeps the country people fled", () => {
  assert.deepEqual(about("Refugiados venezolanos en Colombia, en Perú y en Chile"), ["VEN"]);
  assert.deepEqual(about("Ukrainian refugees in Poland, in Germany and in Czechia"), ["UKR"]);
  assert.deepEqual(about("Sudanese refugees pour into eastern Chad"), ["SDN", "TCD"]); // two countries: both kept
});

test("events: different stories about one country stay apart; a full outlet gives way to another copy", () => {
  const sudan = matchers.get("SDN").terms;
  const two = [
    { title: "Sudanese refugees in Chad face cholera outbreak", url: "a", domain: "a.com", date: "2026-11-10" },
    { title: "Sudanese refugees arrive in Chad after El Fasher attack", url: "b", domain: "b.com", date: "2026-11-11" },
  ];
  assert.equal(pickForCountry(two, { ignore: sudan }).length, 2);
  const reuters = (title, date) => ({ title, url: title, domain: "reuters.com", outlet: "Reuters", date, link: "verified", tier: "wire" });
  const items = [
    reuters("Rains flood camps in eastern Chad", "2026-11-12"), reuters("WFP cuts rations for Sudanese refugees", "2026-11-11"),
    reuters("New arrivals at Adre crossing overwhelm clinics", "2026-11-10"), reuters("Thousands displaced as floods hit Gaza tent camps", "2026-11-05"),
    { title: "Thousands displaced as floods swamp Gaza tent camps", url: "aj", domain: "aljazeera.com", outlet: "Al Jazeera", date: "2026-11-05", tier: "broadcaster" },
  ];
  const picked = pickForCountry(items, { perOutlet: 3 });
  assert.equal(picked.length, 4);
  assert.equal(picked.at(-1).outlet, "Al Jazeera");
  assert.equal(pickForCountry([{ ...reuters("A story about camps", "2026-11-01"), domain: "bbc.com", outlet: "BBC" }, ...["x one two", "y three four", "z five six"].map((t, i) => ({ ...reuters(`${t} camps story`, `2026-11-0${i + 2}`), domain: "bbc.co.uk", outlet: "BBC" }))], { perOutlet: 3 }).length, 3); // one outlet, two domains
});

test("individual cases and place-name look-alikes found in the 16 Nov backfill", () => {
  for (const t of ["How I rejected US asylum, landed in prison", "SA 'refugee' indicted in US over child abuse material",
    "Sri Lankan refugee gets seven years jail for sexual assault case", "Presidencia argentina afirma que Flávio Bolsonaro no ha solicitado asilo",
    "Lituânia recusa asilo a russo que nadou de Kaliningrado"]) assert.ok(isPersonalOrOpinion(t), t);
  assert.ok(!isPersonalOrOpinion("Estados Unidos aumenta las tarifas para solicitar asilo, TPS y permisos de trabajo"));
  assert.ok(!isDisplacement("Más de 100 policías desplegados para cazar al 'Ruso', el ex legionario huido tras matar a un agente"));
  assert.ok(!about("Diplomat led operation to save desperate refugees afloat on the South China Sea").includes("CHN"));
});

test("translations: only Spanish, French and Portuguese, once per text, kept from earlier runs", async () => {
  const { translateItems } = await import("../scripts/translate.mjs");
  const calls = [];
  const translate = async (t) => (calls.push(t), `EN(${t})`);
  const items = [
    { lang: "es", title: "Miles de desplazados", description: "Resumen" },
    { lang: "es", title: "Miles de desplazados", description: "Resumen" }, // same article filed under two countries
    { lang: "fr", title: "Réfugiés au Tchad", titleEn: "Refugees in Chad" }, // translated in an earlier run
    { lang: "en", title: "Refugees in Chad" },
    { lang: "pt", title: "Deslocados internos" },
  ];
  const r = await translateItems(items, { translate });
  assert.equal(r.translated, 3);
  assert.deepEqual(calls, ["Miles de desplazados", "Resumen", "Deslocados internos"]);
  assert.equal(items[1].titleEn, "EN(Miles de desplazados)");
  assert.equal(items[1].descriptionEn, "EN(Resumen)");
  assert.equal(items[2].titleEn, "Refugees in Chad");
  assert.equal(items[3].titleEn, undefined);
  const failing = await translateItems([{ lang: "es", title: "x" }], { translate: async () => { throw new Error("model failed"); } });
  assert.equal(failing.translated, 0);
});

test("translations: names the model mangles are put back", async () => {
  const { fixNames } = await import("../scripts/translate.mjs");
  assert.equal(fixNames("Corporal Delgado, at least 1,235 people have escaped"), "Cabo Delgado, at least 1,235 people have escaped");
  assert.equal(fixNames("DRC: Pnud relays the cry of displaced persons"), "DRC: UNDP relays the cry of displaced persons");
  assert.equal(fixNames("refugees facing precarious conditions in Rutsh-Hur"), "refugees facing precarious conditions in Rutshuru");
});

test("translations: a phrase the model repeats is kept once", async () => {
  const { fixNames } = await import("../scripts/translate.mjs");
  assert.equal(fixNames("fled attacks by armed ins armed ins in four districts"), "fled attacks by armed ins in four districts");
  assert.equal(fixNames("Thousands flee flee fighting"), "Thousands flee fighting");
  assert.equal(fixNames("Refugees in Chad and Chad's camps"), "Refugees in Chad and Chad's camps");
});
