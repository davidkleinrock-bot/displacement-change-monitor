# Displacement Change Monitor

An interactive map that ranks displacement situations by how fast they are changing, so NGO staff can see which crises are worsening without comparing countries one by one.

**Live dashboard:** https://davidkleinrock-bot.github.io/displacement-change-monitor/

- **Map:** countries colored by change between two year-end counts (red = more people displaced, blue = fewer).
- **Flow arrows:** origin → host corridors for any period from 2010 to 2025, sized by people and colored by whether the corridor grew or shrank. Click a country to see only its corridors.
- **Country panel:** start and end figures, change and % change, a 2000–2025 trend, top host countries or origins, returns, IDMC internal displacement, recent news, and links to the exact UNHCR API query behind the numbers.
- **Ranked table:** sortable and searchable, with the same figures as the map. Missing figures are marked "Unavailable".
- **Self-updating:** a GitHub Actions job re-downloads everything daily, checks the numbers, and republishes the site.

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
node scripts/fetch-news.mjs     # read the last 24 h of GDELT news files (~2 min; NEWS_HOURS=72 to look further back)
node scripts/serve.mjs          # open http://localhost:8080
```

You can also open `index.html` straight from disk. Served from localhost or GitHub Pages, the page also fetches live headlines when you open a country.

## Automatic updates and hosting

`.github/workflows/update-and-deploy.yml` runs every day at 06:17 UTC (and on demand from the Actions tab). It runs the three scripts, commits any changed data, and publishes the site to GitHub Pages. Every push to `main` also republishes the site.

One-time setup: in the repo go to **Settings → Pages** and set **Source** to **GitHub Actions**.

## Files

```
index.html                     the dashboard (D3 + TopoJSON from CDNs, everything else local)
data/dashboard-data.js         countries, yearly totals, origin→host flows (built)
data/world.js                  map shapes keyed by ISO3 (built)
data/news.js                   saved headlines (fetched)
data/verification.json         result of the totals check
data/processed/                long-format CSV for spot checks
data/raw/                      untouched downloads + manifest
scripts/                       fetch, build, news and local server scripts
```

## Limitations

Rankings point to situations that deserve a closer look. They are not a full assessment of humanitarian conditions. UNHCR publishes year-end figures once a year, months after the year closes, so the newest comparison is always at least several months old. Headlines are matched automatically and are not checked.
