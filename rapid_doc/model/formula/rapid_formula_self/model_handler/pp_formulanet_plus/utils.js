import {
  fixLatexLeftRight,
  fixLatexEnvironments,
  removeUpCommands,
  removeUnsupportedCommands,
  sanitizeFormulaLatex,
} from "../../../fix_utils.js";

/**
 * Apply all LaTeX post-processing fixes.
 * Python baseline passes fix_delimiter=False to fix_latex_left_right (post_process.py).
 * @param {string} formula
 * @returns {string}
 */
export function fixLatex(formula) {
  let result = fixLatexLeftRight(formula, false); // fix_delimiter=False in Python
  result = fixLatexEnvironments(result);
  result = removeUpCommands(result);
  result = removeUnsupportedCommands(result);
  result = sanitizeFormulaLatex(result);
  return result;
}

// Porting fix: HuggingFace byte-level BPE inverse map for Greek/CJK token decoding
//
// The HuggingFace GPT-2 BPE byte_to_unicode map encodes each of the 256 byte
// values to a unique Unicode character, avoiding "problematic" control/whitespace
// bytes. The forward map (byte → unicode) is built in Python as follows:
//
//   bs = list(range(ord("!"), ord("~")+1)) # 0x21–0x7E (printable ASCII)
//          + list(range(ord("¡"), ord("¬")+1)) # 0xA1–0xAC
//          + list(range(ord("®"), ord("ÿ")+1)) # 0xAE–0xFF
//   cs = bs[:]
//   n = 0
//   for b in range(256):
//     if b not in bs:
//       bs.append(b), cs.append(256 + n), n += 1
//   # result: dict(zip(map(chr, cs), bs)) ← maps unicode char → byte value
//            i.e. this IS the inverse map we need for decoding.
//
// The inverse map (unicode char → byte value) lets us reconstruct the raw byte
// sequence from a sequence of GPT-2 BPE tokens, which can then be decoded as
// UTF-8 to obtain the original string (Greek letters, CJK characters, etc.).

let _gpt2InverseCache = null;

/**
 * Build and return the HuggingFace GPT-2 BPE inverse map: Unicode char → byte value.
 * The result is cached after first call.
 * @returns {Map<string, number>} Map from Unicode character to byte value (0–255)
 */
export function gpt2BytesToUnicodeInverse() {
  if (_gpt2InverseCache !== null) return _gpt2InverseCache;

  // Build the forward map (byte value → unicode codepoint) exactly as Python does
  const bs = [];
  // Printable ASCII: '!' (0x21) through '~' (0x7E)
  for (let b = 0x21; b <= 0x7E; b++) bs.push(b);
  // Extended: '¡' (0xA1) through '¬' (0xAC)
  for (let b = 0xA1; b <= 0xAC; b++) bs.push(b);
  // Extended: '®' (0xAE) through 'ÿ' (0xFF)
  for (let b = 0xAE; b <= 0xFF; b++) bs.push(b);

  // cs starts as a copy of bs; remaining bytes (not yet in bs) are mapped to 256+n
  const cs = [...bs];
  let n = 0;
  for (let b = 0; b < 256; b++) {
    if (!bs.includes(b)) {
      bs.push(b);
      cs.push(256 + n);
      n++;
    }
  }

  // Build the inverse map: Unicode char → byte value
  // Python's dict(zip(map(chr, cs), bs)) produces this directly
  const inverse = new Map();
  for (let i = 0; i < bs.length; i++) {
    inverse.set(String.fromCodePoint(cs[i]), bs[i]);
  }

  _gpt2InverseCache = inverse;
  return inverse;
}

/**
 * Decode a single GPT-2 BPE token string using the byte-level inverse map.
 *
 * Each character in the token string corresponds to a byte value via the
 * inverse map. Those byte values are assembled into a Uint8Array and decoded
 * as UTF-8. Characters that are NOT in the inverse map are passed through
 * as-is (e.g. characters that are already plain ASCII LaTeX like \, {, }).
 *
 * @param {string} token - A single BPE token as it appears in the vocabulary
 * @param {Map<string, number>} inverseMap - The GPT-2 BPE inverse map
 * @returns {string} Decoded UTF-8 string for this token
 */
export function decodeByteLevelToken(token, inverseMap) {
  const bytes = [];
  let allMapped = true;

  for (const ch of token) {
    const byteVal = inverseMap.get(ch);
    if (byteVal !== undefined) {
      bytes.push(byteVal);
    } else {
      // Character not in the map — treat as a literal (e.g. LaTeX backslash etc.)
      allMapped = false;
      break;
    }
  }

  if (!allMapped) {
    // Fall back: return the token as-is; it's likely a LaTeX command or operator
    return token;
  }

  // Decode byte sequence as UTF-8
  try {
    return new TextDecoder('utf-8').decode(new Uint8Array(bytes));
  } catch {
    // If decode fails (malformed sequence), return the raw token
    return token;
  }
}
