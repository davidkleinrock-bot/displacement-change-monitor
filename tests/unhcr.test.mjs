// Run with: node --test "tests/*.test.mjs"
import { test } from "node:test";
import assert from "node:assert/strict";
import { lastYearEnd } from "../scripts/unhcr-fingerprint.mjs";

test("only years that have ended and had their Global Trends release count as year-end", () => {
  assert.equal(lastYearEnd(new Date("2026-11-16T12:00:00Z")), 2025); // UNHCR's "2026" rows are mid-year figures
  assert.equal(lastYearEnd(new Date("2027-03-01T12:00:00Z")), 2025); // 2026 year-end not published until mid-June 2027
  assert.equal(lastYearEnd(new Date("2027-06-30T23:59:59Z")), 2025);
  assert.equal(lastYearEnd(new Date("2027-07-01T00:00:00Z")), 2026);
});
