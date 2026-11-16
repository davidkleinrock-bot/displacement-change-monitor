// A short fingerprint of UNHCR's published figures, used to tell when UNHCR has released something new.
// It covers totals by origin and by host plus the IDMC series, every year from 2000 to the latest year-end
// count (see lastYearEnd), so it changes when a new year-end appears and when UNHCR revises an earlier one.

import { createHash } from "node:crypto";

export const API = "https://api.unhcr.org/population/v1";
export const SERIES_FROM = 2000;

export async function getJSON(url, tries = 4) {
  for (let i = 1; ; i++) {
    try {
      const res = await fetch(url, { headers: { Accept: "application/json" } });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      return await res.json();
    } catch (err) {
      if (i >= tries) throw new Error(`${url} failed: ${err.message}`);
      await new Promise((r) => setTimeout(r, 1500 * i));
    }
  }
}

// Walks every page of a UNHCR endpoint and returns all items.
export async function getAll(path, params) {
  const items = [];
  for (let page = 1; ; page++) {
    const qs = new URLSearchParams({ ...params, limit: 10000, page });
    const json = await getJSON(`${API}/${path}/?${qs}`);
    items.push(...json.items);
    if (page >= (json.maxPages || 1)) break;
  }
  return items;
}

// The latest year whose year-end (31 December) figures UNHCR can have published. The API also carries
// mid-year figures for the current year under that year's number: in November 2026 it returned "2026"
// rows, which describe 30 June 2026, not 31 December. Year-end figures for a year come out in UNHCR's
// Global Trends report around mid-June of the next year, so year Y counts as year-end from 1 July of Y+1.
export function lastYearEnd(now = new Date()) {
  return now.getUTCFullYear() - (now.getUTCMonth() >= 6 ? 1 : 2);
}

export async function fingerprint() {
  const range = { yearFrom: SERIES_FROM, yearTo: lastYearEnd() };
  const parts = await Promise.all([
    getAll("population", { ...range, coo_all: true }),
    getAll("population", { ...range, coa_all: true }),
    getAll("idmc", { ...range, coo_all: true }),
  ]);
  return createHash("sha256").update(JSON.stringify(parts)).digest("hex").slice(0, 16);
}
