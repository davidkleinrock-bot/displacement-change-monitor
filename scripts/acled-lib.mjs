// Rules for the ACLED conflict and protest event counts. Used by fetch-acled.mjs and the tests.
//
// ACLED (Armed Conflict Location & Event Data), https://acleddata.com. API documentation:
//   https://acleddata.com/api-documentation/getting-started        (OAuth token, Bearer header)
//   https://acleddata.com/api-documentation/elements-acleds-api    (filters, fields, cursor paging)
//   https://acleddata.com/api-documentation/acled-endpoint         (fields; iso is the ISO 3166 numeric code)
// Terms: https://acleddata.com/eula (section 3.1: material published outside the licensee "must be transformative,
// such that they cannot be reverse engineered to recreate the Licensed Content") and
// https://acleddata.com/attributionpolicy. So only totals per country, event type and two-month period are kept
// and published. Event rows are read into memory, counted, and never written anywhere.

export const TOKEN_URL = "https://acleddata.com/oauth/token";
export const READ_URL = "https://acleddata.com/api/acled/read";
export const PAGE_SIZE = 5000; // ACLED's documented default row limit
export const MAX_PAGES = 200; // a safety stop; a four-month global pull is roughly 15-20 pages
export const PROBE_MONTHS = 18; // how far back to look for the newest month this account can read

// ACLED's six event types, in the order the page lists them when counts tie.
export const EVENT_TYPES = [
  "Battles",
  "Explosions/Remote violence",
  "Violence against civilians",
  "Protests",
  "Riots",
  "Strategic developments",
];

// ACLED places that the dashboard shows as part of another record, as UNHCR reports them.
// UNHCR reports Kosovo together with Serbia ("Serbia and Kosovo: S/RES/1244 (1999)"); ACLED codes it separately.
export const MERGE_BY_NAME = { Kosovo: "SRB" };

// ---------- Credentials and off state ----------

// GitHub secrets ACLED_USERNAME (the myACLED account's email address) and ACLED_PASSWORD.
export function credentialsFromEnv(env = process.env) {
  const username = (env.ACLED_USERNAME || "").trim();
  const password = env.ACLED_PASSWORD || "";
  return username && password ? { username, password } : null;
}

// Has no timestamp, so the file doesn't change (and isn't re-committed) on every run while switched off.
export function offState() {
  return {
    status: "off",
    message: "ACLED is not switched on: no ACLED_USERNAME and ACLED_PASSWORD secrets. The page hides the ACLED section.",
    retrievedAt: null,
    countries: {},
  };
}

// ---------- HTTP ----------

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// The ACLED error body, without anything we sent (the password is never echoed into logs).
async function errorText(res) {
  let body = "";
  try { body = await res.text(); } catch {}
  let detail = "";
  try {
    const j = JSON.parse(body);
    detail = [j.error, j.error_description, j.message, ...(Array.isArray(j.messages) ? j.messages : [])].filter((x) => typeof x === "string").join("; ");
  } catch {
    detail = body.replace(/\s+/g, " ").slice(0, 200);
  }
  return `HTTP ${res.status}${detail ? `: ${detail}` : ""}`;
}

// POST username/password to ACLED's OAuth endpoint; returns the access token (valid 24 hours).
export async function getToken({ username, password }, { fetch: f = fetch } = {}) {
  const body = new URLSearchParams({ username, password, grant_type: "password", client_id: "acled", scope: "authenticated" });
  let res;
  try {
    res = await f(TOKEN_URL, { method: "POST", headers: { "Content-Type": "application/x-www-form-urlencoded" }, body: body.toString(), signal: AbortSignal.timeout(30000) });
  } catch (err) {
    throw new Error(`ACLED sign-in failed: ${err.message}`);
  }
  if (!res.ok) throw new Error(`ACLED sign-in failed: ${await errorText(res)}`);
  const json = await res.json().catch(() => null);
  if (!json?.access_token) throw new Error("ACLED sign-in failed: no access_token in the response");
  return json.access_token;
}

// Builds a read URL. ACLED separates several values with "|" and keeps the "|" unencoded in its examples.
export function readUrl(params) {
  const q = Object.entries(params)
    .filter(([, v]) => v !== undefined && v !== null && v !== "")
    .map(([k, v]) => `${encodeURIComponent(k)}=${encodeURIComponent(String(v)).replace(/%7C/gi, "|")}`)
    .join("&");
  return `${READ_URL}?${q}`;
}

// One GET to the read endpoint. Retries once after a pause on 429 and 5xx. Throws on anything else.
export function makeReader(token, { fetch: f = fetch, wait = 5000 } = {}) {
  let calls = 0;
  const get = async (params) => {
    const url = readUrl({ _format: "json", ...params });
    for (let attempt = 0; ; attempt++) {
      calls++;
      let res;
      try {
        res = await f(url, { headers: { Authorization: `Bearer ${token}`, Accept: "application/json" }, signal: AbortSignal.timeout(120000) });
      } catch (err) {
        if (attempt === 0) { await sleep(wait); continue; }
        throw new Error(`ACLED request failed: ${err.message}`);
      }
      if ((res.status === 429 || res.status >= 500) && attempt === 0) { await sleep(wait); continue; }
      if (!res.ok) throw new Error(`ACLED request failed: ${await errorText(res)}`);
      const json = await res.json().catch(() => null);
      if (!json || typeof json !== "object") throw new Error("ACLED request failed: the response was not JSON");
      if (json.success === false || (json.status && Number(json.status) >= 400)) {
        const why = [json.error?.message, json.error, ...(Array.isArray(json.messages) ? json.messages : [])].filter((x) => typeof x === "string").join("; ");
        throw new Error(`ACLED request failed: status ${json.status ?? "?"}${why ? `: ${why}` : ""}`);
      }
      if (!Array.isArray(json.data)) throw new Error("ACLED request failed: no data array in the response");
      return json;
    }
  };
  get.calls = () => calls;
  return get;
}

// ---------- Months and periods ----------

const pad = (n) => String(n).padStart(2, "0");
// "2025-10" shifted by k months.
export function addMonths(ym, k) {
  const [y, m] = ym.split("-").map(Number);
  const d = new Date(Date.UTC(y, m - 1 + k, 1));
  return `${d.getUTCFullYear()}-${pad(d.getUTCMonth() + 1)}`;
}
export const monthOf = (date) => `${date.getUTCFullYear()}-${pad(date.getUTCMonth() + 1)}`;
export const firstDay = (ym) => `${ym}-01`;
export function lastDay(ym) {
  const [y, m] = ym.split("-").map(Number);
  return `${ym}-${pad(new Date(Date.UTC(y, m, 0)).getUTCDate())}`;
}

const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
// "Sep–Oct 2025", or "Dec 2025–Jan 2026" across a year end.
export function periodLabel(fromYm, toYm) {
  const [y1, m1] = fromYm.split("-").map(Number), [y2, m2] = toYm.split("-").map(Number);
  return y1 === y2 ? `${MONTHS[m1 - 1]}–${MONTHS[m2 - 1]} ${y2}` : `${MONTHS[m1 - 1]} ${y1}–${MONTHS[m2 - 1]} ${y2}`;
}

// The latest month is the newest complete month; "current" is it and the month before, "previous" the two before that.
export function periodsFor(latestYm) {
  const mk = (a, b) => ({ from: firstDay(a), to: lastDay(b), months: [a, b], label: periodLabel(a, b) });
  return { current: mk(addMonths(latestYm, -1), latestYm), previous: mk(addMonths(latestYm, -3), addMonths(latestYm, -2)) };
}

// The newest calendar month, before the current one, whose last day already has events in ACLED. ACLED adds
// events worldwide every day, so an empty last day means the month is not (yet) available to this account:
// accounts at ACLED's Research level see event data with a 12-month lag.
export async function findLatestMonth(get, now = new Date(), maxBack = PROBE_MONTHS) {
  const thisMonth = monthOf(now);
  for (let k = 1; k <= maxBack; k++) {
    const ym = addMonths(thisMonth, -k);
    const json = await get({ event_date: lastDay(ym), fields: "event_id_cnty|event_date", limit: 1 });
    if (json.data.length) return { month: ym, probes: k, restrictions: json.data_query_restrictions ?? null };
  }
  return { month: null, probes: maxBack, restrictions: null };
}

// ---------- Reading the window ----------

export const FIELDS = "event_id_cnty|event_date|iso|country|event_type|fatalities";

// Every event from `from` to `to` (inclusive), worldwide, a page at a time. Uses ACLED's cursor paging
// (next_cursor until null). If a response carries no cursor at all, falls back to the older page numbers.
export async function readWindow(get, from, to, { pageSize = PAGE_SIZE, maxPages = MAX_PAGES } = {}) {
  const base = { event_date: `${from}|${to}`, event_date_where: "BETWEEN", fields: FIELDS, limit: pageSize };
  const rows = [];
  const seen = new Set();
  let cursor = 0, page = 1, mode = "cursor", pages = 0;
  for (;;) {
    if (++pages > maxPages) throw new Error(`ACLED paging did not finish after ${maxPages} pages`);
    const json = await get(mode === "cursor" ? { ...base, cursor } : { ...base, page });
    for (const r of json.data) {
      const id = r.event_id_cnty;
      if (id != null) { if (seen.has(id)) continue; seen.add(id); }
      rows.push(r);
    }
    if (mode === "cursor" && "next_cursor" in json) {
      if (json.next_cursor === null || json.next_cursor === undefined || json.next_cursor === "" || !json.data.length) break;
      if (String(json.next_cursor) === String(cursor)) throw new Error("ACLED paging returned the same cursor twice");
      cursor = json.next_cursor;
      continue;
    }
    // No cursor in the response: page numbers, stopping at the first short page.
    if (json.data.length < pageSize) break;
    mode = "page";
    page++;
  }
  return { rows, pages };
}

// ---------- Country codes ----------

// ACLED's numeric ISO 3166 code → the dashboard's country id (ISO3). Uses world-countries (ccn3 → cca3),
// keeps only ids the dashboard has, and never uses world-countries' "UNK" (its code for Kosovo; UNHCR's for "Unknown").
export function buildIsoMap(worldCountries, dashboardIds) {
  const ids = new Set(dashboardIds);
  const byNum = new Map();
  for (const c of worldCountries) {
    if (!c.ccn3 || c.cca3 === "UNK" || !ids.has(c.cca3)) continue;
    byNum.set(Number(c.ccn3), c.cca3);
  }
  return byNum;
}

export function mapCountry(row, isoMap) {
  const name = String(row.country || "").trim();
  if (MERGE_BY_NAME[name]) return MERGE_BY_NAME[name];
  const n = Number(row.iso);
  return Number.isFinite(n) && n > 0 ? isoMap.get(n) || null : null;
}

// ---------- Aggregation ----------

const emptyCounts = () => ({ events: 0, fatalities: 0, types: Object.fromEntries(EVENT_TYPES.map((t) => [t, 0])) });

// Counts per dashboard country, period and event type. Returns only totals, never rows.
export function aggregate(rows, periods, isoMap) {
  const which = new Map();
  for (const key of ["current", "previous"]) for (const ym of periods[key].months) which.set(ym, key);
  const countries = {};
  const unmapped = new Map();
  const merged = {};
  let counted = 0, outside = 0, otherType = 0;
  for (const r of rows) {
    const key = which.get(String(r.event_date || "").slice(0, 7));
    if (!key) { outside++; continue; }
    const id = mapCountry(r, isoMap);
    if (!id) {
      const label = `${String(r.country || "?").trim()} (iso ${r.iso ?? "?"})`;
      unmapped.set(label, (unmapped.get(label) || 0) + 1);
      continue;
    }
    const name = String(r.country || "").trim();
    if (MERGE_BY_NAME[name]) (merged[id] ||= new Set()).add(name);
    const c = (countries[id] ||= { current: emptyCounts(), previous: emptyCounts() });
    const p = c[key];
    p.events++;
    const f = Number(r.fatalities);
    p.fatalities += Number.isFinite(f) && f > 0 ? f : 0;
    if (r.event_type in p.types) p.types[r.event_type]++;
    else otherType++;
    counted++;
  }
  for (const [id, names] of Object.entries(merged)) countries[id].includes = [...names].sort();
  return {
    countries,
    unmapped: [...unmapped].map(([place, events]) => ({ place, events })).sort((a, b) => b.events - a.events || a.place.localeCompare(b.place)),
    counted,
    outside,
    otherType,
  };
}

// Change between the two periods: absolute, and percent when the earlier period had any events.
export function change(current, previous) {
  const abs = current - previous;
  return { abs, pct: previous > 0 ? (abs / previous) * 100 : null };
}

// Event types with at least one event, most first (ties in ACLED's order).
export function topTypes(types, n = 3) {
  return EVENT_TYPES.map((t, i) => ({ type: t, events: types?.[t] || 0, i }))
    .filter((t) => t.events > 0)
    .sort((a, b) => b.events - a.events || a.i - b.i)
    .slice(0, n)
    .map(({ type, events }) => ({ type, events }));
}

// ---------- The file the page loads ----------

export function buildOutput({ now = new Date(), latest, agg, previousCovered = [], pages, requests }) {
  const periods = periodsFor(latest.month);
  // Places ACLED has been seen to cover (in this window or an earlier one), so a covered place with no events
  // reads "No events recorded" instead of disappearing.
  const covered = [...new Set([...previousCovered, ...Object.keys(agg.countries)])].sort();
  return {
    status: "ok",
    retrievedAt: now.toISOString(),
    checkedAt: now.toISOString(),
    latestMonth: latest.month,
    periods,
    eventTypes: EVENT_TYPES,
    countries: agg.countries,
    covered,
    unmapped: agg.unmapped,
    run: { pages, requests, events: agg.counted },
    source: {
      name: "Armed Conflict Location & Event Data (ACLED)",
      url: "https://acleddata.com",
      note: "Counts of ACLED events by country, event type and two-month period, summed by the Displacement Change Monitor from ACLED's API. No event-level data is stored.",
    },
  };
}

export function serialize(data) {
  return (
    "// ACLED conflict and protest event counts per country, written by scripts/fetch-acled.mjs.\n" +
    "// Source: Armed Conflict Location & Event Data (ACLED), https://acleddata.com. Totals by country, event type and\n" +
    "// two-month period, summed by this project; ACLED's event-level data is not stored or republished.\n" +
    `window.ACLED_DATA = ${JSON.stringify(data)};\n`
  );
}

// Reads a data/acled.js file back (from the repo or the live site). Returns null if it can't be read.
export function parseFile(text) {
  if (typeof text !== "string") return null;
  const a = text.indexOf("{"), b = text.lastIndexOf("}");
  if (a < 0 || b < a) return null;
  try { return JSON.parse(text.slice(a, b + 1)); } catch { return null; }
}

// Whether ACLED was asked recently enough to skip it this run: at most one pull a day after a success,
// and a retry after 6 hours after a failure (wrong password, ACLED down), so failures don't repeat every hour.
export function isFresh(prev, now = new Date(), { okHours = 20, retryHours = 6 } = {}) {
  if (!prev || (prev.status !== "ok" && prev.status !== "error") || !prev.checkedAt) return false;
  const failed = prev.status === "error" || prev.lastAttempt?.ok === false;
  const age = now - new Date(prev.checkedAt);
  return age >= 0 && age < (failed ? retryHours : okHours) * 3600 * 1000;
}

// The more recently checked of two saved files (the repo's and the live site's). A file with counts wins over
// one without, so an old placeholder on the live site never replaces real counts.
export function newer(a, b) {
  if (!a) return b || null;
  if (!b) return a;
  const has = (x) => x.status === "ok";
  if (has(a) !== has(b)) return has(a) ? a : b;
  return String(b.checkedAt || "") > String(a.checkedAt || "") ? b : a;
}
