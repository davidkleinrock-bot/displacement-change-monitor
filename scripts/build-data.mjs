// Turns data/raw/* into the files the dashboard loads, and checks the numbers.
// Usage: node scripts/build-data.mjs
// Writes:
//   data/dashboard-data.js        window.DISPLACEMENT_DATA (countries, yearly totals, origin→host flows)
//   data/world.js                 window.WORLD_TOPO (map shapes keyed by ISO3)
//   data/verification.json        flows-vs-published-totals check
//   data/processed/country_totals.csv   long-format totals for spot checks in a spreadsheet
//   data/processed/news-targets.json    countries fetch-news.mjs should search for

import { readFile, writeFile, mkdir } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const RAW = join(ROOT, "data", "raw");
const OUT = join(ROOT, "data");

const API = "https://api.unhcr.org/population/v1";

// Map shapes with no ISO numeric id in Natural Earth, assigned to the record UNHCR reports them under.
const SHAPE_OVERRIDES = { Kosovo: "SRB", Somaliland: "SOM", "N. Cyprus": "CYP" };
// Display names that are too long for a table cell. Everything else keeps UNHCR's name.
const NAME_OVERRIDES = { SRB: "Serbia and Kosovo (S/RES/1244)", UNK: "Unknown origin", XXA: "Stateless", TIB: "Tibetan" };
// Plain search terms for the news search, where the UNHCR name would miss most coverage.
const NEWS_TERMS = {
  COD: ['"DR Congo"', '"Democratic Republic of the Congo"', '"eastern Congo"'],
  COG: ['"Republic of the Congo"', '"Congo-Brazzaville"'],
  PSE: ["Gaza", '"West Bank"', "Palestinian"],
  SYR: ["Syria", "Syrian"],
  UKR: ["Ukraine", "Ukrainian"],
  VEN: ["Venezuela", "Venezuelan"],
  MMR: ["Myanmar", "Rohingya"],
  AFG: ["Afghanistan", "Afghan"],
  TUR: ["Turkey", "Türkiye"],
  IRN: ["Iran"],
  RUS: ["Russia"],
  SRB: ["Serbia", "Kosovo"],
  USA: ['"United States"'],
  GBR: ['"United Kingdom"', "Britain"],
};

function parseCSV(text) {
  const rows = [];
  let row = [], cell = "", quoted = false;
  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (quoted) {
      if (ch === '"' && text[i + 1] === '"') { cell += '"'; i++; }
      else if (ch === '"') quoted = false;
      else cell += ch;
    } else if (ch === '"') quoted = true;
    else if (ch === ",") { row.push(cell); cell = ""; }
    else if (ch === "\n") { row.push(cell); rows.push(row); row = []; cell = ""; }
    else if (ch !== "\r") cell += ch;
  }
  if (cell || row.length) { row.push(cell); rows.push(row); }
  const [head, ...body] = rows;
  return body.map((r) => Object.fromEntries(head.map((h, i) => [h, r[i]])));
}

// "-" and "" mean nothing was reported; keep that distinct from a reported zero.
const num = (v) => (v === undefined || v === null || v === "" || v === "-" ? null : Number(v));
const key = (iso, code) => (iso && iso !== "-" && iso !== "null" ? iso : code);
const readJSON = async (p) => JSON.parse(await readFile(join(RAW, p), "utf8"));
const readCSV = async (p) => parseCSV(await readFile(join(RAW, p), "utf8"));

async function main() {
  const manifest = await readJSON("manifest.json");
  const files = Object.keys(manifest.files);
  const pick = (prefix) => files.find((f) => f.startsWith(prefix));
  const latest = manifest.latestYear;

  const unCountries = await readJSON("unhcr_countries.json");
  const worldCountries = await readJSON("geo/world-countries.json");
  const topo = await readJSON("geo/countries-50m.json");
  const matrix = await readCSV(pick("unhcr_population_matrix_"));
  const byOrigin = await readCSV(pick("unhcr_population_by_origin_"));
  const byHost = await readCSV(pick("unhcr_population_by_host_"));
  const idmc = await readCSV(pick("idmc_idps_by_country_"));

  // world-countries uses "UNK" for Kosovo; UNHCR uses it for "Unknown". Never join on it.
  const wcByIso = new Map(worldCountries.filter((c) => c.cca3 !== "UNK").map((c) => [c.cca3, c]));
  const wcByNum = new Map(worldCountries.filter((c) => c.ccn3).map((c) => [c.ccn3, c]));

  // ---- Countries -------------------------------------------------------------
  const countries = new Map();
  const addCountry = (id, code, name, region = null, area = null) => {
    if (!id || countries.has(id)) return;
    const wc = wcByIso.get(id);
    countries.set(id, {
      id,
      code: code || id,
      name: NAME_OVERRIDES[id] || (name || id).trim(),
      region: region && region !== "Various" ? region : null,
      area: area && area !== "Stateless" ? area : null,
      lat: wc ? +wc.latlng[0].toFixed(2) : null,
      lon: wc ? +wc.latlng[1].toFixed(2) : null,
      news: (NEWS_TERMS[id] || [`"${wc?.name?.common || (name || id).trim()}"`]),
    });
  };
  for (const c of unCountries) addCountry(key(c.iso, c.code), c.code, c.name, c.region, c.majorArea);
  for (const r of [...matrix, ...byOrigin]) addCountry(key(r.coo_iso, r.coo), r.coo, r.coo_name);
  for (const r of [...matrix, ...byHost]) if (r.coa !== "-") addCountry(key(r.coa_iso, r.coa), r.coa, r.coa_name);
  for (const r of idmc) addCountry(key(r.coo_iso, r.coo), r.coo, r.coo_name);

  // ---- Map shapes ------------------------------------------------------------
  const onMap = new Set();
  const geoms = topo.objects.countries.geometries;
  for (const g of geoms) {
    const iso = SHAPE_OVERRIDES[g.properties.name] || wcByNum.get(g.id)?.cca3 || null;
    g.properties = { name: g.properties.name, iso: iso === "UNK" ? null : iso };
    delete g.id;
    if (g.properties.iso) onMap.add(g.properties.iso);
  }
  delete topo.objects.land;

  const countryList = [...countries.values()]
    .map((c) => ({ ...c, mapped: onMap.has(c.id) }))
    .sort((a, b) => a.name.localeCompare(b.name));
  const index = new Map(countryList.map((c, i) => [c.id, i]));

  // ---- Yearly totals (UNHCR's own published aggregates) -----------------------
  const firstYear = Math.min(...byOrigin.map((r) => +r.year));
  const years = Array.from({ length: latest - firstYear + 1 }, (_, i) => firstYear + i);
  const series = {};
  const put = (metric, id, year, value) => {
    if (value === null) return;
    series[metric] ??= {};
    series[metric][id] ??= years.map(() => null);
    series[metric][id][year - firstYear] = value;
  };
  const sumOrNull = (...vals) => (vals.every((v) => v === null) ? null : vals.reduce((s, v) => s + (v ?? 0), 0));

  for (const r of byOrigin) {
    const id = key(r.coo_iso, r.coo), y = +r.year;
    const [ref, asy, oip] = [num(r.refugees), num(r.asylum_seekers), num(r.oip)];
    put("ref_o", id, y, ref);
    put("asy_o", id, y, asy);
    put("intl_o", id, y, sumOrNull(ref, asy, oip));
    put("ret_o", id, y, num(r.returned_refugees));
  }
  for (const r of byHost) {
    const id = key(r.coa_iso, r.coa), y = +r.year;
    const [ref, asy, oip] = [num(r.refugees), num(r.asylum_seekers), num(r.oip)];
    put("ref_h", id, y, ref);
    put("asy_h", id, y, asy);
    put("intl_h", id, y, sumOrNull(ref, asy, oip));
  }
  for (const r of idmc) put("idmc", key(r.coo_iso, r.coo), +r.year, num(r.total));

  // ---- Flows: origin → host pairs per year ------------------------------------
  const flowYears = [...new Set(matrix.map((r) => +r.year))].sort();
  const flows = Object.fromEntries(flowYears.map((y) => [y, []]));
  const sums = { o: new Map(), h: new Map() };
  const addSum = (m, k, ref, asy, oip) => {
    const s = m.get(k) || { ref: 0, asy: 0, oip: 0 };
    s.ref += ref; s.asy += asy; s.oip += oip;
    m.set(k, s);
  };
  for (const r of matrix) {
    const o = key(r.coo_iso, r.coo), h = key(r.coa_iso, r.coa), y = +r.year;
    const ref = num(r.refugees) ?? 0, asy = num(r.asylum_seekers) ?? 0, oip = num(r.oip) ?? 0;
    addSum(sums.o, `${y}|${o}`, ref, asy, oip);
    addSum(sums.h, `${y}|${h}`, ref, asy, oip);
    if (o === h || ref + asy + oip === 0) continue;
    flows[y].push([index.get(o), index.get(h), ref, asy, oip]);
  }

  // ---- Verification: do the flows add up to UNHCR's published totals? ---------
  const check = (rows, side, field) => {
    let compared = 0;
    const mismatches = [];
    for (const r of rows) {
      const y = +r.year;
      if (!flowYears.includes(y)) continue;
      const id = side === "o" ? key(r.coo_iso, r.coo) : key(r.coa_iso, r.coa);
      for (const [f, col] of field) {
        const published = num(r[col]) ?? 0;
        const summed = sums[side].get(`${y}|${id}`)?.[f] ?? 0;
        compared++;
        if (published !== summed) mismatches.push({ year: y, country: id, measure: col, published, summed });
      }
    }
    return { compared, mismatches };
  };
  const fields = [["ref", "refugees"], ["asy", "asylum_seekers"], ["oip", "oip"]];
  const vOrigin = check(byOrigin, "o", fields);
  const vHost = check(byHost, "h", fields);
  const verification = {
    checkedAt: new Date().toISOString(),
    description: "Each origin→host flow row was summed by origin and by host and compared with UNHCR's own published totals for the same year.",
    years: [flowYears[0], flowYears.at(-1)],
    byOrigin: { compared: vOrigin.compared, mismatched: vOrigin.mismatches.length },
    byHost: { compared: vHost.compared, mismatched: vHost.mismatches.length },
    mismatches: [...vOrigin.mismatches, ...vHost.mismatches].slice(0, 200),
  };
  await writeFile(join(OUT, "verification.json"), JSON.stringify(verification, null, 2));
  console.log(`Verification: origin ${vOrigin.compared - vOrigin.mismatches.length}/${vOrigin.compared} match, host ${vHost.compared - vHost.mismatches.length}/${vHost.compared} match`);
  if (vOrigin.mismatches.length || vHost.mismatches.length) {
    // Leave the last good dashboard files in place so the live site never shows numbers that don't add up.
    throw new Error("Flows no longer add up to UNHCR's published totals; see data/verification.json. Dashboard files were not updated.");
  }

  // ---- News targets: countries the dashboard features most ---------------------
  const yi = latest - firstYear;
  const top = (metric, n, by) =>
    Object.entries(series[metric] || {})
      .map(([id, v]) => [id, by(v)])
      .filter(([id, s]) => s !== null && countries.get(id)?.lat !== null)
      .sort((a, b) => b[1] - a[1])
      .slice(0, n)
      .map(([id]) => id);
  const size = (v) => v[yi];
  const growth = (v) => (v[yi] === null || v[yi - 1] === null ? null : v[yi] - v[yi - 1]);
  const targets = [...new Set([
    ...top("ref_o", 25, size), ...top("ref_o", 20, growth), ...top("intl_o", 15, growth),
    ...top("ref_h", 15, size), ...top("ref_h", 12, growth), ...top("idmc", 15, size), ...top("idmc", 10, growth),
  ])];
  await mkdir(join(OUT, "processed"), { recursive: true });
  await writeFile(
    join(OUT, "processed", "news-targets.json"),
    JSON.stringify(targets.map((id) => ({ id, name: countries.get(id).name, terms: countries.get(id).news })), null, 2)
  );

  // ---- Long CSV for spreadsheet spot checks ------------------------------------
  const labels = { ref_o: "refugees_by_origin", asy_o: "asylum_seekers_by_origin", intl_o: "intl_protection_by_origin", ret_o: "returned_refugees_to_origin", ref_h: "refugees_by_host", asy_h: "asylum_seekers_by_host", intl_h: "intl_protection_by_host", idmc: "idps_conflict_idmc" };
  const lines = ["year,iso3,country,measure,value"];
  for (const [m, byId] of Object.entries(series)) {
    for (const [id, vals] of Object.entries(byId)) {
      vals.forEach((v, i) => { if (v !== null) lines.push([years[i], id, `"${countries.get(id).name.replace(/"/g, '""')}"`, labels[m], v].join(",")); });
    }
  }
  await writeFile(join(OUT, "processed", "country_totals.csv"), lines.join("\n") + "\n");

  // ---- Dashboard payload --------------------------------------------------------
  const payload = {
    meta: {
      retrievedAt: manifest.retrievedAt,
      builtAt: new Date().toISOString(),
      latestYear: latest,
      years: [firstYear, latest],
      flowYears: [flowYears[0], flowYears.at(-1)],
      api: API,
      verification: { byOrigin: verification.byOrigin, byHost: verification.byHost },
    },
    countries: countryList,
    series: Object.fromEntries(
      Object.entries(series).map(([m, byId]) => [m, Object.fromEntries(Object.entries(byId).map(([id, v]) => [index.get(id), v]))])
    ),
    flows: { columns: ["origin", "host", "refugees", "asylum_seekers", "oip"], byYear: flows },
  };
  await writeFile(join(OUT, "dashboard-data.js"), `window.DISPLACEMENT_DATA = ${JSON.stringify(payload)};\n`);
  await writeFile(join(OUT, "world.js"), `window.WORLD_TOPO = ${JSON.stringify(topo)};\n`);

  const unmapped = countryList.filter((c) => !c.mapped).map((c) => c.id);
  console.log(`Countries: ${countryList.length} (${unmapped.length} without a map shape: ${unmapped.join(" ")})`);
  console.log(`Flow rows: ${Object.values(flows).reduce((s, f) => s + f.length, 0)} across ${flowYears.length} years`);
  console.log(`News targets: ${targets.length}`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
