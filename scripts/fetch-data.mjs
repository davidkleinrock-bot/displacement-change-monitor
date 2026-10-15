// Downloads every raw input the dashboard needs into data/raw/.
// Usage: node scripts/fetch-data.mjs [--from 2010] [--to 2025]
// Sources:
//   UNHCR Refugee Population Statistics API  https://api.unhcr.org/docs/refugee-statistics.html
//   world-atlas (Natural Earth 1:50m)          https://github.com/topojson/world-atlas
//   world-countries (ISO codes, centroids)     https://github.com/mledoze/countries

import { mkdir, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { API, SERIES_FROM, getJSON, getAll, fingerprint } from "./unhcr-fingerprint.mjs";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const RAW = join(ROOT, "data", "raw");

const args = Object.fromEntries(
  process.argv.slice(2).reduce((acc, a, i, all) => (a.startsWith("--") ? [...acc, [a.slice(2), all[i + 1]]] : acc), [])
);
const FROM = Number(args.from ?? 2010); // origin x host matrix (flows)

const POP_FIELDS = ["refugees", "asylum_seekers", "returned_refugees", "idps", "returned_idps", "stateless", "ooc", "oip", "hst"];

function toCSV(rows, columns) {
  const cell = (v) => {
    const s = v == null ? "" : String(v);
    return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
  };
  return [columns.join(","), ...rows.map((r) => columns.map((c) => cell(r[c])).join(","))].join("\n") + "\n";
}

async function save(name, content) {
  const file = join(RAW, name);
  await mkdir(dirname(file), { recursive: true });
  await writeFile(file, content);
  console.log(`  saved data/raw/${name} (${(Buffer.byteLength(content) / 1024).toFixed(0)} KB)`);
}

const manifest = { retrievedAt: new Date().toISOString(), files: {} };

async function main() {
  console.log("Checking which years UNHCR has published…");
  // The /years/ endpoint lists future years too, so probe for actual rows instead.
  let latest = Number(args.to ?? 0);
  if (!latest) {
    for (let y = new Date().getFullYear(); y > 2000; y--) {
      const probe = await getJSON(`${API}/population/?limit=1&year=${y}&coo_all=true`);
      if (probe.items.length) { latest = y; break; }
    }
  }
  console.log(`  latest year-end data: ${latest}`);
  manifest.latestYear = latest;

  console.log("Countries…");
  const countries = await getAll("countries", {});
  await save("unhcr_countries.json", JSON.stringify(countries, null, 1));
  manifest.files["unhcr_countries.json"] = { url: `${API}/countries/`, rows: countries.length };

  const pairCols = ["year", "coo", "coo_iso", "coo_name", "coa", "coa_iso", "coa_name", ...POP_FIELDS];

  console.log(`Origin x host matrix ${FROM}–${latest} (one request per year)…`);
  const matrix = [];
  for (let y = FROM; y <= latest; y++) {
    const rows = await getAll("population", { year: y, coo_all: true, coa_all: true });
    matrix.push(...rows);
    process.stdout.write(`  ${y}: ${rows.length} rows\n`);
  }
  const mName = `unhcr_population_matrix_${FROM}_${latest}.csv`;
  await save(mName, toCSV(matrix, pairCols));
  manifest.files[mName] = { url: `${API}/population/?year=YYYY&coo_all=true&coa_all=true`, rows: matrix.length };

  console.log(`UNHCR's own totals by origin and by host ${SERIES_FROM}–${latest}…`);
  const byOrigin = await getAll("population", { yearFrom: SERIES_FROM, yearTo: latest, coo_all: true });
  const oName = `unhcr_population_by_origin_${SERIES_FROM}_${latest}.csv`;
  await save(oName, toCSV(byOrigin, pairCols));
  manifest.files[oName] = { url: `${API}/population/?yearFrom=${SERIES_FROM}&yearTo=${latest}&coo_all=true`, rows: byOrigin.length };

  const byHost = await getAll("population", { yearFrom: SERIES_FROM, yearTo: latest, coa_all: true });
  const hName = `unhcr_population_by_host_${SERIES_FROM}_${latest}.csv`;
  await save(hName, toCSV(byHost, pairCols));
  manifest.files[hName] = { url: `${API}/population/?yearFrom=${SERIES_FROM}&yearTo=${latest}&coa_all=true`, rows: byHost.length };

  console.log("IDMC internal displacement (conflict) by country…");
  const idmc = await getAll("idmc", { yearFrom: SERIES_FROM, yearTo: latest, coo_all: true });
  const iName = `idmc_idps_by_country_${SERIES_FROM}_${latest}.csv`;
  await save(iName, toCSV(idmc, ["year", "coo", "coo_iso", "coo_name", "total"]));
  manifest.files[iName] = { url: `${API}/idmc/?yearFrom=${SERIES_FROM}&yearTo=${latest}&coo_all=true`, rows: idmc.length };

  console.log("Map geometry and country codes…");
  const geo = [
    ["geo/countries-50m.json", "https://cdn.jsdelivr.net/npm/world-atlas@2.0.2/countries-50m.json"],
    ["geo/world-countries.json", "https://cdn.jsdelivr.net/npm/world-countries@5.1.0/countries.json"],
  ];
  for (const [name, url] of geo) {
    const json = await getJSON(url);
    await save(name, JSON.stringify(json));
    manifest.files[name] = { url };
  }

  // Lets check-unhcr.mjs tell later whether UNHCR has published anything new.
  manifest.fingerprint = await fingerprint();
  await save("manifest.json", JSON.stringify(manifest, null, 2));
  console.log("Done. Next: node scripts/build-data.mjs");
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
