// Pure logic for the news feature, shared by fetch-news.mjs and the tests in tests/news.test.mjs.
// Nothing here reads files or the network except fetchArticleMeta and downloadFile, which take the
// fetch function as a parameter so tests can simulate failures.

// ---------- Time window ----------
// Default: the previous two calendar months, counted back from today's date and including today.
// On 25 Oct 2026 that is 25 Aug 2026 to 25 Oct 2026. If the earlier month is shorter, the start day is
// clamped to its last day (31 Dec → 31 Oct; 30 Apr → 28 or 29 Feb). All dates are UTC calendar dates.
export const DEFAULT_MONTHS = 2;

export const isoDay = (d) => d.toISOString().slice(0, 10);

export function newsWindow(now = new Date(), months = DEFAULT_MONTHS) {
  const y = now.getUTCFullYear(), m = now.getUTCMonth(), day = now.getUTCDate();
  const first = new Date(Date.UTC(y, m - months, 1));
  const lastDay = new Date(Date.UTC(first.getUTCFullYear(), first.getUTCMonth() + 1, 0)).getUTCDate();
  const from = new Date(Date.UTC(first.getUTCFullYear(), first.getUTCMonth(), Math.min(day, lastDay)));
  return { from: isoDay(from), to: isoDay(now), months };
}

// Checks an article date against the window. Returns { date } or { reason } when it can't be used.
export function checkDate(value, window) {
  if (!value) return { reason: "missing" };
  const t = Date.parse(value);
  if (Number.isNaN(t)) return { reason: "invalid" };
  const date = new Date(t).toISOString().slice(0, 10);
  if (date > window.to) return { reason: "future" };
  if (date < window.from) return { reason: "older" };
  return { date };
}

// ---------- Is this headline about forced displacement? ----------
// Headlines are read in English, Spanish, French and Portuguese. Core terms count on their own. "Fled",
// "evacuated" and similar count only with a conflict word or a sense of scale, so wildfire evacuations and
// suspects "fleeing" are left out. Deadly or mass migrant crossings count. Job "displacement", emigration
// of the wealthy, bomb-threat evacuations, house fires and medical evacuations do not.
// Word edges are written as letter lookarounds, because \b treats accented letters as non-letters.
const anyOf = (body) => new RegExp(`(?<![\\p{L}\\p{N}])(?:${body})(?![\\p{L}\\p{N}])`, "iu");
// In Spanish, French and Portuguese, "desplazados", "déplacés" and "deslocados" also mean "travelled" or
// "deployed", and "asilo" also means an old-age home or one person's asylum. So those words count only in
// phrases that mean forced displacement ("miles de desplazados", "déplacés internes", "solicitantes de asilo").
const CORE = anyOf([
  "refugees?|internally displaced|idps?|asylum|stateless(?:ness)?|returnees?", // English
  "refugiad[oa]s?|desplazad[oa]s internos|desplazamiento forzado|(?:miles|cientos|centenares|decenas|familias|personas|población|los|las|de) (?:de )?desplazad[oa]s|desplazad[oa]s por (?:la |el |los |las )?(?:violencia|conflicto|combates|guerra|enfrentamientos|grupos armados|lluvias|inundaciones|huracán)"
    + "|solicitantes? de asilo|(?:derecho|sistema|política|solicitud(?:es)?|peticiones|pedidos?) de asilo|apátridas?", // Spanish
  "réfugié(?:e|s|es)?|demandeu(?:r|rs|se|ses) d['’]asile|droit d['’]asile|déplacés internes|personnes déplacées|(?:des|les|aux|de|milliers de|centaines de) déplacés|apatrides?", // French
  "deslocad[oa]s internos|deslocamento forçado|(?:milhares|centenas|famílias|pessoas) (?:de )?deslocad[oa]s|requerentes? de asilo|pedidos? de asilo", // Portuguese
].join("|"));
const LOOSE = anyOf("displace(?:d|ment|s)|forcibly"); // English only: see above
const LOOSE_OTHER = anyOf("asilo|asile"); // counts only with GDELT's displacement tags (isDisplacement), never on its own
// Evacuating diplomats, troops or foreign citizens is not forced displacement; neither is capital or the wealthy "fleeing".
const NOT_FORCED = anyOf([
  "AI|automation|jobs?|workers?|workforce|labou?r market|billionaires?|millionaires?|wealthy|tax(?:es)?|tourists?|investors?|expats?|retirees|stocks?|shares|diplomats?|embass(?:y|ies)|citizens|nationals|staff|personnel",
  "turistas|touristes|inversores|inversionistas|investisseurs|investidores|diplomáticos|diplomates|diplomatas|ressortissants|ciudadanos|cidadãos|riches|ricos|millonarios|millionnaires|milionários|capitales|capitaux|capitais|fiscalité",
].join("|"));
// Fugitives and prisoners "flee" too. This only blocks the "fled + a number" path, so "10,000 flee as gangs
// attack; two suspects arrested" still counts.
const FUGITIVE = anyOf("fugitives?|extradit\\w*|arrested|manhunt|jailbreak|suspects?|escaped (?:from )?(?:prison|jail|custody)|prófugos?|fugitifs?|reos|presos|reclusos|detenidos|détenus|prisonniers|detentos|cárcel|prisión|presídio|prisons?|jails?");
const FLIGHT = anyOf("fle(?:e|es|eing|d)|evacuat\\w*|exodus|uproot\\w*"
  + "|hu(?:yen|yeron|ir|yendo|yó|ido)|huid[oa]s|evacuad[oa]s|evacuación|éxodo|desplaz(?:a|an|ó|aron)|desplazamientos?"
  + "|fuient|fuir|fuyant|fuyaient|ont fui|avaient fui|évacu\\w*|exode|déplacements? de population"
  + "|fogem|fugi(?:r|ram|ndo|u)|fugid[oa]s|evacuad[oa]s|êxodo|deslocamentos?");
const CONFLICT = anyOf([
  "wars?|fighting|violence|conflict|attacks?|bombing|bombardment|shelling|air ?strikes?|offensive|clashes|siege|gangs?|militias?|rebels?|famine|massacres?|genocide|persecution|troops|army|militants?|insurgents?|occupation",
  "guerra|combates|violencia|conflicto armado|conflicto|ataques?|bombardeos?|enfrentamientos|ofensiva|pandillas|grupos armados|hambruna|masacres?",
  "guerre|combats|violences?|conflit|attaques?|bombardements?|affrontements|groupes armés|jihadistes|djihadistes|famine",
  "violência|conflito|bombardeios?|confrontos|gangues|fome|massacres?",
].join("|"));
// Scale means real magnitudes ("230,000", "20M", "thousands"), not any number ("2 detained") or a year ("in 2019").
const SCALE = anyOf("\\d{1,3}(?:[,.]\\d{3})+|(?!(?:19|20)\\d\\d(?!\\d))\\d{3,}|\\d+(?:\\.\\d+)?\\s?(?:k|m|million|thousand)|thousands|millions?|hundreds|tens of thousands|miles de|millones|cientos|centenares|milliers|centaines|milhares|milhões|centenas");
const MIGRANT = "migrants?|migrantes?";
const LOSS = "boats?|shipwreck|drown\\w*|dead|died|deaths|missing|capsiz\\w*|sinks?|sank|naufragio|naufragó|ahogad[oa]s|muert[oa]s|desaparecid[oa]s|pateras?|cayucos?|naufrage|noyés|morts|disparus|pirogues?|embarcations?|naufrágio|afogad[oa]s|mort[oa]s";
const CROSSING = new RegExp(`(?<![\\p{L}])(?:${MIGRANT})(?![\\p{L}]).*(?<![\\p{L}])(?:${LOSS})(?![\\p{L}])|(?<![\\p{L}])(?:${LOSS})(?![\\p{L}]).*(?<![\\p{L}])(?:${MIGRANT})(?![\\p{L}])`, "iu");
// Things that look like displacement but are not: bomb-threat and drill evacuations, house fires,
// medical evacuations of a few people, company names, procurement notices, and old-age homes ("asilo de ancianos").
const LOOKALIKE = [
  anyOf("bomb (?:threats?|hoax(?:es)?|alerts?|scares?)|hoax(?:es)?|amenazas? de bomba|alertes? à la bombe|ameaças? de bomba"),
  anyOf("(?:schools?|universit(?:y|ies)|airports?|malls?|stadiums?|offices?|courthouses?) (?:\\w+ ){0,2}evacuat\\w*|evacuat\\w* (?:\\w+ ){0,3}(?:schools?|airports?|malls?|stadiums?)"),
  anyOf("(?:escuelas?|colegios?|aeropuertos?|estadios?|écoles?|lycées?|aéroports?|stades?|escolas?|aeroportos?|estádios?) (?:\\S+ ){0,3}(?:evacu|évacu)\\S*|(?:evacu|évacu)\\S* (?:\\S+ ){0,4}(?:escuelas?|colegios?|aeropuertos?|estadios?|écoles?|lycées?|aéroports?|stades?|escolas?|aeroportos?|estádios?)"),
  anyOf("medical(?:ly)? evacuat\\w*|medevac\\w*|evacuación médica|évacuation sanitaire|evacuação médica|power evacuation|evacuation drill|simulacros?|simulados?|exercices? d['’]évacuation"),
  anyOf("displaced by (?:an? |the )?(?:\\w+ )?(?:fire|blaze)|(?:house|home|apartment|flat|building|residential|hotel|tenement|condo) (?:fire|blaze)|fire displaces"),
  anyOf("IDP Education|takeover bid|procurement|tender notice|asilos? (?:de|para) (?:ancianos|adultos mayores|mayores|la tercera edad|idosos|velhos|perros|animales|gatos)|asile psychiatrique"),
];

export const isDisplacement = (t) =>
  !LOOKALIKE.some((re) => re.test(t)) &&
  (CORE.test(t) ||
    (!NOT_FORCED.test(t) && (LOOSE.test(t) || LOOSE_OTHER.test(t) || (FLIGHT.test(t) && (CONFLICT.test(t) || (SCALE.test(t) && !FUGITIVE.test(t)))) || CROSSING.test(t))));

// Feeds have no GDELT tags to confirm the topic, so their headlines need a core term (or English "displaced").
export const isCoreDisplacement = (t) => !LOOKALIKE.some((re) => re.test(t)) && (CORE.test(t) || (LOOSE.test(t) && !NOT_FORCED.test(t)));

// ---------- GDELT's own topic tags ----------
// GDELT tags every article with themes from its full text. A headline must match the rules above AND the
// article must carry one of these refugee or displacement themes. In a hand-checked sample of GDELT's
// English files (16 Nov 2026), that raised the share of on-topic headlines from about 2 in 3 to 9 in 10.
// EVACUATION and the broad IMMIGRATION / MIGRATION_FEAR themes are left out: they are mostly noise.
export const DISPLACEMENT_THEMES = new Set([
  "REFUGEES", "DISPLACED", "SOC_FORCEDRELOCATION", "WB_740_FORCED_DISPLACEMENT", "WB_2489_POPULATION_DISPLACEMENT",
  "SOC_REFUGEECAMP", "SOC_POINTSOFINTEREST_REFUGEE_CAMP", "SOC_POINTSOFINTEREST_REFUGEE_CAMPS",
  "SOC_POINTSOFINTEREST_DISPLACED_PERSONS_CAMP", "SOC_POINTSOFINTEREST_DISPLACED_PERSONS_CAMPS",
  "SOC_POINTSOFINTEREST_DISPLACED_PERSON_CAMP", "SOC_POINTSOFINTEREST_DISPLACED_PERSON_CAMPS",
  "WB_2665_REFUGEE_RESETTLEMENT", "WB_1601_REFUGEE_SUPPORT", "SOC_MASSMIGRATION",
  "HUMAN_RIGHTS_ABUSES_FORCED_MIGRATION", "HUMAN_RIGHTS_ABUSES_FORCED_MIGRATIONS",
  "TAX_AIDGROUPS_HIGH_COMMISSIONER_FOR_REFUGEES", "TAX_AIDGROUPS_NORWEGIAN_REFUGEE_COUNCIL",
  "TAX_AIDGROUPS_DANISH_REFUGEE_COUNCIL", "TAX_AIDGROUPS_REFUGEES_INTERNATIONAL",
]);
// GKG "V1Themes" column: "THEME_A;THEME_B;…". Returns the displacement themes it carries.
export const displacementThemes = (v1Themes = "") => [...new Set(v1Themes.split(";").filter((t) => DISPLACEMENT_THEMES.has(t)))];

// GKG "TranslationInfo" column, e.g. "srclc:spa;eng:GT-SPA 1.0". Empty for English articles.
export const LANGUAGES = { eng: "en", spa: "es", fra: "fr", por: "pt" };
export const sourceLanguage = (info = "") => LANGUAGES[info.match(/srclc:(\w+)/)?.[1] || "eng"] || null;

// Profiles of one person, opinion and other sections a brief can't cite as reporting.
const PERSONAL = [
  /^['"‘“]?(she|he|they|i|we|my|our|his|her|their|meet)\b/i,
  /\b(she|he)('s| is| was| has| had)\b/i,
  /:\s*['"‘“]?(she|he|they|i|we)\s/i, // "'Betrayal': She fought…"
  /^from\b.+\bto\b/i,
  /\b(a|an|one)\s+(\w+\s)?(woman|man|mother|mom|father|dad|boy|girl|teen|teenager|student|nurse|family|couple|child|grandmother|grandfather|pastor)\b/i,
  /^([\p{L}'’-]+\s){0,2}(man|woman|boy|girl|teen|teenager|couple|grandmother|grandfather|pastor|activist|footballer|singer|rapper)\b/iu, // "Russian man swims…"
  /\b(his|her) (story|journey|life|family|wife|husband|son|daughter|mother|father|dream)\b/i,
  /\b(political asylum|asilo político|asile politique)\b/i, // nearly always one named person's case
  /(?<![\p{L}])(su|sus|mi|tu|son|sa|seu|sua|pide|pidió|solicita|solicitó|obtiene|recibe|concede|concedió|otorga|otorgó|demande|obtient|pede|pediu|recebe|concede) asil[oe](?![\p{L}])/iu,
];
const SECTION_TITLE = /^(opinion|editorial|podcast|letters?|column|commentary|live|watch|video|photos?|review|quiz)\b\s*[:|–-]/i;
const SECTION_URL = /\/(opinion|opinions|editorials?|letters?|obituar\w*|podcasts?|sports?|lifestyle|life-?style|entertainment|arts?|culture|food|travel|commentisfree|comment|blogs?|videos?|live|liveblog|live-news)\//i;
export const isPersonalOrOpinion = (title, url = "") =>
  PERSONAL.some((re) => re.test(title)) || SECTION_TITLE.test(title) || SECTION_URL.test(url);

// ---------- Which country is a headline about? ----------
export const escapeRe = (t) => t.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

// Extra names people and newsrooms use, including places that stand for a country's crisis.
export const ALIASES = {
  AFG: ["Afghanistan", "Afghan", "Afghans", "Kabul", "Taliban"],
  ARE: ["UAE", "Emirati"],
  BGD: ["Bangladesh", "Bangladeshi", "Cox's Bazar", "Cox’s Bazar"],
  CIV: ["Ivory Coast", "Côte d'Ivoire", "Cote d'Ivoire", "Côte d’Ivoire", "Ivorian"],
  COD: ["Democratic Republic of the Congo", "Democratic Republic of Congo", "DR Congo", "D.R. Congo", "DRC", "RDC", "RD Congo", "Congo-Kinshasa", "eastern Congo", "Goma", "North Kivu", "South Kivu", "Nord-Kivu", "Sud-Kivu", "Ituri", "Congo", "Congolese", "Congolais", "Congolaise", "République démocratique du Congo", "República Democrática del Congo", "República Democrática do Congo"],
  COG: ["Republic of the Congo", "Congo-Brazzaville", "Brazzaville", "République du Congo", "República del Congo"],
  CZE: ["Czech Republic", "Czechia"],
  DOM: ["Dominican Republic", "Dominican", "dominicano", "dominicana", "dominicanos", "dominicanas"],
  ETH: ["Ethiopia", "Ethiopian", "Tigray", "Tigrayan", "Amhara"],
  GBR: ["UK", "U.K.", "Britain", "British", "United Kingdom", "Irlanda del Norte", "Irlande du Nord", "Irlanda do Norte"],
  GEO: ["Georgia", "Georgian", "Tbilisi"],
  HTI: ["Haiti", "Haitian", "Port-au-Prince", "haitiano", "haitiana", "haitianos", "haitianas"],
  KOR: ["South Korea", "South Korean"],
  MMR: ["Myanmar", "Burma", "Burmese", "Rohingya", "Rakhine", "Birmania", "Birmânia", "birmano", "birmana", "rohinyá", "rohinyás"],
  MOZ: ["Mozambique", "Mozambican", "Cabo Delgado", "moçambicano", "moçambicanos"],
  NGA: ["Nigeria", "Nigerian", "Borno"],
  NLD: ["Netherlands", "Dutch", "Néerlandais", "Néerlandaise"], // "Dutch" is also the demonym of Bonaire, Sint Eustatius and Saba
  PRK: ["North Korea", "North Korean"],
  PSE: ["Gaza", "Gazan", "West Bank", "Palestine", "Palestinian", "Hebron", "Jenin", "Nablus", "Tulkarm", "Ramallah", "Rafah", "Khan Younis", "Cisjordania", "Cisjordanie", "Cisjordânia", "palestino", "palestina", "palestinos", "palestinas"],
  SDN: ["Sudan", "Sudanese", "Darfur", "Khartoum", "El Fasher", "Kordofan", "sudanés", "sudaneses", "Soudanais", "Soudanaise"],
  SOM: ["Somalia", "Somali", "Mogadishu"],
  SSD: ["South Sudan", "South Sudanese"],
  SYR: ["Syria", "Syrian", "Idlib", "Aleppo", "sirio", "siria", "sirios", "sirias", "sírio", "síria", "sírios", "sírias"],
  TUR: ["Turkey", "Türkiye", "Turkiye", "Turkish"],
  UKR: ["Ukraine", "Ukrainian", "Kyiv", "Kharkiv", "Donbas", "ucraniano", "ucraniana", "ucranianos", "ucranianas"],
  USA: ["United States", "U.S.", "US", "USA", "American", "EE.UU.", "EEUU", "EE. UU.", "EUA", "estadounidense", "estadounidenses", "norte-americano", "norte-americanos", "Américain", "Américaine", "Américains", "Américaines"],
  VEN: ["Venezuela", "Venezuelan", "venezolano", "venezolana", "venezolanos", "venezolanas", "venezuelano", "venezuelanos"],
  YEM: ["Yemen", "Yemeni", "Houthi"],
};
// Spanish and Portuguese demonyms (masculine, feminine), for countries with much displacement reporting
// in those languages. French demonyms come from the world-countries file. Plurals add "s" automatically.
const DEMONYMS_ES_PT = {
  AFG: ["afgano", "afgana", "afegão", "afegãos"], ARG: ["argentino", "argentina"], BOL: ["boliviano", "boliviana"],
  BRA: ["brasileño", "brasileña", "brasileiro", "brasileira"], CHL: ["chileno", "chilena"], COL: ["colombiano", "colombiana"],
  CRI: ["costarricense"], CUB: ["cubano", "cubana"], ECU: ["ecuatoriano", "ecuatoriana", "equatoriano"],
  GTM: ["guatemalteco", "guatemalteca"], HND: ["hondureño", "hondureña", "hondurenho"], MEX: ["mexicano", "mexicana"],
  NIC: ["nicaragüense", "nicaraguense"], PAN: ["panameño", "panameña"], PER: ["peruano", "peruana"],
  PRY: ["paraguayo", "paraguaya"], SLV: ["salvadoreño", "salvadoreña"], URY: ["uruguayo", "uruguaya"],
  AGO: ["angolano", "angolana"], RUS: ["ruso", "rusa"], LBN: ["libanés", "libaneses"], IRN: ["iraní", "iraníes"],
  IRQ: ["iraquí", "iraquíes", "iraquiano", "iraquiana"], SOM: ["somalí", "somalíes"], ERI: ["eritreo", "eritrea", "eritreia"],
  COD: ["congoleño", "congoleña", "congolês", "congoleses"], CAF: ["Centrafrique", "centroafricano", "centroafricana"],
  ETH: ["etíope", "etíopes"], YEM: ["yemení", "yemeníes"], LBY: ["libio", "libia"],
};
// Names that also belong to someone else. The same word is never filed under two countries.
const GUARDS = {
  Sudan: { before: ["South "], after: [" del Sur"] },
  Sudanese: { before: ["South "] },
  "Sudán": { after: [" del Sur"] },
  Soudan: { after: [" du Sud"] },
  Soudanais: { before: ["Sud-"] },
  Soudanaise: { before: ["Sud-"] },
  "Sudão": { after: [" do Sul"] },
  Guinea: { before: ["New ", "Equatorial ", "Papua New ", "Nueva ", "Papúa Nueva "], after: ["-Bissau", " Bissau", "-Bisáu", " Ecuatorial"] },
  Guinean: { before: ["Equatorial ", "Papua New ", "New "] },
  "Guinée": { before: ["Nouvelle-", "Papouasie-Nouvelle-"], after: ["-Bissau", " équatoriale"] },
  "Guinéen": { before: ["Équato-", "Bissau-"] },
  "Guinéenne": { before: ["Équato-", "Bissau-"] },
  "Guiné": { before: ["Nova "], after: ["-Bissau", " Equatorial"] },
  Niger: { before: ["delta du ", "Delta del "], after: [" Delta", "-Delta", " State", " River"] },
  "Níger": { before: ["Delta del "] },
  Korea: { before: ["North ", "South "] },
  Korean: { before: ["North ", "South "] },
  Ireland: { before: ["Northern "] },
  Irlanda: { after: [" del Norte", " do Norte"] },
  Irlande: { after: [" du Nord"] },
  American: { before: ["Latin ", "South ", "Central ", "North ", "African ", "Native ", "Asian ", "Arab "] },
  "Américain": { before: ["Latino-", "Sud-", "Nord-", "latino-", "sud-", "nord-"] },
  "Américaine": { before: ["Latino-", "Sud-", "Nord-", "latino-", "sud-", "nord-"] },
  British: { after: [" Columbia"] },
  Indian: { before: ["American ", "Native "], after: [" Ocean"] },
  Russian: { before: ["study ", "speak ", "learn ", "speaking ", "studying ", "learning "], after: [" language", " lessons", " classes"] }, // the language
  Congo: { before: ["Republic of the ", "Republic of ", "DR ", "D.R. ", "RD ", "Democratic Republic of the ", "Democratic Republic of ", "eastern ", "République démocratique du ", "République du ", "República Democrática del ", "República del ", "República Democrática do "], after: ["-Brazzaville", "-Kinshasa"] },
  Macedonian: { before: ["Greek "] },
};
// Shared demonyms go to the state that dominates displacement reporting.
// Keys are compared without accents, so "Americaine" follows "Américaine".
const SHARED_DEMONYM = {
  Congolese: "COD", Congolais: "COD", Congolaise: "COD", Dominican: "DOM", Neerlandais: "NLD", Neerlandaise: "NLD", Dutch: "NLD",
  Americain: "USA", Americaine: "USA", Americains: "USA", Americaines: "USA", Americano: "USA", Americana: "USA",
};
// Capitalized abbreviations that must match exactly ("US", not "us").
const CASE_SENSITIVE = new Set(["US", "USA", "UK", "UAE", "DRC", "RDC", "EUA", "U.S.", "U.K.", "EE.UU.", "EEUU", "EE. UU."]);
// Country names whose plural is another word ("Fort Frances", Air "Jordans", "Cartagena de Indias").
const NO_PLURAL = new Set(["France", "Chad", "Jordan", "Wales", "India"]);
// Translated names that are everyday words, first names or other places: "reunión" (meeting), "gana"
// (wins), "irão" (they will go), Granada (the Spanish city; "granadas" = grenades), Mauricio and
// Dominique (first names), Guadalupe and Santa Lucía (towns in Mexico), "chili", "grenade", Salvador
// (the Brazilian city), Georgie (accent-stripped Géorgie).
const SKIP_TRANSLATION = new Set([
  "Salvador", "Reunión", "Reunion", "Réunion", "Reunião", "Reuniao", "Gana", "Irão", "Irao", "Granada", "Grenade",
  "Mauricio", "Dominique", "Guadalupe", "Santa Lucía", "Santa Lucia", "Chili", "Georgie",
]);
// Headlines where a name means somewhere else.
const TITLE_EXCLUDE = {
  REU: /\b(family reunion|reunion visas?|reunification)\b|reuni[oó]n|reuni[aã]o|réunions? (d|de|du|des|sur|avec|entre)\b/i,
  GEO: /\b(Atlanta|Savannah|Augusta|Macon|Kemp|Fulton County|Georgia (State|Tech|Bulldogs|Power)|Georgia's (governor|legislature)|Ga\.)\b/i,
  JOR: /\b(Michael Jordan|Jordan River|Jordan Peterson|Air Jordan)\b/i,
  JAM: /\b(Jamaica Plain|Jamaica,? Queens|Jamaica,? N\.?Y\.?|Jamaica Bay)\b/i,
};
// Outlets for which a name usually means a place at home: Nigerian papers' "Niger" is Niger State.
const DOMAIN_EXCLUDE = {
  NER: /(^|\.)(punchng\.com|premiumtimesng\.com|dailytrust\.com|thecable\.ng|vanguardngr\.com|channelstv\.com|guardian\.ng|thisdaylive\.com|leadership\.ng|[a-z0-9-]+\.ng)$/i,
};
const MAX_COUNTRIES = 3; // more places than this: keep only where people fled from (see attributeCountries)

const stripAccents = (t) => t.normalize("NFD").replace(/\p{M}/gu, "");

// Guards also apply to a name written without accents ("Guinee"), in both spellings.
const PLAIN_GUARDS = Object.fromEntries(Object.entries(GUARDS).map(([k, g]) => [stripAccents(k), g]));
function pattern(term) {
  const g = GUARDS[term] || PLAIN_GUARDS[stripAccents(term)] || {};
  const both = (list = []) => [...new Set(list.flatMap((s) => [s, stripAccents(s)]))];
  const before = both(g.before).map((b) => `(?<!${escapeRe(b)})`).join("");
  const after = both(g.after).map((a) => `(?!${escapeRe(a)})`).join("");
  const plural = NO_PLURAL.has(term) ? `(?:['’]s)?` : `(?:s|['’]s)?`;
  return `(?<![\\p{L}\\p{N}])${before}${escapeRe(term)}${plural}${after}(?![\\p{L}\\p{N}])`;
}

// Builds one matcher per country from its names, the world-countries file and the aliases above, in
// English, Spanish, French and Portuguese.
export function buildMatchers(countries, worldCountries) {
  const wcBy = new Map(worldCountries.filter((w) => w.cca3 !== "UNK").map((w) => [w.cca3, w]));
  const taken = new Map(); // term → iso, so a word is never filed under two countries
  const terms = new Map();
  const add = (iso, t) => {
    if (!t) return;
    t = t.replace(/"/g, "").trim();
    if (t.length < 4 && !CASE_SENSITIVE.has(t)) return;
    if (/[(),]/.test(t) || SKIP_TRANSLATION.has(t)) return;
    const owner = SHARED_DEMONYM[stripAccents(t)];
    if (owner && owner !== iso) return;
    const key = t.toLowerCase();
    if (taken.has(key) && taken.get(key) !== iso) return;
    taken.set(key, iso);
    if (!terms.has(iso)) terms.set(iso, new Set());
    terms.get(iso).add(t);
  };
  // Aliases first, so they claim shared words before generic names do. Each also without accents,
  // since headlines often drop them ("sirios" for "sírios").
  for (const [iso, list] of Object.entries(ALIASES)) for (const t of list) { add(iso, t); add(iso, stripAccents(t)); }
  const places = countries.filter((c) => c.lat != null); // Unknown origin, Stateless, Tibetan: not places
  for (const c of places) {
    const w = wcBy.get(c.id);
    for (const t of [...(c.news || []), w?.name?.common, w?.demonyms?.eng?.m, w?.demonyms?.eng?.f]) add(c.id, t);
    if (!/\(|Rep\.|Dem\.|,/.test(c.name)) add(c.id, c.name); // UNHCR's name when it reads like everyday usage
  }
  // Then other languages, so an English name always wins a clash.
  for (const c of places) {
    const w = wcBy.get(c.id);
    const names = [w?.translations?.spa?.common, w?.translations?.fra?.common, w?.translations?.por?.common, w?.demonyms?.fra?.m, w?.demonyms?.fra?.f, ...(DEMONYMS_ES_PT[c.id] || [])];
    for (const t of names) { add(c.id, t); if (t) add(c.id, stripAccents(t)); }
  }
  const matchers = new Map();
  for (const [iso, set] of terms) {
    const all = [...set];
    const insensitive = all.filter((t) => !CASE_SENSITIVE.has(t)).map(pattern);
    const sensitive = all.filter((t) => CASE_SENSITIVE.has(t)).map(pattern);
    matchers.set(iso, {
      iso,
      terms: all,
      ci: insensitive.length ? new RegExp(insensitive.join("|"), "giu") : null,
      cs: sensitive.length ? new RegExp(sensitive.join("|"), "gu") : null,
      exclude: TITLE_EXCLUDE[iso] || null,
      excludeDomain: DOMAIN_EXCLUDE[iso] || null,
    });
  }
  return matchers;
}

// A country is tied to displaced people by a noun after its name ("Sudanese refugees"), a noun before it
// ("refugiados venezolanos", "réfugiés soudanais"), or a preposition before it ("fled Sudan", "en Colombia").
const DISPLACED_NOUNS = "refugees?|asylum(?:[- ]seekers?)?|migrants?|idps?|displaced|displacement|returnees?|civilians|families|people|residents|evacuees|children|women|exodus|influx|camps?|crisis|stateless|minorit(?:y|ies)|population|returns?|fle(?:e|es|eing|d)|forced|seek(?:s|ing)? asylum"
  + "|refugiad[oa]s?|desplazad[oa]s|migrantes|solicitantes de asilo|familias|personas|niños|éxodo|crisis"
  + "|réfugiés?|déplacés|demandeurs d['’]asile|familles|personnes|enfants|exode"
  + "|deslocad[oa]s|famílias|pessoas|crianças";
const NOUNS = new RegExp(`^(?:['’]s)?(?:[\\s,:;–-]+[\\p{L}'’-]+){0,3}?[\\s,:;–-]+['"‘“«]?(?:${DISPLACED_NOUNS})(?![\\p{L}])`, "iu");
const NOUNS_BEFORE = new RegExp(`(?<![\\p{L}])(?:refugiad[oa]s|desplazad[oa]s|migrantes|réfugiés|déplacés|migrants|deslocad[oa]s|exiliad[oa]s|exilés)(?:[\\s,]+[\\p{L}'’-]+){0,1}[\\s,]+$`, "iu");
const PREPS = new RegExp(`(?<![\\p{L}])(?:in|from|into|out of|inside|across|to|toward|towards|off|near|along|at|leave|leaving|left|flee|flees|fleeing|fled|returns? to|returning to|returned to|back to|within|of`
  + `|en|desde|hacia|huyen de|huyeron de|huir de|llegan a|regresan a|dans|depuis|vers|fuient|fuyant|fuir|au|aux|em|no|na|para|fogem de|fugindo de|deixam)\\s+(?:the\\s+|la\\s+|el\\s+|le\\s+|les\\s+|l['’]|o\\s+|a\\s+)?(?:[\\p{L}-]+\\s+)?$`, "iu");

function findMatches(m, title) {
  const out = [];
  for (const re of [m.ci, m.cs]) {
    if (!re) continue;
    re.lastIndex = 0;
    for (const hit of title.matchAll(re)) out.push({ start: hit.index, end: hit.index + hit[0].length });
  }
  return out;
}

const FLED_FROM = /(?<![\p{L}])(?:from|out of|flee|flees|fleeing|fled|leave|leaving|left|huyen de|huyeron de|huir de|desde|fuient|fuyant|fuir|depuis|fogem de|fugindo de|deixam)\s+(?:the\s+|la\s+|el\s+|le\s+|les\s+|l['’]|o\s+|a\s+)?(?:[\p{L}-]+\s+)?$/iu;

// Files a headline under the countries it is about. A country counts when the headline ties it to
// displaced people ("Sudanese refugees", "fled Sudan", "in Chad"). If no country is tied that way and
// exactly one country is named, it goes there. Otherwise it is not filed: a passing mention is not enough.
// When more than three countries are tied (a list of host countries), only the places people come from
// are kept ("Sudanese refugees…", "fled Sudan"); if none is clear, the first one named.
export function attributeCountries(title, matchers, { domain = "" } = {}) {
  const hits = [];
  for (const m of matchers.values()) {
    if (m.exclude && m.exclude.test(title)) continue;
    if (m.excludeDomain && m.excludeDomain.test(domain)) continue;
    const found = findMatches(m, title);
    if (!found.length) continue;
    const before = ({ start }) => title.slice(Math.max(0, start - 50), start);
    const origin = found.some((f) => NOUNS.test(title.slice(f.end, f.end + 80)) || NOUNS_BEFORE.test(before(f)) || FLED_FROM.test(before(f)));
    const strong = origin || found.some((f) => PREPS.test(before(f)));
    hits.push({ iso: m.iso, strong, origin, at: Math.min(...found.map((f) => f.start)) });
  }
  const strong = hits.filter((h) => h.strong).sort((a, b) => a.at - b.at);
  if (strong.length > MAX_COUNTRIES) {
    const origins = strong.filter((h) => h.origin);
    return (origins.length && origins.length <= MAX_COUNTRIES ? origins : strong.slice(0, 1)).map((h) => h.iso);
  }
  if (strong.length) return strong.map((h) => h.iso);
  return hits.length === 1 ? [hits[0].iso] : [];
}

// ---------- Duplicates ----------
// Drops a trailing " | Section | Outlet" or " – Outlet" so syndicated copies of one story compare equal.
export function cleanTitle(title) {
  const parts = title.split(/\s+[|–—]\s+|\s+-\s+(?=[^-]+$)/);
  const head = parts[0].trim();
  return head.split(/\s+/).length >= 4 ? head : title.trim();
}
export const normTitle = (t) => cleanTitle(t).toLowerCase().normalize("NFKD").replace(/\p{M}/gu, "").replace(/[^a-z0-9]+/g, " ").trim().slice(0, 80);

export function dedupe(items) {
  const seen = new Map();
  for (const a of items) {
    const k = normTitle(a.title);
    const prev = seen.get(k);
    // Keep the copy with a verified link and summary, then the earliest.
    const score = (x) => (x.link === "verified" ? 2 : 0) + (x.description ? 1 : 0);
    if (!prev || score(a) > score(prev) || (score(a) === score(prev) && (a.date || "") < (prev.date || ""))) seen.set(k, a);
  }
  return [...seen.values()];
}

// One event reported by many outlets ("At least 139 migrants dead after boat capsizes", in seven papers)
// takes one slot, not all eight. Headlines about the same country within a few days are one story when
// they share at least three words and 60% of the shorter headline, not counting words every story about
// that country shares (its names, "refugees", "displaced"…). The best-documented copy is shown.
const TIER_RANK = { wire: 5, broadcaster: 4, humanitarian: 4, newspaper: 3, specialist: 3, regional: 2 };
const docScore = (a) => (a.link === "verified" ? 8 : 0) + (a.description ? 4 : 0) + (TIER_RANK[a.tier] || (a.basis === "wikipedia" ? 3 : 1)) + (a.lang === "en" || !a.lang ? 0.5 : 0);
const GENERIC = new Set(("refugee refugees displaced displacement migrants migrant asylum seekers idps idp people thousands hundreds flee fled fleeing"
  + " camp camps crisis returnees return returns civilians families children war fighting violence says warns new"
  + " refugiados refugiadas desplazados desplazadas migrantes miles personas huyen crisis refugies deplaces milliers personnes deslocados pessoas milhares").split(" "));
const eventWords = (t, ignore) => new Set([...words(t)].filter((w) => !GENERIC.has(w) && !ignore.has(w)));
function sameEvent(a, b, ignore, days) {
  const dayOf = (x) => Date.parse(x.date || x.seen || "") / 86400000;
  const da = dayOf(a), db = dayOf(b);
  if (!Number.isNaN(da) && !Number.isNaN(db) && Math.abs(da - db) > days) return false;
  const A = eventWords(a.title, ignore), B = eventWords(b.title, ignore);
  let n = 0;
  for (const w of A) if (B.has(w)) n++;
  return n >= 3 && n / Math.max(1, Math.min(A.size, B.size)) >= 0.6;
}
// Groups items into events; each group lists its copies best-documented first. `ignore` holds words to
// leave out of the comparison, such as the names of the country the list is for.
export function eventGroups(items, { days = 3, ignore = [] } = {}) {
  const skip = new Set([...ignore].map((t) => normTitle(t)).flatMap((t) => t.split(" ")).filter(Boolean));
  const ranked = [...items].sort((x, y) => docScore(y) - docScore(x) || (x.date || "").localeCompare(y.date || ""));
  const groups = [];
  for (const a of ranked) {
    const g = groups.find((g) => sameEvent(a, g[0], skip, days));
    if (g) g.push(a); else groups.push([a]);
  }
  return groups;
}
export const clusterEvents = (items, opts) => eventGroups(items, opts).map((g) => g[0]);

// Picks what a country's panel shows: newest first, one copy per event, at most `perOutlet` from one
// outlet (counted by outlet, so bbc.com and bbc.co.uk are one) so a single outlet can't fill the list,
// and at most `max` in all. If an event's best copy is from an outlet that is already full, another
// outlet's copy is used.
export function pickForCountry(items, { max = 8, perOutlet = 3, ignore = [] } = {}) {
  const byOutlet = new Map();
  const key = (a) => a.outlet || a.domain;
  const out = [];
  const groups = eventGroups(items, { ignore }).sort((x, y) => (y[0].date || "").localeCompare(x[0].date || ""));
  for (const g of groups) {
    const a = g.find((x) => (byOutlet.get(key(x)) || 0) < perOutlet);
    if (!a) continue;
    byOutlet.set(key(a), (byOutlet.get(key(a)) || 0) + 1);
    out.push(a);
    if (out.length >= max) break;
  }
  return out;
}

// ---------- Which outlets count ----------
// An outlet counts if it (or a parent domain: edition.cnn.com → cnn.com) is on the hand-picked list in
// data/outlets.json, or Wikipedia's Perennial Sources list rates it generally reliable, or it is a UN or
// intergovernmental body. Blocked domains (aggregators, tabloids, trade press) never count, and neither
// do outlets Wikipedia rates generally unreliable, deprecated or blacklisted, even if hand-picked.
// `sources` is data/processed/news-sources.json; `curated` is data/outlets.json.
const NEVER = /generally unreliable|deprecated|blacklisted/i;
export function makeOutletChecker(sources, curated) {
  const clean = (s) => (s ? s.replace(/\s*\(.*?\)\s*/g, " ").trim() : null);
  return (domain) => {
    const d = (domain || "").toLowerCase().replace(/^www\./, "");
    const parts = d.split(".");
    for (let i = 0; i < parts.length - 1; i++) {
      const c = parts.slice(i).join(".");
      if (curated.block?.[c]) return null;
      const ex = sources.excluded?.[c];
      if (ex && NEVER.test(ex)) return null;
      const pick = curated.allow?.[c];
      if (pick) return { basis: "curated", tier: pick.tier, name: pick.name || null, lang: pick.lang || null };
      if (ex) return null; // no consensus, or reliable only for some sections, and not hand-picked
      const rated = sources.allowed?.[c];
      if (rated?.basis?.includes("wikipedia")) return { basis: "wikipedia", tier: null, name: clean(rated.name), lang: null };
    }
    const ig = sources.intergovernmental || { suffixes: [], domains: [] };
    if (ig.suffixes.some((s) => d.endsWith(s)) || ig.domains.some((x) => d === x || d.endsWith("." + x))) return { basis: "intergovernmental", tier: "humanitarian", name: null, lang: null };
    return null;
  };
}

// ---------- Publisher pages: summary, date, working link ----------
const decodeEntities = (s) =>
  s.replace(/&#x([0-9a-f]+);/gi, (_, h) => String.fromCodePoint(parseInt(h, 16)))
    .replace(/&#(\d+);/g, (_, n) => String.fromCodePoint(+n))
    .replace(/&quot;/g, '"').replace(/&apos;|&#39;/g, "'").replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&nbsp;/g, " ").replace(/&amp;/g, "&")
    .replace(/\s+/g, " ").trim();

export function parseArticleMeta(html) {
  const meta = {};
  for (const tag of html.matchAll(/<meta\b[^>]*>/gi)) {
    const attr = (n) => tag[0].match(new RegExp(`\\b${n}\\s*=\\s*("([^"]*)"|'([^']*)')`, "i"));
    const keyM = attr("property") || attr("name") || attr("itemprop");
    const valM = attr("content");
    if (!keyM || !valM) continue;
    const key = (keyM[2] ?? keyM[3]).toLowerCase();
    if (!(key in meta)) meta[key] = decodeEntities(valM[2] ?? valM[3]);
  }
  let ldDate = null, ldHeadline = null;
  for (const s of html.matchAll(/<script[^>]+application\/ld\+json[^>]*>([\s\S]*?)<\/script>/gi)) {
    try {
      const walk = (o) => {
        if (!o || typeof o !== "object") return;
        if (Array.isArray(o)) return o.forEach(walk);
        if (!ldDate && typeof o.datePublished === "string") ldDate = o.datePublished;
        if (!ldHeadline && typeof o.headline === "string") ldHeadline = o.headline;
        if (o["@graph"]) walk(o["@graph"]);
      };
      walk(JSON.parse(s[1].trim()));
    } catch { /* malformed JSON-LD is common; ignore it */ }
  }
  const titleTag = html.match(/<title[^>]*>([\s\S]*?)<\/title>/i)?.[1];
  return {
    title: meta["og:title"] || meta["twitter:title"] || (ldHeadline && decodeEntities(ldHeadline)) || (titleTag && decodeEntities(titleTag)) || null,
    description: meta["og:description"] || meta["description"] || meta["twitter:description"] || null,
    siteName: meta["og:site_name"] || null,
    published: meta["article:published_time"] || ldDate || meta["datepublished"] || meta["pubdate"] || meta["parsely-pub-date"] || meta["sailthru.date"] || meta["dc.date.issued"] || meta["date"] || null,
  };
}

export function summarize(text, title = "", max = 220) {
  if (!text) return null;
  const t = decodeEntities(text);
  if (t.length < 40 || normTitle(t) === normTitle(title)) return null;
  if (t.length <= max) return t;
  return t.slice(0, max).replace(/\s+\S*$/, "") + "…";
}

const STOP = new Set(("a an the of to in on for and or with by at from as is are was were be after over into amid says said"
  + " los las del que una por con para sus tras ante les des aux pour sur dans est une par das dos com uma pelo pela").split(" "));
const words = (t) => new Set(normTitle(t).split(" ").filter((w) => w.length > 2 && !STOP.has(w)));
export function titleOverlap(a, b) {
  const A = words(a), B = words(b);
  if (!A.size || !B.size) return 0;
  let n = 0;
  for (const w of A) if (B.has(w)) n++;
  return n / Math.min(A.size, B.size);
}

export const USER_AGENT = "Mozilla/5.0 (compatible; displacement-change-monitor/1.0; +https://github.com/davidkleinrock-bot/displacement-change-monitor)";

// Opens the article. "broken": the page is gone (404/410). "mismatched": the link lands on a different
// story or the homepage. "unverified": the site blocked us, timed out or failed; the link is kept but
// marked. "verified": the page loaded and matches the headline.
export async function fetchArticleMeta(url, title, { fetchImpl = fetch, timeoutMs = 12000 } = {}) {
  let res;
  try {
    res = await fetchImpl(url, { redirect: "follow", headers: { "User-Agent": USER_AGENT, Accept: "text/html" }, signal: AbortSignal.timeout(timeoutMs) });
  } catch (err) {
    return { link: "unverified", reason: err.name === "TimeoutError" ? "timeout" : "network error" };
  }
  if (res.status === 404 || res.status === 410) return { link: "broken", reason: `HTTP ${res.status}` };
  if (!res.ok) return { link: "unverified", reason: `HTTP ${res.status}` };
  let html = "";
  try { html = (await res.text()).slice(0, 600000); } catch { return { link: "unverified", reason: "unreadable page" }; }
  try {
    const finalPath = new URL(res.url || url).pathname;
    if ((finalPath === "/" || finalPath === "") && new URL(url).pathname.length > 1) return { link: "mismatched", reason: "redirected to the homepage" };
  } catch { /* keep going */ }
  const meta = parseArticleMeta(html);
  if (meta.title && titleOverlap(meta.title, title) < 0.3) return { link: "mismatched", reason: "page headline does not match", pageTitle: meta.title };
  return { link: "verified", meta };
}

// ---------- GDELT files ----------
export async function downloadFile(url, { fetchImpl = fetch, tries = 3, pauseMs = 3000 } = {}) {
  for (let attempt = 1; attempt <= tries; attempt++) {
    try {
      const res = await fetchImpl(url, { signal: AbortSignal.timeout(60000) });
      if (res.status === 404) return null; // GDELT occasionally skips a 15-minute slot
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      return Buffer.from(await res.arrayBuffer());
    } catch (err) {
      if (attempt === tries) throw err;
      await new Promise((r) => setTimeout(r, pauseMs * attempt));
    }
  }
}

// What the page should say for a country, given the news file (or its absence).
export function newsState(news, iso) {
  if (!news) return { state: "not-loaded", message: "News could not be loaded." };
  if (!(news.searched || []).includes(iso)) return { state: "not-searched", message: "News is not searched for this row." };
  const items = news.byCountry?.[iso] || [];
  if (items.length) return { state: "found", items };
  return { state: "none", message: "No relevant news found in the selected period." };
}
