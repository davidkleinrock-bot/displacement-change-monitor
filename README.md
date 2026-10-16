# Displacement Change Monitor

An interactive map that ranks displacement situations by how fast they are changing. It's built for people who brief others or write quick reports, including in government: every figure can be copied into a brief with its source.

**Live dashboard:** https://davidkleinrock-bot.github.io/displacement-change-monitor/

- **Map:** countries colored by change between two year-end counts (red = more people displaced, blue = fewer).
- **Flow arrows:** origin → host corridors for any period from 2010 to 2025, sized by people and colored by whether the corridor grew or shrank. Click a country to see only its corridors.
- **Country panel:** start and end figures, change and % change, a 2000–2025 trend, top host countries or origins, returns, IDMC internal displacement, recent news, and links to the exact UNHCR API query behind the numbers.
- **Ranked table:** sortable and searchable, with the same figures as the map. Missing figures are marked "Unavailable". Territories are labeled with their governing country; "Unknown origin", "Stateless" and "Tibetan" are explained and never ranked.
- **Briefing tools:** key-findings sentences at the top, plus a "Summary for your brief" for the world and every country with Copy summary, Copy citation and Copy link buttons. Links reproduce the exact view. Download the map as PNG or the table as CSV, or print/save as PDF.
- **News from rated outlets only:** headlines about forced displacement, from outlets rated reliable (Wikipedia's Perennial Sources list, or Lin et al. 2023 quality scores plus national or international reach in the Tranco ranking) and UN/intergovernmental bodies. Personal profiles, opinion and local news are left out. See [the audit](docs/ux-audit.md#news-sources-how-reputable-is-defined).
- **Self-updating:** every hour a GitHub Actions job reads the newest GDELT news and checks whether UNHCR or IDMC published new figures. It rebuilds and re-checks the data only when they did, then republishes the site.

## Data

| What | Source | File |
|---|---|---|
| Refugees, asylum-seekers, other people in need of international protection, returns, by origin × host, 2010–latest | [UNHCR Refugee Population Statistics API](https://api.unhcr.org/docs/refugee-statistics.html) | `data/raw/unhcr_population_matrix_*.csv` |
| UNHCR's own totals by origin and by host, 2000–latest | same API | `data/raw/unhcr_population_by_origin_*.csv`, `..._by_host_*.csv` |
| Internally displaced by conflict (IDMC) | same API, `/idmc/` endpoint | `data/raw/idmc_idps_by_country_*.csv` |
| Country names, codes, regions | same API, `/countries/` | `data/raw/unhcr_countries.json` |
| Map shapes (Natural Earth 1:50m) | [world-atlas](https://github.com/topojson/world-atlas) | `data/raw/geo/countries-50m.json` |
| ISO codes and country reference points for arrows | [world-countries](https://github.com/mledoze/countries) | `data/raw/geo/world-countries.json` |
| Displacement headlines by country, rolling 14 days | [GDELT 2.0 news files](https://www.gdeltproject.org/data.html) (Global Knowledge Graph, every 15 minutes) | `data/news.js` |
| Which news outlets count as reputable | [Wikipedia: Perennial sources](https://en.wikipedia.org/wiki/Wikipedia:Reliable_sources/Perennial_sources) (CC BY-SA 4.0), [Lin et al. 2023](https://doi.org/10.1093/pnasnexus/pgad286) ([data](https://github.com/hauselin/domain-quality-ratings)) and the [Tranco](https://tranco-list.eu) top-10,000 sites | `data/processed/news-sources.json` (raw downloads in `data/raw/sources/` are not committed) |

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

## Run it locally

Requires Node 18 or newer. There are no packages to install.

```bash
node scripts/fetch-data.mjs     # download UNHCR, IDMC and map data into data/raw/
node scripts/build-data.mjs     # build data/*.js and run the checks
node scripts/fetch-sources.mjs  # build the list of reputable news outlets
node scripts/fetch-news.mjs     # read the last 24 h of GDELT news files (~2 min; NEWS_HOURS=72 to look further back)
node scripts/serve.mjs          # open http://localhost:8080
```

You can also open `index.html` straight from disk. Everything it needs, including d3, topojson-client and the Public Sans font, is in the repo (`vendor/`), so it works on networks that block public CDNs.

## Automatic updates and hosting

`.github/workflows/update-and-deploy.yml` runs every hour (at :47), on every push to `main`, and on demand from the Actions tab:

1. `check-unhcr.mjs` compares a fingerprint of UNHCR's published totals with the one saved at the last download. Only if they differ, because of a new year or a revision, does it run `fetch-data.mjs` and `build-data.mjs` and commit the new data.
2. `fetch-news.mjs` reads the last 2 hours of GDELT news files, keeps headlines from rated outlets, and merges them into the 14-day headline history taken from the live site. Once a day `fetch-sources.mjs` refreshes the list of rated outlets.
3. The site is republished. News is committed to the repo once a day; the other runs only publish.

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
scripts/                       fetch, build, news and local server scripts
```

## Limitations

Rankings point to situations that deserve a closer look. They are not a full assessment of humanitarian conditions. UNHCR publishes year-end figures once a year, months after the year closes, so the newest comparison is always at least several months old. Headlines are matched automatically and are not checked.
