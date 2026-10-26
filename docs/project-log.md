# Project log: Displacement Change Monitor (repository record)

This log records the technical work in this repository. The group's official meeting log (kept by Aryana) lives in the team's shared documents and was not accessible when this file was written, so this file does not copy or replace it. Earlier entries are **reconstructed from the commit history** and cite their commits; times are US Eastern from `git log`. Planned milestones are listed separately from completed work.

## Planned milestones (from the project plan) and evidence

| Planned date | Milestone in the plan | Evidence in the repository |
|---|---|---|
| 9 Oct | Working prototype of map and data sheet | No repository evidence before 14 Oct. The repository was created 14 Oct 2026 (17:13 UTC); the first commit, `25a6ba0`, contains the map, ranked table, country panel and data pipeline. |
| 16 Oct | Add other data sources and check they agree | IDMC internal-displacement data and GDELT news were in the first commit (14 Oct). Rated-outlet rules for news were added 16 Oct (`2d82a4e`, `3e80b2a`). Agreement between UNHCR and IDMC figures has **not** been checked (they measure different populations; see open items). |
| 23 Oct | Usability testing | A UX/UI audit and a usability test script were written on 16 Oct (`2d82a4e`, `docs/ux-audit.md`). **No record of a usability test with users exists in the repository.** A test planned by Isa had not been documented when this log was written. |

## Entries

### 14 Oct 2026: first version of the dashboard *(reconstructed from commits `25a6ba0`, `ef8ea8b`)*
- **Issue:** The plan called for a map, ranked table and country panels built on UNHCR data, with GDELT news as an extension.
- **Change:**
  - Built the dashboard: a world map colored by change between two year-end counts, a ranked table, country panels and origin-to-host flow arrows.
  - Built the data pipeline: UNHCR population data by origin and host for 2010–2025, UNHCR totals for 2000–2025, and IDMC internal displacement.
  - Added a totals check: every origin-to-host figure is summed and compared with UNHCR's published totals (9,549 origin and 8,409 host comparisons, 0 differences; `data/verification.json`).
  - Added news from the GDELT search API, a scheduled GitHub Actions update, and GitHub Pages hosting.
- **Reason:** Core deliverables in the plan; flow arrows were requested by David during the session.
- **Tools/AI:** Claude (Claude Code desktop app) wrote the code and scripts at David's direction; GitHub Actions; GitHub Pages.
- **Files:** `index.html`, `scripts/fetch-data.mjs`, `scripts/build-data.mjs`, `scripts/fetch-news.mjs`, `.github/workflows/update-and-deploy.yml`.
- **Tests:** Totals check (above). The page was checked in a browser during the AI session.
- **Result:** Live at https://davidkleinrock-bot.github.io/displacement-change-monitor/. GDELT's search API refused most requests, so only some countries had headlines.
- **Remaining:** News coverage.

### 15 Oct 2026: news from GDELT files; update on change *(reconstructed from `fc99faa`, `6ebf01d`, `90239b9`, `a452f0b`)*
- **Change:**
  - News now reads GDELT's bulk 15-minute files instead of its rate-limited search API.
  - The update job is scheduled hourly and rebuilds UNHCR data only when UNHCR's published figures change, using a fingerprint check.
  - Fixed a memory leak that crashed multi-day news runs.
  - Upgraded GitHub Actions versions.
- **Reason:** The search API's rate limits blocked most requests; UNHCR publishes year-end data once a year, so rebuilding hourly was unnecessary.
- **Tools/AI:** Claude (Claude Code).
- **Tests:** Fingerprint stable across repeated checks; workflow runs succeeded on GitHub.
- **Result:** Headlines for 134 countries after a 3-day catch-up run (unfiltered by outlet quality at that time).

### 16 Oct 2026: UX/UI audit, rated outlets, territory labels *(reconstructed from `2d82a4e`, `ea97225`, `3e80b2a`, `d401cdb`)*
- **Issue:** The primary users brief others or write quick reports, often in government. News included unreliable and local outlets and stories about individuals.
- **Change:**
  - Wrote a UX/UI audit (`docs/ux-audit.md`), then added briefing tools: copyable summaries and citations, shareable links, PNG/CSV export and a print layout.
  - Served the libraries and font from the site itself, since government networks often block public CDNs.
  - Labeled territories with their governing country, and explained "Unknown origin", "Stateless" and "Tibetan", which are no longer ranked.
  - Removed the animation button.
  - Restricted news to outlets that Wikipedia's Perennial Sources list rates reliable, or that score above 0.66 in Lin et al. (2023) and rank in Tranco's top 10,000 websites, plus UN and intergovernmental bodies.
  - Required headlines to be about forced displacement and to name the country; dropped profiles and opinion.
- **Reason:** David's requests during the session, and audit findings.
- **Tools/AI:** Claude (Claude Code); public rating repositories named above.
- **Tests:** Headline-rule spot checks (16 sample headlines); browser checks at desktop and phone width, light and dark mode.
- **Result:** News became reliable but sparse: in a 3-day run, 15 of 512 displacement headlines passed.
- **Remaining:** Sparse news coverage.

### 17–24 Oct 2026: automatic updates *(from GitHub Actions run history and bot commits)*
- **Result:** All scheduled runs succeeded. GitHub started the "hourly" job only 5 to 7 times a day. Because each run read only the last 2 hours of GDELT files, hours between runs were never read. Daily news snapshots were committed on 17, 18, 19, 21 and 23 Oct only; they depended on a run happening in the 06:00 UTC hour. UNHCR's figures did not change after 15 Oct.

### 23 Oct 2026: team meeting notes on news *(from the team document, "Oct 23 meeting")*
- **Raised:** some countries, "even US", had no news; "maybe within the last month instead of last two weeks"; who the rated outlets are and what makes them rated; whether the link is secure; other data sources (HDX, IDMC database, Migration Policy Institute, World Bank microdata).

### 25 Oct 2026: news window, coverage and matching (commits `ac4cc9d`, `4f3b42a`; branch `news-two-month-window`)
- **Issue:** The 23 Oct snapshot had headlines for 18 of 227 places and none for the US.
- **Diagnosis:**
  - The 14-day window was short.
  - The update job ran 5 to 7 times a day but read only the last 2 hours of GDELT files, so most hours were skipped.
  - Country matching missed "US"/"U.S." and matched "Sudan" inside "South Sudan", "Guinea" inside "Papua New Guinea", and "Niger" in "Niger Delta".
- **Change:**
  - News window is now the previous two calendar months (same UTC date two months back through today, inclusive; configurable with `NEWS_MONTHS`). The team notes suggested one month; this is pending team confirmation.
  - Each run reads all files since the previous run.
  - Country matching was rebuilt with aliases and guards, and a story counts only when its headline ties the country to displaced people.
  - Each article page is opened once: dead or mismatched links and articles published before the window are dropped, and the publisher's date and summary are kept.
  - The page tells apart "No relevant news found in the selected period", a failed update and rows not searched.
  - Added a caveat when "all needing international protection" spans 2018.
  - Fixed dates showing a day early in the Americas and the map PNG export hanging.
  - Workflow: tests and a coverage audit before publishing, a deploy switch for test runs, and a daily snapshot independent of run times.
- **Checked:**
  - The link is HTTPS with a valid certificate.
  - UNHCR's API has no sub-annual country figures: its nowcasting endpoint holds one global estimate for September 2026. So the storyboard's 3- and 6-month comparisons are not possible with this data.
  - The dashboard's end-2025 total of refugees under UNHCR's mandate (28,461,306) matches UNHCR's *Global Trends 2025* (28.5 million).
- **Tools/AI:** Claude (Claude Code desktop app) wrote and ran the changes at David's direction. A separate AI chat assistant drafted David's instructions from the team's feedback.
- **Tests:**
  - 12 automated tests (`node --test "tests/*.test.mjs"`): window and date boundaries, topic rules, country matching, duplicates, publisher-page parsing, link failures, GDELT download failures and empty states. All pass.
  - Browser check of all 48 combinations of measure, view, ranking and arrows; Sudan drill-down unchanged; CSV and PNG exports produced.
  - Local sampled run: every 8th GDELT file over the two months, 33 of 216 dashboard places with at least one article.
- **Result:** Merged to main and published on 26 Oct (UTC). Full two-month run (GitHub Actions run 40253864418): 57 of 216 places shown on the dashboard now have at least one article (203 articles; 193 with a verified link), up from 18 of 227 on 23 October. The full run read 5,856 GDELT files covering 26 August to 26 October; of 10,943 displacement headlines, 9,813 came from outlets not rated reliable or with only local reach and 439 passed every rule. Coverage is weakest in Latin America and the Caribbean (1 of 45) and Oceania (1 of 18), partly because only English-language news is read. See docs/news-coverage-audit.md. Two further fixes were made after reviewing its output: evacuations of diplomats or foreign citizens and any-number "scale" no longer count as displacement.
- **Remaining:** the team to choose one or two months; coverage is limited mostly by the outlet rules; UNHCR-IDMC comparison and user testing not started.
