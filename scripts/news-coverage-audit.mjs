// Writes a per-country audit of the saved news: docs/news-coverage-audit.md and data/processed/news-coverage.csv.
// Usage: node scripts/news-coverage-audit.mjs   (after fetch-news.mjs; it reports what data/news.js holds)
// It reports only what is in the file. It never adds or guesses articles.

import { readFile, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const readJS = async (p) => { const s = await readFile(join(ROOT, p), "utf8"); return JSON.parse(s.slice(s.indexOf("{"), s.lastIndexOf("}") + 1)); };

// Countries whose names are easy to confuse, and how matching handles them (see news-lib.mjs).
const NAME_NOTES = {
  SDN: "'Sudan' inside 'South Sudan' is not counted for Sudan.",
  SSD: "Matched only as 'South Sudan' / 'South Sudanese'.",
  GIN: "'Guinea' in 'Papua New Guinea', 'Equatorial Guinea' and 'Guinea-Bissau' is not counted.",
  GNB: "Matched as 'Guinea-Bissau'.",
  NER: "'Niger Delta', 'Niger State' and 'Niger River' (Nigeria) are not counted.",
  GEO: "Headlines that point to the US state (Atlanta, Savannah, Kemp…) are not counted.",
  COD: "'Congo' and 'Congolese' are filed under DR Congo; 'Republic of the Congo' and 'Congo-Brazzaville' are not.",
  COG: "Matched only as 'Republic of the Congo', 'Congo-Brazzaville' or 'Brazzaville'; 'Congolese' goes to DR Congo.",
  DOM: "'Dominican' is filed under the Dominican Republic.",
  DMA: "Matched only as 'Dominica'; 'Dominican' goes to the Dominican Republic.",
  KOR: "Matched only as 'South Korea(n)'.",
  PRK: "Matched only as 'North Korea(n)'.",
  IRL: "'Northern Ireland' (UK) is not counted.",
  USA: "'US' must be in capitals; 'Latin American', 'South American' and similar are not counted.",
  NLD: "'Dutch' and 'Néerlandais' are filed under the Netherlands, not Bonaire, Sint Eustatius and Saba.",
  PSE: "West Bank towns (Hebron, Jenin, Nablus, Tulkarm, Ramallah) and Gaza places are filed under Palestine.",
  NER: "'Niger' in Nigerian outlets (Niger State) is not counted.",
  FRA: "'Fort Frances' (Canada) is not counted: the name takes no plural.",
  JAM: "'Jamaica Plain' (Boston) and Jamaica, Queens are not counted.",
  GBR: "'UK' must be in capitals; 'British Columbia' is not counted.",
  IND: "'Indian Ocean' and 'Native/American Indian' are not counted.",
  JOR: "Headlines about Michael Jordan, the Jordan River and similar are not counted.",
};

const csvCell = (v) => (v == null ? "" : /[",\n]/.test(String(v)) ? `"${String(v).replace(/"/g, '""')}"` : String(v));
const mdCell = (v) => String(v ?? "").replace(/\|/g, "\\|");

async function main() {
  const news = await readJS("data/news.js");
  const data = await readJS("data/dashboard-data.js");
  const w = news.window || {};
  const searched = new Set(news.searched || []);
  const NOT_PLACES = new Set(["UNK", "XXA", "TIB"]); // Unknown origin, Stateless, Tibetan
  // Only rows that appear in the dashboard: those with figures in at least one series.
  const shown = new Set(Object.values(data.series).flatMap((byIdx) => Object.keys(byIdx).map(Number)));
  const rows = [];
  for (const c of data.countries.filter((_, i) => shown.has(i)).sort((a, b) => a.name.localeCompare(b.name))) {
    const status = NOT_PLACES.has(c.id) ? "Not a place" : c.territory || (c.lat == null ? "No map point" : "Country");
    const items = news.byCountry?.[c.id] || [];
    const issues = [];
    if (!searched.has(c.id)) issues.push(status === "Not a place" ? "Not a place; news not searched." : c.lat == null ? "No map point; news not searched." : "Not searched in this run.");
    else if (!items.length) issues.push("No relevant article found in the window.");
    const firstSeen = items.filter((a) => a.dateKind !== "published").length;
    if (firstSeen) issues.push(`${firstSeen} dated by when GDELT first saw it (publisher page gave no date).`);
    const langs = items.filter((a) => a.lang && a.lang !== "en").map((a) => a.lang);
    if (langs.length) issues.push(`${langs.length} not in English (${[...new Set(langs)].join(", ")}).`);
    const unverified = items.filter((a) => a.link === "unverified").length;
    if (unverified) issues.push(`${unverified} link(s) could not be checked (site blocked or timed out).`);
    const noSummary = items.filter((a) => !a.description).length;
    if (noSummary) issues.push(`${noSummary} without a publisher summary.`);
    if (NAME_NOTES[c.id]) issues.push(NAME_NOTES[c.id]);
    const reports = news.reports?.byCountry?.[c.id] || [];
    rows.push({
      iso3: c.id, country: c.name, region: c.area || "", status,
      articles: items.length, verified: items.filter((a) => a.link === "verified").length, reports: reports.length,
      latest: items.map((a) => a.date).sort().at(-1) || "", window: w.from ? `${w.from} to ${w.to}` : "", issues: issues.join(" "),
    });
  }

  const places = rows.filter((r) => searched.has(r.iso3));
  const covered = places.filter((r) => r.articles > 0);
  const byRegion = {};
  for (const r of places) {
    const k = r.region || "No region";
    byRegion[k] ??= { places: 0, covered: 0, reports: 0, either: 0 };
    byRegion[k].places++;
    if (r.articles) byRegion[k].covered++;
    if (r.reports) byRegion[k].reports++;
    if (r.articles || r.reports) byRegion[k].either++;
  }
  const run = news.lastBackfill || news.lastRun || {};
  const latest = news.lastRun || {};

  await writeFile(join(ROOT, "data", "processed", "news-coverage.csv"),
    "﻿" + ["iso3,country,region,status,valid_articles,verified_links,reliefweb_reports,latest_article,window,issues", ...rows.map((r) => [r.iso3, r.country, r.region, r.status, r.articles, r.verified, r.reports, r.latest, r.window, r.issues].map(csvCell).join(","))].join("\n") + "\n");

  const md = [];
  md.push("# News coverage audit", "");
  md.push(`*Generated by \`scripts/news-coverage-audit.mjs\` from \`data/news.js\` (news retrieved ${news.retrievedAt}). It reports what the file holds; nothing is added or estimated.*`, "");
  md.push(news.lastBackfill ? `## Full run that filled the window (${run.at || "date not recorded"}${run.source ? `; ${run.source}` : ""})` : "## Run that produced this file", "");
  md.push(`- **Window:** ${w.from} to ${w.to} (${w.months} calendar months, both days included, UTC).`);
  md.push(`- **GDELT English files read:** ${run.filesRead ?? "?"} (${run.filesMissing ?? 0} missing), ${run.hoursRead ?? "?"} hours back from ${run.checkedThrough ?? news.checkedThrough ?? "?"}${run.step > 1 ? `, **sampled: one 15-minute file in ${run.step}**, so about ${Math.round(100 / run.step)}% of GDELT's English coverage was read` : ", every 15-minute file"}.`);
  if (run.translated) md.push(`- **GDELT translated files read:** ${run.translated.filesRead} (${run.translated.filesMissing} missing), ${run.translated.hoursRead} hours${run.translated.step > 1 ? `, one file in ${run.translated.step}` : ""}. Spanish, French and Portuguese articles are kept; ${(run.otherLanguage ?? 0).toLocaleString("en-US")} articles in other languages were skipped.`);
  if (run.feeds) md.push(`- **Outlet RSS feeds:** ${run.feeds.read} of ${run.feeds.feeds} read (${run.feeds.failed} failed), ${run.feeds.items} items, ${run.feeds.kept} kept after the topic, outlet and country rules.`);
  md.push(`- **Articles scanned (GDELT):** ${(run.articles ?? 0).toLocaleString("en-US")}. Displacement headlines: ${run.topical ?? "?"}. Left out: ${run.untagged ?? 0} without GDELT's refugee or displacement tags, ${run.personal ?? "?"} profiles or opinion, ${run.outlet ?? "?"} from outlets that don't count (not hand-picked, not rated generally reliable, or blocked), ${run.unattributed ?? "?"} not tied to a country. Kept for checking: ${run.kept ?? "?"}.`);
  if (run.links) md.push(`- **Article pages opened:** verified ${run.links.verified}, could not be checked ${run.links.unverified}, dead links dropped ${run.links.broken}, mismatched pages dropped ${run.links.mismatched}, published before the window dropped ${run.links.older}${run.pendingChecks ? `; ${run.pendingChecks} left for the next run` : ""}.`);
  if (news.lastBackfill) md.push(`- **Since then:** the most recent update (${latest.at || news.retrievedAt}) read ${latest.filesRead ?? "?"} file(s) and re-checked every saved article against the current rules.`);
  md.push(`- **Last attempt:** ${news.lastAttempt?.ok === false ? `failed at ${news.lastAttempt.at}: ${news.lastAttempt.error}` : `succeeded at ${news.lastAttempt?.at ?? news.retrievedAt}`}.`);
  md.push(news.reports?.enabled ? `- **ReliefWeb reports:** ${Object.keys(news.reports.byCountry || {}).length} places have at least one (last update ${news.reports.retrievedAt || "not yet"}${news.reports.lastRun?.error ? `; last error: ${news.reports.lastRun.error}` : ""}).` : "- **ReliefWeb reports:** not switched on yet (the repository has no approved ReliefWeb appname).");
  md.push("- **Known gaps:** headlines are read in English, Spanish, French and Portuguese only, so countries covered mainly in Arabic, Russian or other languages have fewer articles; small Pacific states rarely appear in any feed.", "");
  md.push("## Summary", "");
  md.push(`- **Searched places with at least one valid article:** ${covered.length} of ${places.length} (${Math.round((100 * covered.length) / places.length)}%).`);
  md.push(`- **Articles shown:** ${places.reduce((s, r) => s + r.articles, 0)} (at most 8 per place), of which ${places.reduce((s, r) => s + r.verified, 0)} have a verified link.`);
  md.push(`- **Places with news or a ReliefWeb report:** ${places.filter((r) => r.articles || r.reports).length} of ${places.length}.`);
  md.push(`- **Dashboard rows not searched:** ${rows.length - places.length} (${rows.filter((r) => !searched.has(r.iso3)).map((r) => r.country).join(", ")}): they are not places or have no map point.`, "");
  md.push("| Region | Places | With news | With ReliefWeb reports | With either |", "|---|---:|---:|---:|---:|");
  for (const [k, v] of Object.entries(byRegion).sort()) md.push(`| ${mdCell(k)} | ${v.places} | ${v.covered} | ${v.reports} | ${v.either} |`);
  md.push("", "## Every country and territory", "");
  md.push("| Country | ISO3 | Status | Valid articles | Verified links | ReliefWeb reports | Latest | Issues |", "|---|---|---|---:|---:|---:|---|---|");
  for (const r of rows) md.push(`| ${mdCell(r.country)} | ${r.iso3} | ${mdCell(r.status)} | ${r.articles} | ${r.verified} | ${r.reports} | ${r.latest} | ${mdCell(r.issues)} |`);
  md.push("");
  await writeFile(join(ROOT, "docs", "news-coverage-audit.md"), md.join("\n"));
  console.log(`Audit written: ${covered.length} of ${places.length} places have at least one article.`);
}

main().catch((err) => { console.error(err.message); process.exit(1); });
