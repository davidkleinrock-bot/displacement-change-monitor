# UX/UI audit: Displacement Change Monitor

*16 October 2026. Reviewed version: the live site before commit "Briefing tools, rated news outlets, territory labels". Status reflects the version after that commit.*

## Who we audited for

**Primary users:** people who brief others or put together quick reports. Typical examples are a desk officer preparing a two-paragraph update for leadership, or an NGO headquarters analyst building a slide. Many work in **government**.

**What they need in one sitting:**

1. Find which situations changed most.
2. Get a defensible number with its date and source.
3. Paste it into a document or slide.
4. Send a colleague to the same view.

**Constraints that come with government users:**

- **Locked-down networks:** these often block third-party CDNs and web fonts.
- **Accessibility:** Section 508, which follows WCAG 2.x AA.
- **Printing:** reports often end up printed or saved as PDF.
- **Caution with sources:** sources are scrutinized, so anything that looks like an unvetted news feed is a liability.

**Fit with Carnegie's suite.** We compared against the [Global Protest Tracker](https://carnegieendowment.org/features/global-protest-tracker), which follows these conventions:

- A dark title band with "Last updated on [date]" directly under the title.
- A row of headline figures written as full sentences, plus a spotlight item.
- A neutral sans-serif type with deep navy ink and light gray rules.
- Filters with a reset.
- A separate "About the tracker" / limitations section.

The tracker offers no data download or citation help, so those are an opportunity for this tool rather than something to match. We matched the conventions, not the branding. The site does not use Carnegie's name, logo or typeface, and should not until Carnegie approves it.

## Method

We worked through the four tasks above on desktop and at phone width (390 px), in light and dark mode, and with the keyboard only. We checked the page against WCAG 2.2 AA basics (contrast, focus, names and roles, target size, reflow). We also simulated a network that blocks public CDNs.

## Findings

Severity: **High** means it blocks a core task or excludes users. **Medium** means it slows users down or risks misreading. **Low** is polish.

| # | Finding | Severity | Status |
|---|---|---|---|
| 1 | No way to get a figure into a report. Users had to retype numbers and work out the source line themselves. | High | **Fixed.** A "Summary for your brief" box for the world view and every country, with plain sentences and Copy summary, Copy citation and Copy link buttons. |
| 2 | Links didn't reproduce the view. Only the country was kept, so a colleague opening the link saw a different measure or period. | High | **Fixed.** The address now carries measure, count-by, period, ranking and arrows, plus the country (`?measure=refugees&by=origin&from=2024&to=2025…#SDN`). |
| 3 | Charting library and fonts loaded from public CDNs, which government networks often block. If d3 failed, the whole page failed. | High | **Fixed.** d3, topojson-client and the Public Sans font are served from the site itself (`vendor/`). |
| 4 | News came from any outlet GDELT indexes, including ones widely rated unreliable, small local papers, and stories about individuals or unrelated "evacuations". | High | **Fixed.** Only outlets rated reliable with national or international reach, and only headlines about forced displacement that name the country and aren't profiles or opinion (see "News sources" below). |
| 5 | "Unknown origin", "Stateless" and "Tibetan" looked like countries and could top a ranking, as Unknown origin did for "All needing international protection", 2024–2025. | High | **Fixed.** They are labeled "Not a country", explained in the panel and in About, and never ranked. |
| 6 | Territories weren't distinguished from states (Puerto Rico, Guam, Gibraltar…). | Medium | **Fixed.** Labeled with the governing country ("US territory", "UK overseas territory", "Part of France (overseas department)"…) in the table, tooltip, panel and brief. |
| 7 | No print or PDF layout. | Medium | **Fixed.** "Print or save as PDF" in the title band, with a print stylesheet that drops the controls and keeps the map, brief and table. |
| 8 | No exports for slides or spreadsheets. | Medium | **Fixed.** "Download map (PNG)" includes the title, legend, source line and link. "Download table (CSV)" includes the source, the dates covered and the retrieval date on every row. |
| 9 | The key answer ("what changed most?") sat in the side panel, below the fold on laptops. | Medium | **Fixed.** Key-findings sentences sit at the top: worldwide change, largest increase, largest decrease and fastest-growing corridor. Each opens its country. |
| 10 | "Play years" animation read as gimmicky and didn't serve a briefing task. | Low | **Fixed.** Removed. The start and end year selectors cover any period. |
| 11 | The interactive map was marked `role="img"`, which hides its controls from screen readers. No skip link; toggles didn't respond to arrow keys; some text was 11 px. | Medium | **Fixed.** The map is now a labeled group pointing to the table. Added a skip link to the ranking table, arrow-key navigation in the toggles, and a 12 px minimum for text. |
| 12 | No quick way back to the default view after exploring. | Low | **Fixed.** "Reset" button, as on Carnegie's trackers. |
| 13 | The date of the data wasn't prominent. | Low | **Fixed.** "Data updated … · UNHCR figures through 31 Dec 2025 · News updated …" under the title. |
| 14 | Countries on the map can't be reached by keyboard individually. | Medium | **Open, mitigated.** Every figure is in the ranking table, which is fully keyboard accessible, and the map says so. A keyboard country picker would close this. |
| 15 | Abbreviations from UNHCR ("Syrian Arab Rep.", "Dem. Rep. of the Congo") appear in pasted text. | Low | **Open.** Kept so figures match UNHCR's tables exactly. Switch to full names if readers prefer. |
| 16 | No usability test with real briefers yet. | Medium | **Open.** For the 23 Oct milestone; see the test script below. |

## News sources: how "reputable" is defined

Defined from public repositories, not by us. Built by `scripts/fetch-sources.mjs`, refreshed daily, and saved with the reason for each outlet in `data/processed/news-sources.json`.

**An outlet is shown if any one of these holds:**

1. [Wikipedia's Perennial Sources list](https://en.wikipedia.org/wiki/Wikipedia:Reliable_sources/Perennial_sources) rates it **generally reliable** in every entry for that domain.
2. Wikipedia has not rated it, or rates it reliable only for some sections, topics or periods (for example, The Guardian is rated reliable but its blogs are not). It then needs **both** of these:
   - **Quality:** an aggregate score **above 0.66** in [Lin et al. (2023), *PNAS Nexus*](https://doi.org/10.1093/pnasnexus/pgad286). Lin et al. combine six expert news-quality rating sets into one 0–1 score for 11,000+ domains, and 0.66 is the cut-off later work uses for "reliable".
   - **Reach:** national or international, measured as a place among the **10,000 most-visited websites** in the [Tranco research ranking](https://tranco-list.eu). The quality ratings also cover small local papers and TV stations; this keeps them out.
3. It is an **intergovernmental or UN system organization**: a `.int` domain ([IANA grants .int only to treaty-based intergovernmental bodies](https://www.iana.org/domains/int/policy)), un.org, or an agency in the [UN system directory](https://unsceb.org/directory) such as UNHCR or WFP.

**Excluded:** anything Wikipedia never rates generally reliable (no consensus, generally unreliable, deprecated, blacklisted), whatever its score.

**Which headlines count.** A headline from a qualifying outlet is kept only if all of these hold:

- **Forced displacement:** it uses forced-displacement terms (refugees, asylum, internally displaced, stateless, returnees). Looser words ("fled", "evacuated", "displacement") count only with conflict words or scale, and not in stories about jobs, AI or the wealthy.
- **Names the country:** it names the country it is listed under, or its people.
- **Reporting, not profile or opinion:** it is not built around one person ("She fled…", "From refugee to mayor") and is not opinion, an editorial, a podcast or a live blog.

**Examples**

| Status | Outlets |
|---|---|
| In | Reuters, AP, BBC, Al Jazeera, NYT, The Guardian, Bloomberg, France 24, DW, CBC, Euronews, Dawn, Punch, UNHCR, WFP |
| Out (rated unreliable) | Fox News, New York Post, Xinhua, Anadolu Agency, Daily Mail, RT, Breitbart |
| Out (local reach) | Wyoming News, CT Mirror, WAtoday, WTOP, KIRO 7, Big News Network |

The outlet list has about 590 outlets; about 3,100 outlets with good quality scores were left out as local. In a 12-hour sample, 98 displacement headlines appeared. Of those, 83 came from outlets not rated reliable or with only local reach, 4 were profiles or opinion, and 6 named no country.

**Limits**

- Both repositories lean toward English-language and Western outlets.
- **The New Humanitarian is a loss.** It is the main specialist outlet on crises, but ranks about 26,000th by traffic, so the reach rule drops it. To bring humanitarian-sector outlets back on a principled basis, request a free ReliefWeb API app name ([apidoc.reliefweb.int](https://apidoc.reliefweb.int/parameters#appname)) and add "sources UN OCHA's ReliefWeb republishes" as a fourth rule.
- The Lin et al. data repository has no license file. We download it at build time, don't redistribute it, and cite the paper.

## Usability test script for 23 October (about 15 minutes per person)

Ask 3–5 people who write briefings to think aloud. Don't help unless they're stuck for more than a minute.

1. "Which country's refugee situation grew most last year? How many people, and by how much?" *Success: names Sudan, about 726,000, +34.7%, within 60 seconds.*
2. "Put that into a short note with its source." *Success: uses Copy summary or Copy citation; the pasted text includes the dates.*
3. "Where are most Sudanese refugees living now?" *Success: finds Chad, South Sudan and Libya in the panel or on the arrows.*
4. "Send a colleague a link that shows exactly this." *Success: Copy link; opening it reproduces the view.*
5. "Is Puerto Rico a country in this data?" *Success: notices the "US territory" label.*
6. "What does 'Unknown origin' mean, and should it be in your brief?" *Success: finds the definition and says it isn't a place.*

Record: time per task, wrong turns, words they use for things (to fix labels), and anything they'd need before trusting the numbers.
