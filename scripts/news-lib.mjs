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

// ---------- Arabic and Russian spelling ----------
// Arabic and Russian headlines are compared after removing spelling variation, so each rule and name is
// written once: Arabic short vowels and other marks (tashkeel), tatweel (ـ) and Quranic signs are dropped;
// أ إ آ ٱ → ا, ى → ي, ة → ه, Persian ی ک → ي ك; Arabic-Indic digits → 0-9; Russian ё → е. Latin text is
// returned unchanged, and every rule and name in this file passes through the same function.
const HAS_AR = /[\u0600-\u06FF]/;
const HAS_RU = /[\u0400-\u04FF]/;
const SCRIPT_MAP = { "أ": "ا", "إ": "ا", "آ": "ا", "ٱ": "ا", "ى": "ي", "ی": "ي", "ة": "ه", "ک": "ك", "ё": "е", "Ё": "Е", "٬": ",", "٫": "." };
export function normScript(t = "") {
  if (!HAS_AR.test(t) && !HAS_RU.test(t)) return t;
  return t.replace(/[\u0610-\u061A\u064B-\u065F\u0670\u06D6-\u06ED\u0640]/g, "")
    .replace(/[أإآٱىیةکёЁ٬٫]/g, (c) => SCRIPT_MAP[c])
    .replace(/[\u0660-\u0669\u06F0-\u06F9]/g, (d) => String((d.charCodeAt(0) - 0x660) % 0x90));
}

// ---------- Is this headline about forced displacement? ----------
// Headlines are read in English, Spanish, French, Portuguese, Arabic and Russian. Core terms count on their
// own. "Fled", "evacuated" and similar count only with a conflict word or a sense of scale, so wildfire
// evacuations and suspects "fleeing" are left out. Deadly or mass migrant crossings count. Job
// "displacement", emigration of the wealthy, bomb-threat evacuations, house fires and medical evacuations do not.
// Word edges are written as letter lookarounds, because \b treats accented, Arabic and Cyrillic letters as non-letters.
const anyOf = (body) => new RegExp(`(?<![\\p{L}\\p{N}])(?:${normScript(body)})(?![\\p{L}\\p{N}])`, "iu");
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
const FUGITIVE = anyOf("fugitives?|extradit\\w*|arrested|manhunt|jailbreak|suspects?|escaped (?:from )?(?:prison|jail|custody)|prófugos?|fugitifs?|polic(?:e|ías?|iais)|manhunts?|cazar|matar|reos|presos|reclusos|detenidos|détenus|prisonniers|detentos|cárcel|prisión|presídio|prisons?|jails?");
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
const crossing = (migrant, loss) => {
  const [m, l] = [normScript(migrant), normScript(loss)];
  return new RegExp(`(?<![\\p{L}])(?:${m})(?![\\p{L}]).*(?<![\\p{L}])(?:${l})(?![\\p{L}])|(?<![\\p{L}])(?:${l})(?![\\p{L}]).*(?<![\\p{L}])(?:${m})(?![\\p{L}])`, "iu");
};
const CROSSING = crossing(MIGRANT, LOSS);
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
const NO_MATCH = /$^/; // a rule a language doesn't have
const LATIN = { CORE, LOOSE, LOOSE_OTHER, NOT_FORCED, FUGITIVE, FLIGHT, CONFLICT, SCALE, CROSSING, LOOKALIKE, SOFT: [] };

// Arabic. Words take clitics in front: و/ف "and", ب/ل/ك "in, for, like", the article ال, and ل + ال → لل.
// A is that prefix. Rules are written in the normalized spelling (see normScript).
const A = "[وف]?(?:[بك]?ال|لل|[بلك])?";
const AR_CULTURE = `${A}(?:فيلم|افلام|مسلسل|روايه|مسرحيه|كتاب|اغنيه|معرض|مهرجان|سينما|اوسكار)`;
const AR_TOPIC = "(?:لاج|نزوح|نازح|مهجر|لجوء)";
const AR = {
  // لاجئ refugee, نازح displaced person, نزوح displacement, مهجرين forcibly displaced (the singular المهجر is
  // "the diaspora"), تهجير forced displacement, طالبي اللجوء asylum seekers, عديمي الجنسية stateless. Bare
  // لجوء also means "resorting to" (اللجوء إلى القوة), so on its own it counts only with GDELT's tags.
  CORE: anyOf(`${A}لاج(?:ئ|يء|ء)(?:ين|ون|ات|ه|ا|ي|و|يها|يهم)?|${A}نازح(?:ين|ون|ات|ه|ا|ي|و|يها|يهم)?|${A}نزوح|${A}مهجر(?:ين|ون)|${A}تهجير|${A}هجره ${A}قسريه`
    + `|طالب(?:ي|و|ات)? ${A}لجوء|(?:طلبات|ملفات|حق|نظام|قانون|قوانين|سياسه|سياسات|اجراءات|مراكز|مركز|بلدان|دول|بلد) ${A}لجوء|(?:عديم|عديمي|عديمو) ${A}جنسيه|${A}انعدام ${A}جنسيه`),
  LOOSE: NO_MATCH,
  LOOSE_OTHER: anyOf(`${A}لجوء(?!(?:\\s+\\S+){0,2}\\s+(?:الي|ل))|${A}طلب ${A}لجوء`),
  // Evacuating diplomats, nationals (رعايا) or crews, and capital, investors or players "fleeing".
  NOT_FORCED: anyOf(`${A}(?:رعايا|رعاياها|رعاياه|مواطنيها|مواطنيه|دبلوماسيين|دبلوماسي|دبلوماسيه|سفاره|سفارات|بعثه|موظفي|موظفين|طاقم|سياح|سائحين|مستثمرين|استثمارات|اموال|ثروات|اثرياء|اغنياء|مليونيرات|مليارديرات|ضرائب|شركات|وظائف|لاعبين|لاعب|مشجعين|جماهير|بحاره|بحارا|طواقم|جنود|مقاتلين|مقاتلي|عناصر|ضباط)|رؤوس|رووس|راس المال`),
  FUGITIVE: anyOf(`${A}(?:سجن|سجون|سجناء|مساجين|سجين|سجينا|شرطه|متهم|متهمين|مطلوب|مطلوبين|قبض|اعتقال|معتقلين|هارب|عداله|لصوص|مجرمين)`),
  // fled, fleeing, were displaced, evacuation of places (إخلاء) and of people (إجلاء), made homeless (تشريد)
  FLIGHT: anyOf(`[وف]?(?:نزح(?:وا|ت|ن)?|ينزح(?:ون)?|تنزح|يفرون|هربوا|يهربون|اجلي|اجلت|تجلي|يجلي|شرد(?:ت|وا)?|يشرد|تشرد|يشردون)|فر(?:وا|ت)|${A}فرار|فرارا|${A}فارين|هربا|${A}هاربين|${A}اخلاء|${A}اجلاء|${A}تشريد|${A}مشرد(?:ين|ون)`),
  CONFLICT: anyOf(`${A}(?:حرب|حروب|قتال|معارك|معركه|اشتباكات|اشتباك|عنف|هجوم|هجمات|قصف|غارات|غاره|ضربات|قوات|جيش|ميليشيا|ميليشيات|مليشيا|مليشيات|متمردين|مسلحين|مسلحون|عصابات|حصار|مجاعه|مجزره|مجازر|اباده|اضطهاد|احتلال|عدوان|توغل|توغلات|اجتياح|تصعيد|صراع|نزاع|اعتداءات|مستوطنين|ارهاب|ارهابيين|مسيرات|صواريخ|قذائف|تفجيرات|عمليات عسكريه|عمليه عسكريه|دعم السريع|جماعات مسلحه|مدنيين)`),
  SCALE: anyOf(`\\d{1,3}(?:[,.]\\d{3})+|(?!(?:19|20)\\d\\d(?!\\d))\\d{3,}|\\d+(?:[.,]\\d+)?\\s?(?:${A}الف|${A}الاف|مليون|ملايين)|${A}الاف|${A}مئات|${A}ملايين|عشرات ${A}الاف`),
  CROSSING: crossing(`${A}مهاجر(?:ين|ون|ات|ه|ا)?|${A}هجره غير (?:الشرعيه|شرعيه|النظاميه|نظاميه)`,
    `${A}(?:قارب|قوارب|مركب|مراكب|زورق|زوارق|غرق|غرقا|غرقي|حطام|جثث|جثه|مفقودين|مفقودون)|غرق|غرقا|مصرع|مقتل|انقلاب|قباله ${A}(?:سواحل|ساحل)`),
  LOOKALIKE: [
    // capital, brain and fan "flight" (نزوح رؤوس الأموال); release from custody (إخلاء سبيل), disclaimers; medical evacuations
    anyOf(`${A}نزوح (?:\\S+ ){0,2}(?:${A}(?:اموال|استثمارات|مستثمرين|ودائع|سيوله|شركات|عقول|كفاءات|ادمغه|اطباء|لاعبين|نجوم|مشجعين|جماهير|سياح|طيور|عملاء|مستخدمين|مشتركين|مشاهدين|ناخبين|مليار|مليارات|دولار|دولارات|صناديق|سندات|اسهم|عملات)|رؤوس|رووس|راس)`),
    anyOf(`${A}اخلاء ${A}(?:سبيل|مسؤوليه|مسئوليه|طرف)|${A}(?:اخلاء|اجلاء) ${A}طبي|${A}(?:اخلاء|اجلاء) ${A}(?:مرضي|جرحي|مصابين)`),
    // bomb threats and hoaxes, evacuation drills, pumping out water (نزح المياه)
    anyOf(`${A}(?:تهديد|تهديدات|بلاغ|بلاغات|انذار)(?: \\S+){0,2} ${A}(?:قنبله|قنابل|متفجرات)|بوجود ${A}(?:قنبله|قنابل|متفجرات)|${A}(?:جهاز|جسم) (?:غامض|غريب|مشبوه)|${A}بلاغ كاذب|${A}بلاغات كاذبه|${A}(?:قنبله|عبوه) (?:وهميه|مشبوهه)|${A}(?:جسم|طرد|حقيبه) مشبوه`),
    anyOf(`${A}(?:تجربه|تمرين|مناوره|محاكاه)(?: \\S+){0,2} ${A}(?:اخلاء|اجلاء)|${A}(?:اخلاء|اجلاء) ${A}(?:تجريبي|وهمي|افتراضي)|(?:نزح|ونزح|شفط|وشفط) ${A}(?:مياه|امطار|صرف|برك|رمال)`),
    // a film, series, book or song whose quoted title has a displacement word
    anyOf(`^['"«“]?${AR_CULTURE}(?![\\p{L}])|${AR_CULTURE}(?![\\p{L}]).*[«"“][^»"”]{0,60}${AR_TOPIC}|[«"“][^»"”]{0,60}${AR_TOPIC}[^»"”]{0,60}[»"”].*${AR_CULTURE}`),
  ],
  // Only against evacuation and flight words, not core terms: buildings, aircraft and ships evacuated, the sick
  // and wounded taken out for treatment, building fires.
  SOFT: [
    anyOf(`${A}(?:اخلاء|اجلاء)(?: \\S+){0,3} ${A}(?:مبني|مباني|مدرسه|مدارس|مؤسسه تعليميه|مؤسسات تعليميه|جامعه|مطار|فندق|سفاره|ملعب|مول|برج|محطه|قطار|طائره|سفينه|ناقله|منصه|مصنع|مجمع|منشاه|مستشفي)|${A}(?:مبني|مدرسه|مطار|فندق|ملعب|مول|برج|محطه|طائره|سفينه|ناقله)(?: \\S+){0,2} ${A}(?:اخلاء|اجلاء)`),
    anyOf(`(?:${A}(?:اخلاء|اجلاء)|اجلي|اجلت|تجلي|يجلي).*${A}(?:علاج|مرضي|مريض|جرحي|مصابين|طبي|طبيه)\\p{L}*`),
    anyOf(`${A}حريق(?: \\S+){0,3} ${A}(?:منزل|مبني|عماره|شقه|فندق|برج|مصنع|مستودع|سوق)`),
  ],
};

// Russian. Words change their endings with case, so stems take any ending (R).
const R = "[а-яё]*";
const RU_CULTURE = `(?:фильм|сериал|спектакл|роман|книг|песн|альбом|клип|выставк|премьер|постановк|режисс|кинофестивал|театр|оскар)${R}`;
const RU_TOPIC = "(?:беж|переселен|изгнан|эвакуа|убежищ)";
const RU = {
  // беженцы refugees; вынужденные переселенцы and внутренне перемещённые лица (ВПЛ) are the official terms for
  // displaced people. Bare переселенцы also means voluntary or historical settlers, and bare убежище also means
  // a shelter ("took cover in a shelter"; бомбоубежище), so they count only with a conflict word, a sense of
  // scale or GDELT's tags, or in asylum phrases (просители убежища).
  CORE: anyOf(`беженц(?:ы|ев|ам|ами|ах|а|у|ем|е)?|беженец|беженк(?:а|и|е|у|ой|ам|ами|ах)|беженок|беженск${R}`
    + `|вынужденн${R} переселенц${R}|внутренне перемещенн${R}|перемещенн${R} (?:лиц|лица|лицам|лицами|людей|граждан)|ВПЛ`
    + `|(?:просител|соискател|ищущ)${R} (?:политического |временного )?убежищ${R}|(?:заявк|заявлени|ходатайств|прошени)${R} (?:на|о|об) (?:предоставлени${R} |получени${R} )?убежищ${R}`
    + `|лиц${R} без гражданства|апатрид${R}`),
  LOOSE: NO_MATCH,
  LOOSE_OTHER: anyOf(`отказ${R} в (?:предоставлении )?убежищ${R}|(?:временн|предоставлени|получени)${R} убежищ${R}|прав${R} на убежищ${R}|(?:систем|политик)(?:а|ы|е|у|ой)? (?:предоставления )?убежищ${R}`),
  // Evacuating diplomats, staff, crews or tourists; companies, capital or fans "fleeing"; compatriots resettling.
  NOT_FORCED: anyOf(`дипломат${R}|посольств${R}|консульств${R}|турист${R}|инвестор${R}|капитал${R}|вклад${R}|бизнес${R}|компани${R}|бренд${R}|миллионер${R}|миллиардер${R}|олигарх${R}|богач${R}|налог${R}|болельщик${R}|фанат${R}|зрител${R}|игрок${R}|экипаж${R}|персонал${R}|сотрудник${R}|спецборт${R}|авиарейс${R}|рейс${R}|соотечественник${R}|релокант${R}|айтишник${R}|боевик${R}|солдат${R}|бойц${R}|наемник${R}|военнослужащ${R}|позици${R}|оборон${R}|котел|котле|котла|штурмовик${R}|мобилиз${R}`),
  FUGITIVE: anyOf(`обвинени${R}|госизмен${R}|уголовн${R}|заключенн${R}|осужденн${R}|тюрьм${R}|колони${R}|СИЗО|подозреваем${R}|задержан${R}|арестован${R}|полици${R}|розыск${R}|преступник${R}|беглец${R}|экстрадиц${R}|экстрадир${R}`),
  FLIGHT: anyOf(`бежал${R}|бегут|бежать|бегств${R}|эвакуац${R}|эвакуир${R}|переселенц${R}|переселени${R}|спаса(?:ясь|ются|лись) от (?:войн|обстрел|бомбеж|бомбардир|боев|насили|оккупац|голод|преследовани)${R}|изгнан${R}|вынужден${R} (?:покинуть|бежать|уехать|оставить)`
    + `|(?:покинул|покида)${R} (?:сво${R} )?(?:дом|жиль|город|сел|регион|стран|област|район|родин)${R}|лишились (?:крова|жилья|домов)|без крова`),
  CONFLICT: anyOf(`войн${R}|боев${R}|бои|боя|обстрел${R}|бомбардировк${R}|бомбежк${R}|авиаудар${R}|удар${R} (?:дрон|беспилотн|ракет|ВСУ|арми)${R}|атак${R}|наступлени${R}|оккупац${R}|оккупир${R}|насили${R}|конфликт${R}|столкновени${R}|осад${R}|голод|голода|резн${R}|геноцид${R}|преследовани${R}|войск${R}|арми(?:я|и|ей|ю)|боевик${R}|повстанц${R}|банд(?:а|ы|ам|ами|ах|ой)?|ракет${R}|дрон${R}|беспилотник${R}|БПЛА|ВСУ|артиллер${R}|теракт${R}|вторжени${R}|фронт${R}|прифронтов${R}|приграничь${R}|приграничн${R}|джихадист${R}|террорист${R}|исламист${R}|мирн${R} (?:жител|граждан|населени)${R}`),
  SCALE: anyOf(`\\d{1,3}(?:[,.\\s\\u00a0\\u202f]\\d{3})+|(?!(?:19|20)\\d\\d(?!\\d))\\d{3,}|\\d+(?:[.,]\\d+)?\\s?(?:тыс\\.?|тысяч${R}|млн|миллион${R})|тысяч${R}|сотни|сотен|сотням|сотнями|миллион${R}|десятк${R} тысяч`),
  CROSSING: crossing(`мигрант${R}|нелегал${R}`, `лодк${R}|лодок|судн${R}|катер${R}|шлюпк${R}|крушени${R}|кораблекрушени${R}|затонул${R}|утонул${R}|утонувш${R}|перевернул${R}`),
  LOOKALIKE: [
    // bomb threats and hoaxes, medical evacuations, drills
    anyOf(`минировани${R}|заминирова${R}|угроз${R} (?:взрыва|теракта|минирования)|ложн${R} (?:сообщени|звон|вызов)${R}|сообщени${R} о (?:бомб|взрывн)${R}|подозрительн${R} (?:предмет|сумк|пакет|коробк)${R}|бесхозн${R} (?:предмет|сумк|пакет)${R}`),
    anyOf(`медицинск${R} эвакуац${R}|медэвакуац${R}|санавиаци${R}|санитарн${R} (?:авиаци|рейс|борт)${R}|эвакуац${R} (?:раненых|больных|пациентов)`),
    anyOf(`учебн${R} эвакуац${R}|тренировочн${R} эвакуац${R}|эвакуац${R} (?:\\S+ ){0,2}(?:в рамках|в ходе) (?:учени|тренировк)${R}|(?:учени|тренировк)${R} по эвакуац${R}|объектов${R} тренировк${R}`),
    // a film, series, book or song whose quoted title has a displacement word
    anyOf(`^['"«“„]?${RU_CULTURE}(?![а-я])|${RU_CULTURE}.*[«"„“][^»"“”]{0,60}${RU_TOPIC}|[«"„“][^»"“”]{0,60}${RU_TOPIC}[^»"“”]{0,60}[»"“”].*${RU_CULTURE}`),
  ],
  // Only against evacuation and flight words: schools, shops, stations, concerts and other buildings evacuated,
  // building fires and gas leaks.
  SOFT: [
    anyOf(`(?:эвакуир|эвакуац)${R}(?: \\S+){0,3} (?:школ(?:а|ы|е|у|ой|ах|ам|ами)?|гимнази|лице|ТЦ|торгов|аэропорт|вокзал|суд|офис|стадион|университет|вуз|колледж|детск|метро|бизнес-центр|кинотеатр|театр|концерт|здани|больниц|поликлиник|гостиниц|отел|поезд|самолет|судн|корабл|танкер|завод|учреждени|администраци|МФЦ)${R}`
      + `|(?:школ(?:а|ы|е|у|ой|ах|ам|ами)?|гимнази|лице|ТЦ|торгов|аэропорт|вокзал|суд|офис|стадион|университет|вуз|колледж|метро|бизнес-центр|кинотеатр|театр|здани|больниц|гостиниц|отел|поезд|самолет)${R}(?: \\S+){0,3} (?:эвакуир|эвакуац)${R}`
      + `|(?:выступлени|концерт|спектакл|матч|показ|шоу)${R}.*(?:эвакуир|эвакуац)${R}`
      + `|(?:эвакуир|эвакуац)${R}.*(?:ранен|больн|пациент)${R}|(?:ранен|больн|пациент)${R}.*(?:эвакуир|эвакуац)${R}`), // the wounded and sick
    anyOf(`(?:пожар|возгорани|задымлени)${R}(?: \\S+){0,3} (?:дом|многоэтажк|общежити|жил|гостиниц|подъезд|квартир|здани|больниц|школ|ТЦ|торгов|завод|склад|цех|кафе|ресторан)${R}|из горящ${R}|задымлени${R}|(?:утечк|взрыв)${R} газа|обрушени${R}`),
  ],
};
// Each headline is read with the rules of its script: Arabic, Cyrillic, or Latin (the four Latin-script languages).
const rulesFor = (t) => (HAS_AR.test(t) ? AR : HAS_RU.test(t) ? RU : LATIN);

export function isDisplacement(title) {
  const t = normScript(title), r = rulesFor(t);
  const core = r.CORE.test(t), flight = r.FLIGHT.test(t);
  // Most headlines carry no topic word at all; they are settled before the slower look-alike checks.
  if (!core && !flight && !r.LOOSE.test(t) && !r.LOOSE_OTHER.test(t) && !r.CROSSING.test(t)) return false;
  if (r.LOOKALIKE.some((re) => re.test(t))) return false;
  if (core) return true;
  if (r.NOT_FORCED.test(t) || r.SOFT.some((re) => re.test(t))) return false;
  return r.LOOSE.test(t) || r.LOOSE_OTHER.test(t) || (flight && (r.CONFLICT.test(t) || (r.SCALE.test(t) && !r.FUGITIVE.test(t)))) || r.CROSSING.test(t);
}

// Feeds have no GDELT tags to confirm the topic, so their headlines need a core term (or English "displaced").
export function isCoreDisplacement(title) {
  const t = normScript(title), r = rulesFor(t);
  return !r.LOOKALIKE.some((re) => re.test(t)) && (r.CORE.test(t) || (r.LOOSE.test(t) && !r.NOT_FORCED.test(t)));
}

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
export const LANGUAGES = { eng: "en", spa: "es", fra: "fr", por: "pt", ara: "ar", rus: "ru" };
export const sourceLanguage = (info = "") => LANGUAGES[info.match(/srclc:(\w+)/)?.[1] || "eng"] || null;
// Languages whose headlines the topic and country rules can read, English first. Every source keeps
// only articles in these languages; add one by extending LANGUAGES and the rules that read headlines.
export const READ_LANGS = ["en", ...Object.values(LANGUAGES).filter((l) => l !== "en")];

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
  /(^|[:\s'"‘“])(how|why|when) I\b/i, // first-person accounts ("How I rejected US asylum…")
  /\b(indicted|sentenced|convicted|jailed|gets \d+ years|\d+ years (?:in )?(?:jail|prison)|prison term|sexual assault|child abuse)\b/i, // one person's criminal case
  /(?<![\p{L}])(su|sus|mi|tu|son|sa|seu|sua|pide|pidió|solicita|solicitó|obtiene|recibe|concede|concedió|otorga|otorgó|demande|obtient|pede|pediu|recebe|solicitado|rechaza|rechazó|recusa|recusou|refuse|refusé|concede) asil[oe](?![\p{L}])/iu,
];
// Arabic and Russian (normalized spelling): one refugee or one person at the start of a headline ("لاجئة سورية
// تفوز…", "طفلة في غزة…", "Беженка из Украины…", "Российский журналист попросил убежища…"), a story or diary,
// political asylum and one person asking for or getting asylum, and one person's prison sentence.
const PERSON_AR = "قصه|حكايه|رحله|شهاده|يوميات|مذكرات|رجل|امراه|سيده|طفل|طفله|شاب|شابه|فتاه|فتي|مسن|مسنه|عجوز|ناشط|ناشطه|مغني|مغنيه|فنان|فنانه|كاتب|كاتبه|شاعر|شاعره|معلم|معلمه|طبيب|طبيبه|ممرضه|صحفي|صحفيه|مصور|مصوره|لاعب|لاعبه|بطل|بطله";
const PERSON_RU = "россиянин|россиянка|украинец|украинка|сириец|сирийка|афганец|афганка|палестинец|палестинка|белорус|белоруска|армянин|армянка|грузин|грузинка|мужчина|женщина|мальчик|девочка|девушка|парень|пенсионер|пенсионерка|бабушка|дедушка|мать|отец|семья|школьник|школьница|студент|студентка|подросток|ребенок|блогер|певец|певица|рэпер|актер|актриса|футболист|спортсмен|спортсменка|активист|активистка|журналист|журналистка|писатель|писательница|художник|художница";
const PERSONAL_AR = [
  `^\\s*['"«“]?${A}(?:لاج(?:ئ|يء)|نازح|مهاجر)ه?(?![\\p{L}])`,
  `(?:^|[.:،!؟|]\\s*)['"«“]?(?:${PERSON_AR})(?![\\p{L}])`,
  `${A}لجوء ${A}سياسي|(?:يطلب|تطلب|طلبت|منحه|منحها|منحته|منحتها|يمنحه|تمنحه|حصل|حصلت|يحصل|تحصل|رفضت|قدمت)(?: (?!طلبات|الاف|مئات|عدد|\\d)\\S+){0,2} ${A}لجوء(?! (?:\\S+ )?(?:\\d|${A}الاف|${A}مئات))|(?:تمنح|يمنح|منحت)(?: (?!طلبات|الاف|مئات|عدد|\\d)\\S+){1,2} ${A}لجوء(?! (?:\\S+ )?(?:\\d|${A}الاف|${A}مئات))`,
  `${A}(?:سجن|حبس) \\d+|بالسجن|بالحبس|${A}حكم (?:علي|ب)`,
].map((s) => new RegExp(normScript(s), "iu"));
const PERSONAL_RU = [
  `(?<![а-я])(?:беженец|беженка|переселенец|переселенка)(?![а-я])|^['"«“„]?(?:мигрант|мигрантка)(?![а-я])`,
  `^(?:[а-я-]+\\s){0,2}(?:${PERSON_RU})(?![а-я])`,
  `политическ${R} убежищ|(?:попросил|попросила|просит|запросил|запросила|получил|получила|получит|предоставил|предоставила|предоставили|отказал|отказала|добивается|ищет|нашел|нашла)(?: (?!\\d|тысяч|сотн|десятк)\\S+){0,2} убежищ${R}(?![а-я])(?! (?:\\S+ )?(?:\\d|тысяч|сотн|десятк))`,
  `(?:приговорил|приговорили|приговорен|приговорена|осужден|осуждена|осудили|получил|получила)(?: \\S+){0,3} (?:\\d+|[а-я]+) (?:лет|года?) (?:колонии|тюрьмы|заключения|лишения свободы)|лишени${R} свободы`,
].map((s) => new RegExp(s, "iu"));
const SECTION_TITLE = /^(opinion|editorial|podcast|letters?|column|commentary|live|watch|video|photos?|review|quiz)\b\s*[:|–-]/i;
const SECTION_TITLE_AR_RU = new RegExp(normScript("^(?:مقال رأي|رأي|مقال|افتتاحية|بودكاست|فيديو|بالفيديو|بالصور|مباشر|كاريكاتير|мнение|колонка|комментарий|видео|фото|фоторепортаж|подкаст|онлайн|прямая трансляция|блог)(?![\\p{L}])\\s*[:.|–—-]"), "iu");
const SECTION_URL = /\/(opinion|opinions|editorials?|letters?|obituar\w*|podcasts?|sports?|lifestyle|life-?style|entertainment|arts?|culture|food|travel|commentisfree|comment|blogs?|videos?|live|liveblog|live-news)\//i;
export function isPersonalOrOpinion(title, url = "") {
  const t = normScript(title);
  const extra = HAS_AR.test(t) ? PERSONAL_AR : HAS_RU.test(t) ? PERSONAL_RU : [];
  return PERSONAL.some((re) => re.test(t)) || extra.some((re) => re.test(t)) || SECTION_TITLE.test(t) || (extra.length > 0 && SECTION_TITLE_AR_RU.test(t)) || SECTION_URL.test(url);
}

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
  China: { before: ["South ", "East "], after: [" Sea"] },
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
  GEO: /\b(Atlanta|Savannah|Augusta|Macon|Kemp|Fulton County|Georgia (State|Tech|Bulldogs|Power)|Georgia's (governor|legislature)|Ga\.)\b|اتلانتا|سافانا/i, // Arabic in the normalized spelling (أتلانتا)
  JOR: /\b(Michael Jordan|Jordan River|Jordan Peterson|Air Jordan)\b/i,
  JAM: /\b(Jamaica Plain|Jamaica,? Queens|Jamaica,? N\.?Y\.?|Jamaica Bay)\b/i,
};
// Outlets for which a name usually means a place at home: Nigerian papers' "Niger" is Niger State.
const DOMAIN_EXCLUDE = {
  NER: /(^|\.)(punchng\.com|premiumtimesng\.com|dailytrust\.com|thecable\.ng|vanguardngr\.com|channelstv\.com|guardian\.ng|thisdaylive\.com|leadership\.ng|[a-z0-9-]+\.ng)$/i,
};
// ---------- Country names in Arabic and Russian ----------
// Names come from the world-countries file (its Arabic and Russian translations) and the lists below, which add
// demonyms, short forms and the places that stand for a crisis. Both languages change the written word: Arabic
// attaches "and", "in", "for" and the article (وبالسودان, للسوريين), Russian changes endings with case
// (Сирия, Сирии, Сирию). So each name becomes a pattern:
//   Arabic "السودان": the article is part of the name; "سوري~": a demonym that also takes ة/ون/ين/ات;
//   Russian "Сирия": a name, declined from its ending; "сирийск*": an adjective with every ending;
//   "сириец/сирийц": a people noun (singular / stem of the other forms); { re, plain }: a hand-written pattern.
// Russian names are matched with their capital letter, so "Того" (the pronoun "that") or "газа" (of gas) are not
// Togo or Gaza; Russian adjectives and people nouns, and all Arabic, are matched in any case.
const AR_ALIASES = {
  AFG: ["أفغانستان", "أفغاني~", "الأفغان", "كابول", "طالبان"],
  ARE: ["الإمارات", "إماراتي~", "الإمارات العربية المتحدة"],
  ARM: ["أرمينيا", "أرميني~", "أرمني~", "الأرمن"],
  AZE: ["أذربيجان", "أذربيجاني~"],
  BGD: ["بنغلاديش", "بنغلادش", "بنجلاديش", "بنغلاديشي~", "كوكس بازار"],
  BHR: ["البحرين", "بحريني~"],
  CAF: ["أفريقيا الوسطى", "إفريقيا الوسطى", "جمهورية أفريقيا الوسطى"],
  CHN: ["الصين", "صيني~"],
  COD: ["الكونغو الديمقراطية", "الكونغو الديموقراطية", "جمهورية الكونغو الديمقراطية", "الكونغو", "كونغولي~", "كينشاسا", "غوما", "شمال كيفو", "جنوب كيفو", "إيتوري"],
  COG: ["جمهورية الكونغو", "الكونغو برازافيل", "الكونغو-برازافيل", "برازافيل"],
  DEU: ["ألمانيا", "ألماني~", "الألمان"],
  DMA: ["دومينيكا"],
  DOM: ["الدومينيكان", "جمهورية الدومينيكان", "دومينيكاني~"],
  DZA: ["الجزائر", "جزائري~"],
  EGY: ["مصر", "مصري~"],
  ERI: ["إريتريا", "إرتريا", "إريتري~", "إرتري~"],
  ESP: ["إسبانيا", "إسباني~"],
  ETH: ["إثيوبيا", "إثيوبي~", "تيغراي", "تيجراي", "أمهرة"],
  FRA: ["فرنسا", "فرنسي~"],
  GBR: ["بريطانيا", "بريطاني~", "المملكة المتحدة", "أيرلندا الشمالية"],
  GEO: ["جورجيا", "تبليسي"],
  GIN: ["غينيا", "كوناكري"],
  GNB: ["غينيا بيساو", "غينيا-بيساو"],
  GNQ: ["غينيا الاستوائية"],
  GRC: ["اليونان", "يوناني~"],
  GUF: ["غويانا الفرنسية"],
  GUY: ["غيانا", "غويانا"],
  HTI: ["هايتي~", "بورت أو برنس"],
  IND: ["الهند", "هندي~"],
  IRN: ["إيران", "إيراني~"],
  IRQ: ["العراق", "عراقي~", "الموصل", "سنجار"],
  ISR: ["إسرائيل", "إسرائيلي~"],
  ITA: ["إيطاليا", "إيطالي~"],
  JOR: ["الأردن", "أردني~"],
  KEN: ["كينيا", "كيني~"],
  KOR: ["كوريا الجنوبية"],
  KWT: ["الكويت", "كويتي~"],
  LBN: ["لبنان", "لبناني~"],
  LBY: ["ليبيا", "ليبي~", "بنغازي", "درنة"],
  MAR: ["المغرب", "مغربي~"],
  MEX: ["المكسيك", "مكسيكي~"],
  MLI: [{ re: "(?<=(?:في|من|الي|شمال|جنوب|وسط|شرق|غرب|دوله|جمهوريه|حكومه|جيش|سلطات)\\s)[وف]?مالي", plain: "مالي" }, "باماكو", "تمبكتو"],
  MMR: ["ميانمار", "بورما", "الروهينغا", "روهينغا", "الروهينجا", "روهينجا", "راخين", "أراكان"],
  MOZ: ["موزمبيق", "موزمبيقي~", "كابو ديلغادو"],
  MRT: ["موريتانيا", "موريتاني~"],
  NER: ["النيجر", "نيجري~", "نيامي"],
  NGA: ["نيجيريا", "نيجيري~"],
  NLD: ["هولندا", "هولندي~"],
  OMN: ["سلطنة عمان", "عماني~"],
  PAK: ["باكستان", "باكستاني~"],
  POL: ["بولندا", "بولندي~"],
  PRK: ["كوريا الشمالية"],
  PSE: ["فلسطين", "فلسطيني~", "غزة", "الضفة الغربية", "رفح", "خان يونس", "جنين", "نابلس", "طولكرم", "رام الله", "أريحا", "الخليل", "جباليا", "دير البلح", "النصيرات", "بيت لاهيا", "بيت حانون", "المواصي"],
  QAT: ["قطر", "قطري~"],
  RUS: ["روسيا", "روسي~"],
  SAU: ["السعودية", "سعودي~", "المملكة العربية السعودية"],
  SDN: ["السودان", "سوداني~", "دارفور", "الخرطوم", "الفاشر", "كردفان", "الجنينة"],
  SOM: ["الصومال", "صومالي~", "مقديشو"],
  SRB: ["صربيا", "صربي~", "كوسوفو"],
  SSD: ["جنوب السودان", "جوبا"],
  SYR: ["سوريا", "سورية", "سوري~", "إدلب", "حلب", "دمشق", "درعا", "السويداء", "دير الزور", "الرقة"],
  TCD: ["تشاد", "تشادي~"],
  TUN: ["تونس", "تونسي~"],
  TUR: ["تركيا", "تركي~"],
  UGA: ["أوغندا", "أوغندي~"],
  UKR: ["أوكرانيا", "أوكراني~", "كييف", "خاركيف", "دونباس"],
  USA: ["الولايات المتحدة", "أمريكا", "أميركا", "أمريكي~", "أميركي~"],
  UZB: ["أوزبكستان"],
  VEN: ["فنزويلا", "فنزويلي~"],
  YEM: ["اليمن", "يمني~", "حوثي~", "صنعاء", "عدن", "الحديدة", "تعز"],
  COL: ["كولومبيا", "كولومبي~"],
  CUB: ["كوبا", "كوبي~"],
};
// Arabic names in the world-countries file that are also everyday words or are misspelt there: عمان is both
// Oman and Amman, مالي both Mali and "financial", بنين both Benin and "boys"; المسكيك and صيربيا are typos.
const AR_SKIP = new Set(["عمان", "مالي", "بنين", "المسكيك", "صيربيا"].map(normScript));

const RU_ALIASES = {
  AFG: ["Афганистан", "афганск*", "афганец/афганц", "Кабул", "Талибан", { re: "талиб(?:ы|ов|ам|ами|ах)", plain: "талибы" }],
  ARE: ["ОАЭ", "Эмираты"],
  ARM: ["Армения", "армянск*", { re: "армян(?:ин|ина|ину|ином|е|ам|ами|ах)?", plain: "армяне" }],
  AZE: ["Азербайджан", "азербайджанск*", "азербайджанец/азербайджанц"],
  BGD: ["Бангладеш", "бангладешск*"],
  BLR: ["Белоруссия", "белорусск*"],
  CAF: ["ЦАР"],
  CHN: ["КНР", "китайск*"],
  COD: ["ДРК", "ДР Конго", "Конго", "конголезск*", "конголезец/конголезц", "Киншаса", "Гома", "Северное Киву", "Южное Киву", "Итури"],
  COG: ["Конго-Браззавиль", "Браззавиль"],
  DEU: ["ФРГ", "немецк*", "германск*", "немец/немц"],
  DOM: ["Доминикана", "доминиканск*"],
  EGY: [{ re: "Египет|Египт(?:а|у|е|ом)", plain: "Египет" }, "египетск*", { re: "египтян(?:ин|ина|е|ам|ами|ах)?", plain: "египтяне" }],
  ERI: ["эритрейск*", "эритреец/эритрейц"],
  ETH: ["эфиопск*", { re: "эфиоп(?:ы|ов|ам|ами|ах|ка|ки)?", plain: "эфиопы" }, "Тыграй", "Тигре", "Амхара"],
  FRA: ["французск*", { re: "француз(?:ы|ов|ам|ами|ах)?", plain: "французы" }],
  GBR: ["Британия", "британск*", "британец/британц", "Соединённое Королевство", "Северная Ирландия"],
  GEO: ["грузинск*", { re: "грузин(?:ы|ам|ами|ах|ка|ки)?", plain: "грузины" }, "Тбилиси"],
  GNB: ["Гвинея-Бисау"],
  GNQ: ["Экваториальная Гвинея"],
  GRC: ["греческ*", { re: "грек(?:и|ов|ам|ами|ах)?", plain: "греки" }],
  HTI: ["гаитянск*", { re: "гаитян(?:ин|е|ам|ами|ах)?", plain: "гаитяне" }],
  IND: ["индийск*", "индиец/индийц"],
  IRN: ["иранск*", "иранец/иранц"],
  IRQ: ["иракск*", "иракец/иракц", "Мосул", "Синджар"],
  ISR: ["израильск*", { re: "израильтян(?:ин|ина|е|ам|ами|ах)?", plain: "израильтяне" }],
  JOR: ["иорданск*", "иорданец/иорданц"],
  KAZ: ["казахстанск*"],
  KGZ: ["Кыргызстан", "киргизск*", "кыргызск*", "кыргызстанск*"],
  KOR: ["южнокорейск*"],
  LBN: ["ливанск*", "ливанец/ливанц"],
  LBY: ["ливийск*", "ливиец/ливийц", "Бенгази", "Дерна"],
  MDA: ["Молдова", "молдавск*"],
  MEX: ["мексиканск*", "мексиканец/мексиканц"],
  MLI: ["малийск*", "Бамако"],
  MMR: ["Бирма", "мьянманск*", "рохинджа", "Ракхайн", "Аракан"],
  NGA: ["нигерийск*", "нигериец/нигерийц"],
  NLD: ["Голландия", "нидерландск*", "голландск*"],
  PAK: ["пакистанск*", "пакистанец/пакистанц"],
  POL: ["польск*", { re: "поляк(?:и|ов|ам|ами|ах)?", plain: "поляки" }],
  PRK: ["КНДР", "северокорейск*"],
  PSE: ["палестинск*", "палестинец/палестинц", { re: "Газ(?:а|ы|е|у|ой)|[Сс]ектор(?:а|е|ом)?\\s+Газ(?:а|ы)", plain: "Газа" },
    { re: "Западн(?:ый|ого|ом|ому|ым) берег(?:а|у|е|ом)?(?!\\s+(?:Днепр|Днестр|Дон|Волг))", plain: "Западный берег" }, "Рафах", "Хан-Юнис", "Дженин", "Наблус", "Тулькарм", "Рамалла", "Хеврон"],
  RUS: ["РФ", "российск*", { re: "россиян(?:ин|ина|ину|ином|ка|ки|е|ам|ами|ах)?", plain: "россияне" }, "Белгород", "Курск",
    { re: "[Бб]елгородск(?:ая|ой|ую) област(?:ь|и|ью)", plain: "Белгородская область" }, { re: "[Кк]урск(?:ая|ой|ую) област(?:ь|и|ью)", plain: "Курская область" }],
  SAU: ["саудовск*"],
  SDN: ["Судан", "суданск*", "суданец/суданц", "Дарфур", "Хартум", "Эль-Фашер", "Кордофан"],
  SOM: ["сомалийск*", "сомалиец/сомалийц", "Могадишо"],
  SSD: ["Южный Судан", "южносуданск*", "южносуданец/южносуданц", "Джуба"],
  SWZ: ["Эсватини"],
  SYR: ["сирийск*", "сириец/сирийц", "Идлиб", "Алеппо", "Дамаск"],
  TCD: ["чадск*"],
  TJK: ["таджикск*", { re: "таджик(?:и|ов|ам|ами|ах)?", plain: "таджики" }],
  TKM: ["Туркменистан", "туркменск*"],
  TUR: ["турецк*", { re: "турк(?:и|ов|ам|ами|ах)", plain: "турки" }],
  UKR: ["украинск*", "украинец/украинц", "Киев", "Харьков", "Донбасс", "Донбас", "Херсон", "Запорожье", "Одесса", "Мариуполь", "Покровск",
    "одесск*", "харьковск*", "херсонск*", "запорожск*", "донецк*", "луганск*", "сумск*", "днепропетровск*", "николаевск*"],
  USA: ["США", "Соединённые Штаты", "Америка", "американск*", "американец/американц"],
  UZB: ["узбекск*", { re: "узбек(?:и|ов|ам|ами|ах)?", plain: "узбеки" }],
  VEN: ["венесуэльск*", "венесуэлец/венесуэльц"],
  YEM: ["йеменск*", "йеменец/йеменц", { re: "хусит(?:ы|ов|ам|ами|ах)?", plain: "хуситы" }, "хуситск*", "Сана", "Аден", "Ходейда"],
  ZAF: ["ЮАР", "Южная Африка"],
  COL: ["колумбийск*", "колумбиец/колумбийц"],
  CUB: ["кубинск*", "кубинец/кубинц"],
};
// Russian names in the world-countries file that are everyday words: "Того" is also "of that".
const RU_SKIP = new Set(["Того"]);

// Names that also belong to someone else, as in GUARDS above; patterns in the normalized spelling.
const SCRIPT_GUARDS = {
  "السودان": { before: ["جنوب\\s+"] },
  "سوداني": { before: ["جنوب\\s+"] },
  "غينيا": { before: ["بابوا\\s+"], after: ["\\s*-?\\s*بيساو", "\\s+الاستوائيه", "\\s+الجديده"] },
  "النيجر": { before: ["دلتا\\s+", "ولايه\\s+", "نهر\\s+"] },
  "الكونغو": { before: ["جمهوريه\\s+"], after: ["\\s*-?\\s*برازافيل"] },
  "جمهوريه الكونغو": { after: ["\\s+(?:ال)?ديمقراطيه", "\\s+(?:ال)?ديموقراطيه"] },
  "جورجيا": { before: ["ولايه\\s+"], after: ["\\s+الجنوبيه"] },
  "ايرلندا": { after: ["\\s+الشماليه"] },
  "امريكا": { after: ["\\s+(?:اللاتينيه|الجنوبيه|الشماليه|الوسطي)"] },
  "اميركا": { after: ["\\s+(?:اللاتينيه|الجنوبيه|الشماليه|الوسطي)"] },
  "امريكي": { after: ["\\s+(?:ال)?لاتيني"] },
  "اميركي": { after: ["\\s+(?:ال)?لاتيني"] },
  "الهند": { after: ["\\s+الصينيه"] },
  "هندي": { before: ["المحيط\\s+"] },
  "الصين": { before: ["بحر\\s+"] },
  "صيني": { before: ["بحر\\s+"] },
  "المغرب": { before: ["صلاه\\s+"], after: ["\\s+العربي"] },
  "غويانا": { after: ["\\s+الفرنسيه"] },
  "طالبان": { after: ["\\s+(?:باكستان|الباكستانيه)"] },
  "Судан": { before: ["Южн[а-я]*\\s+"] },
  "Гвинея": { before: ["Экваториальн[а-я]*\\s+", "Нов[а-я]*\\s+"], after: ["\\s*-\\s*Бисау", "\\s+Бисау"] },
  "Нигер": { before: ["[Дд]ельт[а-я]*\\s+", "[Шш]тат[а-я]*\\s+", "[Рр]ек[а-я]*\\s+"] },
  "Конго": { before: ["Республик[а-я]*\\s+", "ДР\\s+"], after: ["\\s*-\\s*Браззавил"] },
  "Республика Конго": { before: ["Демократическ[а-я]*\\s+"] },
  "Корея": { before: ["Южн[а-я]*\\s+", "Северн[а-я]*\\s+"] },
  "Ирландия": { before: ["Северн[а-я]*\\s+"] },
  "Америка": { before: ["Латинск[а-я]*\\s+", "Южн[а-я]*\\s+", "Северн[а-я]*\\s+", "Центральн[а-я]*\\s+"] },
  "Македония": { before: ["[Гг]реческ[а-я]*\\s+"] },
  "китайск": { before: ["Южно-", "Восточно-"], after: ["[а-я]*\\s+мор"] },
  "индийск": { after: ["[а-я]*\\s+океан"] },
};

const RU_ADJ = "(?:ий|ый|ой|ая|ое|ие|ые|ого|его|ому|ему|ую|ым|им|ыми|ими|ых|их|ом|ем|ою)";
// One Russian word in every case, from its dictionary form. Indeclinable names (Конго, Перу, Сомали) stay as they are.
function ruWord(w) {
  if (/^[А-ЯA-Z]{2,}$/.test(w)) return escapeRe(w); // abbreviations: США, ДРК
  const s = (n) => escapeRe(w.slice(0, -n));
  if (/ия$/.test(w)) return s(2) + "(?:ия|ии|ию|ией|иею)";
  if (/ая$/.test(w)) return s(2) + "(?:ая|ой|ую|ою)";
  if (/(?:ый|ий|ой)$/.test(w)) return s(2) + "(?:ый|ий|ой|ого|его|ому|ему|ым|им|ом|ем)";
  if (/(?:ые|ие)$/.test(w)) return s(2) + "(?:ые|ие|ых|их|ым|им|ыми|ими)";
  if (/(?:ое|ее)$/.test(w)) return s(2) + "(?:ое|ее|ого|его|ому|ему|ым|им|ом|ем)";
  if (/^[Оо]строва$/.test(w)) return s(1) + "(?:а|ов|ам|ами|ах)";
  if (/ы$/.test(w)) return s(1) + "(?:ы|ов|ам|ами|ах)";
  if (/а$/.test(w)) return s(1) + "(?:а|ы|и|е|у|ой|ою)";
  if (/я$/.test(w)) return s(1) + "(?:я|и|е|ю|ей|ею)";
  if (/ь$/.test(w)) return s(1) + "(?:ь|я|ю|е|ем|и|ью)";
  if (/й$/.test(w)) return s(1) + "(?:й|я|ю|е|ем)";
  if (/[бвгджзклмнпрстфхцчшщ]$/i.test(w)) return escapeRe(w) + "(?:а|у|е|ом)?";
  return escapeRe(w);
}
const SCRIPT_GUARDS_N = Object.fromEntries(Object.entries(SCRIPT_GUARDS).map(([k, g]) => [normScript(k), g]));
const guardsFor = (key) => {
  const g = SCRIPT_GUARDS_N[key] || {};
  return { before: (g.before || []).map((b) => `(?<!${normScript(b)})`).join(""), after: (g.after || []).map((a) => `(?!${normScript(a)})`).join("") };
};
// An Arabic name or demonym → { re, prep, plain }. `prep` is the same name with ب or ل attached ("in", "to"),
// which ties the country to the story the way "in Chad" does.
function arTerm(raw) {
  if (typeof raw === "object") return { re: normScript(raw.re), prep: null, plain: normScript(raw.plain) };
  const demonym = raw.endsWith("~");
  const word = normScript(raw.replace(/~$/, ""));
  const article = raw.startsWith("ال"); // checked before normalizing: "ألمانيا" has no article
  const core = escapeRe(article ? word.slice(2) : word).replace(/[\s-]+/g, "[\\s-]+");
  const { before, after } = guardsFor(word);
  const suffix = demonym ? "(?:ه|ون|ين|ات|ا)?" : "";
  const pre = article ? "[وف]?(?:[بك]?ال|لل)" : demonym ? "[وف]?(?:[بك]?ال|لل|[بلك])?" : "[وف]?[بلك]?";
  const prep = article ? "[وف]?(?:بال|لل)" : demonym ? "[وف]?(?:بال|لل|[بل])" : "[وف]?[بل]";
  return { re: `${before}${pre}${core}${suffix}${after}`, prep: `${before}${prep}${core}${suffix}${after}`, plain: word };
}
// A Russian name, adjective or people noun → { re, plain, cs }.
function ruTerm(raw) {
  if (typeof raw === "object") return { re: normScript(raw.re), plain: normScript(raw.plain), cs: /^[А-Я]/.test(normScript(raw.plain)) };
  const n = normScript(raw);
  if (n.endsWith("*")) {
    const stem = n.slice(0, -1);
    const { before, after } = guardsFor(stem);
    return { re: `${before}${escapeRe(stem)}${RU_ADJ}${after}`, plain: stem + "ий", cs: false };
  }
  if (n.includes("/")) {
    const [one, stem] = n.split("/");
    return { re: `(?:${escapeRe(one)}|${escapeRe(stem)}(?:ы|ев|ам|ами|ах|а|у|ем|е))`, plain: stem + "ы", cs: false };
  }
  const { before, after } = guardsFor(n);
  const body = n.split(/(\s*[—–]\s*|\s+|-)/).map((p, i) => (i % 2 ? (/[—–]/.test(p) ? "\\s*[—–-]\\s*" : p === "-" ? "-" : "\\s+") : ruWord(p).replace(/['’]/g, "['’]"))).join("");
  return { re: `${before}(?:${body})${after}`, plain: n, cs: /^[А-ЯA-Z]/.test(n) };
}
const edge = (re) => `(?<![\\p{L}\\p{N}])(?:${re})(?![\\p{L}\\p{N}])`;

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
// English, Spanish, French, Portuguese, Arabic and Russian.
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
  // Arabic and Russian patterns (see "Country names in Arabic and Russian"): the lists above first, then the
  // world-countries file. A name already claimed by another country is skipped, as for the other languages.
  const script = new Map(); // iso → { ar, prep, ru, ruCs, plain }
  const takenScript = new Map();
  const addScript = (iso, lang, raw) => {
    if (!raw) return;
    const t = lang === "ar" ? arTerm(raw) : ruTerm(raw);
    if (typeof raw === "string" && (lang === "ar" ? AR_SKIP : RU_SKIP).has(t.plain)) return;
    const key = `${lang}:${t.plain.toLowerCase()}`;
    if (takenScript.has(key)) return;
    takenScript.set(key, iso);
    if (!script.has(iso)) script.set(iso, { ar: [], prep: [], ru: [], ruCs: [], plain: [] });
    const s = script.get(iso);
    (lang === "ar" ? s.ar : t.cs ? s.ruCs : s.ru).push(edge(t.re));
    if (t.prep) s.prep.push(edge(t.prep));
    s.plain.push(t.plain);
  };
  for (const c of places) {
    for (const raw of AR_ALIASES[c.id] || []) addScript(c.id, "ar", raw);
    for (const raw of RU_ALIASES[c.id] || []) addScript(c.id, "ru", raw);
  }
  for (const c of places) {
    const w = wcBy.get(c.id);
    addScript(c.id, "ar", w?.translations?.ara?.common);
    addScript(c.id, "ru", w?.translations?.rus?.common);
  }
  const matchers = new Map();
  for (const [iso, set] of terms) {
    const all = [...set];
    const insensitive = all.filter((t) => !CASE_SENSITIVE.has(t)).map(pattern);
    const sensitive = all.filter((t) => CASE_SENSITIVE.has(t)).map(pattern);
    const s = script.get(iso);
    const re = (list, flags) => (list?.length ? new RegExp(list.join("|"), flags) : null);
    matchers.set(iso, {
      iso,
      terms: [...all, ...(s?.plain || [])],
      ci: insensitive.length ? new RegExp(insensitive.join("|"), "giu") : null,
      cs: sensitive.length ? new RegExp(sensitive.join("|"), "gu") : null,
      // Arabic has no letter case, so its patterns skip the case-insensitive flag, which makes large Unicode
      // patterns slow to compile; Russian names keep their capital letter, Russian adjectives don't.
      ar: re(s?.ar, "gu"),
      arPrep: re(s?.prep, "gu"), // Arabic names with ب or ل ("in", "to") attached
      ru: re(s?.ru, "giu"),
      ruCs: re(s?.ruCs, "gu"),
      exclude: TITLE_EXCLUDE[iso] || null,
      excludeDomain: DOMAIN_EXCLUDE[iso] || null,
    });
  }
  return matchers;
}

// A country is tied to displaced people by a noun after its name ("Sudanese refugees"), a noun before it
// ("refugiados venezolanos", "réfugiés soudanais", "اللاجئين السوريين"), or a preposition before it ("fled Sudan",
// "en Colombia", "في السودان", "из Сирии"). Patterns are in the normalized spelling (see normScript).
const DISPLACED_NOUNS = normScript("refugees?|asylum(?:[- ]seekers?)?|migrants?|idps?|displaced|displacement|returnees?|civilians|families|people|residents|evacuees|children|women|exodus|influx|camps?|crisis|stateless|minorit(?:y|ies)|population|returns?|fle(?:e|es|eing|d)|forced|seek(?:s|ing)? asylum"
  + "|refugiad[oa]s?|desplazad[oa]s|migrantes|solicitantes de asilo|familias|personas|niños|éxodo|crisis"
  + "|réfugiés?|déplacés|demandeurs d['’]asile|familles|personnes|enfants|exode"
  + "|deslocad[oa]s|famílias|pessoas|crianças"
  + `|${A}(?:لاج(?:ئ|يء)|نازح|مهجر|مهاجر)(?:ين|ون|ات|ه|و|ي)?|${A}(?:نزوح|تهجير|عائلات|اسر|سكان|مدنيين|اطفال|مخيم|مخيمات|ازمه|عوده)|طالبي ${A}لجوء|فروا|فرار|نزحوا|ينزحون|يفرون`
  + `|беженц${R}|беженк${R}|переселенц${R}|мигрант${R}|ВПЛ|перемещенн${R}|жител${R}|мирн${R} (?:жител|населени)${R}|семь${R}|дет(?:ей|и|ям|ьми)|люд(?:и|ей|ям|ьми)|населени${R}|лагер${R}|кризис${R}|эвакуац${R}|бежал${R}|бегут|покинул${R}|эвакуирова${R}|просител${R} убежищ${R}`);
const NOUNS = new RegExp(`^(?:['’]s)?(?:[\\s,:;–—.،-]+[\\p{L}'’-]+){0,3}?[\\s,:;–—.،-]+['"‘“«„]?(?:${DISPLACED_NOUNS})(?![\\p{L}])`, "iu");
const NOUNS_BEFORE = new RegExp(normScript(`(?<![\\p{L}])(?:refugiad[oa]s|desplazad[oa]s|migrantes|réfugiés|déplacés|migrants|deslocad[oa]s|exiliad[oa]s|exilés`
  + `|${A}(?:لاج(?:ئ|يء)|نازح|مهجر|مهاجر)(?:ين|ون|ات|ه|و|ي)?|${A}(?:نزوح|تهجير|عوده|اعاده|ترحيل|طرد|معاناه|اوضاع|مخيمات|مخيم|استقبال|ايواء|توطين)|طالبي ${A}لجوء` // "عودة الأفغان": the return of the Afghans
  + `|беженц${R}|беженк${R}|переселенц${R}|мигрант${R}|ВПЛ|перемещенн${R} лиц${R}|возвращени${R}|депортаци${R}|высылк${R}|выдворени${R}|расселени${R})(?:[\\s,]+[\\p{L}'’-]+){0,1}[\\s,]+$`), "iu");
const PREPS = new RegExp(normScript(`(?<![\\p{L}])(?:in|from|into|out of|inside|across|to|toward|towards|off|near|along|at|leave|leaving|left|flee|flees|fleeing|fled|returns? to|returning to|returned to|back to|within|of`
  + `|en|desde|hacia|huyen de|huyeron de|huir de|llegan a|regresan a|dans|depuis|vers|fuient|fuyant|fuir|au|aux|em|no|na|para|fogem de|fugindo de|deixam`
  + `|في|من|الي|نحو|داخل|عبر|علي|حدود|شمال|جنوب|شرق|غرب|وسط|شمالي|جنوبي|شرقي|غربي`
  + `|в|во|из|на|до|к|ко|от|через|по|вглубь|внутри|около|возле|вблизи|из-за|покинули|бежали из|бегут из|вернулись в|возвращаются в|границ${R} с)\\s+(?:the\\s+|la\\s+|el\\s+|le\\s+|les\\s+|l['’]|o\\s+|a\\s+)?(?:[\\p{L}-]+\\s+)?$`), "iu");

function findMatches(m, title) {
  const out = [];
  const res = [m.ci, m.cs];
  if (HAS_AR.test(title)) res.push(m.ar, m.arPrep);
  if (HAS_RU.test(title)) res.push(m.ru, m.ruCs);
  for (const re of res) {
    if (!re) continue;
    re.lastIndex = 0;
    for (const hit of title.matchAll(re)) out.push({ start: hit.index, end: hit.index + hit[0].length, prep: re === m.arPrep });
  }
  return out;
}

// Arabic adjectives follow their noun, so a demonym right after an attack word is the attacker ("قصف إسرائيلي
// ونزوح…", Israeli shelling and displacement), not the people displaced; such a mention ties no country.
const ATTACKER_BEFORE = new RegExp(normScript(`(?<![\\p{L}])${A}(?:قصف|غارات|غاره|هجوم|هجمات|عدوان|احتلال|جيش|قوات|ضربات|توغل|توغلات|اجتياح|حصار|تصعيد|اعتداءات|مسيرات|طائرات|دبابات|عمليه|عمليات|جنود|مستوطنين)\\s+$`), "u");

const FLED_FROM = new RegExp(normScript(`(?<![\\p{L}])(?:from|out of|flee|flees|fleeing|fled|leave|leaving|left|huyen de|huyeron de|huir de|desde|fuient|fuyant|fuir|depuis|fogem de|fugindo de|deixam`
  + `|من|فروا من|فرارا من|هربا من|نزحوا من|نزوح من|الفارين من|خرجوا من`
  + `|из|бежали из|бегут из|бежавш${R} из|покинул${R}|покидают|эвакуирова${R} из|вывезен${R} из|с территории|из-под)\\s+(?:the\\s+|la\\s+|el\\s+|le\\s+|les\\s+|l['’]|o\\s+|a\\s+)?(?:[\\p{L}-]+\\s+)?$`), "iu");

// Files a headline under the countries it is about. A country counts when the headline ties it to
// displaced people ("Sudanese refugees", "fled Sudan", "in Chad"). If no country is tied that way and
// exactly one country is named, it goes there. Otherwise it is not filed: a passing mention is not enough.
// When more than three countries are tied (a list of host countries), only the places people come from
// are kept ("Sudanese refugees…", "fled Sudan"); if none is clear, the first one named.
export function attributeCountries(rawTitle, matchers, { domain = "" } = {}) {
  const title = normScript(rawTitle);
  const hits = [];
  for (const m of matchers.values()) {
    if (m.exclude && m.exclude.test(title)) continue;
    if (m.excludeDomain && m.excludeDomain.test(domain)) continue;
    const found = findMatches(m, title).filter((f) => !ATTACKER_BEFORE.test(title.slice(Math.max(0, f.start - 30), f.start)));
    if (!found.length) continue;
    const before = ({ start }) => title.slice(Math.max(0, start - 50), start);
    const origin = found.some((f) => NOUNS.test(title.slice(f.end, f.end + 80)) || NOUNS_BEFORE.test(before(f)) || FLED_FROM.test(before(f)));
    const strong = origin || found.some((f) => f.prep || PREPS.test(before(f)));
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
// Russian and Arabic headlines also use dashes inside the sentence ("Удары по Харькову — тысячи эвакуированы"),
// so there only a short trailing part is dropped: after "|", or after a dash when it is at most three words
// and, in Russian, every word is capitalized ("— РИА Новости", "– الجزيرة نت").
export function cleanTitle(title) {
  if (HAS_AR.test(title) || HAS_RU.test(title)) {
    let t = title.trim(), m;
    while ((m = t.match(/^(.+?)\s+([|–—-])\s+([^|–—]+)$/))) {
      const [, head, sep, tail] = m;
      const tailWords = tail.trim().split(/\s+/);
      const outletLike = sep === "|" || (tailWords.length <= 3 && (!HAS_RU.test(tail) || tailWords.every((w) => !/^\p{Ll}/u.test(w))));
      if (!outletLike || head.trim().split(/\s+/).length < 4) break;
      t = head.trim();
    }
    return t;
  }
  const parts = title.split(/\s+[|–—]\s+|\s+-\s+(?=[^-]+$)/);
  const head = parts[0].trim();
  return head.split(/\s+/).length >= 4 ? head : title.trim();
}
// Lower case, accents and marks removed, and every letter kept, so Arabic and Cyrillic headlines don't all
// reduce to "" and collapse into one (normScript unifies their spelling first).
export const normTitle = (t) => normScript(cleanTitle(t)).toLowerCase().normalize("NFKD").replace(/\p{M}/gu, "").replace(/[^\p{L}\p{N}]+/gu, " ").trim().slice(0, 80);
// Words compared across headlines lose their Arabic article and clitics and their Russian case ending, so
// "السودانيين" and "السوداني", or "Сирии" and "Сирия", count as one word. Latin words are left as they are.
const RU_ENDINGS = /(?:иями|ями|ами|ого|его|ому|ему|ыми|ими|иях|ах|ях|ам|ям|ов|ев|ей|ии|ия|ию|ие|ые|ий|ый|ой|ая|яя|ое|ее|ых|их|ым|им|ом|ем|ую|юю|ью|а|я|о|е|ы|и|у|ю|ь)$/;
function stem(w) {
  if (HAS_AR.test(w)) {
    let s = w.length > 4 ? w.replace(/^(?:وبال|وال|بال|فال|كال|ولل|ال|لل)/, "") : w;
    if (s.length < 3) s = w;
    const cut = s.replace(/(?:يين|يون|ين|ون|ات|يه|ه|ي|ا)$/, "");
    return cut.length >= 3 ? cut : s;
  }
  if (HAS_RU.test(w)) {
    const cut = w.replace(RU_ENDINGS, "");
    return cut.length >= 4 ? cut : w;
  }
  return w;
}

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
  + " refugiados refugiadas desplazados desplazadas migrantes miles personas huyen crisis refugies deplaces milliers personnes deslocados pessoas milhares"
  + " لاجئ لاجئين لاجئون اللاجئين للاجئين واللاجئين نازح نازحين نازحون النازحين للنازحين والنازحين نزوح النزوح مهاجرين المهاجرين الاف آلاف الآلاف مئات ألف"
  + " مخيم مخيمات أزمة الحرب حرب عودة العودة المدنيين أطفال الأطفال عائلات يقول تقول جديد"
  + " беженцы беженцев беженцам беженцами переселенцы переселенцев мигранты мигрантов тысячи тысяч сотни людей человек жителей"
  + " лагерь лагеря кризис война войны эвакуация эвакуации эвакуировали бежали дети детей семьи заявил заявили").split(" ").flatMap((w) => normTitle(w).split(" ")).map(stem));
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
  const skip = new Set([...ignore].map((t) => normTitle(t)).flatMap((t) => t.split(" ")).filter(Boolean).map(stem));
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
  + " los las del que una por con para sus tras ante les des aux pour sur dans est une par das dos com uma pelo pela"
  + " على إلى الى بعد قبل بين حول خلال منذ عبر ضد الذي التي الذين هذا هذه ذلك تلك وسط أمام إثر عقب جراء بسبب كان قد لا ما هل عند حتى نحو دون غير كل أكثر"
  + " для при что как это после над под без или его она они так уже еще все около более чем где когда который которые также будет может").split(" ").flatMap((w) => normTitle(w).split(" ")));
const words = (t) => new Set(normTitle(t).split(" ").filter((w) => w.length > 2 && !STOP.has(w)).map(stem));
export function titleOverlap(a, b) {
  const A = words(a), B = words(b);
  if (!A.size || !B.size) return 0;
  let n = 0;
  for (const w of A) if (B.has(w)) n++;
  return n / Math.min(A.size, B.size);
}

export const USER_AGENT = "Mozilla/5.0 (compatible; displacement-change-monitor/1.0; +https://github.com/davidkleinrock-bot/displacement-change-monitor)";

// Pages and feeds are not always UTF-8: Arabic sites may use windows-1256, Russian ones windows-1251 or KOI8-R,
// older Latin ones ISO-8859-1. The charset comes from a byte-order mark, else the HTTP header, else the
// <?xml encoding="..."?> declaration or (for pages) a <meta charset> tag near the top, else UTF-8.
export function decodeBytes(buf, contentType = "", { html = false } = {}) {
  const bytes = new Uint8Array(buf);
  const bom = bytes[0] === 0xef && bytes[1] === 0xbb && bytes[2] === 0xbf;
  const head = new TextDecoder("latin1").decode(bytes.subarray(0, html ? 16384 : 200));
  const charset = (bom && "utf-8") || (contentType || "").match(/charset=["']?([\w-]+)/i)?.[1]
    || head.match(/<\?xml[^>]*encoding=["']([\w-]+)["']/i)?.[1]
    || (html && head.match(/<meta[^>]+charset=["']?([\w-]+)/i)?.[1]) || "utf-8";
  try { return new TextDecoder(charset.toLowerCase()).decode(bytes); } catch { return new TextDecoder("utf-8").decode(bytes); }
}

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
  try {
    html = (res.arrayBuffer ? decodeBytes(await res.arrayBuffer(), res.headers?.get?.("content-type"), { html: true }) : await res.text()).slice(0, 600000);
  } catch { return { link: "unverified", reason: "unreadable page" }; }
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
