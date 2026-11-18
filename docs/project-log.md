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
- **Follow-up (26 Oct, `e9a7084`):** a short update run found GDELT's newest file listed but not yet downloadable and recorded a failed update, so the live page briefly showed a false "update failed" note. Short runs now wait for the file instead, and each run starts from the newer of the live and repo news files so committed updates are not overwritten. Verified on the live site afterwards: last update succeeded, window 26 Aug to 26 Oct.
- **Remaining:** the team to choose one or two months; coverage is limited mostly by the outlet rules; UNHCR-IDMC comparison and user testing not started.

### 16 Nov 2026: trusted outlets, four languages, outlet feeds and ReliefWeb (branch `news-sources-upgrade`)
- **Issue:** David reported that news was "not trustworthy enough and not enough of them on countries", and that the filter over-filtered while source quality was still poor.
- **Audit of the live panel (16 Nov, 230 articles, 63 places):**
  - Judged from title, summary and publisher: 154 (67%) about forced displacement, 144 filed under the right country, 114 (50%) usable in a briefing.
  - The most frequent outlet was wn.com, an aggregator (38 articles). 406 of the 587 allowed domains had qualified only through the Lin et al. (2023) score plus Tranco popularity, which also admitted aol.com, msn.com, Yahoo, Metro and similar. Specialist outlets such as The New Humanitarian, ReliefWeb and Africanews were not allowed. In the 26 Oct full run, 90% of displacement headlines were dropped at the outlet step.
  - Misfires came from keyword matching: school bomb-threat evacuations, house fires, medical evacuations, "IDP Education", single-person asylum cases, one boat sinking listed 8 times, and name errors (Fort Frances → France, Niger State → Niger, Dutch → Bonaire).
  - Only English was read: Latin America and the Caribbean had usable news for 1 of 45 places and Oceania for 1 of 18.
- **Options researched:** humanitarian feeds (ReliefWeb, UN News, UNHCR, IOM, IDMC, ECHO), news APIs (NewsAPI, GNews, NewsData, Mediastack, Currents, Google News RSS and others), better use of GDELT, outlet rating lists, and AI relevance checks. David chose free options only; paid APIs and AI checks were dropped. Google News RSS was rejected because its terms allow only personal feed-reader use.
- **Change:**
  - Outlets: a hand-picked list of about 200 outlets with a reason for each (`data/outlets.json`), plus Wikipedia "generally reliable" and UN/intergovernmental bodies. The Lin et al. + Tranco route was removed. Aggregators, press-release sites, tabloids and trade press are blocked; Wikipedia "generally unreliable", "deprecated" and "blacklisted" outlets never count.
  - Topic: GDELT articles must also carry one of GDELT's refugee or displacement themes (in a hand-checked 8-hour sample, about 9 in 10 such headlines were on topic, against about 2 in 3 for the headline rule alone). New exclusions for bomb threats, house fires, medical evacuations, company names and individual asylum cases; years no longer count as "scale".
  - Languages: GDELT's translated files are read and Spanish, French and Portuguese articles kept with their original headline and a language label; topic and country names work in all four languages.
  - Feeds: 75 RSS feeds of listed outlets (`data/feeds.json`), chosen for Latin America, French-speaking Africa, the Pacific and humanitarian specialists, each tested live on 16 Nov.
  - ReliefWeb (UN OCHA): code to list up to five displacement reports per country, shown separately as "Humanitarian reports", through ReliefWeb's official API. The API needs an appname that ReliefWeb approves; a team member has to request one with an organization email. Until the repository variable `RELIEFWEB_APPNAME` is set, nothing is requested and the section stays hidden. ReliefWeb's public RSS pages were tried first, but after a burst of requests its firewall refused scripted requests (HTTP 429, then 406), so they are not used.
  - One event reported by several outlets takes one slot; at most three articles per outlet per country.
- **Tools/AI:** Claude (Claude Code desktop app) researched the options, wrote the code and ran the checks at David's direction; helper agents built the first drafts of the outlet list, feed list and feed reader, which were then reviewed.
- **Review:** three independent reviewers (Claude agents) checked the pipeline, the matching rules on real headlines (the 230 live ones, an 8-hour GDELT sample in four languages, and 25 live feeds) and the page text. Fixed as a result:
  - Spanish, French and Portuguese words that also mean "travelled" or "deployed" ("desplazados", "déplacés", "deslocados") and bare "asilo" now count only in displacement phrases; individual asylum cases in Spanish are treated as profiles.
  - Translated names that are everyday words or first names (reunión, gana, Granada, Mauricio, Dominique, Guadalupe) are no longer country names; French "américaine" goes to the US (it had gone to the Northern Mariana Islands).
  - Similar but different stories about one country were being merged; events now need three shared words beyond the country's names.
  - GDELT files that are listed but not yet posted are read on the next run instead of being skipped; long backfills have a time budget; articles not yet checked wait for the next run; a GDELT outage no longer stops the feeds.
  - Feeds in ISO-8859-1 (Folha de S.Paulo) are decoded correctly.
  - A test now compiles the page's script: an unescaped regular expression had briefly broken the whole page while all other tests passed.
- **Tests:** 39 automated tests pass (`node --test "tests/*.test.mjs"`), including the misfires above, the reviewers' cases, the four-language rules, outlet decisions, the consistency of the outlet and feed lists, and the page script. A 2-hour local run read 7 English and 4 translated GDELT files and 72 of 75 feeds and checked 19 article pages in about a minute; 14 places had articles, 4 of them in French.
- **Result:** full two-month run on the branch, without publishing (GitHub Actions run 43949196186, 16 Nov, 57 minutes): 5,855 English and 5,856 translated GDELT files read (9.0 million articles in languages other than English, Spanish, French and Portuguese skipped); 12,819 displacement headlines, of which 4,706 lacked GDELT's displacement tags, 7,112 came from outlets that don't count (most often AllAfrica, SANA, AOL, Arab News, the Daily Mail and Anadolu), 430 were profiles or opinion and 247 were not tied to a country; 324 kept, plus 19 from the outlet feeds. After opening each page: 216 articles for 65 places (162 in English, 29 Spanish, 19 French, 6 Portuguese), against 230 articles for 63 places before, of which only about 114 for 39 places were usable in the 16 Nov audit. The most frequent outlets are now Al Jazeera, Africanews, The Guardian and Deutsche Welle. Reading the 216 turned up 10 more misfires (single-person criminal and asylum cases, "South China Sea" filed under China, a Spanish police manhunt), fixed before merging; the next run removes them.
- **Remaining:** a ReliefWeb appname (request, then set `RELIEFWEB_APPNAME`); the ReliefWeb API code is tested only against the documented response format until then; Arabic and Russian-language coverage; small Pacific states remain thin.
- **Follow-up (16 Nov, UNHCR mid-year figures):** the publish run found new UNHCR figures and rebuilt the data with a year 2026. UNHCR's API now carries mid-year 2026 figures (as of 30 June 2026) under "2026", and the dashboard showed them as "31 Dec 2026" for about 20 minutes. The data step now uses only years whose year-end figures can have been published (year Y from 1 July of Y+1, after UNHCR's Global Trends release), and the rebuild restored 2025 as the latest year. Showing mid-year figures, clearly labeled as 30 June, is possible later if the team wants it.

### 18 Nov 2026: Arabic and Russian, Media Cloud, NewsData.io and ACLED (branch `news-apis-acled-arabic-russian`)
- **Issue:** David asked for more free sources alongside GDELT, for better worldwide coverage. In the 17 Nov snapshot, 151 of 216 places had no article. Headlines in Arabic and Russian were dropped: about 9 million in GDELT's translated files over two months, because the rules read only English, Spanish, French and Portuguese.
- **Options:** free news APIs and datasets were compared (NewsData.io, Media Cloud, NewsCatcher, Webz.io, Currents, Event Registry, Common Crawl CC-NEWS, POLECAT, ACLED). David chose Media Cloud, NewsData.io and ACLED, plus Arabic and Russian rules.
- **Change:**
  - **Arabic and Russian** (`news-lib.mjs`, `feeds-lib.mjs`, `outlets.json`, `feeds.json`):
    - Topic, profile and country rules for both languages: Arabic clitics and spelling variants, Russian case endings, and country names and demonyms for every place, with the same guards as before (South Sudan/Sudan, Niger/Nigeria, the Congos, Oman/Amman, Mali/"financial").
    - Exclusions: bomb shelters (бомбоубежище), fire and bomb-threat evacuations, diplomats, voluntary resettlers, capital flight (نزوح رؤوس الأموال), building evacuations, "resorting to" (اللجوء إلى), single-person asylum cases and films.
    - Title normalization keeps all letters. Before this, Arabic and Cyrillic titles became empty strings, so they would all have been merged as duplicates and every Arabic page marked "mismatched".
    - Pages and feeds in windows-1256, windows-1251 and KOI8-R are decoded.
    - Outlets: 18 domains added, including Radio Dabanga, Sudan Tribune Arabic, Mada Masr, Annahar, Monte Carlo Doualiya, Caucasian Knot, Novaya Gazeta Europe, JAMnews, 24.kg, Asia-Plus, Ukrainska Pravda, and RFE/RL's Radio Svoboda, Current Time and Central Asia services.
    - Feeds: 28 added (12 Arabic, 16 Russian; 103 feeds in all), each fetched live on 18 Nov.
    - Judgment calls for the team to confirm: RFE/RL is hand-picked, as VOA is, although Wikipedia lists it as "no consensus". State media are left out, following the earlier SANA/Xinhua decision (TASS, RIA, SANA, Al-Ahram, WAFA, Ukrinform). So are Saudi- and UAE-owned outlets (Al Arabiya, Asharq Al-Awsat, Sky News Arabia).
  - **Media Cloud and NewsData.io** (`news-apis-lib.mjs`, `fetch-news.mjs`): two more ways to find headlines, under the same rules as the outlet feeds (window, core displacement term, outlet, country, language, then the page check).
    - Media Cloud searches by place, places with the fewest articles first, at most once a UTC day per place, and stays under 3,000 of its 4,000 weekly quota units. Regular accounts must name outlets, so the first runs look up each accepted outlet in Media Cloud's directory.
    - NewsData.io runs keyword searches in each of the six languages, at most 24 credits a run and 180 a day. The plan allows 200 a day and 30 per 15 minutes.
    - The quota ledgers are saved in `data/news.js` (`newsApis`), even when a run fails. Without the `MEDIACLOUD_API_KEY` or `NEWSDATA_API_KEY` secret, that source is skipped.
  - **ACLED** (`acled-lib.mjs`, `fetch-acled.mjs`, `data/acled.js`, `index.html`): a "Conflict and protest events (ACLED)" item in the country panel. It shows events and fatalities for the two latest complete months available, against the two months before, and the most common event types, from a once-a-day read.
    - ACLED's EULA (§3.1, updated 1 Nov 2026) requires published material to be "transformative", so only totals per country, event type and period are kept, and no event row is written to disk. The panel and a methods note credit ACLED and say the totals are the project's.
    - A free Research account (institutional email) gets event data with a 12-month lag, so the months shown are about a year behind the news; the panel says so.
    - Without the `ACLED_USERNAME` and `ACLED_PASSWORD` secrets, the section stays hidden.
  - **Page:** Arabic and Russian headlines have language labels, Arabic reads right to left, and the language list in the news note comes from the news file. The methods text names the new sources.
  - **Workflow:** the two API key secrets were added to the news step, and an ACLED step was added after it.
  - **README:** has switch-on instructions for each source.
- **Tools/AI:** Claude (Claude Code desktop app) researched the options, split the work into three parallel tracks (languages, news APIs, ACLED) handled by helper agents, then reviewed, integrated and tested the result, at David's direction.
- **Tests:**
  - 98 automated tests pass (`node --test "tests/*.test.mjs"`), up from 40. They cover real Arabic and Russian headlines and lookalikes, country guards, non-Latin duplicates and charset decoding. Both API clients are covered against their documented responses: pagination, quota ledgers across runs and UTC days, 429/500 handling, and the switched-off state. ACLED is covered for sign-in, paging, totals, change, country mapping and the switched-off state.
  - A separate spot check of 12 new Arabic and Russian headlines (true cases and lookalikes) gave 12 correct results.
  - Precision check on 216 hourly GDELT translated files (9–18 Nov; 50,635 Arabic and Russian headlines): 58 passed topic, GDELT tags and country at any outlet. About 55 were on topic and about 54 filed under the right country. Only 4 came from outlets that count (BBC, Al Jazeera), all correct. GDELT's Arabic and Russian stream is mostly Egyptian, Palestinian and Russian domestic outlets, so the new feeds supply most items: on 18 Nov, 6 of 1,113 feed items were kept, all on topic.
  - None of Media Cloud, NewsData.io or ACLED has been called with a real key yet.
- **Remaining:**
  - Sign up for Media Cloud, NewsData.io (check its free plan's terms for a public site first) and ACLED (Research account), and add the secrets.
  - Confirm with ACLED that country totals meet its EULA.
  - Watch the first live runs of each API.
  - Request the ReliefWeb appname.
  - Russian recall is low because GDELT's Russian stream is dominated by outlets that don't count.
