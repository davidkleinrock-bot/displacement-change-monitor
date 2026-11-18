# Displacement Change Monitor

An interactive map that ranks displacement situations by how fast they are changing. It's built for people who brief others or write quick reports, including in government: every figure can be copied into a brief with its source.

**Live dashboard:** https://davidkleinrock-bot.github.io/displacement-change-monitor/

- **Map:** countries colored by change between two year-end counts (red = more people displaced, blue = fewer).
- **Flow arrows:** origin → host corridors for any period from 2010 to 2025, sized by people and colored by whether the corridor grew or shrank. Click a country to see only its corridors.
- **Country panel:** start and end figures, change and % change, a 2000–2025 trend, top host countries or origins, returns, IDMC internal displacement, recent news, and links to the exact UNHCR API query behind the numbers.
- **Ranked table:** sortable and searchable, with the same figures as the map. Missing figures are marked "Unavailable". Territories are labeled with their governing country; "Unknown origin", "Stateless" and "Tibetan" are explained and never ranked.
- **Briefing tools:** key-findings sentences at the top, plus a "Summary for your brief" for the world and every country with Copy summary, Copy citation and Copy link buttons. Links reproduce the exact view. Download the map as PNG or the table as CSV, or print/save as PDF.
- **News from trusted outlets only:** headlines about forced displacement in English, Spanish, French and Portuguese, only from about 180 outlets checked for their own reporting (agencies, broadcasters, newspapers with correspondents, humanitarian specialists with field staff, local outlets with reporters on the ground), each recording its owner and which outside databases list it (Journalism Trust Initiative, ReliefWeb sources, Reuters Institute Digital News Report, EBU, Public Media Alliance, The Trust Project, press councils), plus UN/intergovernmental bodies as official sources. Outlets that don't publish their owner are marked. See `data/outlets.json` (`allow`, `excluded` with reasons). Aggregators, press-release sites, tabloids and trade press are blocked. GDELT articles must also carry GDELT's own refugee/displacement topic tags. Personal profiles, opinion and individual asylum cases are left out, and one event reported by many outlets is listed once. Each article shows its publisher, publication date, language and the publisher's own summary, and its link is checked. Spanish, French and Portuguese headlines and summaries also get an English machine translation (OPUS-MT, run free on the update job), shown under the original. The panel covers the previous two calendar months. See the [coverage audit](docs/news-coverage-audit.md).
- **Humanitarian reports (switched on once ReliefWeb approves an appname):** up to five recent ReliefWeb (UN OCHA) reports per country about displacement, from UN agencies, NGOs and governments, tagged by country by ReliefWeb's editors. See [Switching on ReliefWeb](#switching-on-reliefweb).
- **Self-updating:** a GitHub Actions job, scheduled hourly and in practice run 5 to 7 times a day, reads the GDELT news (English and translated) published since its last run, the outlets' RSS feeds and (once switched on) ReliefWeb, and checks whether UNHCR or IDMC published new figures. It rebuilds and re-checks the data only when they did, then republishes the site.

## Data

| What | Source | File |
|---|---|---|
| Refugees, asylum-seekers, other people in need of international protection, returns, by origin × host, 2010–latest | [UNHCR Refugee Population Statistics API](https://api.unhcr.org/docs/refugee-statistics.html) | `data/raw/unhcr_population_matrix_*.csv` |
| UNHCR's own totals by origin and by host, 2000–latest | same API | `data/raw/unhcr_population_by_origin_*.csv`, `..._by_host_*.csv` |
| Internally displaced by conflict (IDMC) | same API, `/idmc/` endpoint | `data/raw/idmc_idps_by_country_*.csv` |
| Country names, codes, regions | same API, `/countries/` | `data/raw/unhcr_countries.json` |
| Map shapes (Natural Earth 1:50m) | [world-atlas](https://github.com/topojson/world-atlas) | `data/raw/geo/countries-50m.json` |
| ISO codes and country reference points for arrows | [world-countries](https://github.com/mledoze/countries) | `data/raw/geo/world-countries.json` |
| Displacement headlines by country, previous two calendar months | [GDELT 2.0 news files](https://www.gdeltproject.org/data.html) (Global Knowledge Graph, English and translated, every 15 minutes) and the RSS feeds in `data/feeds.json` | `data/news.js` |
| Humanitarian reports by country | [ReliefWeb API](https://apidoc.reliefweb.int) (UN OCHA), once an appname is approved | `data/news.js` (`reports`) |
| Which news outlets count | Outlet list checked on 18 Nov 2026 for own reporting and ownership, with sources and outside databases ([Journalism Trust Initiative](https://journalismtrustinitiative.org/community/), ReliefWeb sources, [Reuters Institute Digital News Report](https://reutersinstitute.politics.ox.ac.uk/digital-news-report/2026), EBU, Public Media Alliance, The Trust Project, press councils); UN system directory; block list | `data/outlets.json` |
| English translations of Spanish, French and Portuguese news | [OPUS-MT](https://github.com/Helsinki-NLP/Opus-MT) (University of Helsinki, CC BY 4.0) via [transformers.js](https://github.com/huggingface/transformers.js), installed and run only on the update job | `data/news.js` (`titleEn`, `descriptionEn`) |

`data/raw/manifest.json` records when each file was downloaded and from which URL. The dashboard shows both the dates the statistics cover (31 December of each year) and the date they were retrieved.

### Checks

`build-data.mjs` adds up every origin → host row by origin and by host and compares the sums with UNHCR's published totals for the same year. The result is in `data/verification.json`. On the first build, all 9,549 origin checks and 8,409 host checks matched. If any check ever fails, the build stops without overwriting the dashboard data, so the live site keeps the last good numbers.

For spot checks in a spreadsheet, `data/processed/country_totals.csv` has every figure the dashboard uses in long format (year, ISO3, country, measure, value).

### Known quirks

- UNHCR uses `UNK` for "Unknown origin"; the world-countries file uses `UNK` for Kosovo. The build never joins on that code.
- UNHCR reports Kosovo together with Serbia ("Serbia and Kosovo: S/RES/1244 (1999)"), so the Kosovo map shape shows that record. Somaliland and N. Cyprus shapes show Somalia and Cyprus.
- French Guiana, Guadeloupe, Martinique, Réunion and a few small territories have figures but no separate map shape. They appear in the table and as arrow endpoints.
- "-" in the API means nothing was reported. It stays distinct from a reported zero.
- Big swings can reflect how a government counts people. In 2025, refugees hosted in Iran fell from 3.49M to 0.77M and "Unknown origin" people needing international protection rose by about 1.5M.

### Switching on ReliefWeb

ReliefWeb (UN OCHA) only allows its data to be read through its API with an appname it has approved. It is free.
1. Request one with the short form linked from https://apidoc.reliefweb.int ("Appname"). ReliefWeb asks for an organization email address (a university address works; Gmail and similar are not accepted) and replies by email.
2. In the GitHub repository, open Settings → Secrets and variables → Actions → Variables, and add a variable named `RELIEFWEB_APPNAME` with the approved name. The appname is not a secret.
3. The next run adds a "Humanitarian reports" list to each country panel and a paragraph about it under "About the data". Until then, nothing is requested from ReliefWeb and both stay hidden.

Scripted requests to ReliefWeb's public RSS pages were refused by its firewall on 16 Nov 2026 (HTTP 406/429), so the dashboard does not use them.

## Run it locally

Requires Node 18 or newer. There are no packages to install.

```bash
node scripts/fetch-data.mjs     # download UNHCR, IDMC and map data into data/raw/
node scripts/build-data.mjs     # build data/*.js and run the checks
node scripts/fetch-news.mjs     # read GDELT files since the last run, outlet feeds and ReliefWeb (NEWS_HOURS=1464 for a two-month backfill; NEWS_STEP=8 to sample; RELIEFWEB_APPNAME=… for reports)
node scripts/news-coverage-audit.mjs  # per-country coverage report: docs/news-coverage-audit.md
node --test "tests/*.test.mjs"  # tests for dates, topic and country rules (4 languages), outlets, duplicates, feeds, empty results and failures
node scripts/serve.mjs          # open http://localhost:8080
```

You can also open `index.html` straight from disk. Everything it needs, including d3, topojson-client and the Public Sans font, is in the repo (`vendor/`), so it works on networks that block public CDNs.

## Automatic updates and hosting

`.github/workflows/update-and-deploy.yml` is scheduled every hour (at :47); in practice GitHub has started it 5 to 7 times a day. It also runs on every push to `main` and on demand from the Actions tab:

1. `check-unhcr.mjs` compares a fingerprint of UNHCR's published totals with the one saved at the last download. Only if they differ, because of a new year or a revision, does it run `fetch-data.mjs` and `build-data.mjs` and commit the new data.
2. `fetch-news.mjs` reads every GDELT news file published since the previous run (so hours between runs are not skipped), keeps headlines that pass the rules, opens each new article to read its date and summary and to check the link, and merges them into the two-month history taken from the live site. Once a day `fetch-sources.mjs` refreshes the list of rated outlets.
3. The tests run, then the site is republished. News is committed to the repo about once a day; the other runs only publish.

To fill the two-month window from scratch, run the workflow from the Actions tab with `news_hours` = 1464 (about 5,900 files; allow up to two hours).

If the totals check fails after a UNHCR release, the run fails, nothing is published, and GitHub emails the repo owner.

One-time setup: in the repo go to **Settings → Pages** and set **Source** to **GitHub Actions**.

## Files

```
index.html                     the dashboard
vendor/                        d3 7.8.5, topojson-client 3.1.0, Public Sans (SIL Open Font License)
docs/ux-audit.md               UX/UI audit, news-source definition, usability test script
data/dashboard-data.js         countries, yearly totals, origin→host flows (built)
data/world.js                  map shapes keyed by ISO3 (built)
data/news.js                   saved headlines (fetched)
data/verification.json         result of the totals check
data/processed/                long-format CSV for spot checks; reputable news outlets with reasons
data/raw/                      untouched downloads + manifest
scripts/                       fetch, build, news and local server scripts (news-lib.mjs holds the news rules)
tests/                         node --test suite for the news rules
docs/news-coverage-audit.md    which countries have news, and why some don't
docs/project-log.md            what changed, when, why, and how it was tested
```

## Limitations

Rankings point to situations that deserve a closer look. They are not a full assessment of humanitarian conditions. UNHCR publishes year-end figures once a year, months after the year closes, so the newest comparison is always at least several months old. Headlines are matched automatically and are not checked.
