// Counts ACLED conflict and protest events per country for the country panel, and writes data/acled.js.
// Usage: ACLED_USERNAME=you@org.edu ACLED_PASSWORD=… node scripts/fetch-acled.mjs
//   ACLED_USERNAME, ACLED_PASSWORD  the myACLED account (GitHub secrets). Without them nothing is requested,
//                                   data/acled.js says "off" and the page hides the section. Exits 0.
//   SITE_URL                        optional; starts from the live site's data/acled.js if it is newer.
//   ACLED_FORCE=1                   read ACLED even if it was read in the last 20 hours.
// What it does, at most once a day:
//   1. Gets an OAuth token (https://acleddata.com/oauth/token).
//   2. Finds the newest complete month this account can read (accounts at ACLED's Research level see events with
//      a 12-month lag): one tiny request per month, going back from last month.
//   3. Reads every event of the four months ending there, worldwide, in pages (only date, country, type, fatalities).
//   4. Counts events and fatalities per country, event type and two-month period, and writes only those totals.
//      ACLED's terms allow publishing only transformed material that can't be turned back into its data, so
//      event rows are never saved.
// If ACLED fails, the previous counts stay, with a note of the failed attempt. It never exits with an error.

import { readFile, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import vm from "node:vm";
import {
  credentialsFromEnv, offState, getToken, makeReader, findLatestMonth, periodsFor, readWindow,
  buildIsoMap, aggregate, buildOutput, serialize, parseFile, isFresh, newer,
} from "./acled-lib.mjs";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");

async function readText(path) {
  try { return await readFile(path, "utf8"); } catch { return null; }
}

// The dashboard's country ids (ISO3), from data/dashboard-data.js.
async function dashboardIds(root) {
  const src = await readFile(join(root, "data", "dashboard-data.js"), "utf8");
  const ctx = { window: {} };
  vm.runInNewContext(src, ctx);
  return ctx.window.DISPLACEMENT_DATA.countries.map((c) => c.id);
}

export async function run({
  env = process.env,
  fetch: f = globalThis.fetch,
  now = new Date(),
  root = ROOT,
  outFile = join(root, "data", "acled.js"),
  wait = 5000,
  log = console.log,
} = {}) {
  const save = (data) => writeFile(outFile, serialize(data));
  const creds = credentialsFromEnv(env);
  if (!creds) {
    await save(offState());
    log("ACLED is not switched on (no ACLED_USERNAME / ACLED_PASSWORD). Wrote the 'off' placeholder.");
    return { status: "off" };
  }

  let base = parseFile(await readText(outFile));
  if (env.SITE_URL) {
    try {
      const res = await f(`${env.SITE_URL.replace(/\/$/, "")}/data/acled.js`, { signal: AbortSignal.timeout(30000) });
      if (res.ok) base = newer(base, parseFile(await res.text()));
    } catch {}
  }
  if (base?.status === "off") base = null;
  if (!env.ACLED_FORCE && isFresh(base, now)) {
    await save(base);
    log(`ACLED was last checked ${base.checkedAt}; not asking again yet (at most once a day).`);
    return { status: "kept" };
  }

  try {
    const token = await getToken(creds, { fetch: f });
    const get = makeReader(token, { fetch: f, wait });
    const latest = await findLatestMonth(get, now);
    if (latest.restrictions) log(`ACLED query restrictions for this account: ${JSON.stringify(latest.restrictions).slice(0, 500)}`);
    if (!latest.month) throw new Error("this account can't read any events from the last 18 months");
    const periods = periodsFor(latest.month);
    log(`Newest complete month: ${latest.month}. Reading ${periods.previous.from} to ${periods.current.to}…`);
    const { rows, pages } = await readWindow(get, periods.previous.from, periods.current.to);

    const world = JSON.parse(await readFile(join(root, "data", "raw", "geo", "world-countries.json"), "utf8"));
    const isoMap = buildIsoMap(world, await dashboardIds(root));
    const agg = aggregate(rows, periods, isoMap);
    rows.length = 0; // nothing below needs the rows
    const out = buildOutput({ now, latest, agg, previousCovered: base?.covered || [], pages, requests: get.calls() + 1 });
    await save(out);
    log(`Counted ${agg.counted} events in ${Object.keys(agg.countries).length} places (${periods.previous.label} and ${periods.current.label}), ${pages} pages, ${get.calls() + 1} requests.`);
    if (agg.unmapped.length) log(`Not matched to a dashboard country: ${agg.unmapped.map((u) => `${u.place} ${u.events}`).join("; ")}`);
    return { status: "ok", unmapped: agg.unmapped };
  } catch (err) {
    const message = String(err?.message || err).slice(0, 300);
    const attempt = { at: now.toISOString(), ok: false, message };
    if (base?.status === "ok") {
      await save({ ...base, checkedAt: now.toISOString(), lastAttempt: attempt });
      log(`ACLED update failed (${message}); kept the counts from ${base.retrievedAt}.`);
    } else {
      await save({ status: "error", message, retrievedAt: null, checkedAt: now.toISOString(), lastAttempt: attempt, countries: {} });
      log(`ACLED update failed (${message}); no earlier counts, so the page hides the section.`);
    }
    return { status: "error", message };
  }
}

if (import.meta.url === pathToFileURL(process.argv[1] || "").href) {
  run().catch((err) => {
    // run() handles ACLED failures itself; this is a last resort (for example, data/ can't be written).
    console.error(`fetch-acled: ${err?.message || err}`);
  });
}
