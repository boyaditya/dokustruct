/**
 * PORTING NOTE: hash_utils.py → hash_utils.js
 *
 * WORKAROUND: Python uses hashlib (synchronous) for MD5/SHA256
 * REASON: Browser SubtleCrypto API is asynchronous; MD5 is not natively
 *         supported (SHA-256 is). For MD5 compatibility a small pure-JS
 *         implementation is included.
 * SOLUTION: SHA-256 via SubtleCrypto.digest(); MD5 via inline pure-JS impl.
 *
 * AFFECTED METHODS: bytes_md5 → async bytesMd5(); str_sha256 → async strSha256()
 */

// ─── SHA-256 via SubtleCrypto ─────────────────────────────────────────────────

/**
 * Compute SHA-256 hex digest of a string.
 * @param {string} text
 * @returns {Promise<string>} hex string
 */
export async function strSha256(text) {
  const encoder = new TextEncoder();
  const data = encoder.encode(text);
  const hashBuffer = await crypto.subtle.digest('SHA-256', data);
  return bufferToHex(hashBuffer);
}

/**
 * Compute SHA-256 hex digest of an ArrayBuffer.
 * @param {ArrayBuffer} buffer
 * @returns {Promise<string>} hex string
 */
export async function bufferSha256(buffer) {
  const hashBuffer = await crypto.subtle.digest('SHA-256', buffer);
  return bufferToHex(hashBuffer);
}

// ─── MD5 (pure-JS, synchronous) ───────────────────────────────────────────────
// Minimal RFC 1321 implementation — used only for bytes_md5 compatibility.

/**
 * Compute MD5 hex digest of an ArrayBuffer or Uint8Array.
 * @param {ArrayBuffer|Uint8Array} input
 * @returns {string} hex string
 */
export function bytesMd5(input) {
  const bytes = input instanceof Uint8Array ? input : new Uint8Array(input);
  return md5Hex(bytes);
}

/**
 * Compute MD5 hex digest of a string.
 * @param {string} text
 * @returns {string} hex string
 */
export function strMd5(text) {
  const encoder = new TextEncoder();
  return bytesMd5(encoder.encode(text));
}

/**
 * Convert any value to a stable, hashable representation.
 * Mirrors Python: make_hashable(value)
 *
 * - dict/object → JSON-stringified with sorted keys
 *   (objects with a 'custom_model' key have that value replaced by its type name)
 * - array       → JSON-stringified with each element made hashable
 * - all others  → returned as-is
 *
 * @param {*} value
 * @returns {*}
 */
export function makeHashable(value) {
  if (value !== null && typeof value === 'object' && !Array.isArray(value)) {
    const result = {};
    for (const [k, v] of Object.entries(value)) {
      if (k === 'custom_model') {
        result[k] = v == null ? 'null' : (v.constructor?.name ?? typeof v);
      } else {
        result[k] = makeHashable(v);
      }
    }
    return JSON.stringify(result, Object.keys(result).sort());
  }
  if (Array.isArray(value)) {
    return JSON.stringify(value.map(makeHashable));
  }
  return value;
}

// ─── Helpers ──────────────────────────────────────────────────────────────────

/**
 * @param {ArrayBuffer} buffer
 * @returns {string}
 */
function bufferToHex(buffer) {
  return Array.from(new Uint8Array(buffer))
    .map(b => b.toString(16).padStart(2, '0'))
    .join('');
}

// ─── Minimal MD5 implementation ───────────────────────────────────────────────

function md5Hex(input) {
  // Based on the public-domain MD5 algorithm by Paul Johnston
  function safeAdd(x, y) {
    const lsw = (x & 0xffff) + (y & 0xffff);
    const msw = (x >> 16) + (y >> 16) + (lsw >> 16);
    return (msw << 16) | (lsw & 0xffff);
  }
  function bitRotateLeft(num, cnt) { return (num << cnt) | (num >>> (32 - cnt)); }
  function md5cmn(q, a, b, x, s, t) { return safeAdd(bitRotateLeft(safeAdd(safeAdd(a, q), safeAdd(x, t)), s), b); }
  function md5ff(a, b, c, d, x, s, t) { return md5cmn((b & c) | (~b & d), a, b, x, s, t); }
  function md5gg(a, b, c, d, x, s, t) { return md5cmn((b & d) | (c & ~d), a, b, x, s, t); }
  function md5hh(a, b, c, d, x, s, t) { return md5cmn(b ^ c ^ d, a, b, x, s, t); }
  function md5ii(a, b, c, d, x, s, t) { return md5cmn(c ^ (b | ~d), a, b, x, s, t); }

  function md5blk(s) {
    const md5blks = [];
    for (let i = 0; i < 64; i += 4) {
      md5blks[i >> 2] = s[i] + (s[i + 1] << 8) + (s[i + 2] << 16) + (s[i + 3] << 24);
    }
    return md5blks;
  }

  const length8 = input.length;
  const extra = length8 & 63;
  const tail = new Uint8Array(extra < 56 ? 64 : 128);
  for (let i = 0; i < extra; i++) tail[i] = input[length8 - extra + i];
  tail[extra] = 0x80;
  const length32 = length8 * 8;
  tail[tail.length - 8] = length32 & 0xff;
  tail[tail.length - 7] = (length32 >>> 8) & 0xff;
  tail[tail.length - 6] = (length32 >>> 16) & 0xff;
  tail[tail.length - 5] = (length32 >>> 24) & 0xff;

  let a = 0x67452301, b = 0xefcdab89, c = 0x98badcfe, d = 0x10325476;

  function cycle(block) {
    let aa = a, bb = b, cc = c, dd = d;
    a = md5ff(a,b,c,d,block[0],7,-680876936); d=md5ff(d,a,b,c,block[1],12,-389564586); c=md5ff(c,d,a,b,block[2],17,606105819); b=md5ff(b,c,d,a,block[3],22,-1044525330);
    a=md5ff(a,b,c,d,block[4],7,-176418897); d=md5ff(d,a,b,c,block[5],12,1200080426); c=md5ff(c,d,a,b,block[6],17,-1473231341); b=md5ff(b,c,d,a,block[7],22,-45705983);
    a=md5ff(a,b,c,d,block[8],7,1770035416); d=md5ff(d,a,b,c,block[9],12,-1958414417); c=md5ff(c,d,a,b,block[10],17,-42063); b=md5ff(b,c,d,a,block[11],22,-1990404162);
    a=md5ff(a,b,c,d,block[12],7,1804603682); d=md5ff(d,a,b,c,block[13],12,-40341101); c=md5ff(c,d,a,b,block[14],17,-1502002290); b=md5ff(b,c,d,a,block[15],22,1236535329);
    a=md5gg(a,b,c,d,block[1],5,-165796510); d=md5gg(d,a,b,c,block[6],9,-1069501632); c=md5gg(c,d,a,b,block[11],14,643717713); b=md5gg(b,c,d,a,block[0],20,-373897302);
    a=md5gg(a,b,c,d,block[5],5,-701558691); d=md5gg(d,a,b,c,block[10],9,38016083); c=md5gg(c,d,a,b,block[15],14,-660478335); b=md5gg(b,c,d,a,block[4],20,-405537848);
    a=md5gg(a,b,c,d,block[9],5,568446438); d=md5gg(d,a,b,c,block[14],9,-1019803690); c=md5gg(c,d,a,b,block[3],14,-187363961); b=md5gg(b,c,d,a,block[8],20,1163531501);
    a=md5gg(a,b,c,d,block[13],5,-1444681467); d=md5gg(d,a,b,c,block[2],9,-51403784); c=md5gg(c,d,a,b,block[7],14,1735328473); b=md5gg(b,c,d,a,block[12],20,-1926607734);
    a=md5hh(a,b,c,d,block[5],4,-378558); d=md5hh(d,a,b,c,block[8],11,-2022574463); c=md5hh(c,d,a,b,block[11],16,1839030562); b=md5hh(b,c,d,a,block[14],23,-35309556);
    a=md5hh(a,b,c,d,block[1],4,-1530992060); d=md5hh(d,a,b,c,block[4],11,1272893353); c=md5hh(c,d,a,b,block[7],16,-155497632); b=md5hh(b,c,d,a,block[10],23,-1094730640);
    a=md5hh(a,b,c,d,block[13],4,681279174); d=md5hh(d,a,b,c,block[0],11,-358537222); c=md5hh(c,d,a,b,block[3],16,-722521979); b=md5hh(b,c,d,a,block[6],23,76029189);
    a=md5hh(a,b,c,d,block[9],4,-640364487); d=md5hh(d,a,b,c,block[12],11,-421815835); c=md5hh(c,d,a,b,block[15],16,530742520); b=md5hh(b,c,d,a,block[2],23,-995338651);
    a=md5ii(a,b,c,d,block[0],6,-198630844); d=md5ii(d,a,b,c,block[7],10,1126891415); c=md5ii(c,d,a,b,block[14],15,-1416354905); b=md5ii(b,c,d,a,block[5],21,-57434055);
    a=md5ii(a,b,c,d,block[12],6,1700485571); d=md5ii(d,a,b,c,block[3],10,-1894986606); c=md5ii(c,d,a,b,block[10],15,-1051523); b=md5ii(b,c,d,a,block[1],21,-2054922799);
    a=md5ii(a,b,c,d,block[8],6,1873313359); d=md5ii(d,a,b,c,block[15],10,-30611744); c=md5ii(c,d,a,b,block[6],15,-1560198380); b=md5ii(b,c,d,a,block[13],21,1309151649);
    a=md5ii(a,b,c,d,block[4],6,-145523070); d=md5ii(d,a,b,c,block[11],10,-1120210379); c=md5ii(c,d,a,b,block[2],15,718787259); b=md5ii(b,c,d,a,block[9],21,-343485551);
    a=safeAdd(a,aa); b=safeAdd(b,bb); c=safeAdd(c,cc); d=safeAdd(d,dd);
  }

  const full = new Uint8Array(length8 - extra + tail.length);
  full.set(input.subarray(0, length8 - extra));
  full.set(tail, length8 - extra);

  for (let i = 0; i < full.length; i += 64) {
    cycle(md5blk(full.subarray(i, i + 64)));
  }

  function int32ToHex(val) {
    let hex = '';
    for (let j = 0; j < 4; j++) hex += ((val >>> (j * 8)) & 0xff).toString(16).padStart(2, '0');
    return hex;
  }
  return int32ToHex(a) + int32ToHex(b) + int32ToHex(c) + int32ToHex(d);
}