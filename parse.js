// Markdash — a fast Markdown renderer producing byte-identical HTML to marked
// 18.1.3 with its default options (GFM on, breaks off, pedantic off, async off).
// Written from scratch as a single-pass design: first-character block dispatch
// plus a hand-written inline scanner with a delimiter stack, rendering HTML
// directly instead of building token objects. Behaviour verified against
// marked itself; marked is the oracle, not the source.

// ---------------------------------------------------------------------------
// Small helpers
// ---------------------------------------------------------------------------

// Strip trailing characters equal to `ch` from the end of `s`.
function stripEnd(s, ch) {
  let n = s.length;
  while (n > 0 && s.charCodeAt(n - 1) === ch) n--;
  return n === s.length ? s : s.slice(0, n);
}

// Normalize a link reference label: trim, collapse whitespace runs to one
// space, then case-fold (the lower-upper-lower round trip folds a few extra
// Unicode characters the way marked does).
function normLabel(s) {
  return s.trim().replace(/\s+/g, ' ').toLowerCase().toUpperCase().toLowerCase();
}

// Find the index of the closing bracket of a pair in `s` (for link
// destinations with balanced parens). Returns the index of the first
// unmatched closer, -2 when openers are left unclosed, -1 when balanced.
function bracketEnd(s, open, close) {
  if (s.indexOf(open) === -1 && s.indexOf(close) === -1) return -1;
  let depth = 0;
  for (let i = 0; i < s.length; i++) {
    const c = s[i];
    if (c === '\\') { i++; continue; }
    if (c === open) depth++;
    else if (c === close) { depth--; if (depth < 0) return i; }
  }
  return depth > 0 ? -2 : -1;
}

// Clean a link destination the way marked does: encodeURI, then restore any
// literal percent signs. Returns null when encodeURI throws (lone surrogates),
// in which case the link renders as plain text.
function cleanUrl(href) {
  try {
    const e = encodeURI(href);
    // encodeURI turns a literal % into %25; marked restores it. Most hrefs
    // have no %, so skip the replace pass when there is nothing to restore.
    return e.indexOf('%25') === -1 ? e : e.replace(/%25/g, '%');
  } catch {
    return null;
  }
}

// ---------------------------------------------------------------------------
// HTML escaping
// ---------------------------------------------------------------------------

// Escape map for the five characters marked escapes.
const ESC_MAP = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' };

// Escape with encode=true: every & < > " ' is replaced. Used for code spans,
// autolink text/href, and code block contents.
function escapeAll(s) {
  if (!/[&<>"']/.test(s)) return s;
  let out = '';
  let start = 0;
  for (let i = 0; i < s.length; i++) {
    const code = s.charCodeAt(i);
    if (code === 38 || code === 60 || code === 62 || code === 34 || code === 39) {
      if (i > start) out += s.slice(start, i);
      out += code === 38 ? '&amp;' : code === 60 ? '&lt;' : code === 62 ? '&gt;' : code === 34 ? '&quot;' : '&#39;';
      start = i + 1;
    }
  }
  return start === 0 ? s : out + s.slice(start);
}

// Test whether the character at `i` in `s` (an ampersand) begins a sequence
// that looks like an entity reference: &#digits; / &#x hex; / word; — those
// are left alone by the no-encode escape.
function looksLikeEntity(s, i) {
  // s[i] === '&'; scan the candidate that follows.
  let j = i + 1;
  if (s[j] === '#') {
    j++;
    if (s[j] === 'x' || s[j] === 'X') {
      j++;
      const start = j;
      while (j < s.length && j - start < 6) {
        const c = s.charCodeAt(j);
        if (!((c >= 48 && c <= 57) || (c >= 65 && c <= 70) || (c >= 97 && c <= 102))) break;
        j++;
      }
      return j > start && s[j] === ';';
    }
    const start = j;
    while (j < s.length && j - start < 7 && s[j] >= '0' && s[j] <= '9') j++;
    return j > start && s[j] === ';';
  }
  const start = j;
  while (j < s.length) {
    const c = s.charCodeAt(j);
    if (!((c >= 48 && c <= 57) || (c >= 65 && c <= 90) || (c >= 97 && c <= 122) || c === 95)) break;
    j++;
  }
  return j > start && s[j] === ';';
}

// Decode one numeric character reference starting at `i` in `s` (s[i] is
// '&', followed by '#'). Returns [codePoint, endIndex] or null when the text
// is not a valid numeric reference (1-7 decimal digits or 1-6 hex digits,
// then a semicolon).
function numericRef(s, i) {
  let j = i + 2; // skip '&#'
  let hex = false;
  if (s[j] === 'x' || s[j] === 'X') { hex = true; j++; }
  const start = j;
  if (hex) {
    while (j < s.length && j - start < 6) {
      const c = s.charCodeAt(j);
      if (!((c >= 48 && c <= 57) || (c >= 65 && c <= 70) || (c >= 97 && c <= 102))) break;
      j++;
    }
  } else {
    while (j < s.length && j - start < 7 && s[j] >= '0' && s[j] <= '9') j++;
  }
  if (j === start || s[j] !== ';') return null;
  const cp = parseInt(s.slice(start, j), hex ? 16 : 10);
  return [cp, j + 1];
}

// Process one inline text run: decode numeric character references and escape
// the rest, exactly as marked's unescape-then-escape pipeline does. A decoded
// reference that yields < > " ' is re-escaped; &#38; becomes &amp; directly;
// code point 0, surrogates, and values above U+10FFFF become U+FFFD.
function textRun(s) {
  if (s.indexOf('&') === -1 && s.indexOf('<') === -1 && s.indexOf('>') === -1 &&
      s.indexOf('"') === -1 && s.indexOf("'") === -1) {
    return s;
  }
  let out = '';
  let start = 0;
  let i = 0;
  const n = s.length;
  while (i < n) {
    const code = s.charCodeAt(i);
    if (code === 38) { // &
      if (s.charCodeAt(i + 1) === 35) { // #
        const ref = numericRef(s, i);
        if (ref !== null) {
          const cp = ref[0];
          if (i > start) out += s.slice(start, i);
          if (cp === 0 || cp > 0x10ffff || (cp >= 0xd800 && cp <= 0xdfff)) {
            out += '\uFFFD';
          } else if (cp === 38) {
            out += '&amp;';
          } else if (cp === 60) {
            out += '&lt;';
          } else if (cp === 62) {
            out += '&gt;';
          } else if (cp === 34) {
            out += '&quot;';
          } else if (cp === 39) {
            out += '&#39;';
          } else {
            out += String.fromCodePoint(cp);
          }
          i = ref[1];
          start = i;
          continue;
        }
      }
      if (looksLikeEntity(s, i)) { i++; continue; }
      if (i > start) out += s.slice(start, i);
      out += '&amp;';
      i++;
      start = i;
      continue;
    }
    if (code === 60 || code === 62 || code === 34 || code === 39) {
      if (i > start) out += s.slice(start, i);
      out += code === 60 ? '&lt;' : code === 62 ? '&gt;' : code === 34 ? '&quot;' : '&#39;';
      i++;
      start = i;
      continue;
    }
    i++;
  }
  return start === 0 ? s : out + s.slice(start);
}

// Escape with encode=false (marked's default for text, hrefs, titles):
// < > " ' always escaped, & only when it does not begin an entity-looking
// sequence. The input has already been through textRun for text tokens, but
// hrefs and titles come here directly.
function escapeLoose(s) {
  if (!/[<>"']/.test(s) && s.indexOf('&') === -1) return s;
  let out = '';
  let start = 0;
  for (let i = 0; i < s.length; i++) {
    const code = s.charCodeAt(i);
    if (code === 38) { // &
      if (looksLikeEntity(s, i)) continue;
      if (i > start) out += s.slice(start, i);
      out += '&amp;';
      start = i + 1;
      continue;
    }
    if (code === 60 || code === 62 || code === 34 || code === 39) {
      if (i > start) out += s.slice(start, i);
      out += code === 60 ? '&lt;' : code === 62 ? '&gt;' : code === 34 ? '&quot;' : '&#39;';
      start = i + 1;
    }
  }
  return start === 0 ? s : out + s.slice(start);
}

// Remove backslash escapes before ASCII punctuation (used in link hrefs,
// titles, and fenced code info strings).
const ANY_PUNCT = /\\([\p{P}\p{S}])/gu;
function unescapePunct(s) {
  return ANY_PUNCT.test(s) ? s.replace(ANY_PUNCT, '$1') : s;
}

// ---------------------------------------------------------------------------
// Emphasis and strikethrough: marked's delimiter algorithm
// ---------------------------------------------------------------------------

// Left-delimiter test (GFM): a run of * or _ followed by a non-space char
// (punctuation in groups 1/3, other in groups 2/4). Tildes are not punctuation
// here, so a * run followed by ~ counts as followed by a non-punctuation char.
const LDELIM = /(?:\*+(?:((?!\*)(?!~)[\p{P}\p{S}])|([^\s*]))?)|_+(?:((?!_)(?!~)[\p{P}\p{S}])|([^\s_]))?/yu;

// Right-delimiter search for * (GFM). The first two alternatives skip text
// without delimiters; groups 1-2 are plain closers, groups 3-4 are
// opener-side runs, groups 5-6 are closers in punctuation context.
const RDELIM_AST = /^[^_*]*?__[^_*]*?\*[^_*]*?(?=__)|[^*]+(?=[^*])|(?!\*)(?!~)[\p{P}\p{S}](\*+)(?=[\s]|$)|(?:[^\s\p{P}\p{S}]|~)(\*+)(?!\*)(?=(?!~)[\s\p{P}\p{S}]|$)|(?!\*)(?!~)[\s\p{P}\p{S}](\*+)(?=(?:[^\s\p{P}\p{S}]|~))|[\s](\*+)(?!\*)(?=(?!~)[\p{P}\p{S}])|(?!\*)(?!~)[\p{P}\p{S}](\*+)(?!\*)(?=(?!~)[\p{P}\p{S}])|(?:[^\s\p{P}\p{S}]|~)(\*+)(?=(?:[^\s\p{P}\p{S}]|~))/gu;

// Right-delimiter search for _ (GFM). Same shape as the * one, with plain
// punctuation classes (tildes count as punctuation here).
const RDELIM_UND = /^[^_*]*?\*\*[^_*]*?_[^_*]*?(?=\*\*)|[^_]+(?=[^_])|(?!_)[\p{P}\p{S}](_+)(?=[\s]|$)|[^\s\p{P}\p{S}](_+)(?!_)(?=[\s\p{P}\p{S}]|$)|(?!_)[\s\p{P}\p{S}](_+)(?=[^\s\p{P}\p{S}])|[\s](_+)(?!_)(?=[\p{P}\p{S}])|(?!_)[\p{P}\p{S}](_+)(?!_)(?=[\p{P}\p{S}])/gu;

// Strikethrough delimiters (GFM). A run is one or two tildes.
const DEL_LDELIM = /~~?(?:((?!~)[\p{P}\p{S}])|[^\s~])/yu;
const DEL_RDELIM = /^[^~]+(?=[^~])|(?!~)[\p{P}\p{S}](~~?)(?=[\s]|$)|[^\s\p{P}\p{S}](~~?)(?!~)(?=[\s\p{P}\p{S}]|$)|(?!~)[\s\p{P}\p{S}](~~?)(?=[^\s\p{P}\p{S}])|[\s](~~?)(?!~)(?=[\p{P}\p{S}])|(?!~)[\p{P}\p{S}](~~?)(?!~)(?=[\p{P}\p{S}])|[^\s\p{P}\p{S}](~~?)(?=[^\s\p{P}\p{S}])/gu;

// One-character test: whitespace or punctuation, but not * or _.
const PUNCT_SPACE = /^((?![*_])[\s\p{P}\p{S}])/u;
const ALNUM = /[\p{L}\p{N}]/u;

// Scan a (masked) source for the last position where a closer run of each
// delimiter could start: a run whose preceding character is not whitespace.
function lastClosers(masked) {
  const out = { '*': -1, '_': -1, '~': -1 };
  const n = masked.length;
  for (let s = 0; s < n; s++) {
    const r = masked[s];
    if (r !== '*' && r !== '_' && r !== '~') continue;
    const before = s === 0 ? '\n' : masked[s - 1];
    let i = s + 1;
    while (i < n && masked[i] === r) i++;
    if (before !== ' ' && before !== '\t' && before !== '\n' && before !== '\r' && before !== '\f') {
      out[r] = s;
    }
    s = i - 1;
  }
  return out;
}

// --- Masking: hide delimiters that live inside code spans, links, images and
// HTML, so the closer search never matches them. The masked string keeps the
// original length, so indices still line up.

const PUNCT_OUTSIDE_CODE = /(`+)(?:[^`]|[^`][\s\S]*?[^`])\1(?!`)|`+|\\([\p{P}\p{S}])/gu;
const BLOCK_SKIP = /\[(?:[^\[\]`]|(?<a>`+)[^`]+\k<a>(?!`))*?\]\((?:\\[\s\S]|[^\[\]\\()]|\((?:\\[\s\S]|[^\[\]\\()])*\))*\)|(?<!`)()(?<b>`+)[^`]+\k<b>(?!`)|<(?! )[^<>]*?>/g;
const INLINE_LINK_RE = /^!?\[((?:\[(?:\[(?:\\[\s\S]|[^\[\]\\])*\]|\\[\s\S]|[^\[\]\\])*\]|\\[\s\S]|`+(?!`)[^`]*?`+(?!`)|``+(?=\])|[^\[\]\\`])*?)\]\([ \t\n]*(?:<(?:\\.|[^\n<>\\])+>|[^ \t\n\x00-\x1f]+|(?=\)))(?:(?:[ \t]+(?:\n[ \t]*)?|\n[ \t]*)("(?:\\[\s\S]|[^"\\])*"|'(?:\\[\s\S]|[^'\\])*'|\((?:\\[\s\S]|[^)\\])*\)))?[ \t\n]*\)/;

// Does `s` contain a link (inline or reference)? Used while masking.
function linkInText(s, links) {
  if (!s.includes('[')) return false;
  for (const m of s.matchAll(BLOCK_SKIP)) {
    if (INLINE_LINK_RE.test(m[0]) && s.charAt(m.index - 1) !== '!') return true;
  }
  for (const m of s.matchAll(REFLINK_SEARCH)) {
    const whole = m[0];
    const r = whole.lastIndexOf('[');
    if (!(whole.charAt(0) === '!' || !Object.hasOwn(links, normLabel(whole.slice(r + 1, -1)))) &&
        !(r > 1 && linkInText(whole.slice(1, r - 1), links))) {
      return true;
    }
  }
  return false;
}

function maskSrc(src, links) {
  let t = src;
  if (links && src.includes('[')) {
    const maskReflink = (m) => {
      const o = m.lastIndexOf('[');
      if (!Object.hasOwn(links, normLabel(m.slice(o + 1, -1)))) return m;
      if (o > 1 && m.charAt(0) !== '!') {
        const inner = m.slice(1, o - 1);
        if (linkInText(inner, links)) {
          return '[' + inner.replace(REFLINK_SEARCH, maskReflink) + '][' + 'a'.repeat(m.length - o - 2) + ']';
        }
      }
      return '[' + 'a'.repeat(m.length - 2) + ']';
    };
    t = t.replace(REFLINK_SEARCH, maskReflink);
  }
  // The code/escape mask only matters if the span has a backtick or a
  // backslash; the link/tag mask only if it has [, `, or <.
  if (src.includes('`') || src.includes('\\')) {
    t = t.replace(PUNCT_OUTSIDE_CODE, (m, ticks, punct) =>
      punct ? '+'.repeat(m.length)
        : ticks ? ticks + m.slice(ticks.length, -ticks.length).replace(/`/g, '+') + ticks
        : m);
  }
  if (src.includes('[') || src.includes('`') || src.includes('<')) {
    t = t.replace(BLOCK_SKIP, (m) => '[' + 'a'.repeat(m.length - 2) + ']');
  }
  return t;
}

// Try emphasis/strong at `pos` in `src`. `getMasked`/`getClosers` are lazy
// getters for the masked source and the last-closer indices: they are only
// invoked after the left-delimiter test passes, so spans whose delimiters
// never form emphasis never pay for the masking passes. `prev` is the
// previous character (last char of the preceding text token, or '').
// Returns {len, inner, strong} or null.
function tryEmphasis(src, getMasked, getClosers, pos, prev, render) {
  LDELIM.lastIndex = pos;
  const m = LDELIM.exec(src);
  if (!m || (!m[1] && !m[2] && !m[3] && !m[4])) return null;
  const masked = getMasked();
  const closers = getClosers();
  const delim = m[0][0];
  const prevIsDelim = prev === delim;
  const i = pos;
  let l = i;
  while (l > 0 && masked[l - 1] === delim) l--;
  // Last code point before the run (astral-aware): if the two code units
  // form a surrogate pair, the last code point is both of them.
  const beforeRun = masked.slice(Math.max(0, l - 2), l);
  let p = '';
  if (beforeRun) {
    const lastCode = beforeRun.charCodeAt(beforeRun.length - 1);
    p = beforeRun.length === 2 && lastCode >= 0xdc00 && lastCode <= 0xdfff &&
      beforeRun.charCodeAt(0) >= 0xd800 && beforeRun.charCodeAt(0) <= 0xdbff
      ? beforeRun : beforeRun.charAt(beforeRun.length - 1);
  }
  const h = p === '*' || p === '_' || PUNCT_SPACE.test(p);
  if (l < i) prev = p;
  const u = l < i ? h : PUNCT_SPACE.test(prev);
  if (m[4] && ALNUM.test(prev)) return null;
  const d = m[1] || m[3] || '';
  if (!d || !prev || u) {
    // Opening run length: the delimiter run starting at pos (delimiters are
    // ASCII, so the run length in code units is the run length).
    let k = 0;
    while (src[i + k] === delim) k++;
    let mm = k;
    let f = 0;
    const y = i - l + k;
    const R = !!p.trim() && (!!d || (delim === '*' && !h));
    if (delim !== '*' && delim !== '_') return null;
    const re = delim === '*' ? RDELIM_AST : RDELIM_UND;
    const v = closers[delim];
    const Q = i + k;
    if (v < Q) return null;
    const tail = masked.slice(Q);
    const ee = v - Q;
    re.lastIndex = 0;
    let s;
    while ((s = re.exec(tail)) !== null && !(s.index > ee)) {
      const g = s[1] || s[2] || s[3] || s[4] || s[5] || s[6];
      if (!g) continue;
      const b0 = g.length; // a delimiter run is pure ASCII
      if (s[3] || s[4]) { mm += b0; continue; }
      if (s[5] || s[6] || R) {
        if (prevIsDelim && (s[5] || s[6])) break;
        if (y % 3 && !((y + b0) % 3)) { f += b0; continue; }
      }
      mm -= b0;
      if (mm > 0) continue;
      const b = Math.min(b0, b0 + mm + f);
      // Length in code units of the match's first code point (1, or 2 for
      // an astral character): the delimiter run starts after it.
      const fc = s[0].charCodeAt(0);
      const te = fc >= 0xd800 && fc <= 0xdbff &&
        s[0].charCodeAt(1) >= 0xdc00 && s[0].charCodeAt(1) <= 0xdfff ? 2 : 1;
      const rawLen = k + s.index + te + b;
      const raw = src.slice(pos, pos + rawLen);
      if (Math.min(k, b) % 2) {
        return { len: rawLen, inner: raw.slice(1, -1), strong: false };
      }
      return { len: rawLen, inner: raw.slice(2, -2), strong: true };
    }
  }
  return null;
}

// Try strikethrough at `pos`. Same shape as emphasis, but the closer must have
// the same run length as the opener (1 or 2 tildes) and there is no rule of 3.
// `getMasked`/`getClosers` are lazy (see tryEmphasis).
function tryDel(src, getMasked, getClosers, pos, prev) {
  DEL_LDELIM.lastIndex = pos;
  const m = DEL_LDELIM.exec(src);
  if (!m) return null;
  if (!(m[1] || '') || !prev || PUNCT_SPACE.test(prev)) {
    const masked = getMasked();
    const closers = getClosers();
    // Opening run length (1 or 2): the greedy ~~? matched two tildes iff a
    // second tilde follows (a single tilde plus a ~ group char can never
    // match, so the regex cannot have matched just one when two are there).
    const o = src[pos + 1] === '~' ? 2 : 1;
    let p = o;
    const u = closers['~'];
    const d = pos + o;
    if (u < d) return null;
    const tail = masked.slice(d);
    const limit = u - d;
    DEL_RDELIM.lastIndex = 0;
    let s;
    while ((s = DEL_RDELIM.exec(tail)) !== null && !(s.index > limit)) {
      const g = s[1] || s[2] || s[3] || s[4] || s[5] || s[6];
      if (!g) continue;
      const len = g.length; // a tilde run is pure ASCII
      if (len !== o) continue;
      if (s[3] || s[4]) { p += len; continue; }
      p -= len;
      if (p > 0) continue;
      const use = Math.min(len, len + p);
      const fc = s[0].charCodeAt(0);
      const te = fc >= 0xd800 && fc <= 0xdbff &&
        s[0].charCodeAt(1) >= 0xdc00 && s[0].charCodeAt(1) <= 0xdfff ? 2 : 1;
      const rawLen = o + s.index + te + use;
      const raw = src.slice(pos, pos + rawLen);
      return { len: rawLen, inner: raw.slice(o, -o) };
    }
  }
  return null;
}

// ---------------------------------------------------------------------------
// Inline scanner
// ---------------------------------------------------------------------------

const ESCAPE_RE = /\\([!"#$%&'()*+,\-./:;<=>?@\[\]\\^_`{|}~])/y;
const CODE_RE = /(`+)([^`]|[^`][\s\S]*?[^`])\1(?!`)/y;
const BR_RE = /( {2,}|\\)\n(?!\s*$)[ \t]*/y;
const AUTOLINK_RE = /<([a-zA-Z][a-zA-Z0-9+.-]{1,31}:[^\s\x00-\x1f<>]*|[a-zA-Z0-9.!#$%&'*+\/=?^_`{|}~-]+(@)[a-zA-Z0-9](?:[a-zA-Z0-9-]{0,61}[a-zA-Z0-9])?(?:\.[a-zA-Z0-9](?:[a-zA-Z0-9-]{0,61}[a-zA-Z0-9])?)+(?![-_]))>/y;
const TAG_RE = /<!--(?:-?>|[\s\S]*?-->)|<\/[a-zA-Z][a-zA-Z0-9-]*\s*>|<[a-zA-Z][a-zA-Z0-9-]*(?:\s+[a-zA-Z:_][\w.:-]*(?:\s*=\s*"[^"]*"|\s*=\s*'[^']*'|\s*=\s*[^\s"'=<>`]+)?)*?\s*\/?>|<\?[\s\S]*?\?>|<![a-zA-Z]+\s[\s\S]*?>|<!\[CDATA\[[\s\S]*?\]\]>/y;
const START_A_TAG = /^<a /i;
const END_A_TAG = /^<\/a>/i;
const START_PRE_TAG = /^<(pre|code|kbd|script)(\s|>)/i;
const END_PRE_TAG = /^<\/(pre|code|kbd|script)(\s|>)/i;

const LABEL_PAT = /(?:\[(?:\[(?:\\[\s\S]|[^\[\]\\])*\]|\\[\s\S]|[^\[\]\\])*\]|\\[\s\S]|`+(?!`)[^`]*?`+(?!`)|``+(?=\])|[^\[\]\\`])*?/;
const REF_PAT = /(?:(?!\s*\])(?:\\[\s\S]|[^\[\]\\\n]|\n(?![ \t]*\n))+)/;
const REFLINK_SEARCH = new RegExp(
  '!?\\[(?:' + LABEL_PAT.source + ')\\]\\[(?!\\s*\\])(?:' + REF_PAT.source + ')\\]' +
  '|!?\\[(?!\\s*\\])(?:' + REF_PAT.source + ')\\](?:\\[\\])?(?!\\()',
  'g',
);
const LINK_RE = new RegExp('!?\\[(' + LABEL_PAT.source + ')\\]\\([ \t\n]*(<(?:\\\\.|[^\n<>\\\\])+>|[^ \t\n\x00-\x1f]+|(?=\\)))(?:(?:[ \t]+(?:\n[ \t]*)?|\n[ \t]*)("(?:\\\\[\\s\\S]|[^"\\\\])*"|\'(?:\\\\[\\s\\S]|[^\'\\\\])*\'|\\((?:\\\\[\\s\\S]|[^)\\\\])*\\)))?[ \t\n]*\\)', 'y');
const REFLINK_RE = new RegExp('!?\\[(' + LABEL_PAT.source + ')\\]\\[(' + REF_PAT.source + ')\\]', 'y');
const NOLINK_RE = new RegExp('!?\\[(' + REF_PAT.source + ')\\](?:\\[\\])?', 'y');
const URL_RE = /(?:mailto:[A-Za-z0-9._+-]+@[a-zA-Z0-9-_]+(?:\.[a-zA-Z0-9-_]*[a-zA-Z0-9])+(?![\w-])|xmpp:[A-Za-z0-9._+-]+@[a-zA-Z0-9-_]+(?:\.[a-zA-Z0-9-_]*[a-zA-Z0-9])+(?![\w-])(?:\/[A-Za-z0-9@.]+)?)|((?:[hH][tT][tT][pP][sS]?|[fF][tT][pP]):\/\/|www\.)(?:[a-zA-Z0-9\-]+\.?)+[^\s<]*|[A-Za-z0-9._+-]+(@)[a-zA-Z0-9-_]+(?:\.[a-zA-Z0-9-_]*[a-zA-Z0-9])+(?![\w-])/y;
const BACKPEDAL = /(?:[^?!.,:;*_'\"~()&]+|\([^)]*\)|&(?![a-zA-Z0-9]+;$)|[?!.,:;*_'\"~)]+(?!$))+/;

// Does the link text contain an HTML tag or autolink that runs past the end
// of the text? If so the link is invalid. Code spans must close inside the
// text; tags are matched against the full source from the `<`.
function tagOverruns(src, textStart, text) {
  if (!text.includes('<')) return false;
  for (let s = 0; s < text.length; s++) {
    if (text[s] === '\\') { s++; continue; }
    if (text[s] === '`') {
      CODE_RE.lastIndex = s;
      const m = CODE_RE.exec(text);
      if (m) { s += m[0].length - 1; continue; }
    }
    if (text[s] !== '<') continue;
    const at = textStart + s;
    TAG_RE.lastIndex = at;
    let m = TAG_RE.exec(src);
    if (!m) {
      AUTOLINK_RE.lastIndex = at;
      m = AUTOLINK_RE.exec(src);
    }
    if (m) {
      if (m[0].length > text.length - s) return true;
      s += m[0].length - 1;
    }
  }
  return false;
}

// Email characters for the extended-autolink text stop.
// Email local-part characters as a charCode lookup table (hot path).
const EMAIL_CHARS = new Uint8Array(128);
for (const c of 'abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789.!#$%&\'*+/=?`{|}~-_') {
  EMAIL_CHARS[c.charCodeAt(0)] = 1;
}
function isEmailChar(c) {
  const code = c.charCodeAt(0);
  return code < 128 && EMAIL_CHARS[code] === 1;
}

// Per-character class for the text scanner (ASCII only; non-ASCII code units
// are ordinary text): 1 = stop char (a delimiter or trigger), 2 = space.
const SCAN_CLASS = new Uint8Array(128);
for (const c of '\\<[!`*~_') SCAN_CLASS[c.charCodeAt(0)] = 1;
SCAN_CLASS[32] = 2;

// Scan a text run starting at `i`: return its end index. Stops before special
// characters, hard breaks, and positions where an autolink could start.
// `lastAt` is the index of the last @ in the span (-1 when there is none): an
// email can only start left of it, so every email check is gated on the scan
// position being left of it.
// Written with charCodeAt + lookup tables (no per-character string indexing
// or function calls) because this is one of the hottest loops in the parser.
function scanTextEnd(src, i, n, lastAt) {
  let j = i;
  const c0 = src.charCodeAt(i);
  if (c0 === 96 || c0 === 126) { // ` or ~
    while (j < n && src.charCodeAt(j) === c0) j++;
    if (j < n) {
      const nc = src.charCodeAt(j);
      if (nc === 96 || nc === 126) return j;
    }
  } else {
    j = i + 1;
  }
  // Stop immediately before a hard break (2+ spaces then newline).
  if (src.charCodeAt(j) === 32 && src.charCodeAt(j + 1) === 32) {
    let k = j;
    while (k < n && src.charCodeAt(k) === 32) k++;
    if (k < n && src.charCodeAt(k) === 10) return j;
  }
  // An email starting after leading spaces (e.g. right after a link): end
  // the run before it so the main loop can try the autolink regex.
  if (i < lastAt && c0 === 32) {
    let k = i;
    while (k < n && src.charCodeAt(k) === 32) k++;
    if (k <= lastAt) {
      const kc = src.charCodeAt(k);
      if (kc < 128 && EMAIL_CHARS[kc]) {
        let e = k;
        while (e < n) {
          const ec = src.charCodeAt(e);
          if (ec >= 128 || !EMAIL_CHARS[ec]) break;
          e++;
        }
        if (e < n && src.charCodeAt(e) === 64) return k;
      }
    }
  }
  // An email starting right after the run's first character: marked's text
  // rule stops the run there (its lookahead runs after the first char), so
  // without this the email is swallowed whenever the run starts right after
  // a link/image — e.g. "![x](y)\nPath@z.com", where the run starts at \n.
  // The loop below only treats chars at j > i as "preceding" chars, so the
  // char at i itself is never checked. (Skipped when the first char is an
  // email char: the main loop already tried the autolink regex at i.)
  if (j < lastAt && (c0 >= 128 || !EMAIL_CHARS[c0])) {
    const kc = src.charCodeAt(j);
    if (kc < 128 && EMAIL_CHARS[kc]) {
      let e = j;
      while (e < n) {
        const ec = src.charCodeAt(e);
        if (ec >= 128 || !EMAIL_CHARS[ec]) break;
        e++;
      }
      if (e < n && src.charCodeAt(e) === 64) return j;
    }
  }
  while (j < n) {
    const code = src.charCodeAt(j);
    if (code < 128) {
      const cls = SCAN_CLASS[code];
      if (cls === 1) return j;
      if (cls === 2) { // space run
        let k = j;
        while (k < n && src.charCodeAt(k) === 32) k++;
        if (k - j >= 2 && k < n && src.charCodeAt(k) === 10 && j > i && src.charCodeAt(j - 1) !== 32) {
          return j;
        }
        // An email starting right after the spaces: end the text run here so
        // the main loop can try the autolink regex at the email start.
        if (k <= lastAt) {
          const kc = src.charCodeAt(k);
          if (kc < 128 && EMAIL_CHARS[kc]) {
            let e = k;
            while (e < n) {
              const ec = src.charCodeAt(e);
              if (ec >= 128 || !EMAIL_CHARS[ec]) break;
              e++;
            }
            if (e < n && src.charCodeAt(e) === 64) return k;
          }
        }
        j = k;
        continue;
      }
      if (code === 104 || code === 72) { // h H: http:// or https://
        if ((src.charCodeAt(j + 1) | 32) === 116 && (src.charCodeAt(j + 2) | 32) === 116 &&
            (src.charCodeAt(j + 3) | 32) === 112) {
          const c4 = src.charCodeAt(j + 4) | 32;
          if (c4 === 115) { // https://
            if (src.charCodeAt(j + 5) === 58 && src.charCodeAt(j + 6) === 47 && src.charCodeAt(j + 7) === 47) return j;
          } else if (src.charCodeAt(j + 4) === 58 && src.charCodeAt(j + 5) === 47 && src.charCodeAt(j + 6) === 47) {
            return j;
          }
        }
      } else if (code === 102 || code === 70) { // f F: ftp://
        if ((src.charCodeAt(j + 1) | 32) === 116 && (src.charCodeAt(j + 2) | 32) === 112 &&
            src.charCodeAt(j + 3) === 58 && src.charCodeAt(j + 4) === 47 && src.charCodeAt(j + 5) === 47) {
          return j;
        }
      }
      if (code === 119 && j > i && src.charCodeAt(j + 1) === 119 && src.charCodeAt(j + 2) === 119 &&
          src.charCodeAt(j + 3) === 46) { // www.
        const before = src.charCodeAt(j - 1);
        if (before === 32 || before === 9 || before === 10 || before === 13 ||
            before === 42 || before === 95 || before === 126 || before === 40) {
          return j;
        }
      }
      if ((code === 109 || code === 120) && j > i) { // m x: mailto: / xmpp:
        const before = src.charCodeAt(j - 1);
        if (!((before >= 97 && before <= 122) || (before >= 65 && before <= 90) ||
              (before >= 48 && before <= 57))) {
          if (src.startsWith('mailto:', j) || src.startsWith('xmpp:', j)) return j;
        }
      }
      if (j < lastAt && !EMAIL_CHARS[code] && j + 1 < n) {
        const nc = src.charCodeAt(j + 1);
        if (nc < 128 && EMAIL_CHARS[nc]) {
          let k = j + 1;
          while (k < n) {
            const kc = src.charCodeAt(k);
            if (kc >= 128 || !EMAIL_CHARS[kc]) break;
            k++;
          }
          if (k < n && src.charCodeAt(k) === 64) return j + 1;
          // Not an email: do NOT skip the run (it may contain specials like *).
          j++;
          continue;
        }
      }
    } else if (j < lastAt && j + 1 < n) {
      // Non-ASCII char: never an email char itself, but an email may start
      // right after it.
      const nc = src.charCodeAt(j + 1);
      if (nc < 128 && EMAIL_CHARS[nc]) {
        let k = j + 1;
        while (k < n) {
          const kc = src.charCodeAt(k);
          if (kc >= 128 || !EMAIL_CHARS[kc]) break;
          k++;
        }
        if (k < n && src.charCodeAt(k) === 64) return j + 1;
        j++;
        continue;
      }
    }
    j++;
  }
  return n;
}

// Render one inline span to HTML. `links` is the reference-definition map,
// `st` the shared inline state {inLink, inRawBlock, linkEmitted}.
function inlineHtml(src, links, st) {
  if (!st) st = { inLink: false, inRawBlock: false, linkEmitted: false };
  const out = [];
  const n = src.length;
  if (n === 0) return '';
  // Fast path: a span with no inline constructs at all is a single text run.
  // Excluded: any delimiter or trigger char (` * _ ~ [ ! \ <), any autolink
  // starter (@, www., :// for http/https/ftp, mailto:, xmpp:), and any hard
  // break (2+ spaces before a newline — every such run contains '  \n' as a
  // substring, so one indexOf rules them all out). A lone \n is a soft break
  // and passes through textRun unchanged, and & is handled by textRun's
  // entity logic, so neither blocks the fast path. With none of these the
  // main loop would produce exactly one textRun(src) call anyway.
  if (src.indexOf('*') === -1 && src.indexOf('`') === -1 && src.indexOf('[') === -1 &&
      src.indexOf('_') === -1 && src.indexOf('~') === -1 && src.indexOf('!') === -1 &&
      src.indexOf('\\') === -1 && src.indexOf('<') === -1 && src.indexOf('@') === -1 &&
      src.indexOf('www.') === -1 && src.indexOf('://') === -1 &&
      src.indexOf('mailto:') === -1 && src.indexOf('xmpp:') === -1 &&
      src.indexOf('  \n') === -1) {
    return st.inRawBlock ? src : textRun(src);
  }
  const hasDelim = src.includes('*') || src.includes('_') || src.includes('~');
  // Index of the last @ in the span (-1 when there is none): an email can
  // only start left of it, so the email checks are gated on the position.
  const lastAt = src.lastIndexOf('@');
  // Masked source is built lazily: only emphasis/delimiter handling needs
  // it, and most spans with delimiters never attempt emphasis. (maskSrc
  // itself short-circuits cheaply when the span holds nothing to hide, so
  // no extra guard is needed here — an earlier guard just duplicated its
  // scans and measured slower.)
  let masked = null;
  const getMasked = () => (masked ??= hasDelim ? maskSrc(src, links) : src);
  let closers = null;
  const getClosers = () => (closers ??= lastClosers(getMasked()));
  let i = 0;
  let prev = '';
  let prevWasText = false;
  while (i < n) {
    if (!prevWasText) prev = '';
    prevWasText = false;
    const c = src[i];
    // Backslash escape.
    if (c === '\\') {
      ESCAPE_RE.lastIndex = i;
      const m = ESCAPE_RE.exec(src);
      if (m) {
        out.push(textRun(m[1]));
        i += m[0].length;
        continue;
      }
      // Backslash-newline is a hard break (handled by the br rule below);
      // a lone backslash is text.
      if (src[i + 1] === '\n') {
        BR_RE.lastIndex = i;
        const b = BR_RE.exec(src);
        if (b) {
          out.push('<br>');
          i += b[0].length;
          continue;
        }
      }
    }
    // Inline HTML tag.
    if (c === '<') {
      TAG_RE.lastIndex = i;
      const m = TAG_RE.exec(src);
      if (m) {
        const tag = m[0];
        if (!st.inLink && START_A_TAG.test(tag)) st.inLink = true;
        else if (st.inLink && END_A_TAG.test(tag)) st.inLink = false;
        if (!st.inRawBlock && START_PRE_TAG.test(tag)) st.inRawBlock = true;
        else if (st.inRawBlock && END_PRE_TAG.test(tag)) st.inRawBlock = false;
        out.push(tag);
        i += tag.length;
        continue;
      }
      AUTOLINK_RE.lastIndex = i;
      const a = AUTOLINK_RE.exec(src);
      if (a) {
        const text = a[1];
        const href = a[2] === '@' ? 'mailto:' + text : text;
        const clean = cleanUrl(href);
        if (clean === null) {
          out.push(escapeAll(text));
        } else {
          out.push('<a href="' + escapeAll(clean) + '">' + escapeAll(text) + '</a>');
        }
        i += a[0].length;
        continue;
      }
    }
    // Links and images.
    if (c === '[' || (c === '!' && src[i + 1] === '[')) {
      const isImage = c === '!';
      let made = false;
      // An inline link needs "](" after the label; without it LINK_RE cannot
      // match, so skip the (expensive) regex attempt entirely.
      if (src.indexOf('](', i) !== -1) {
        LINK_RE.lastIndex = i;
        const m = LINK_RE.exec(src);
        if (m) {
          const textStart = i + (isImage ? 2 : 1);
          if (!tagOverruns(src, textStart, m[1])) {
            let href = m[2].trim();
            let title = '';
            let ok = true;
            let rawLen = m[0].length;
            if (href.charAt(0) === '<') {
              if (href.charAt(href.length - 1) !== '>') ok = false;
              else {
                const stripped = stripEnd(href.slice(0, -1), 92);
                if ((href.length - stripped.length) % 2 === 0) ok = false;
              }
            } else {
              const be = bracketEnd(m[2], '(', ')');
              if (be === -2) ok = false;
              else if (be > -1) {
                const h = (isImage ? 5 : 4) + m[1].length + be;
                href = m[2].substring(0, be);
                rawLen = m[0].substring(0, h).trimEnd().length;
                title = '';
                m[3] = undefined;
              }
            }
            if (ok) {
              const rawSoFar = src.slice(i, i + rawLen);
              const stripped = stripEnd(rawSoFar.slice(0, -1), 92);
              if ((rawSoFar.length - stripped.length) % 2 === 0) ok = false;
            }
            if (ok) {
              title = m[3] ? m[3].slice(1, -1) : '';
              href = href.trim();
              if (href.charAt(0) === '<') href = href.slice(1, -1);
              href = href ? unescapePunct(href) : href;
              title = title ? unescapePunct(title) : title;
              const labelText = m[1].replace(/\\([\[\]])/g, '$1');
              const savedLink = st.inLink;
              const savedEmitted = st.linkEmitted;
              const savedRaw = st.inRawBlock;
              st.inLink = true;
              st.linkEmitted = false;
              const inner = inlineHtml(labelText, links, st);
              const emittedInside = st.linkEmitted;
              st.linkEmitted = savedEmitted;
              st.inLink = savedLink;
              if (isImage || !emittedInside) {
                if (!isImage) st.linkEmitted = true;
                if (isImage) {
                  const alt = plainInline(labelText, links, st);
                  const clean = cleanUrl(href);
                  if (clean === null) {
                    out.push(escapeLoose(alt));
                  } else {
                    out.push('<img src="' + escapeLoose(clean) + '" alt="' + escapeLoose(alt) + '"' +
                      (title ? ' title="' + escapeLoose(title) + '"' : '') + '>');
                  }
                } else {
                  const clean = cleanUrl(href);
                  if (clean === null) {
                    out.push(inner);
                  } else {
                    out.push('<a href="' + escapeLoose(clean) + '"' +
                      (title ? ' title="' + escapeLoose(title) + '"' : '') + '>' + inner + '</a>');
                  }
                }
                i += rawLen;
                made = true;
              } else {
                st.inRawBlock = savedRaw;
              }
            }
          }
        }
      }
      if (made) continue;
      // Reference links (full, collapsed, shortcut).
      REFLINK_RE.lastIndex = i;
      let rm = REFLINK_RE.exec(src);
      if (!rm) {
        NOLINK_RE.lastIndex = i;
        rm = NOLINK_RE.exec(src);
      }
      if (rm) {
        const textStart = i + (isImage ? 2 : 1);
        const label = rm[2] !== undefined ? rm[2] : rm[1];
        const ref = links[normLabel(label)];
        if (ref && !tagOverruns(src, textStart, rm[1])) {
          const labelText = rm[1].replace(/\\([\[\]])/g, '$1');
          const savedLink = st.inLink;
          const savedEmitted = st.linkEmitted;
          const savedRaw = st.inRawBlock;
          st.inLink = true;
          st.linkEmitted = false;
          const inner = inlineHtml(labelText, links, st);
          const emittedInside = st.linkEmitted;
          st.linkEmitted = savedEmitted;
          st.inLink = savedLink;
          if (isImage || !emittedInside) {
            if (!isImage) st.linkEmitted = true;
            if (isImage) {
              const alt = plainInline(labelText, links, st);
              const clean = cleanUrl(ref.href);
              if (clean === null) {
                out.push(escapeLoose(alt));
              } else {
                out.push('<img src="' + escapeLoose(clean) + '" alt="' + escapeLoose(alt) + '"' +
                  (ref.title ? ' title="' + escapeLoose(ref.title) + '"' : '') + '>');
              }
            } else {
              const clean = cleanUrl(ref.href);
              if (clean === null) {
                out.push(inner);
              } else {
                out.push('<a href="' + escapeLoose(clean) + '"' +
                  (ref.title ? ' title="' + escapeLoose(ref.title) + '"' : '') + '>' + inner + '</a>');
              }
            }
            i += rm[0].length;
            continue;
          }
          st.inRawBlock = savedRaw;
        }
        // Undefined reference: the [ (or !) is literal text; re-scan the rest.
        out.push(st.inRawBlock ? c : textRun(c));
        i++;
        continue;
      }
    }
    // Emphasis / strong.
    if (c === '*' || c === '_') {
      const em = tryEmphasis(src, getMasked, getClosers, i, prev);
      if (em) {
        const inner = inlineHtml(em.inner, links, st);
        out.push(em.strong ? '<strong>' + inner + '</strong>' : '<em>' + inner + '</em>');
        i += em.len;
        continue;
      }
    }
    // Code span.
    if (c === '`') {
      CODE_RE.lastIndex = i;
      const m = CODE_RE.exec(src);
      if (m) {
        let text = m[2].replace(/\n/g, ' ');
        if (/[^ ]/.test(text) && text.charAt(0) === ' ' && text.charAt(text.length - 1) === ' ') {
          text = text.substring(1, text.length - 1);
        }
        out.push('<code>' + escapeAll(text) + '</code>');
        i += m[0].length;
        continue;
      }
    }
    // Hard break (two spaces + newline).
    if (c === ' ') {
      BR_RE.lastIndex = i;
      const m = BR_RE.exec(src);
      if (m) {
        out.push('<br>');
        i += m[0].length;
        continue;
      }
    }
    // Strikethrough.
    if (c === '~') {
      const d = tryDel(src, getMasked, getClosers, i, prev);
      if (d) {
        const inner = inlineHtml(d.inner, links, st);
        out.push('<del>' + inner + '</del>');
        i += d.len;
        continue;
      }
    }
    // GFM extended autolinks (www. / scheme / bare email), not inside a link.
    // URL_RE can only match at i when the character there starts an
    // autolink: w (www.), h/H/f/F (scheme), m/x (mailto:/xmpp:), or an email
    // character (the email alternative's first-char class is a subset of the
    // email-char table, and no email can start at or after the last @).
    if (!st.inLink && (c === 'w' || c === 'h' || c === 'H' || c === 'f' || c === 'F' ||
        c === 'm' || c === 'x' || (i < lastAt && isEmailChar(c)))) {
      URL_RE.lastIndex = i;
      const m = URL_RE.exec(src);
      if (m) {
        let text;
        let href;
        if (m[2] === '@') {
          text = m[0];
          href = 'mailto:' + text;
        } else {
          let u = m[0];
          let prevU;
          do {
            prevU = u;
            BACKPEDAL.lastIndex = 0;
            const b = BACKPEDAL.exec(u);
            u = b ? b[0] : '';
          } while (u !== prevU);
          text = u;
          href = m[1] === 'www.' ? 'http://' + u : u;
        }
        const clean = cleanUrl(href);
        if (clean === null) {
          out.push(escapeAll(text));
        } else {
          out.push('<a href="' + escapeAll(clean) + '">' + escapeAll(text) + '</a>');
        }
        i += text.length;
        continue;
      }
    }
    // Plain text run.
    const end = scanTextEnd(src, i, n, lastAt);
    const run = src.slice(i, end);
    if (st.inRawBlock) {
      out.push(run);
    } else {
      out.push(textRun(run));
    }
    const lastCh = run.charAt(run.length - 1);
    if (lastCh !== '_') prev = lastCh;
    prevWasText = true;
    i = end;
  }
  return out.join('');
}

// Render an inline span to plain text (image alt text): emphasis markers are
// dropped, code spans and HTML keep their raw text, links keep their text.
function plainInline(src, links, st) {
  // Render HTML and strip tags. Images contribute their alt text (an inner
  // image's label is plain text, not an empty tag).
  const html = inlineHtml(src, links, st);
  const ents = { lt: '<', gt: '>', quot: '"', amp: '&', '#39': "'" };
  return html
    .replace(/<img[^>]*alt="([^"]*)"[^>]*>/g, (_, a) => a.replace(/&(lt|gt|quot|amp|#39);/g, (_, e) => ents[e]))
    .replace(/<[^>]*>/g, '');
}

// ---------------------------------------------------------------------------
// Block parser (line based, over the normalized source string)
// ---------------------------------------------------------------------------

// Block tag names that start an HTML block (type 6).
const BLOCK_TAGS = new Set(('address|article|aside|base|basefont|blockquote|body|caption|center|col|colgroup|dd|details|dialog|dir|div|dl|dt|fieldset|figcaption|figure|footer|form|frame|frameset|h1|h2|h3|h4|h5|h6|head|header|hr|html|iframe|legend|li|link|main|menu|menuitem|meta|nav|noframes|ol|optgroup|option|p|param|search|section|summary|table|tbody|td|tfoot|th|thead|title|tr|track|ul').split('|'));

// Link reference definition regex (marked's def rule).
const DEF_RE = new RegExp(' {0,3}\\[((' + REF_PAT.source.slice(3, -1) + '))\\]: *(?:\\n[ \\t]*)?([^<\\s][^\\s]*|<.*?>)(?:(?: +(?:\\n[ \\t]*)?| *\\n[ \\t]*)(("(?:\\\\[\\s\\S]|[^"\\\\])*"|\'(?:\\\\[\\s\\S]|[^\'\\\\\\n]|\\n(?!\\n))*\'|\\((?:\\\\[\\s\\S]|[^()\\\\])*\\))))? *(?:\\n+|$)', 'y');

// Get the line starting at `pos`: [lineText (no newline), nextPos].
function getLine(src, pos) {
  const e = src.indexOf('\n', pos);
  if (e === -1) return [src.slice(pos), src.length];
  return [src.slice(pos, e), e + 1];
}

// Indent info for a line: columns of leading whitespace (tab advances to a
// multiple of 4) and the index of the first non-space/tab character.
function indentInfo(line) {
  let cols = 0;
  let idx = 0;
  while (idx < line.length) {
    const c = line.charCodeAt(idx);
    if (c === 32) { cols++; idx++; }
    else if (c === 9) { cols += 4 - (cols % 4); idx++; }
    else break;
  }
  return { cols, idx };
}

function isBlankLine(line) {
  for (let i = 0; i < line.length; i++) {
    const c = line.charCodeAt(i);
    if (c !== 32 && c !== 9) return false;
  }
  return true;
}

// Does `s` end with a blank line (a newline, optional spaces/tabs, another
// newline, optional spaces/tabs, end)? Equivalent to /\n[ \t]*\n[ \t]*$/.
function endsWithBlankLine(s) {
  let i = s.length;
  while (i > 0) {
    const c = s.charCodeAt(i - 1);
    if (c !== 32 && c !== 9) break;
    i--;
  }
  if (i === 0 || s.charCodeAt(i - 1) !== 10) return false;
  i--;
  while (i > 0) {
    const c = s.charCodeAt(i - 1);
    if (c !== 32 && c !== 9) break;
    i--;
  }
  return i > 0 && s.charCodeAt(i - 1) === 10;
}

// Remove up to `cols` columns of leading indent from a line. A tab straddling
// the boundary becomes spaces.
function stripColumns(line, cols) {
  let taken = 0;
  let idx = 0;
  while (idx < line.length && taken < cols) {
    const c = line.charCodeAt(idx);
    if (c === 32) { taken++; idx++; }
    else if (c === 9) {
      const adv = 4 - (taken % 4);
      if (taken + adv <= cols) { taken += adv; idx++; }
      else {
        const left = taken + adv - cols;
        return ' '.repeat(left) + line.slice(idx + 1);
      }
    } else break;
  }
  return line.slice(idx);
}

// Expand leading tabs to spaces, starting at column `base` (marked's J).
function expandLeadingTabs(line, base) {
  let col = base;
  let out = '';
  let i = 0;
  while (i < line.length) {
    const c = line[i];
    if (c === '\t') {
      const adv = 4 - (col % 4);
      out += ' '.repeat(adv);
      col += adv;
      i++;
    } else if (c === ' ') {
      out += c;
      col++;
      i++;
    } else break;
  }
  return out + line.slice(i);
}

// Trim trailing blank lines the way marked's `ge` does: 0-1 trailing blank
// lines are kept, 2+ are all removed.
function trimTrailingBlanks(raw) {
  const lines = raw.split('\n');
  let t = lines.length - 1;
  while (t >= 0 && isBlankLine(lines[t])) t--;
  if (lines.length - t <= 2) return raw;
  return lines.slice(0, t + 1).join('\n');
}

const CODE_REMOVE_INDENT = /^(?: {0,3}\t| {1,4})/gm;

// Is this line a thematic break (3+ of -, _, or * with spaces/tabs only)?
function isHrLine(line, idx) {
  const ch = line[idx];
  if (ch !== '-' && ch !== '_' && ch !== '*') return false;
  let count = 0;
  for (let i = idx; i < line.length; i++) {
    const c = line[i];
    if (c === ch) count++;
    else if (c !== ' ' && c !== '\t') return false;
  }
  return count >= 3;
}

// Is this line a setext underline (1+ of = or - with spaces/tabs only)?
function setextLevel(line, idx) {
  const ch = line[idx];
  if (ch !== '=' && ch !== '-') return 0;
  let i = idx;
  while (i < line.length && line[i] === ch) i++;
  while (i < line.length && (line[i] === ' ' || line[i] === '\t')) i++;
  return i === line.length ? (ch === '=' ? 1 : 2) : 0;
}

// Does this line start an HTML block? Returns the block type (1-7) or 0.
// Type 1: script/pre/style/textarea open tag. Type 2: comment. Type 3: <?.
// Type 4: <!A declaration. Type 5: <![CDATA[. Type 6: block tag open/close.
// Type 7: complete open/close tag alone on the line.
function htmlBlockType(line, idx) {
  if (line[idx] !== '<') return 0;
  const rest = line.slice(idx + 1);
  if (rest.startsWith('!--')) return 2;
  if (rest.startsWith('?')) return 3;
  if (rest.startsWith('![CDATA[')) return 5;
  if (rest.charAt(0) === '!' && /[A-Z]/.test(rest.charAt(1))) return 4;
  const m = /^<\/?([A-Za-z][A-Za-z0-9-]*)/.exec(line.slice(idx));
  if (!m) return 0;
  const tag = m[1].toLowerCase();
  const after = line.slice(idx + m[0].length);
  if ((tag === 'script' || tag === 'pre' || tag === 'style' || tag === 'textarea') &&
      line[idx + 1] !== '/' && (after === '' || after.charAt(0) === ' ' || after.charAt(0) === '\t' || after.charAt(0) === '>' || after.charAt(0) === '\n')) {
    return 1;
  }
  if (BLOCK_TAGS.has(tag)) {
    // Type 6 needs the tag followed by space, newline, / or > (or end).
    if (after === '' || after.charAt(0) === ' ' || after.charAt(0) === '\t' || after.charAt(0) === '\n' || after.charAt(0) === '/' || after.charAt(0) === '>') {
      return 6;
    }
    return 0;
  }
  // Type 7: complete open or close tag, alone on the line (only whitespace
  // after the tag). Not for script/pre/style/textarea.
  if (tag === 'script' || tag === 'pre' || tag === 'style' || tag === 'textarea') return 0;
  const tagRe = line[idx + 1] === '/'
    ? /^<\/[a-zA-Z][a-zA-Z0-9-]*\s*>/
    : /^<[a-zA-Z][a-zA-Z0-9-]*(?:\s+[a-zA-Z:_][\w.:-]*(?:\s*=\s*"[^"\n]*"|\s*=\s*'[^'\n]*'|\s*=\s*[^\s"'=<>`]+)?)*?\s*\/?>/;
  const tm = tagRe.exec(line.slice(idx));
  if (tm && /^[ \t]*$/.test(line.slice(idx + tm[0].length))) return 7;
  return 0;
}

// Split a table row on unescaped pipes (marked's `de`). `count` pads or
// truncates the result; without it the raw cell list is returned.
function splitCells(row, count) {
  const parts = [];
  let cur = '';
  let i = 0;
  while (i < row.length) {
    const c = row[i];
    if (c === '\\' && row[i + 1] === '|') {
      cur += '\\|';
      i += 2;
      continue;
    }
    if (c === '|') {
      parts.push(cur);
      cur = '';
      i++;
      continue;
    }
    cur += c;
    i++;
  }
  parts.push(cur);
  // Drop one empty leading / trailing cell (from edge pipes).
  if (parts.length > 0 && parts[0].trim() === '') parts.shift();
  if (parts.length > 0 && parts[parts.length - 1].trim() === '') parts.pop();
  if (count !== undefined) {
    if (parts.length > count) parts.length = count;
    while (parts.length < count) parts.push('');
  }
  for (let j = 0; j < parts.length; j++) {
    parts[j] = parts[j].trim().replace(/\\\|/g, '|');
  }
  return parts;
}

// Parse a table delimiter row: returns the alignment list (per column) or
// null when the line is not a delimiter row.
function parseDelimiterRow(line, idx) {
  let s = line.slice(idx);
  // Strip one leading and one trailing pipe (with surrounding spaces).
  s = s.replace(/^\|/, '').replace(/\| *$/, '');
  const cells = s.split('|');
  const aligns = [];
  for (const cell of cells) {
    const t = cell.trim();
    if (!/^:?-+:?$/.test(t)) return null;
    if (/^ *-+: *$/.test(cell)) aligns.push('right');
    else if (/^ *:-+: *$/.test(cell)) aligns.push('center');
    else if (/^ *:-+ *$/.test(cell)) aligns.push('left');
    else aligns.push(null);
  }
  return aligns;
}

// Does `line` (a single line, no newline) start a block within `maxSpaces`
// spaces of indent? Used for list continuation breaks: fence, heading, HTML
// begin, blockquote, bullet/ordered marker, thematic break.
function blockStartWithin(line, maxSpaces) {
  let sp = 0;
  while (sp < line.length && line[sp] === ' ') sp++;
  if (sp > maxSpaces) return false;
  const rest = line.slice(sp);
  if (rest.startsWith('```') || rest.startsWith('~~~')) return true;
  if (/^#{1,6}(?:\s|$)/.test(rest)) return true;
  if (rest.charAt(0) === '>') return true;
  if (/^(?:[*+-]|\d{1,9}[.)])(?:[ \t]|$)/.test(rest)) return true;
  if (isHrLine(line, sp)) return true;
  if (rest.charAt(0) === '<') {
    if (rest.startsWith('<!--') || rest.startsWith('<?') || rest.startsWith('<![CDATA[')) return true;
    if (rest.charAt(1) === '!' && /[A-Za-z]/.test(rest.charAt(2))) return true;
    const m = /^<\/?([A-Za-z][A-Za-z0-9-]*)/.exec(rest);
    if (m) {
      const tag = m[1].toLowerCase();
      const after = rest.slice(m[0].length);
      if (BLOCK_TAGS.has(tag) &&
          (after === '' || after.charAt(0) === ' ' || after.startsWith('/>') || after.startsWith('>'))) {
        return true;
      }
      if ((tag === 'script' || tag === 'pre' || tag === 'style' || tag === 'textarea') &&
          rest.charAt(1) !== '/' && (after === '' || /[\s>]/.test(after.charAt(0)))) {
        return true;
      }
    }
  }
  return false;
}

// Does stripped content `s` start a fence, heading, HTML block, or hr?
function startsBlock(s) {
  if (s.startsWith('```') || s.startsWith('~~~')) return true;
  if (/^#{1,6}(?:\s|$)/.test(s)) return true;
  if (isHrLine(s, 0)) return true;
  if (s.charAt(0) === '<') {
    const t = htmlBlockType(s, 0);
    if (t > 0) return true;
  }
  return false;
}

// Would `${content}\n${underline}` form a setext heading? (Approximation of
// marked's lheading test for the list lazy-line case.)
function isSetextPair(content, underline) {
  if (!content.trim()) return false;
  if (setextLevel(underline, indentInfo(underline).idx) === 0) return false;
  const first = content.charAt(0);
  if (first === '>' || first === '#' || first === '<') return false;
  if (content.startsWith('```') || content.startsWith('~~~')) return false;
  if (/^(?:[*+-]|\d{1,9}[.)])(?:[ \t]|$)/.test(content)) return false;
  if (isHrLine(content, 0)) return false;
  return true;
}

// Parse blocks from `src`. Returns [blocks, blankSeparated], where
// blankSeparated is true when two blocks were separated by a blank line
// (used for list looseness). `top` false makes paragraph-like blocks bare
// text (tight list items).
function parseBlocks(src, links, top) {
  const blocks = [];
  const n = src.length;
  let pos = 0;
  let blankSep = false;
  let seenBlock = false;
  // marked's Lexer.state.top is MUTABLE: blockTokens returns with top=true,
  // and the list tokenizer does not restore it — so once a nested list has
  // been lexed inside an item (top=false), every later block in that item
  // is lexed with top=true (real paragraphs, not single-line text tokens).
  // The blockquote tokenizer saves/restores top, so only lists flip it.
  let curTop = top;
  while (pos < n) {
    // Skip blank lines, remembering whether any were skipped between blocks.
    let skippedBlank = false;
    while (pos < n) {
      const [line, next] = getLine(src, pos);
      if (!isBlankLine(line)) break;
      skippedBlank = true;
      pos = next;
    }
    if (pos >= n) break;
    if (seenBlock && skippedBlank) blankSep = true;
    const [line, next] = getLine(src, pos);
    const { cols, idx } = indentInfo(line);
    const first = line[idx];
    // Indented code.
    if (cols >= 4) {
      let p = pos;
      while (p < n) {
        const [l2, n2] = getLine(src, p);
        if (isBlankLine(l2)) { p = n2; continue; }
        if (indentInfo(l2).cols >= 4) { p = n2; continue; }
        break;
      }
      const raw = src.slice(pos, p);
      const text = trimTrailingBlanks(raw).replace(CODE_REMOVE_INDENT, '');
      blocks.push(['code', '', text, true]);
      pos = p;
      seenBlock = true;
      continue;
    }
    // Fenced code.
    if (first === '`' || first === '~') {
      let len = 0;
      while (line[idx + len] === first) len++;
      if (len >= 3) {
        const info = line.slice(idx + len);
        if (first !== '`' || !info.includes('`')) {
          const contentLines = [];
          let p = next;
          while (p < n) {
            const [l2, n2] = getLine(src, p);
            let sp = 0;
            while (sp < l2.length && l2[sp] === ' ') sp++;
            let isClose = false;
            if (sp <= 3) {
              let run = 0;
              while (l2[sp + run] === first) run++;
              if (run >= len && /^ *$/.test(l2.slice(sp + run))) isClose = true;
            }
            if (isClose) { p = n2; break; }
            contentLines.push(l2);
            p = n2;
          }
          // Dedent by the opening fence's indent (backtick fences only).
          let text = contentLines.join('\n');
          if (first === '`' && idx > 0) {
            text = contentLines.map((l2) => {
              const m = /^[ \t]*/.exec(l2);
              const lead = m ? m[0].length : 0;
              return l2.slice(Math.min(lead, idx));
            }).join('\n');
          }
          const lang = info.trim() ? unescapePunct(info.trim()) : '';
          blocks.push(['code', lang, text]);
          pos = p;
          seenBlock = true;
          continue;
        }
      }
    }
    // ATX heading.
    if (first === '#') {
      let depth = 0;
      while (line[idx + depth] === '#') depth++;
      if (depth >= 1 && depth <= 6) {
        const after = line[idx + depth];
        if (after === undefined || after === ' ' || after === '\t' || /\s/.test(after)) {
          let text = line.slice(idx + depth).trim();
          if (text.endsWith('#')) {
            const stripped = stripEnd(text, 35);
            if (!stripped || stripped.endsWith(' ') || stripped.endsWith('\t')) {
              text = stripped.trim();
            }
          }
          blocks.push(['h', depth, text]);
          pos = next;
          seenBlock = true;
          continue;
        }
      }
    }
    // Thematic break.
    if ((first === '-' || first === '_' || first === '*') && isHrLine(line, idx)) {
      blocks.push(['hr']);
      pos = next;
      seenBlock = true;
      continue;
    }
    // Blockquote.
    if (first === '>') {
      const [block, endPos] = parseBlockquote(src, pos, links);
      blocks.push(block);
      pos = endPos;
      seenBlock = true;
      continue;
    }
    // List.
    if (first === '-' || first === '+' || first === '*' ||
        (first >= '0' && first <= '9')) {
      const listRes = parseList(src, pos, links);
      if (listRes) {
        blocks.push(listRes[0]);
        pos = listRes[1];
        seenBlock = true;
        curTop = true; // lexing the list's items left marked's state.top true
        continue;
      }
    }
    // HTML block.
    if (first === '<') {
      const htype = htmlBlockType(line, idx);
      if (htype > 0) {
        const [block, endPos] = parseHtmlBlock(src, pos, htype);
        blocks.push(block);
        pos = endPos;
        seenBlock = true;
        continue;
      }
    }
    // Link reference definition.
    if (first === '[') {
      DEF_RE.lastIndex = pos;
      const dm = DEF_RE.exec(src);
      if (dm) {
        const dest = dm[3];
        let ok = true;
        if (dest.charAt(0) !== '<' && bracketEnd(dest, '(', ')') !== -1) ok = false;
        if (ok) {
          const tag = normLabel(dm[1]);
          if (!Object.hasOwn(links, tag)) {
            const href = dest.replace(/^<(.*)>$/, '$1');
            const title = dm[4] ? dm[4].substring(1, dm[4].length - 1) : '';
            links[tag] = {
              href: href ? unescapePunct(href) : href,
              title: title ? unescapePunct(title) : title,
            };
          }
          pos += dm[0].length;
          // A def renders nothing; it does not count as a block for blankSep.
          continue;
        }
      }
    }
    // Paragraph (with table / setext checks).
    const [block, endPos] = parseParagraph(src, pos, links, curTop);
    blocks.push(block);
    pos = endPos;
    seenBlock = true;
  }
  return [blocks, blankSep];
}

// Parse a paragraph starting at `pos`: collect lines, then check for a table
// (delimiter row on line 2) or a setext heading (underline last / next).
function parseParagraph(src, pos, links, top) {
  const lines = [];
  const ends = [];
  let p = pos;
  const n = src.length;
  while (p < n) {
    const [line, next] = getLine(src, p);
    if (isBlankLine(line)) {
      // A whitespace-only line at the very end of the source (no newline
      // after it) is paragraph content, not a separator — but ONLY for a
      // real paragraph (top=true). In a list item (top=false) the text
      // token is a single line and the trailing `\n ` becomes a separate
      // space token, so the text ends without it.
      if (top && next === n && line.length > 0) {
        lines.push(line);
        ends.push(next);
        p = next;
      }
      break;
    }
    if (lines.length > 0) {
      // Continuation line: must not start an interrupting block.
      const { cols, idx } = indentInfo(line);
      // A table delimiter row as the second line never interrupts (marked
      // tries the table rule before the paragraph rule, so a delimiter
      // starting with `- ` is a table, not a list). Verify the cell count
      // matches the header before skipping the interruption checks.
      let isDelim = false;
      if (lines.length === 1 && cols <= 3 && /[:|]/.test(line)) {
        const al = parseDelimiterRow(line, idx);
        if (al !== null && al.length === splitCells(lines[0]).length) isDelim = true;
      }
      if (cols < 4 && !isDelim) {
        const first = line[idx];
        if (first === '>') break;
        if ((first === '-' || first === '_' || first === '*') && isHrLine(line, idx)) break;
        if (first === '#') {
          let d = 0;
          while (line[idx + d] === '#') d++;
          if (d >= 1 && d <= 6) {
            const a = line[idx + d];
            if (a === undefined || a === ' ' || a === '\t') break;
          }
        }
        if (first === '`' || first === '~') {
          let r = 0;
          while (line[idx + r] === first) r++;
          if (r >= 3 && (first !== '`' || !line.slice(idx + r).includes('`'))) break;
        }
        if (first === '-' || first === '+' || first === '*') {
          const a = line[idx + 1];
          if ((a === ' ' || a === '\t') && line.slice(idx + 2).trim() !== '') break;
        }
        if (first >= '0' && first <= '9') {
          // Top-level paragraphs are only interrupted by a list starting
          // with 1; inside a list item (top=false) the text token is a
          // single line, so ANY ordered marker starts a new list.
          const m = top ? /^1[.)]/.exec(line.slice(idx)) : /^\d{1,9}[.)]/.exec(line.slice(idx));
          if (m) {
            const a = line[idx + m[0].length];
            if ((a === ' ' || a === '\t') && line.slice(idx + m[0].length + 1).trim() !== '') break;
          }
        }
        if (first === '<') { const ht = htmlBlockType(line, idx); if (ht >= 1 && ht <= 6) break; }
      }
    }
    lines.push(line);
    ends.push(next);
    p = next;
  }
  // Table? Line 2 must be a delimiter row with a matching cell count.
  if (lines.length >= 2) {
    const dInfo = indentInfo(lines[1]);
    if (dInfo.cols <= 3) {
      const aligns = parseDelimiterRow(lines[1], dInfo.idx);
      if (aligns !== null && /[:|]/.test(lines[1])) {
        const header = splitCells(lines[0]);
        if (header.length === aligns.length) {
          // Body rows: non-blank lines that do not start a block.
          const rows = [];
          let bodyHasContent = false;
          let q = p;
          // p is past the paragraph lines; body rows start after line 2.
          // Recompute: the body starts at the line after the delimiter row.
          let bpos = pos;
          for (let k = 0; k < 2; k++) bpos = getLine(src, bpos)[1];
          q = bpos;
          while (q < n) {
            const [line, next] = getLine(src, q);
            // Only an empty or spaces-only line ends the table (marked's
            // body lookahead is ` *\n`); a whitespace-only line containing
            // a tab IS a body row (all-empty cells).
            if (/^ *$/.test(line)) break;
            if (line.trim() === '') {
              rows.push(splitCells(line, header.length));
              q = next;
              continue;
            }
            const { cols, idx } = indentInfo(line);
            let stop = false;
            if (cols >= 4) stop = true;
            else {
              const first = line[idx];
              if (first === '>') stop = true;
              else if ((first === '-' || first === '_' || first === '*') && isHrLine(line, idx)) stop = true;
              else if (first === '#') {
                let d = 0;
                while (line[idx + d] === '#') d++;
                if (d >= 1 && d <= 6) {
                  const a = line[idx + d];
                  if (a === undefined || a === ' ' || a === '\t') stop = true;
                }
              } else if (first === '`' || first === '~') {
                let r = 0;
                while (line[idx + r] === first) r++;
                if (r >= 3 && (first !== '`' || !line.slice(idx + r).includes('`'))) stop = true;
              } else if (first === '-' || first === '+' || first === '*') {
                const a = line[idx + 1];
                if (a === ' ' || a === '\t') stop = true;
              } else if (first === '1') {
                const m = /^1[.)]/.exec(line.slice(idx));
                if (m) {
                  const a = line[idx + 2];
                  if (a === ' ' || a === '\t') stop = true;
                }
              } else if (first === '<') { const ht = htmlBlockType(line, idx); if (ht >= 1 && ht <= 6) stop = true; }
            }
            if (stop) break;
            bodyHasContent = true; // a non-whitespace row was added
            rows.push(splitCells(line, header.length));
            q = next;
          }
          // If the whole body is whitespace (e.g. a lone tab line), marked's
          // tokenizer drops all rows (t[3].trim() is falsy) — no tbody.
          if (!bodyHasContent) rows.length = 0;
          return [['t', header, aligns, rows], q];
        }
      }
    }
  }
  // Setext heading? The last collected line, or the next line (a `-` underline
  // Setext heading? The first underline at index >= 1 ends the paragraph.
  if (lines.length >= 2) {
    for (let k = 1; k < lines.length; k++) {
      const info = indentInfo(lines[k]);
      if (info.cols <= 3) {
        const lvl = setextLevel(lines[k], info.idx);
        if (lvl > 0) {
          return [['h', lvl, lines.slice(0, k).join('\n').trim()], ends[k]];
        }
      }
    }
  }
  // A `-` underline on the next line (excluded as hr during collection).
  if (lines.length >= 1 && p < n) {
    const [nline, nnext] = getLine(src, p);
    const nInfo = indentInfo(nline);
    if (!isBlankLine(nline) && nInfo.cols <= 3) {
      const lvl = setextLevel(nline, nInfo.idx);
      if (lvl === 2) {
        return [['h', 2, lines.join('\n').trim()], nnext];
      }
    }
  }
  if (!top) {
    // Tight list items: the `text` tokenizer matches one line at a time.
    // An indented line is lexed as indented code and MERGED into the text
    // token: text += "\n" + codeText. The code regex always consumes the
    // newline after a code line (its trailing group matches a bare "\n"),
    // so codeText keeps a trailing "\n" whenever the code line is followed
    // by "\n" in the item text — i.e. whenever more lines follow (blank
    // line, interrupting block, anything) or the item text itself ends
    // with "\n" (a non-last item, whose text is not trimmed). Only a code
    // line that is the last line of a trimmed item text has no trailing
    // "\n". Consecutive indented lines form one code token (joined by
    // "\n", one trailing "\n"). A following text token merges with
    // text += "\n" + text (so a code line before a text line yields "\n\n").
    let text = lines[0];
    let prevWasCode = false;
    for (let k = 1; k < lines.length; k++) {
      const ln = lines[k];
      const isCode = indentInfo(ln).cols >= 4;
      if (isCode) {
        const m = /^(?: {0,3}\t| {1,4})/.exec(ln);
        text += '\n' + (m ? ln.slice(m[0].length) : ln);
        prevWasCode = true;
      } else {
        if (prevWasCode) text += '\n'; // the code block's trailing newline
        text += '\n' + ln;
        prevWasCode = false;
      }
    }
    if (prevWasCode && (p < n || (n > 0 && src.charCodeAt(n - 1) === 10))) {
      text += '\n'; // the last line is code and a "\n" follows it in the text
    }
    return [['x', text], p];
  }
  return [['p', lines.join('\n')], p];
}

// Append `text` (a paragraph's or indented code's text) to the deepest last
// paragraph of `blocks`, descending into nested blockquotes and list items
// (marked re-parses a trailing blockquote/list with the lazy lines appended).
// Returns true if merged; if the deepest container ends in a non-paragraph
// block, the text becomes a new sibling block inside that container.
function deepAppend(blocks, text) {
  if (blocks.length === 0) return false;
  const last = blocks[blocks.length - 1];
  if (last[0] === 'p' || last[0] === 'x') {
    last[1] = last[1] + '\n' + text;
    return true;
  }
  if (last[0] === 'q') {
    if (deepAppend(last[1], text)) return true;
    last[1].push(['p', text]);
    return true;
  }
  if (last[0] === 'l') {
    const items = last[4];
    if (items.length === 0) return false;
    const toks = items[items.length - 1].tokens;
    if (deepAppend(toks, text)) return true;
    toks.push(['x', text]);
    return true;
  }
  return false;
}

// Merge two blockquotes split by a chunk boundary (marked re-parses a
// trailing nested quote with the remaining lines appended): append the
// source's children to the target's, merging boundary paragraphs.
function mergeQuotes(target, source) {
  const tKids = target[1];
  const sKids = source[1];
  if (sKids.length > 0 && (sKids[0][0] === 'p' || sKids[0][0] === 'x')) {
    if (deepAppend(tKids, sKids[0][1])) sKids.shift();
  }
  tKids.push(...sKids);
}

// Parse a blockquote starting at `pos` (first line begins with `>`).
// Mirrors marked's chunked tokenizer: lines are grouped into chunks (a chunk
// boundary falls before a lazy line that follows a `>` line); each chunk's
// content is parsed separately, and its first paragraph merges into the
// previous chunk's last paragraph. A chunk ending in code/heading/hr/html/
// table stops the quote (later lines belong outside it).
function parseBlockquote(src, pos, links) {
  const rawLines = [];
  let p = pos;
  const n = src.length;
  while (p < n) {
    const [line, next] = getLine(src, p);
    const { cols, idx } = indentInfo(line);
    if (cols <= 3 && line[idx] === '>') {
      rawLines.push({ line, next, quoted: true });
      p = next;
      continue;
    }
    if (isBlankLine(line)) {
      // A blank line (no `>` marker) always ends the quote in marked —
      // EXCEPT a whitespace-only line at the very end of the source (no
      // newline after it): the paragraph regex's continuation lookahead
      // `[ \t]+\n` needs the `\n`, so at end-of-input the line is swallowed
      // as a paragraph continuation instead. Collect it as a lazy line.
      if (!(next === n && line.length > 0)) break;
    }
    // Lazy line: only if the previous content line is non-blank (an open
    // paragraph) and the line does not start an interrupting block. Whether
    // it actually joins the quote is decided by the chunking below.
    if (rawLines.length > 0) {
      const lastRl = rawLines[rawLines.length - 1];
      const lastContent = lastRl.quoted
        ? lastRl.line.slice(indentInfo(lastRl.line).idx + 1)
        : lastRl.line;
      if (isBlankLine(lastContent)) break;
      const { cols: c2, idx: i2 } = indentInfo(line);
      let ok = true;
      if (c2 < 4) {
        const first = line[i2];
        if ((first === '-' || first === '_' || first === '*') && isHrLine(line, i2)) ok = false;
        else if (first === '#') {
          let d = 0;
          while (line[i2 + d] === '#') d++;
          if (d >= 1 && d <= 6) {
            const a = line[i2 + d];
            if (a === undefined || a === ' ' || a === '\t') ok = false;
          }
        } else if (first === '`' || first === '~') {
          let r = 0;
          while (line[i2 + r] === first) r++;
          // A backtick run is only a fence if the rest of the line has no
          // backtick (`` ```inner backticks``` `` is a lazy paragraph line,
          // not a fence).
          if (r >= 3 && (first !== '`' || !line.slice(i2 + r).includes('`'))) ok = false;
        } else if (first === '-' || first === '+' || first === '*') {
          const a = line[i2 + 1];
          if ((a === ' ' || a === '\t') && line.slice(i2 + 2).trim() !== '') ok = false;
        } else if (first >= '0' && first <= '9') {
          const m = /^\d{1,9}[.)]/.exec(line.slice(i2));
          if (m) {
            const a = line[i2 + m[0].length];
            if ((a === ' ' || a === '\t') && line.slice(i2 + m[0].length + 1).trim() !== '') ok = false;
          }
        } else if (first === '<') { const ht = htmlBlockType(line, i2); if (ht >= 1 && ht <= 6) ok = false; }
      }
      if (ok) {
        rawLines.push({ line, next, quoted: false });
        p = next;
        continue;
      }
    }
    break;
  }
  // Split into chunks: a boundary falls before a lazy line that follows a
  // `>` line. Blank lines stay in the current chunk.
  const chunks = [];
  let cur = [];
  let seenQuoted = false;
  for (const rl of rawLines) {
    if (!rl.quoted && !rl.blank && seenQuoted) {
      chunks.push(cur);
      cur = [];
      seenQuoted = false;
    }
    cur.push(rl);
    if (rl.quoted) seenQuoted = true;
  }
  if (cur.length > 0) chunks.push(cur);
  const children = [];
  let endPos = pos;
  for (const chunk of chunks) {
    const contentLines = chunk.map((rl) => {
      if (!rl.quoted) return rl.line;
      const { idx } = indentInfo(rl.line);
      const markerLen = idx + 1;
      const rest = rl.line.slice(markerLen);
      const ws = /^[ \t]+/.exec(rest);
      let content;
      if (ws) content = expandLeadingTabs(ws[0], markerLen) + rest.slice(ws[0].length);
      else content = rest;
      if (content.charAt(0) === ' ' || content.charAt(0) === '\t') content = content.slice(1);
      return content;
    });
    let content = contentLines.join('\n');
    // Setext replace: a setext underline preceded by a newline inside the
    // chunk gets 4 spaces, so it cannot form a heading with a lazy line.
    content = content.replace(/\n {0,3}((?:=+|-+)[ \t]*)(?=\n|$)/g, '\n    $1');
    const [blocks] = parseBlocks(content, links, true);
    if (blocks.length > 0 && children.length > 0) {
      const first = blocks[0];
      if (first[0] === 'p' || first[0] === 'x') {
        const prev = children[children.length - 1];
        if (prev[0] === 'l') {
          // The previous chunk ended in a list: marked RE-LEXES that list
          // with the remaining lines appended, so only this chunk's leading
          // LAZY lines are absorbed into the list item — a quoted line
          // (or any block-starting line) stops the absorption. Merging the
          // whole paragraph would wrongly pull quoted lines into the item.
          // Split the paragraph at the end of the leading lazy run.
          let k = 0;
          while (k < chunk.length && !chunk[k].quoted) k++;
          const pLines = first[1].split('\n');
          const take = Math.min(k, pLines.length);
          if (take > 0 && deepAppend(children, pLines.slice(0, take).join('\n'))) {
            if (take >= pLines.length) blocks.shift();
            else first[1] = pLines.slice(take).join('\n');
          }
        } else if (deepAppend(children, first[1])) {
          blocks.shift();
        }
      } else if (first[0] === 'code' && first[3] === true) {
        // Indented code after a paragraph is absorbed into it (marked's
        // blockTokens merges code/def tokens into a preceding paragraph).
        // After absorbing the code, the chunk's following paragraph (if
        // any) merges into the SAME paragraph: marked's lazy-chunk
        // paragraph merge applies to the paragraph token too (its previous
        // token is still the paragraph, now extended by the code text).
        if (deepAppend(children, first[2])) {
          blocks.shift();
          if (blocks.length > 0 && (blocks[0][0] === 'p' || blocks[0][0] === 'x')) {
            if (deepAppend(children, blocks[0][1])) blocks.shift();
          }
        }
      }
      // A chunk-boundary blockquote continues the previous chunk's trailing
      // quote (same quote, split by the lazy-line boundary).
      if (blocks.length > 0) {
        const f2 = blocks[0];
        const prev = children[children.length - 1];
        if (f2[0] === 'q' && prev[0] === 'q') {
          mergeQuotes(prev, f2);
          blocks.shift();
        }
      }
    }
    children.push(...blocks);
    endPos = chunk[chunk.length - 1].next;
    const last = children[children.length - 1];
    if (last && (last[0] === 'code' || last[0] === 'h' || last[0] === 'hr' ||
                 last[0] === 'H' || last[0] === 't')) {
      break;
    }
  }
  return [['q', children], endPos];
}

// Parse an HTML block starting at `pos` (first line is type `htype`).
function parseHtmlBlock(src, pos, htype) {
  const start = pos;
  let p = pos;
  const n = src.length;
  if (htype === 1) {
    // Ends at the matching close tag (script/pre/style/textarea).
    const [firstLine] = getLine(src, pos);
    const m = /<\s*(script|pre|style|textarea)(?:[\s>]|$)/i.exec(firstLine);
    const tag = m ? m[1].toLowerCase() : 'script';
    const closeRe = new RegExp('</' + tag + '\\s*>', 'i');
    let endFound = false;
    while (p < n) {
      const [line, next] = getLine(src, p);
      if (closeRe.test(line)) { p = next; endFound = true; break; }
      p = next;
    }
    if (!endFound) p = n;
  } else if (htype === 2) {
    // Comment: ends at -->.
    while (p < n) {
      const [line, next] = getLine(src, p);
      if (line.includes('-->')) { p = next; break; }
      p = next;
    }
  } else if (htype === 3) {
    // Processing instruction: ends at ?>.
    while (p < n) {
      const [line, next] = getLine(src, p);
      if (line.includes('?>')) { p = next; break; }
      p = next;
    }
  } else if (htype === 4 || htype === 5) {
    // Declaration / CDATA: ends at >.
    while (p < n) {
      const [line, next] = getLine(src, p);
      if (line.includes('>')) { p = next; break; }
      p = next;
    }
  } else {
    // Types 6 and 7: ends at a blank line.
    while (p < n) {
      const [line, next] = getLine(src, p);
      if (isBlankLine(line)) break;
      p = next;
    }
  }
  // Trailing consumption depends on the regex tail: types 1-5 end with
  // `[^\n]*\n*` / `(\n+|$)` (following EMPTY lines only); types 6-7 end
  // with `(?:\n[ \t]*)+\n` (blank lines incl. whitespace-only).
  if (htype >= 6) {
    while (p < n) {
      const [line, next] = getLine(src, p);
      if (!isBlankLine(line)) break;
      p = next;
    }
  } else {
    while (p < n) {
      const [line, next] = getLine(src, p);
      if (line !== '') break;
      p = next;
    }
  }
  const raw = src.slice(start, p);
  const text = trimTrailingBlanks(raw);
  // blockTokens advances by the ge-trimmed raw length, so trailing blank
  // lines that ge removed stay unconsumed.
  return [['H', text], start + text.length];
}

// Parse a list starting at `pos`. Returns [[list-block], endPos] or null.
function parseList(src, pos, links) {
  const [firstLine] = getLine(src, pos);
  const { cols, idx } = indentInfo(firstLine);
  if (cols > 3) return null;
  const first = firstLine[idx];
  let ordered = false;
  let start = 0;
  let markerLen = 0;
  let markerChar = '';
  let delim = '';
  if (first === '-' || first === '+' || first === '*') {
    markerChar = first;
    markerLen = 1;
  } else if (first >= '0' && first <= '9') {
    const m = /^\d{1,9}[.)]/.exec(firstLine.slice(idx));
    if (!m) return null;
    ordered = true;
    start = parseInt(m[0].slice(0, -1), 10);
    delim = m[0].charAt(m[0].length - 1);
    markerLen = m[0].length;
  } else return null;
  const afterMarker = firstLine[idx + markerLen];
  if (afterMarker !== undefined && afterMarker !== ' ' && afterMarker !== '\t') return null;

  const items = [];
  let loose = false;
  let prevBlank = false;
  let curPos = pos;
  // End of the last non-blank line consumed: marked trims the list's raw,
  // so trailing blank lines are NOT consumed by the list (they become space
  // tokens / blank separators for the enclosing parser).
  let listEnd = pos;
  const n = src.length;
  while (curPos < n) {
    const [line, next] = getLine(src, curPos);
    const inf = indentInfo(line);
    if (inf.cols > 3) break;
    if ((line[inf.idx] === '-' || line[inf.idx] === '_' || line[inf.idx] === '*') &&
        isHrLine(line, inf.idx)) break;
    let mLen = 0;
    if (!ordered) {
      if (line[inf.idx] !== markerChar) break;
      mLen = 1;
    } else {
      const m = /^\d{1,9}[.)]/.exec(line.slice(inf.idx));
      if (!m || m[0].charAt(m[0].length - 1) !== delim) break;
      mLen = m[0].length;
    }
    const after = line[inf.idx + mLen];
    if (after !== undefined && after !== ' ' && after !== '\t') break;
    const itemStart = curPos;
    const b = inf.idx + mLen;
    let g = expandLeadingTabs(line.slice(inf.idx + mLen), b);
    const emptyFirst = g.trim() === '';
    let R;
    let d;
    if (emptyFirst) {
      R = b + 1;
      d = '';
    } else {
      let r = 0;
      while (r < g.length && g[r] === ' ') r++;
      if (r > 4) r = 1;
      d = g.slice(r);
      R = r + b;
    }
    curPos = next;
    listEnd = next;
    let u = false;
    if (emptyFirst && curPos < n) {
      const [nl, nn] = getLine(src, curPos);
      if (isBlankLine(nl)) { curPos = nn; u = true; }
    }
    if (!u) {
      let m = d;
      let y = emptyFirst;
      while (curPos < n) {
        const [line2, next2] = getLine(src, curPos);
        const f = line2;
        const Z = expandLeadingTabs(f, 0);
        if (blockStartWithin(f, Math.max(0, Math.min(3, R - 1)))) break;
        const nz = Z.search(/[^ ]/);
        if (nz >= R || !f.trim()) {
          d += '\n' + Z.slice(R);
        } else {
          if (y || m.replace(/\t/g, '    ').search(/[^ ]/) >= 4 || startsBlock(m)) break;
          let qe = f;
          if (/^ {0,3}(?:=+|-+) *$/.test(f) && isSetextPair(m, f)) {
            qe = '    ' + Z.replace(/^ {0,3}/, '');
          }
          d += '\n' + qe;
        }
        y = !f.trim();
        if (f.trim()) listEnd = next2;
        curPos = next2;
        m = Z.slice(R);
      }
    }
    const itemRaw = src.slice(itemStart, curPos);
    if (!loose) {
      if (prevBlank) loose = true;
      else if (endsWithBlankLine(itemRaw)) prevBlank = true;
    }
    items.push({ raw: itemRaw, text: d });
  }
  if (items.length === 0) return null;
  const lastItem = items[items.length - 1];
  lastItem.raw = lastItem.raw.trimEnd();
  lastItem.text = lastItem.text.trimEnd();
  const parsedItems = [];
  for (const item of items) {
    const task = /^\[[ xX]\][ \t]+\S/.test(item.text);
    const [tokens, blankSep] = parseBlocks(item.text, links, false);
    if (!loose && blankSep) loose = true;
    parsedItems.push({
      task,
      checked: task ? item.text.charAt(1) !== ' ' : false,
      tokens,
    });
  }
  if (loose) {
    for (const it of parsedItems) {
      for (const blk of it.tokens) {
        if (blk[0] === 'x') blk[0] = 'p';
      }
    }
  }
  return [['l', ordered, ordered ? start : 0, loose, parsedItems], listEnd];
}

// Render a list of blocks into `out` (an array of strings).
// Top-level inline span (one paragraph, heading, table cell, or list-item
// text): marked resets its Lexer inRawBlock to false before tokenizing each
// queued span (Lexer.lex), so an unclosed <pre>/<code>/<kbd>/<script> tag
// in one paragraph must NOT leak raw mode into later paragraphs. inLink
// and linkEmitted are NOT reset (marked keeps them across spans).
function inlineTop(s, links, ist) {
  ist.inRawBlock = false;
  return inlineHtml(s, links, ist);
}

function renderBlocks(blocks, links, out, ist) {
  for (const b of blocks) {
    const kind = b[0];
    if (kind === 'code') {
      const text = b[2];
      const lang = b[1] ? (b[1].match(/^\S*/) || [''])[0] : '';
      out.push('<pre><code');
      if (lang) out.push(' class="language-', escapeLoose(lang), '"');
      out.push('>');
      const body = text ? (text.endsWith('\n') ? text : text + '\n') : '';
      out.push(escapeAll(body));
      out.push('</code></pre>\n');
    } else if (kind === 'h') {
      out.push('<h', String(b[1]), '>', inlineTop(b[2], links, ist), '</h', String(b[1]), '>\n');
    } else if (kind === 'hr') {
      out.push('<hr>\n');
    } else if (kind === 'q') {
      out.push('<blockquote>\n');
      renderBlocks(b[1], links, out, ist);
      out.push('</blockquote>\n');
    } else if (kind === 'p') {
      out.push('<p>', inlineTop(b[1], links, ist), '</p>\n');
    } else if (kind === 'x') {
      out.push(inlineTop(b[1], links, ist));
    } else if (kind === 'H') {
      out.push(b[1]);
    } else if (kind === 't') {
      const header = b[1];
      const aligns = b[2];
      const rows = b[3];
      out.push('<table>\n<thead>\n<tr>\n');
      for (let i = 0; i < header.length; i++) {
        out.push('<th');
        if (aligns[i]) out.push(' align="', aligns[i], '"');
        out.push('>', inlineTop(header[i], links, ist), '</th>\n');
      }
      out.push('</tr>\n</thead>\n');
      if (rows.length > 0) {
        out.push('<tbody>');
        for (const row of rows) {
          out.push('<tr>\n');
          for (let i = 0; i < header.length; i++) {
            out.push('<td');
            if (aligns[i]) out.push(' align="', aligns[i], '"');
            out.push('>', inlineTop(row[i] ?? '', links, ist), '</td>\n');
          }
          out.push('</tr>\n');
        }
        out.push('</tbody>');
      }
      out.push('</table>\n');
    } else if (kind === 'l') {
      const ordered = b[1];
      const start = b[2];
      const loose = b[3];
      const items = b[4];
      out.push(ordered ? '<ol' : '<ul');
      if (ordered && start !== 1) out.push(' start="', String(start), '"');
      out.push('>\n');
      for (const it of items) {
        out.push('<li>');
        const toks = it.tokens;
        const firstTok = toks[0];
        const isTask = it.task && firstTok &&
          (firstTok[0] === 'p' || firstTok[0] === 'x');
        const checkbox = '<input ' + (it.checked ? 'checked="" ' : '') + 'disabled="" type="checkbox"> ';
        if (isTask && loose && (firstTok[0] === 'p')) {
          // Checkbox inside the first paragraph.
          const stripped = firstTok[1].replace(/^\[[ xX]\][ \t]+/, '');
          out.push('<p>', checkbox, inlineTop(stripped, links, ist), '</p>\n');
          renderBlocks(toks.slice(1), links, out, ist);
        } else if (isTask && !loose) {
          // Checkbox as a block-level token before the first block.
          const stripped = firstTok[1].replace(/^\[[ xX]\][ \t]+/, '');
          out.push(checkbox);
          if (firstTok[0] === 'x') {
            out.push(inlineTop(stripped, links, ist));
          } else {
            out.push('<p>', inlineTop(stripped, links, ist), '</p>\n');
          }
          renderBlocks(toks.slice(1), links, out, ist);
        } else if (isTask && loose) {
          // Loose list, first token not a paragraph: checkbox in its own <p>.
          out.push('<p>', checkbox, '</p>\n');
          renderBlocks(toks, links, out, ist);
        } else {
          renderBlocks(toks, links, out, ist);
        }
        out.push('</li>\n');
      }
      out.push(ordered ? '</ol>\n' : '</ul>\n');
    }
  }
}

// The public entry point: render `markdown` to HTML exactly as marked
// 18.1.3 does with its default options (GFM on, breaks off, pedantic off).
export function parse(markdown) {
  const s0 = String(markdown);
  // Most documents have no carriage returns: skip the regex pass entirely.
  const src = s0.indexOf('\r') === -1 ? s0 : s0.replace(/\r\n|\r/g, '\n');
  const links = Object.create(null);
  const [blocks] = parseBlocks(src, links, true);
  const out = [];
  // One inline state for the whole document: marked's Lexer state persists
  // across blocks, so an unclosed <a> in an early paragraph blocks GFM
  // autolinks in every later block. inRawBlock is the exception: marked
  // resets it before each queued inline span (see inlineTop).
  const ist = { inLink: false, inRawBlock: false, linkEmitted: false };
  renderBlocks(blocks, links, out, ist);
  return out.join('');
}




