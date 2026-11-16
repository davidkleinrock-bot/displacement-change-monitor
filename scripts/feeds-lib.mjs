// Feed reading for the news feature: RSS 2.0, RSS 1.0 (RDF) and Atom parsing with regular expressions,
// a fetch helper, and the ReliefWeb (UN OCHA) API. Nothing here reads files; the fetch helpers take
// the fetch function as a parameter so tests can simulate failures.
import { USER_AGENT } from "./news-lib.mjs";

// ---------- Text helpers ----------
const ENTITIES = {
  amp: "&", quot: '"', apos: "'", lt: "<", gt: ">", nbsp: " ",
  eacute: "é", ntilde: "ñ", ccedil: "ç", aacute: "á", iacute: "í", oacute: "ó", uacute: "ú",
  agrave: "à", egrave: "è", ecirc: "ê", ocirc: "ô", atilde: "ã", otilde: "õ", uuml: "ü",
  laquo: "«", raquo: "»", rsquo: "’", lsquo: "‘", ldquo: "“", rdquo: "”", ndash: "–", mdash: "—", hellip: "…",
};

const codePoint = (n, whole) => {
  try { return String.fromCodePoint(n); } catch { return whole; }
};

const decodeEntities = (s) => s.replace(/&(?:#(\d+)|#x([0-9a-f]+)|([a-z]+));/gi, (whole, dec, hex, name) => {
  if (dec) return codePoint(parseInt(dec, 10), whole);
  if (hex) return codePoint(parseInt(hex, 16), whole);
  return ENTITIES[name] ?? ENTITIES[name.toLowerCase()] ?? whole;
});

const unwrapCdata = (s) => s.replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, "$1");

// Raw markup: CDATA unwrapped and entities decoded once, so escaped HTML (&lt;div&gt;) becomes real tags.
const rawText = (s) => decodeEntities(unwrapCdata(s));
const plainText = (s) => rawText(s).replace(/<\/?[a-z!][^>]*>/gi, " ").replace(/\s+/g, " ").trim();

// ---------- Parsing ----------
// Content of the first <name>...</name> in a block; "<media:title>" never matches "title" and a
// self-closing "<link href=... />" is skipped.
function tagContent(block, name) {
  const m = block.match(new RegExp(String.raw`<${name}(?:\s[^>]*[^/>])?>([\s\S]*?)</${name}>`, "i"));
  return m ? m[1] : null;
}

function attr(tag, name) {
  const m = tag.match(new RegExp(String.raw`\s${name}\s*=\s*(?:"([^"]*)"|'([^']*)')`, "i"));
  return m ? decodeEntities(m[1] ?? m[2]) : null;
}

function itemLink(block) {
  const text = tagContent(block, "link");
  if (text) {
    const url = plainText(text);
    if (/^https?:\/\//i.test(url)) return url;
  }
  // Atom: <link href=... rel="alternate"/> or no rel; the namespaced <atom:link> is not matched.
  for (const tag of block.match(/<link\s[^>]*>/gi) || []) {
    const rel = attr(tag, "rel"), href = attr(tag, "href");
    if (href && (!rel || rel.toLowerCase() === "alternate") && /^https?:\/\//i.test(href.trim())) return href.trim();
  }
  const guid = block.match(/<guid\s[^>]*isPermaLink\s*=\s*["']true["'][^>]*>([\s\S]*?)<\/guid>/i);
  if (guid) {
    const url = plainText(guid[1]);
    if (/^https?:\/\//i.test(url)) return url;
  }
  return null;
}

function itemDate(block) {
  for (const name of ["pubDate", "dc:date", "published", "updated"]) {
    const t = tagContent(block, name);
    if (t == null) continue;
    const d = new Date(plainText(t));
    if (!Number.isNaN(d.getTime())) return d.toISOString();
  }
  return null;
}

function itemCategories(block) {
  const out = [];
  for (const m of block.matchAll(/<category(\s[^>]*)?(?:\/>|>([\s\S]*?)<\/category>)/gi)) {
    const v = m[2] != null ? plainText(m[2]) : (attr(m[1] || "", "term") || "").trim();
    if (v) out.push(v);
  }
  return out;
}

function parseBlocks(xml) {
  const out = [];
  for (const m of String(xml).matchAll(/<(item|entry)(?:\s[^>]*)?>([\s\S]*?)<\/\1>/gi)) {
    const block = m[2];
    const title = plainText(tagContent(block, "title") ?? "");
    const link = itemLink(block);
    if (!title || !link) continue;
    const descRaw = tagContent(block, "description") ?? tagContent(block, "summary") ?? tagContent(block, "content");
    const description = descRaw == null ? "" : plainText(descRaw).slice(0, 500);
    out.push({
      item: { title, link, published: itemDate(block), description: description || null, categories: itemCategories(block) },
    });
  }
  return out;
}

export const parseFeed = (xml) => parseBlocks(xml).map((b) => b.item);

// ---------- Fetching ----------
// Feeds are not always UTF-8 (Folha de S.Paulo's is ISO-8859-1). The charset comes from the HTTP header,
// else from the <?xml encoding="..."?> declaration, else UTF-8.
export function decodeFeed(buf, contentType = "") {
  const bytes = new Uint8Array(buf);
  const head = new TextDecoder("latin1").decode(bytes.subarray(0, 200));
  const charset = (contentType || "").match(/charset=["']?([\w-]+)/i)?.[1] || head.match(/<\?xml[^>]*encoding=["']([\w-]+)["']/i)?.[1] || "utf-8";
  try { return new TextDecoder(charset.toLowerCase()).decode(bytes); } catch { return new TextDecoder("utf-8").decode(bytes); }
}

export async function fetchFeed(url, { fetchImpl = fetch, timeoutMs = 15000 } = {}) {
  let res, text;
  try {
    res = await fetchImpl(url, {
      headers: { "User-Agent": USER_AGENT, Accept: "application/rss+xml, application/atom+xml, application/xml, text/xml;q=0.9, */*;q=0.5" },
      redirect: "follow",
      signal: AbortSignal.timeout(timeoutMs),
    });
    if (res.ok) text = (res.arrayBuffer ? decodeFeed(await res.arrayBuffer(), res.headers?.get?.("content-type")) : await res.text()).slice(0, 5_000_000);
  } catch (e) {
    return { ok: false, error: e?.name === "TimeoutError" ? "timeout" : "network error" };
  }
  if (!res.ok) return { ok: false, status: res.status, error: `HTTP ${res.status}` };
  if (!/<(?:rss|feed|rdf:RDF)\b/i.test(text)) return { ok: false, status: res.status, error: "not a feed" };
  return { ok: true, status: res.status, items: parseFeed(text) };
}

// ---------- ReliefWeb API ----------
// ReliefWeb (UN OCHA) is read only through its official API, which needs an appname that ReliefWeb approves
// (free; requested with a short form, https://apidoc.reliefweb.int). Its public RSS pages are not used: on
// 16 Nov 2026 its firewall refused scripted requests to them (HTTP 406/429). API limits: 1,000 items per
// call and 10,000 calls a day. Documented request and response shapes: https://apidoc.reliefweb.int/read/
export const RELIEFWEB_API = "https://api.reliefweb.int/v2/reports";
export const RELIEFWEB_FIELDS = ["title", "url", "url_alias", "date.original", "date.created", "primary_country.iso3", "country.iso3", "source.shortname", "source.name"];

export async function reliefWebPage(appname, body, { fetchImpl = fetch, timeoutMs = 30000 } = {}) {
  let res;
  try {
    res = await fetchImpl(`${RELIEFWEB_API}?appname=${encodeURIComponent(appname)}`, {
      method: "POST",
      headers: { "User-Agent": USER_AGENT, "Content-Type": "application/json", Accept: "application/json" },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(timeoutMs),
    });
  } catch (e) {
    return { ok: false, error: e?.name === "TimeoutError" ? "timeout" : "network error" };
  }
  if (!res.ok) return { ok: false, status: res.status, error: res.status === 403 ? "appname not approved (HTTP 403)" : res.status === 400 ? "bad request or missing appname (HTTP 400)" : `HTTP ${res.status}` };
  try {
    const json = await res.json();
    return { ok: true, status: res.status, totalCount: json.totalCount ?? null, items: parseReliefWebApi(json) };
  } catch {
    return { ok: false, status: res.status, error: "unreadable response" };
  }
}

// One item per report: its ReliefWeb page, the date it was published (original date, else when ReliefWeb
// posted it), its main country and the organizations that wrote it. Items without a ReliefWeb link are dropped.
export function parseReliefWebApi(json) {
  const out = [];
  for (const d of Array.isArray(json?.data) ? json.data : []) {
    const f = d?.fields || {};
    const url = [f.url_alias, f.url, d.id ? `https://reliefweb.int/node/${d.id}` : null].find((u) => typeof u === "string" && /^https:\/\/reliefweb\.int\//.test(u));
    const published = f.date?.original || f.date?.created || null;
    const t = published ? Date.parse(published) : NaN;
    if (!url || typeof f.title !== "string" || !f.title.trim()) continue;
    const list = (x) => (Array.isArray(x) ? x : x ? [x] : []);
    out.push({
      id: d.id ?? null,
      title: f.title.replace(/\s+/g, " ").trim(),
      url,
      published: Number.isNaN(t) ? null : new Date(t).toISOString(),
      primaryIso: (f.primary_country?.iso3 || "").toUpperCase() || null,
      countries: list(f.country).map((c) => (c?.iso3 || "").toUpperCase()).filter(Boolean),
      sources: list(f.source).map((x) => x?.shortname || x?.name).filter(Boolean),
    });
  }
  return out;
}
