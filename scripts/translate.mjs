// English machine translations of Spanish, French and Portuguese headlines and summaries, so readers who
// don't read those languages can still use them. The original text is always kept and shown first.
// Free and without accounts: the OPUS-MT model from the University of Helsinki (CC BY 4.0,
// https://github.com/Helsinki-NLP/Opus-MT), run on the update job's own computer with transformers.js.
// The library is installed by the GitHub workflow only (npm install --no-save @huggingface/transformers);
// where it is missing, nothing is translated and the page shows the originals with their language label.

export const MT_MODEL = "Xenova/opus-mt-ROMANCE-en"; // one model for Spanish, French and Portuguese
export const MT_LANGS = ["es", "fr", "pt"];

// Names the model is known to mangle (seen on live headlines), put back after translation.
const NAME_FIXES = [
  [/\bCorporal Delgado\b/g, "Cabo Delgado"], [/\bRutsh-?Hur\b/g, "Rutshuru"],
  [/\bPnud\b|\bPNUD\b/g, "UNDP"], [/\bAcnur\b|\bACNUR\b/g, "UNHCR"], [/\bOIM\b/g, "IOM"],
];
// Also drops a phrase the model repeated by mistake ("by armed ins armed ins in four districts").
export const fixNames = (text) =>
  NAME_FIXES.reduce((t, [re, name]) => t.replace(re, name), text).replace(/\b((?:\w+\s+){0,2}\w+)(?:\s+\1\b)+/g, "$1");

async function loadTranslator(cacheDir) {
  const lib = await import("@huggingface/transformers");
  if (cacheDir) lib.env.cacheDir = cacheDir;
  const pipe = await lib.pipeline("translation", MT_MODEL, { dtype: "q8" });
  return async (text) => {
    const out = (await pipe(text, { max_new_tokens: 200 }))[0]?.translation_text?.trim();
    return out ? fixNames(out) : null;
  };
}

// Adds titleEn (and descriptionEn when there is a summary) to items in MT_LANGS that don't have one yet.
// Items already translated in an earlier run keep their translation. The same text is translated once.
// `translate` can be passed in (tests); otherwise the model is loaded on first use.
export async function translateItems(items, { cacheDir, translate, limit = 400, log = console.log } = {}) {
  const todo = items.filter((a) => MT_LANGS.includes(a.lang) && !a.titleEn);
  if (!todo.length) return { translated: 0, skipped: 0 };
  if (!translate) {
    try { translate = await loadTranslator(cacheDir); }
    catch (e) { log(`Translation skipped: ${e.message.split("\n")[0]}`); return { translated: 0, skipped: todo.length }; }
  }
  const done = new Map();
  const once = async (text) => {
    if (!text) return null;
    if (!done.has(text)) done.set(text, await translate(text).catch(() => null));
    return done.get(text);
  };
  let translated = 0;
  for (const a of todo.slice(0, limit)) {
    const titleEn = await once(a.title);
    if (!titleEn) continue;
    a.titleEn = titleEn;
    const descriptionEn = await once(a.description);
    if (descriptionEn) a.descriptionEn = descriptionEn;
    translated++;
  }
  return { translated, skipped: todo.length - translated };
}
