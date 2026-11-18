// Run with: node --test "tests/*.test.mjs"
import { test } from "node:test";
import assert from "node:assert/strict";
import { parseFeed, fetchFeed, decodeFeed, parseReliefWebApi, reliefWebPage, RELIEFWEB_API } from "../scripts/feeds-lib.mjs";

const fakeFetch = (respond) => async (url, opts) => respond(url, opts);
const response = (status, body = "") => ({ status, ok: status >= 200 && status < 300, text: async () => body });
const rss = (items, channel = "") => `<?xml version="1.0"?><rss version="2.0" xmlns:atom="http://www.w3.org/2005/Atom" xmlns:dc="http://purl.org/dc/elements/1.1/" xmlns:media="http://search.yahoo.com/mrss/"><channel><title>Feed</title>${channel}${items}</channel></rss>`;

test("RSS 2.0: CDATA, entities, namespaced tags and categories", () => {
  const xml = rss(`<item>
    <title><![CDATA[Thousands flee <b>Goma</b> &amp; Bukavu]]></title>
    <media:title>Wrong title</media:title>
    <link> https://news.example/a?x=1&amp;y=2 </link>
    <dc:creator>Jane</dc:creator>
    <pubDate>Tue, 20 Oct 2026 10:00:00 GMT</pubDate>
    <description>&lt;p&gt;Caf&eacute; &quot;open&quot; &#39;now&#39; &#x26; &laquo;ok&raquo;&nbsp;done&lt;/p&gt;</description>
    <category>Refugees</category><category><![CDATA[Africa &amp; Asia]]></category>
  </item>`);
  assert.deepEqual(parseFeed(xml), [{
    title: "Thousands flee Goma & Bukavu",
    link: "https://news.example/a?x=1&y=2",
    published: "2026-10-20T10:00:00.000Z",
    description: "Café \"open\" 'now' & «ok» done",
    categories: ["Refugees", "Africa & Asia"],
  }]);
});

test("Atom: rel alternate link, updated date, summary, term categories", () => {
  const xml = `<feed xmlns="http://www.w3.org/2005/Atom"><title>F</title><link rel="self" href="https://n.example/feed"/>
    <entry><title type="html">Floods &amp;amp; displacement</title>
      <link rel="self" href="https://n.example/self"/><link rel="alternate" type="text/html" href="https://n.example/story"/>
      <updated>2026-10-21T08:30:00+02:00</updated><summary>Short text</summary><category term="floods"/></entry>
    <entry><title>No rel</title><link href="https://n.example/norel"/><published>2026-10-22T00:00:00Z</published><content type="html">&lt;p&gt;Body&lt;/p&gt;</content></entry></feed>`;
  const items = parseFeed(xml);
  assert.equal(items.length, 2);
  assert.equal(items[0].link, "https://n.example/story");
  assert.equal(items[0].published, "2026-10-21T06:30:00.000Z");
  assert.equal(items[0].description, "Short text");
  assert.deepEqual(items[0].categories, ["floods"]);
  assert.equal(items[1].link, "https://n.example/norel");
  assert.equal(items[1].published, "2026-10-22T00:00:00.000Z");
  assert.equal(items[1].description, "Body");
});

test("RDF: dc:date and rdf:about items", () => {
  const xml = `<?xml version="1.0"?><rdf:RDF xmlns:rdf="http://www.w3.org/1999/02/22-rdf-syntax-ns#" xmlns="http://purl.org/rss/1.0/" xmlns:dc="http://purl.org/dc/elements/1.1/">
    <channel rdf:about="https://n.example/"><title>F</title><link>https://n.example/</link></channel>
    <item rdf:about="https://n.example/r1"><title>Refugees return</title><link>https://n.example/r1</link><dc:date>2026-10-19T12:00:00Z</dc:date><description>Text</description></item></rdf:RDF>`;
  assert.deepEqual(parseFeed(xml).map((i) => [i.title, i.link, i.published]), [["Refugees return", "https://n.example/r1", "2026-10-19T12:00:00.000Z"]]);
});

test("channel-level atom:link is not an item link; item atom:link is ignored", () => {
  const xml = rss(`<item><title>No link here</title><atom:link rel="self" href="https://n.example/self"/></item>
    <item><title>Has link</title><atom:link rel="self" href="https://n.example/self"/><link>https://n.example/real</link></item>`,
  `<atom:link href="https://n.example/feed.xml" rel="self" type="application/rss+xml"/><link>https://n.example/</link>`);
  assert.deepEqual(parseFeed(xml).map((i) => i.link), ["https://n.example/real"]);
});

test("guid fallback only for permalinks; items without title or http(s) link are skipped", () => {
  const xml = rss(`<item><title>Perma</title><guid isPermaLink="true">https://n.example/g1</guid></item>
    <item><title>Not perma</title><guid isPermaLink="false">abc123</guid></item>
    <item><title>Relative</title><link>/story</link></item>
    <item><link>https://n.example/untitled</link></item>`);
  assert.deepEqual(parseFeed(xml).map((i) => i.link), ["https://n.example/g1"]);
});

test("description: tags stripped, capped at 500 characters, null when empty", () => {
  const long = "word ".repeat(200);
  const xml = rss(`<item><title>A</title><link>https://n.example/a</link><description><![CDATA[<p>Hello <a href="x">world</a></p>${long}]]></description></item>
    <item><title>B</title><link>https://n.example/b</link></item>`);
  const [a, b] = parseFeed(xml);
  assert.ok(a.description.startsWith("Hello world"));
  assert.ok(!/[<>]/.test(a.description));
  assert.equal(a.description.length, 500);
  assert.equal(b.description, null);
  assert.deepEqual(b.categories, []);
});

test("dates: invalid or missing become null", () => {
  const xml = rss(`<item><title>A</title><link>https://n.example/a</link><pubDate>last Tuesday-ish</pubDate></item>
    <item><title>B</title><link>https://n.example/b</link></item>`);
  assert.deepEqual(parseFeed(xml).map((i) => i.published), [null, null]);
});

test("fetchFeed: success, HTTP error, timeout, network error, non-feed", async () => {
  let seen;
  const ok = await fetchFeed("https://n.example/feed", { fetchImpl: fakeFetch((u, o) => { seen = o; return response(200, rss(`<item><title>A</title><link>https://n.example/a</link></item>`)); }) });
  assert.equal(ok.ok, true);
  assert.equal(ok.status, 200);
  assert.equal(ok.items.length, 1);
  assert.match(seen.headers["User-Agent"], /displacement-change-monitor/);
  assert.match(seen.headers.Accept, /application\/rss\+xml/);
  assert.equal(seen.redirect, "follow");
  assert.ok(seen.signal);
  assert.deepEqual(await fetchFeed("u", { fetchImpl: fakeFetch(() => response(404)) }), { ok: false, status: 404, error: "HTTP 404" });
  const timeout = await fetchFeed("u", { fetchImpl: fakeFetch(() => { const e = new Error("t"); e.name = "TimeoutError"; throw e; }) });
  assert.deepEqual(timeout, { ok: false, error: "timeout" });
  assert.deepEqual(await fetchFeed("u", { fetchImpl: fakeFetch(() => { throw new TypeError("fetch failed"); }) }), { ok: false, error: "network error" });
  assert.deepEqual(await fetchFeed("u", { fetchImpl: fakeFetch(() => response(200, "<html><body>Please enable JS</body></html>")) }), { ok: false, status: 200, error: "not a feed" });
  const atom = await fetchFeed("u", { fetchImpl: fakeFetch(() => response(200, `<feed xmlns="http://www.w3.org/2005/Atom"></feed>`)) });
  assert.deepEqual(atom, { ok: true, status: 200, items: [] });
});

// ReliefWeb API: request and response shapes from https://apidoc.reliefweb.int/read/ (no live call: the API
// needs an approved appname).
const rwResponse = {
  href: "https://api.reliefweb.int/v2/reports?appname=x", time: 12, totalCount: 3, count: 3,
  data: [
    { id: 1082221, fields: { title: "Sudan: Displacement update  #12", url: "https://reliefweb.int/node/1082221", url_alias: "https://reliefweb.int/report/sudan/sudan-displacement-update-12",
      date: { original: "2026-11-10T00:00:00+00:00", created: "2026-11-11T08:00:00+00:00" }, primary_country: { name: "Sudan", iso3: "sdn" },
      country: [{ iso3: "sdn" }, { iso3: "tcd" }], source: [{ shortname: "UNHCR", name: "UN High Commissioner for Refugees" }, { name: "IOM" }] } },
    { id: 7, fields: { title: "No link", url: "https://example.com/7", date: { created: "2026-11-01T00:00:00+00:00" } } },
    { id: 8, fields: { title: "", url: "https://reliefweb.int/node/8" } },
  ],
};

test("ReliefWeb API: items keep a ReliefWeb link, date, main country and authors", () => {
  const items = parseReliefWebApi(rwResponse);
  assert.equal(items.length, 2); // the untitled report is dropped
  assert.deepEqual(items[0], {
    id: 1082221, title: "Sudan: Displacement update #12", url: "https://reliefweb.int/report/sudan/sudan-displacement-update-12",
    published: "2026-11-10T00:00:00.000Z", primaryIso: "SDN", countries: ["SDN", "TCD"], sources: ["UNHCR", "IOM"],
  });
  assert.equal(items[1].url, "https://reliefweb.int/node/7"); // the non-ReliefWeb url is replaced by the node link
  assert.equal(items[1].primaryIso, null);
  assert.deepEqual(parseReliefWebApi({}), []);
  assert.deepEqual(parseReliefWebApi(null), []);
});

test("ReliefWeb API: appname on the URL, JSON POST, clear errors", async () => {
  let seenUrl, seen;
  const ok = await reliefWebPage("dcm-test", { limit: 1 }, { fetchImpl: fakeFetch((u, o) => { seenUrl = u; seen = o; return { status: 200, ok: true, json: async () => rwResponse }; }) });
  assert.equal(ok.ok, true);
  assert.equal(ok.totalCount, 3);
  assert.equal(seenUrl, `${RELIEFWEB_API}?appname=dcm-test`);
  assert.equal(seen.method, "POST");
  assert.deepEqual(JSON.parse(seen.body), { limit: 1 });
  assert.equal((await reliefWebPage("x", {}, { fetchImpl: fakeFetch(() => response(403)) })).error, "appname not approved (HTTP 403)");
  assert.equal((await reliefWebPage("x", {}, { fetchImpl: fakeFetch(() => response(429)) })).error, "HTTP 429");
  assert.equal((await reliefWebPage("x", {}, { fetchImpl: fakeFetch(() => ({ status: 200, ok: true, json: async () => { throw new SyntaxError("bad"); } })) })).error, "unreadable response");
  assert.deepEqual(await reliefWebPage("x", {}, { fetchImpl: fakeFetch(() => { throw new TypeError("fetch failed"); }) }), { ok: false, error: "network error" });
});

test("feeds in ISO-8859-1 are decoded by their declared charset", async () => {
  const xml = `<?xml version="1.0" encoding="ISO-8859-1" ?><rss version="2.0"><channel><item><title>Ucrânia e Rússia: refugiados</title><link>https://n.example/a</link></item></channel></rss>`;
  const bytes = new Uint8Array([...xml].map((ch) => ch.charCodeAt(0))); // latin1 bytes
  assert.equal(parseFeed(decodeFeed(bytes.buffer, "text/xml"))[0].title, "Ucrânia e Rússia: refugiados");
  const viaFetch = await fetchFeed("u", { fetchImpl: fakeFetch(() => ({ status: 200, ok: true, headers: { get: () => "text/xml" }, arrayBuffer: async () => bytes.buffer })) });
  assert.equal(viaFetch.items[0].title, "Ucrânia e Rússia: refugiados");
  const utf8 = new TextEncoder().encode(`<rss><channel><item><title>Réfugiés</title><link>https://n.example/b</link></item></channel></rss>`);
  assert.equal(parseFeed(decodeFeed(utf8.buffer, "application/rss+xml; charset=utf-8"))[0].title, "Réfugiés");
});

// Encodes text in a legacy single-byte charset by inverting TextDecoder (Node has no legacy encoder).
const legacyBytes = (text, charset) => {
  const dec = new TextDecoder(charset);
  const map = new Map([...Array(256).keys()].map((b) => [dec.decode(new Uint8Array([b])), b]));
  return new Uint8Array([...text].map((ch) => map.get(ch) ?? 0x3f));
};

test("Arabic and Russian feeds in windows-1256, windows-1251 and KOI8-R are decoded", async () => {
  const ar = "نزوح آلاف السودانيين إلى تشاد";
  const ru = "Тысячи беженцев из Судана прибыли в Чад";
  const item = (title, decl) => `<?xml version="1.0" encoding="${decl}"?><rss version="2.0"><channel><item><title>${title}</title><link>https://n.example/a</link></item></channel></rss>`;
  assert.equal(parseFeed(decodeFeed(legacyBytes(item(ar, "windows-1256"), "windows-1256").buffer, "text/xml"))[0].title, ar);
  assert.equal(parseFeed(decodeFeed(legacyBytes(item(ru, "windows-1251"), "windows-1251").buffer, "application/rss+xml"))[0].title, ru);
  assert.equal(parseFeed(decodeFeed(legacyBytes(item(ru, "x-unknown"), "koi8-r").buffer, "text/xml; charset=KOI8-R"))[0].title, ru); // the HTTP header wins
  const bytes = legacyBytes(item(ru, "windows-1251"), "windows-1251");
  const viaFetch = await fetchFeed("u", { fetchImpl: fakeFetch(() => ({ status: 200, ok: true, headers: { get: () => "text/xml" }, arrayBuffer: async () => bytes.buffer })) });
  assert.equal(viaFetch.items[0].title, ru);
  assert.equal(parseFeed(decodeFeed(new TextEncoder().encode(item(ar, "utf-8")).buffer, ""))[0].title, ar); // UTF-8 stays UTF-8
});
