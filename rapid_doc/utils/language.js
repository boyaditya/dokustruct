// Copyright (c) Opendatalab. All rights reserved.
/**
 * PORTING NOTE: language.py → language.js
 *
 * WORKAROUND: fast_langdetect Python library
 * REASON: Not available in browser
 * SOLUTION: Use franc-min (npm) for language identification
 *           frank-min returns ISO 639-3 codes; we return lowercase language codes.
 *
 * WORKAROUND: os.environ["FTLANG_CACHE"] path setup
 * REASON: No filesystem or environment in browser
 * SOLUTION: Not needed; franc-min ships its own data
 */

import { franc } from 'franc-min';

/**
 * Remove invalid UTF-16 surrogate characters.
 * @param {string} text
 * @returns {string}
 */
export function removeInvalidSurrogates(text) {
  return text.replace(/[\uD800-\uDFFF]/g, '');
}

/**
 * Detect the language of a text string.
 * PORTING NOTE: detect_language(text) → franc(text) with ISO 639-3 → ISO 639-1 mapping
 *
 * Returns a lowercase language code (e.g. "en", "zh", "ja").
 * Returns "" for empty or undetermined text.
 *
 * @param {string} text
 * @returns {string}
 */
export function detectLang(text) {
  if (!text || text.length === 0) return '';

  let cleaned = text.replace(/\n/g, '');
  cleaned = removeInvalidSurrogates(cleaned);

  if (!cleaned.trim()) return '';

  try {
    const iso3 = franc(cleaned);
    if (!iso3 || iso3 === 'und') return '';
    // Map common ISO 639-3 → simpler codes used by the pipeline
    return iso3ToLang(iso3);
  } catch {
    // Fallback: strip control chars and try again
    try {
      const sanitized = [...cleaned].filter(c => {
        const cat = c.codePointAt(0);
        return cat != null && !(cat < 0x20 && cat !== 0x09 && cat !== 0x0A && cat !== 0x0D);
      }).join('');
      const iso3 = franc(sanitized);
      return (!iso3 || iso3 === 'und') ? '' : iso3ToLang(iso3);
    } catch {
      return '';
    }
  }
}

/**
 * ISO 639-3 → ISO 639-1 / pipeline language code mapping.
 * PORTING NOTE: fast_langdetect returns uppercase 2-letter codes;
 *   franc returns 3-letter. We normalize here.
 * @param {string} iso3
 * @returns {string}
 */
function iso3ToLang(iso3) {
  const map = {
    zho: 'ch',  cmn: 'ch',  wuu: 'ch',  yue: 'ch',
    eng: 'en',
    jpn: 'ja',
    kor: 'ko',
    fra: 'fr',
    deu: 'de',
    spa: 'es',
    por: 'pt',
    rus: 'ru',
    ara: 'ar',
    hin: 'hi',
    tha: 'th',
    vie: 'vi',
    ind: 'id',
    msa: 'ms',  zsm: 'ms',
    ita: 'it',
    nld: 'nl',
    pol: 'pl',
    tur: 'tr',
    ukr: 'uk',
    ces: 'cs',
    swe: 'sv',
    nor: 'no',
    dan: 'da',
    fin: 'fi',
    hun: 'hu',
    ron: 'ro',
    bul: 'bg',
    hrv: 'hr',
    slk: 'sk',
    heb: 'he',
    cat: 'ca',
    lat: 'la',
  };
  return map[iso3] ?? iso3.slice(0, 2).toLowerCase();
}
