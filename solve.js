// Fast drop-in for makefun-site 1.0.0: run(input) returns the same output tree,
// byte for byte, with a rewritten Markdown lexer/inline renderer, memoized slugs
// and an array-joined template renderer. Dependency-free ES module.

const byCodeUnits = (a, b) => (a < b ? -1 : a > b ? 1 : 0);

// ---------------------------------------------------------------- text

const ESCAPES = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' };
const ESC_RE = /[&<>"']/g;

export function escapeHtml(text) {
  return text.replace(ESC_RE, (c) => ESCAPES[c]);
}

const slugCache = new Map();
const MARK_RE = /\p{M}/gu;

export function slugify(text) {
  const hit = slugCache.get(text);
  if (hit !== undefined) return hit;
  let plain = text;
  // ASCII fast path: NFKD is identity and there are no combining marks.
  let ascii = true;
  for (let i = 0; i < text.length; i++) {
    if (text.charCodeAt(i) > 127) { ascii = false; break; }
  }
  if (!ascii) plain = text.normalize('NFKD').replace(MARK_RE, '');
  let out = '';
  let gap = false;
  for (let i = 0; i < plain.length; i++) {
    const code = plain.charCodeAt(i);
    let keep = -1;
    if (code >= 65 && code <= 90) keep = code + 32;
    else if ((code >= 97 && code <= 122) || (code >= 48 && code <= 57)) keep = code;
    if (keep === -1) {
      gap = out.length > 0;
      continue;
    }
    if (gap) out += '-';
    gap = false;
    out += String.fromCharCode(keep);
  }
  out = out.slice(0, 64);
  let e = out.length;
  while (e > 0 && out.charCodeAt(e - 1) === 45) e--;
  if (e !== out.length) out = out.slice(0, e);
  if (out === '') out = 'untitled';
  slugCache.set(text, out);
  return out;
}

export function uniqueSlug(slug, taken) {
  let out = slug;
  for (let n = 2; taken.has(out); n++) out = `${slug}-${n}`;
  taken.add(out);
  return out;
}

const MONTHS = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'];

export function longDate(date) {
  return `${Number(date.slice(8, 10))} ${MONTHS[Number(date.slice(5, 7)) - 1]} ${date.slice(0, 4)}`;
}

/** Words of a body: runs of non-whitespace, exactly /\S+/g's count. */
function countWords(s) {
  let n = 0;
  let i = 0;
  const len = s.length;
  while (i < len) {
    let c = s.charCodeAt(i);
    while (c === 32 || c === 9 || c === 10 || c === 11 || c === 12 || c === 13 || c === 160 || (c > 127 && /\s/.test(s[i]))) {
      if (++i >= len) return n;
      c = s.charCodeAt(i);
    }
    n++;
    while (i < len) {
      c = s.charCodeAt(i);
      if (c === 32 || c === 9 || c === 10 || c === 11 || c === 12 || c === 13 || c === 160) break;
      if (c > 127 && /\s/.test(s[i])) break;
      i++;
    }
  }
  return n;
}

// ---------------------------------------------------------------- front matter

const KEYS = new Set(['title', 'date', 'tags', 'draft', 'layout', 'slug', 'summary']);

function daysIn(y, m) {
  if (m === 2) return (y % 4 === 0 && y % 100 !== 0) || y % 400 === 0 ? 29 : 28;
  return m === 4 || m === 6 || m === 9 || m === 11 ? 30 : 31;
}

function isDigit(c) { return c >= 48 && c <= 57; }

function stringOf(raw) {
  if (raw.charCodeAt(0) === 34) {
    if (raw.length < 2 || raw.charCodeAt(raw.length - 1) !== 34) return { error: 'a quoted string is not closed' };
    let out = '';
    for (let i = 1; i < raw.length - 1; i++) {
      const c = raw[i];
      if (c === '\\') {
        const n = raw[i + 1];
        if ((n !== '"' && n !== '\\') || i + 1 === raw.length - 1) return { error: 'a quoted string holds an escape other than \\" or \\\\' };
        out += n;
        i++;
      } else if (c === '"') return { error: 'a quoted string holds a stray quote' };
      else out += c;
    }
    return { value: out };
  }
  if (raw.charCodeAt(0) === 91) return { error: 'a bare string opens on [' };
  return { value: raw };
}

function valueOf(key, raw) {
  switch (key) {
    case 'title':
    case 'summary': {
      const s = stringOf(raw);
      return 'error' in s ? { error: `key "${key}": ${s.error}` } : s;
    }
    case 'date': {
      let ok = raw.length === 10 && raw.charCodeAt(4) === 45 && raw.charCodeAt(7) === 45;
      if (ok) {
        for (let i = 0; i < 10; i++) {
          if (i === 4 || i === 7) continue;
          if (!isDigit(raw.charCodeAt(i))) { ok = false; break; }
        }
      }
      const y = ok ? Number(raw.slice(0, 4)) : 0;
      const mo = ok ? Number(raw.slice(5, 7)) : 0;
      const d = ok ? Number(raw.slice(8, 10)) : 0;
      if (!ok || y < 1970 || y > 2099 || mo < 1 || mo > 12 || d < 1 || d > daysIn(y, mo)) {
        return { error: 'key "date": not a date from 1970-01-01 to 2099-12-31 (YYYY-MM-DD)' };
      }
      return { value: raw };
    }
    case 'tags': {
      if (raw.charCodeAt(0) !== 91 || raw.charCodeAt(raw.length - 1) !== 93) return { error: 'key "tags": not a list [a, b]' };
      const inner = raw.slice(1, -1);
      if (inner.trim() === '') return { value: [] };
      const tags = inner.split(',').map((t) => t.trim());
      for (const t of tags) {
        if (t === '') return { error: 'key "tags": an empty tag, or one holding " [ or ]' };
        for (let i = 0; i < t.length; i++) {
          const c = t.charCodeAt(i);
          if (c === 34 || c === 91 || c === 93) return { error: 'key "tags": an empty tag, or one holding " [ or ]' };
        }
      }
      return { value: tags };
    }
    case 'draft':
      return raw === 'true' ? { value: true } : raw === 'false' ? { value: false } : { error: 'key "draft": true or false' };
    case 'layout': {
      if (raw.length === 0) return { error: 'key "layout": not a template name' };
      for (let i = 0; i < raw.length; i++) {
        const c = raw.charCodeAt(i);
        if (!((c >= 97 && c <= 122) || (c >= 48 && c <= 57) || c === 45)) return { error: 'key "layout": not a template name' };
      }
      return { value: raw };
    }
    case 'slug': {
      if (raw.length === 0 || raw.length > 64) return { error: 'key "slug": not a slug' };
      let prevDash = true;
      for (let i = 0; i < raw.length; i++) {
        const c = raw.charCodeAt(i);
        const alnum = (c >= 97 && c <= 122) || (c >= 48 && c <= 57);
        if (c === 45) {
          if (prevDash) return { error: 'key "slug": not a slug' };
          prevDash = true;
        } else if (alnum) prevDash = false;
        else return { error: 'key "slug": not a slug' };
      }
      if (prevDash) return { error: 'key "slug": not a slug' };
      return { value: raw };
    }
    default:
      return { error: `unknown key "${key}"` };
  }
}

function isBlankLine(line) {
  for (let i = 0; i < line.length; i++) {
    const c = line.charCodeAt(i);
    if (c !== 32 && c !== 9) return false;
  }
  return true;
}

export function parseFrontMatter(text) {
  const firstNL = text.indexOf('\n');
  if (firstNL === -1) {
    if (text !== '---') return { error: 'no front matter' };
    return { error: 'the front matter is not closed' };
  }
  if (text.slice(0, firstNL) !== '---') return { error: 'no front matter' };
  const data = {};
  let pos = firstNL + 1;
  let i = 1;
  for (;;) {
    const nl = text.indexOf('\n', pos);
    const line = nl === -1 ? text.slice(pos) : text.slice(pos, nl);
    if (line === '---') {
      if (!Object.hasOwn(data, 'title')) return { error: 'no title' };
      return { data, body: nl === -1 ? '' : text.slice(nl + 1) };
    }
    if (nl === -1) return { error: 'the front matter is not closed' };
    if (isBlankLine(line) || line.charCodeAt(0) === 35) { pos = nl + 1; i++; continue; }
    // LINE: /^([a-z_]+):(?: (.*))?$/
    let k = 0;
    while (k < line.length) {
      const c = line.charCodeAt(k);
      if ((c >= 97 && c <= 122) || c === 95) k++;
      else break;
    }
    if (k === 0 || line.charCodeAt(k) !== 58) return { error: `line ${i + 1} is not "key: value"` };
    let raw;
    if (k + 1 === line.length) raw = '';
    else if (line.charCodeAt(k + 1) === 32) raw = line.slice(k + 2);
    else return { error: `line ${i + 1} is not "key: value"` };
    let e = raw.length;
    while (e > 0) {
      const c = raw.charCodeAt(e - 1);
      if (c === 32 || c === 9) e--;
      else break;
    }
    if (e !== raw.length) raw = raw.slice(0, e);
    const key = line.slice(0, k);
    if (!KEYS.has(key)) return { error: `unknown key "${key}"` };
    if (Object.hasOwn(data, key)) return { error: `key "${key}" is given twice` };
    if (raw === '') return { error: `key "${key}" has no value` };
    const v = valueOf(key, raw);
    if ('error' in v) return v;
    data[key] = v.value;
    pos = nl + 1;
    i++;
  }
}

// ---------------------------------------------------------------- markdown

function isLangChar(c) {
  return (c >= 65 && c <= 90) || (c >= 97 && c <= 122) || (c >= 48 && c <= 57) || c === 95 || c === 43 || c === 45;
}

/** Fence-open language, or null. /^```([A-Za-z0-9_+-]*)[ \t]*$/" */
function fenceLang(line) {
  if (line.charCodeAt(0) !== 96 || line.charCodeAt(1) !== 96 || line.charCodeAt(2) !== 96) return null;
  let k = 3;
  while (k < line.length && isLangChar(line.charCodeAt(k))) k++;
  const lang = line.slice(3, k);
  while (k < line.length) {
    const c = line.charCodeAt(k);
    if (c !== 32 && c !== 9) return null;
    k++;
  }
  return lang;
}

function isFenceClose(line) {
  if (line.charCodeAt(0) !== 96 || line.charCodeAt(1) !== 96 || line.charCodeAt(2) !== 96) return false;
  for (let k = 3; k < line.length; k++) {
    const c = line.charCodeAt(k);
    if (c !== 32 && c !== 9) return false;
  }
  return true;
}

/** { depth, text } or null. /^(#{1,6})[ \t]+(.*?)[ \t]*$/ with non-empty text. */
function headingOf(line) {
  let k = 0;
  while (k < line.length && line.charCodeAt(k) === 35) k++;
  if (k === 0 || k > 6) return null;
  if (k >= line.length) return null;
  const c = line.charCodeAt(k);
  if (c !== 32 && c !== 9) return null;
  let s = k;
  while (s < line.length) {
    const d = line.charCodeAt(s);
    if (d !== 32 && d !== 9) break;
    s++;
  }
  let e = line.length;
  while (e > s) {
    const d = line.charCodeAt(e - 1);
    if (d !== 32 && d !== 9) break;
    e--;
  }
  if (e === s) return null;
  return { depth: k, text: line.slice(s, e) };
}

function isHR(line) {
  const c0 = line.charCodeAt(0);
  if (c0 !== 45 && c0 !== 42) return false;
  if (line.charCodeAt(1) !== c0 || line.charCodeAt(2) !== c0) return false;
  for (let k = 3; k < line.length; k++) {
    const c = line.charCodeAt(k);
    if (c !== 32 && c !== 9) return false;
  }
  return true;
}

function trimLine(line) {
  const c0 = line.charCodeAt(0);
  const c1 = line.charCodeAt(line.length - 1);
  if (c0 !== 32 && c0 !== 9 && c1 !== 32 && c1 !== 9) return line;
  let s = 0;
  let e = line.length;
  while (s < e) {
    const c = line.charCodeAt(s);
    if (c !== 32 && c !== 9) break;
    s++;
  }
  while (e > s) {
    const c = line.charCodeAt(e - 1);
    if (c !== 32 && c !== 9) break;
    e--;
  }
  return line.slice(s, e);
}

function endsParagraph(line) {
  if (line.length === 0) return true;
  const c0 = line.charCodeAt(0);
  switch (c0) {
    case 32:
    case 9:
      return isBlankLine(line);
    case 96:
      return fenceLang(line) !== null;
    case 35:
      return headingOf(line) !== null;
    case 45:
    case 42:
      return isHR(line);
    default:
      return false;
  }
}

/** Bullet item content, or null. /^[-*] (.*)$/" */
function bulletOf(line) {
  const c0 = line.charCodeAt(0);
  if ((c0 === 45 || c0 === 42) && line.charCodeAt(1) === 32) return line.slice(2);
  return null;
}

/** Ordered item { num, content }, or null. /^(\d{1,9})\. (.*)$/" */
function orderedOf(line) {
  let k = 0;
  while (k < line.length && isDigit(line.charCodeAt(k))) k++;
  if (k === 0 || k > 9) return null;
  if (line.charCodeAt(k) !== 46 || line.charCodeAt(k + 1) !== 32) return null;
  return { num: Number(line.slice(0, k)), content: line.slice(k + 2) };
}

/** /^ {2,}\S/" */
function isContinued(line) {
  if (line.charCodeAt(0) !== 32 || line.charCodeAt(1) !== 32) return false;
  let k = 2;
  while (k < line.length && line.charCodeAt(k) === 32) k++;
  if (k >= line.length) return false;
  const c = line.charCodeAt(k);
  if (c === 9 || c === 11 || c === 12 || c === 13) return false;
  if (c < 128) return true;
  return !/\s/.test(line[k]);
}

const ESCAPABLES = '\\`*_[]()#+-.!>';

function isEscapable(c) {
  return ESCAPABLES.indexOf(c) !== -1;
}

/** First index from `from` where `s` holds `what` outside a backslash escape, or -1. */
function findUnescaped(s, what, from) {
  let j = from;
  for (;;) {
    const k = s.indexOf(what, j);
    if (k === -1) return -1;
    let p = j;
    while (p < k) {
      if (s[p] === '\\' && p + 1 < s.length && isEscapable(s[p + 1])) p += 2;
      else p++;
    }
    if (p === k) return k;
    j = p;
  }
}

/** First single * from `from` (one whose run is not **), outside an escape, or -1. */
function findSingleStar(s, from) {
  let j = from;
  for (;;) {
    const k = s.indexOf('*', j);
    if (k === -1) return -1;
    let p = j;
    while (p < k) {
      if (s[p] === '\\' && p + 1 < s.length && isEscapable(s[p + 1])) p += 2;
      else p++;
    }
    if (p > k) { j = p; continue; }
    if (s[k + 1] === '*') { j = k + 2; continue; }
    return k;
  }
}

/** `s` rendered inline; `link(target)` is a link's href. */
export function inline(s, link) {
  const re = /[\\`*\[&<>"']/g;
  let out = '';
  let run = 0;
  let m;
  while ((m = re.exec(s)) !== null) {
    const i = m.index;
    const c = m[0];
    if (c === '\\') {
      if (i + 1 < s.length && isEscapable(s[i + 1])) {
        out += s.slice(run, i);
        const e = s[i + 1];
        out += e === '>' ? '&gt;' : e;
        run = i + 2;
        re.lastIndex = run;
      }
      continue;
    }
    if (c === '`') {
      const j = s.indexOf('`', i + 1);
      if (j > i + 1) {
        out += s.slice(run, i);
        out += '<code>' + escapeHtml(s.slice(i + 1, j)) + '</code>';
        run = j + 1;
        re.lastIndex = run;
      }
      continue;
    }
    if (c === '*') {
      if (s[i + 1] === '*') {
        const j = findUnescaped(s, '**', i + 2);
        if (j > i + 2) {
          out += s.slice(run, i);
          out += '<strong>' + inline(s.slice(i + 2, j), link) + '</strong>';
          run = j + 2;
          re.lastIndex = run;
        } else re.lastIndex = i + 2;
        continue;
      }
      const j = findSingleStar(s, i + 1);
      if (j > i + 1) {
        out += s.slice(run, i);
        out += '<em>' + inline(s.slice(i + 1, j), link) + '</em>';
        run = j + 1;
        re.lastIndex = run;
      }
      continue;
    }
    if (c === '[') {
      const k = findUnescaped(s, ']', i + 1);
      const q = k !== -1 && s[k + 1] === '(' ? s.indexOf(')', k + 2) : -1;
      const target = q === -1 ? '' : s.slice(k + 2, q);
      if (target !== '' && !/\s/.test(target)) {
        out += s.slice(run, i);
        out += '<a href="' + escapeHtml(link(target)) + '">' + inline(s.slice(i + 1, k), link) + '</a>';
        run = q + 1;
        re.lastIndex = run;
      }
      continue;
    }
    out += s.slice(run, i);
    if (c === '&') out += '&amp;';
    else if (c === '<') out += '&lt;';
    else if (c === '>') out += '&gt;';
    else if (c === '"') out += '&quot;';
    else out += '&#39;';
    run = i + 1;
  }
  if (run === 0) return s;
  if (run < s.length) out += s.slice(run);
  return out;
}

/** `src` rendered: { html, toc, excerpt, words }. Fused lexer+renderer. */
export function renderMarkdown(src, link) {
  const lines = src.split('\n');
  const ids = new Set();
  const blocks = [];
  const toc = [];
  let excerpt = null;
  let i = 0;
  const n = lines.length;
  while (i < n) {
    const line = lines[i];
    if (line.length === 0) { i++; continue; }
    const c0 = line.charCodeAt(0);
    if (c0 === 32 || c0 === 9) {
      if (isBlankLine(line)) { i++; continue; }
    } else if (c0 === 96) {
      const lang = fenceLang(line);
      if (lang !== null) {
        i++;
        let inner = '';
        while (i < n && !isFenceClose(lines[i])) inner += escapeHtml(lines[i++]) + '\n';
        i++;
        blocks.push('<pre><code' + (lang === '' ? '' : ' class="language-' + lang + '"') + '>' + inner + '</code></pre>');
        continue;
      }
    } else if (c0 === 35) {
      const heading = headingOf(line);
      if (heading !== null) {
        const id = uniqueSlug(slugify(heading.text), ids);
        const html = inline(heading.text, link);
        blocks.push(`<h${heading.depth} id="${id}">${html}</h${heading.depth}>`);
        if (heading.depth === 2 || heading.depth === 3) toc.push({ level: heading.depth, id, html });
        i++;
        continue;
      }
    } else if (c0 === 45 || c0 === 42) {
      if (isHR(line)) { blocks.push('<hr>'); i++; continue; }
      if (line.charCodeAt(1) === 32) {
        const items = [];
        while (i < n) {
          const l = lines[i];
          const m = bulletOf(l);
          if (m !== null) {
            items.push([trimLine(m)]);
            i++;
          } else if (isContinued(l)) {
            items[items.length - 1].push(trimLine(l));
            i++;
          } else break;
        }
        let html = '<ul>\n';
        for (const parts of items) html += '<li>' + inline(parts.join('\n'), link) + '</li>\n';
        html += '</ul>';
        blocks.push(html);
        continue;
      }
    } else if (c0 === 62) {
      const body = [];
      while (i < n && lines[i].charCodeAt(0) === 62) {
        const l = lines[i++];
        const t = trimLine(l.charCodeAt(1) === 32 ? l.slice(2) : l.slice(1));
        if (t !== '') body.push(t);
      }
      blocks.push(body.length === 0 ? '<blockquote>\n</blockquote>' : '<blockquote>\n<p>' + inline(body.join('\n'), link) + '</p>\n</blockquote>');
      continue;
    } else if (c0 >= 48 && c0 <= 57) {
      const ordered = orderedOf(line);
      if (ordered !== null) {
        const items = [];
        while (i < n) {
          const l = lines[i];
          const m = orderedOf(l);
          if (m !== null) {
            items.push([trimLine(m.content)]);
            i++;
          } else if (isContinued(l)) {
            items[items.length - 1].push(trimLine(l));
            i++;
          } else break;
        }
        let html = (ordered.num !== 1 ? `<ol start="${ordered.num}">` : '<ol>') + '\n';
        for (const parts of items) html += '<li>' + inline(parts.join('\n'), link) + '</li>\n';
        html += '</ol>';
        blocks.push(html);
        continue;
      }
    }
    const body = [trimLine(line)];
    i++;
    while (i < n && !endsParagraph(lines[i])) body.push(trimLine(lines[i++]));
    const html = inline(body.join('\n'), link);
    if (excerpt === null) excerpt = html;
    blocks.push('<p>' + html + '</p>');
  }
  return { html: blocks.length === 0 ? '' : blocks.join('\n') + '\n', toc, excerpt: excerpt ?? '', words: countWords(src) };
}

// ---------------------------------------------------------------- templates

export class TemplateError extends Error {}

function isPathStart(c) {
  return (c >= 65 && c <= 90) || (c >= 97 && c <= 122) || c === 95;
}
function isPathChar(c) {
  return isPathStart(c) || (c >= 48 && c <= 57);
}

/** PATH: /^[A-Za-z_][A-Za-z0-9_]*(?:\.[A-Za-z_][A-Za-z0-9_]*)*$/ */
function pathOf(name, text) {
  const parts = text.split('.');
  for (const p of parts) {
    if (p.length === 0 || !isPathStart(p.charCodeAt(0))) throw new TemplateError(`template "${name}": ${JSON.stringify(text)} is not a path`);
    for (let i = 1; i < p.length; i++) {
      if (!isPathChar(p.charCodeAt(i))) throw new TemplateError(`template "${name}": ${JSON.stringify(text)} is not a path`);
    }
  }
  return parts;
}

function isTagSpace(line) {
  for (let i = 0; i < line.length; i++) {
    const c = line.charCodeAt(i);
    if (c !== 32 && c !== 9) return false;
  }
  return true;
}

function tokenize(name, src) {
  const tokens = [];
  let text = '';
  let i = 0;
  while (i < src.length) {
    const open = src.indexOf('{', i);
    if (open === -1 || open === src.length - 1) {
      text += src.slice(i);
      break;
    }
    const next = src[open + 1];
    if (next !== '{' && next !== '%') {
      text += src.slice(i, open + 1);
      i = open + 1;
      continue;
    }
    text += src.slice(i, open);
    if (next === '{') {
      const raw = src[open + 2] === '{';
      const close = src.indexOf(raw ? '}}}' : '}}', open + (raw ? 3 : 2));
      if (close === -1) throw new TemplateError(`template "${name}": a ${raw ? '{{{' : '{{'} is not closed`);
      if (text !== '') tokens.push({ t: 'text', text });
      text = '';
      tokens.push({ t: raw ? 'raw' : 'var', path: pathOf(name, src.slice(open + (raw ? 3 : 2), close).trim()) });
      i = close + (raw ? 3 : 2);
      continue;
    }
    const close = src.indexOf('%}', open + 2);
    if (close === -1) throw new TemplateError(`template "${name}": a {% is not closed`);
    const end = close + 2;
    const lineStart = src.lastIndexOf('\n', open - 1) + 1;
    const nl = src.indexOf('\n', end);
    const lineEnd = nl === -1 ? src.length : nl;
    const standalone = isTagSpace(src.slice(lineStart, open)) && isTagSpace(src.slice(end, lineEnd));
    if (standalone) text = text.slice(0, text.length - (open - lineStart));
    if (text !== '') tokens.push({ t: 'text', text });
    text = '';
    tokens.push({ t: 'tag', tag: src.slice(open + 2, close).trim() });
    i = standalone ? (nl === -1 ? src.length : nl + 1) : end;
  }
  if (text !== '') tokens.push({ t: 'text', text });
  return tokens;
}

/** FOR: /^for ([A-Za-z_][A-Za-z0-9_]*) in (\S+)$/" — returns [name, path] or null. */
function forOf(tag) {
  if (!tag.startsWith('for ')) return null;
  const rest = tag.slice(4);
  const inAt = rest.indexOf(' in ');
  if (inAt === -1) return null;
  const name = rest.slice(0, inAt);
  const path = rest.slice(inAt + 4);
  if (name.length === 0 || !isPathStart(name.charCodeAt(0))) return null;
  for (let i = 1; i < name.length; i++) if (!isPathChar(name.charCodeAt(i))) return null;
  if (path.length === 0) return null;
  for (let i = 0; i < path.length; i++) if (/\s/.test(path[i])) return null;
  return [name, path];
}

/** IF: /^if (not )?(\S+)$/" — returns [not, path] or null. */
function ifOf(tag) {
  if (!tag.startsWith('if ')) return null;
  let rest = tag.slice(3);
  let not = false;
  if (rest.startsWith('not ')) { not = true; rest = rest.slice(4); }
  if (rest.length === 0) return null;
  for (let i = 0; i < rest.length; i++) if (/\s/.test(rest[i])) return null;
  return [not, rest];
}

/** INCLUDE: /^include "([a-z0-9-]+)"$/" — returns name or null. */
function includeOf(tag) {
  if (!tag.startsWith('include "') || tag.length < 11 || tag.charCodeAt(tag.length - 1) !== 34) return null;
  const name = tag.slice(9, -1);
  if (name.length === 0) return null;
  for (let i = 0; i < name.length; i++) {
    const c = name.charCodeAt(i);
    if (!((c >= 97 && c <= 122) || (c >= 48 && c <= 57) || c === 45)) return null;
  }
  return name;
}

export function parseTemplate(name, src) {
  const root = { kind: 'root', body: [] };
  const stack = [root];
  let body = root.body;
  for (const tok of tokenize(name, src)) {
    if (tok.t === 'text') body.push({ kind: 'text', text: tok.text });
    else if (tok.t === 'var' || tok.t === 'raw') body.push({ kind: tok.t, path: tok.path });
    else {
      const tag = tok.tag;
      const top = stack[stack.length - 1];
      const f = forOf(tag);
      if (f !== null) {
        const node = { kind: 'for', name: f[0], path: pathOf(name, f[1]), body: [] };
        body.push(node);
        stack.push(node);
        body = node.body;
        continue;
      }
      const q = ifOf(tag);
      if (q !== null) {
        const node = { kind: 'if', not: q[0], path: pathOf(name, q[1]), then: [], else: null };
        body.push(node);
        stack.push(node);
        body = node.then;
        continue;
      }
      if (tag === 'else') {
        if (top.kind !== 'if' || top.else !== null) throw new TemplateError(`template "${name}": an else outside an if`);
        top.else = [];
        body = top.else;
        continue;
      }
      if (tag === 'endfor' || tag === 'endif') {
        if (top.kind !== (tag === 'endfor' ? 'for' : 'if')) throw new TemplateError(`template "${name}": an ${tag} with no open ${tag.slice(3)}`);
        stack.pop();
        const parent = stack[stack.length - 1];
        body = parent.kind === 'root' ? parent.body : parent.kind === 'for' ? parent.body : parent.else ?? parent.then;
        continue;
      }
      const inc = includeOf(tag);
      if (inc !== null) { body.push({ kind: 'include', name: inc }); continue; }
      throw new TemplateError(`template "${name}": {% ${tag} %} is not a tag`);
    }
  }
  if (stack.length > 1) throw new TemplateError(`template "${name}": a ${stack[stack.length - 1].kind} is not closed`);
  return root.body;
}

// Scopes are null-prototype objects chained by prototype: the first name of a
// path resolves with one `in` check walking the chain, exactly the reference's
// hasOwn walk (no Object.prototype names leak in).
function lookup(scope, path) {
  const first = path[0];
  if (!(first in scope)) return undefined;
  let v = scope[first];
  for (let k = 1; k < path.length; k++) {
    if (v === null || typeof v !== 'object' || !Object.hasOwn(v, path[k])) return undefined;
    v = v[path[k]];
  }
  return v;
}

function textOf(v) {
  if (typeof v === 'string') return v;
  if (typeof v === 'number') return String(v);
  if (typeof v === 'boolean') return v ? 'true' : 'false';
  if (Array.isArray(v)) return v.map(textOf).join(', ');
  return '';
}

function truthy(v) {
  if (Array.isArray(v)) return v.length > 0;
  return v !== undefined && v !== null && v !== false && v !== '' && v !== 0;
}

export function renderNodes(nodes, scope, ctx, depth, out) {
  for (let ni = 0; ni < nodes.length; ni++) {
    const n = nodes[ni];
    switch (n.kind) {
      case 'text':
        out.push(n.text);
        break;
      case 'var':
        out.push(escapeHtml(textOf(lookup(scope, n.path))));
        break;
      case 'raw':
        out.push(textOf(lookup(scope, n.path)));
        break;
      case 'if': {
        const v = truthy(lookup(scope, n.path));
        const branch = v !== n.not ? n.then : n.else;
        if (branch !== null) renderNodes(branch, scope, ctx, depth, out);
        break;
      }
      case 'for': {
        const xs = lookup(scope, n.path);
        if (!Array.isArray(xs)) break;
        for (let k = 0; k < xs.length; k++) {
          const child = Object.create(scope);
          child[n.name] = xs[k];
          child.loop = { index: k + 1, first: k === 0, last: k === xs.length - 1, length: xs.length };
          renderNodes(n.body, child, ctx, depth, out);
        }
        break;
      }
      case 'include': {
        const t = ctx.templates.get(n.name);
        if (t !== undefined && depth < 8) renderNodes(t, scope, ctx, depth + 1, out);
        break;
      }
    }
  }
}

// ---------------------------------------------------------------- build

const RESERVED = ['posts', 'tags', 'page'];

function dirOf(path) {
  return path.includes('/') ? path.slice(0, path.lastIndexOf('/')) : '';
}

const DOTSEG = /(^|\/)\.\.?(\/|$)/;

/** `rel` from directory parts `dirParts` (`dirStr` its joined form), or null when it climbs out of the root. */
function resolvePath(dirParts, rel, dirStr) {
  if (!DOTSEG.test(rel) && rel.indexOf('//') === -1 && rel.charCodeAt(0) !== 47 && rel.charCodeAt(rel.length - 1) !== 47) {
    return dirStr === '' ? rel : dirStr + '/' + rel;
  }
  const parts = dirParts.slice();
  for (const seg of rel.split('/')) {
    if (seg === '' || seg === '.') continue;
    if (seg === '..') {
      if (parts.length === 0) return null;
      parts.pop();
    } else parts.push(seg);
  }
  return parts.join('/');
}

/** A link target with a scheme (`https:`, `mailto:` ...). /^[A-Za-z][A-Za-z0-9+.-]*:/ */
function hasScheme(target) {
  const c0 = target.charCodeAt(0);
  if (!((c0 >= 65 && c0 <= 90) || (c0 >= 97 && c0 <= 122))) return false;
  for (let i = 1; i < target.length; i++) {
    const c = target.charCodeAt(i);
    if (c === 58) return true;
    if (!((c >= 65 && c <= 90) || (c >= 97 && c <= 122) || (c >= 48 && c <= 57) || c === 43 || c === 45 || c === 46)) return false;
  }
  return false;
}

export function build(input) {
  const templates = new Map();
  const report = [];
  for (const name of Object.keys(input.templates).sort(byCodeUnits)) {
    try {
      templates.set(name, parseTemplate(name, input.templates[name]));
    } catch (err) {
      if (!(err instanceof TemplateError)) throw err;
      report.push(err.message);
    }
  }
  const base = input.site.base_url.replace(/\/+$/, '');
  const files = [...input.files].sort((x, y) => byCodeUnits(x.path, y.path));
  const sources = [];
  const statics = [];
  for (const f of files) {
    if (!f.path.endsWith('.md')) { statics.push(f); continue; }
    const text = f.content.indexOf('\r') === -1 ? f.content : f.content.replace(/\r\n?/g, '\n');
    const fm = parseFrontMatter(text);
    if ('error' in fm) { report.push(`refused ${f.path}: ${fm.error}`); continue; }
    const s = { path: f.path, data: fm.data, body: fm.body, post: f.path.startsWith('posts/') };
    const own = s.path.startsWith('tags/') ? 'tags' : s.path.startsWith('page/') ? 'page' : undefined;
    if (own !== undefined) { report.push(`refused ${f.path}: ${own}/ is the generator's own`); continue; }
    if (s.post && !Object.hasOwn(s.data, 'date')) { report.push(`refused ${f.path}: a post needs a date`); continue; }
    const layout = s.data.layout ?? (s.post ? 'post' : 'page');
    if (!templates.has(layout)) { report.push(`refused ${f.path}: layout "${layout}" is no template that parses`); continue; }
    s.layout = layout;
    if (s.data.draft === true) { report.push(`draft ${f.path}`); continue; }
    sources.push(s);
  }

  // Permalinks.
  const taken = new Map();
  const bySource = new Map();
  for (const s of sources) {
    const dir = s.post ? 'posts' : dirOf(s.path);
    let set = taken.get(dir);
    if (set === undefined) {
      set = new Set(dir === '' ? RESERVED : []);
      taken.set(dir, set);
    }
    const slug = uniqueSlug(s.data.slug ?? slugify(s.data.title), set);
    s.slug = slug;
    s.outDir = dir === '' ? slug : `${dir}/${slug}`;
    s.url = `${base}/${s.outDir}/`;
    bySource.set(s.path, s);
  }

  // Markdown.
  const staticPaths = new Set(statics.map((f) => f.path));
  const broken = new Set();
  for (const s of sources) {
    const dirStr = dirOf(s.path);
    const dirParts = dirStr === '' ? [] : dirStr.split('/');
    const link = (target) => {
      if (hasScheme(target) || target.charCodeAt(0) === 47 || target.charCodeAt(0) === 35) return target;
      const hash = target.indexOf('#');
      const rel = hash === -1 ? target : target.slice(0, hash);
      const frag = hash === -1 ? '' : target.slice(hash);
      const path = rel === '' ? null : resolvePath(dirParts, rel, dirStr);
      if (path !== null) {
        const hit = bySource.get(path);
        if (hit !== undefined) return `${hit.url}${frag}`;
        if (staticPaths.has(path)) return `${base}/${path}${frag}`;
      }
      broken.add(`broken-link ${s.path} -> ${target}`);
      return target;
    };
    const md = renderMarkdown(s.body, link);
    s.html = md.html;
    s.toc = md.toc;
    s.excerpt = md.excerpt;
    s.words = md.words;
  }

  // Collections.
  const posts = sources.filter((s) => s.post);
  posts.sort((x, y) => byCodeUnits(y.data.date, x.data.date) || byCodeUnits(x.slug, y.slug));
  posts.forEach((p, k) => {
    p.newer = k === 0 ? null : posts[k - 1];
    p.older = k === posts.length - 1 ? null : posts[k + 1];
  });

  // Tags.
  const ownTags = (s) => {
    const seen = new Set();
    const out = [];
    for (const name of s.data.tags ?? []) {
      const sl = slugify(name);
      if (!seen.has(sl)) { seen.add(sl); out.push(name); }
    }
    return out;
  };
  const bySlug = new Map();
  for (const p of posts) {
    p.tagRefs = [];
    for (const name of ownTags(p)) {
      const slug = slugify(name);
      let tag = bySlug.get(slug);
      if (tag === undefined) {
        tag = { name, slug, url: `${base}/tags/${slug}/`, posts: [] };
        bySlug.set(slug, tag);
      }
      tag.posts.push(p);
      p.tagRefs.push(tag);
    }
  }
  for (const s of sources) {
    if (s.post) continue;
    s.tagRefs = ownTags(s).map((name) => {
      const slug = slugify(name);
      return bySlug.get(slug) ?? { name, slug, url: '', posts: [] };
    });
  }
  const tags = [...bySlug.values()].sort((x, y) => y.posts.length - x.posts.length || byCodeUnits(x.slug, y.slug));

  // Cards and pages.
  const linkOf = (s) => (s === null ? null : { title: s.data.title, url: s.url, date: s.data.date ?? '', date_long: s.data.date === undefined ? '' : longDate(s.data.date) });
  const cardOf = (s) => ({
    title: s.data.title,
    url: s.url,
    date: s.data.date ?? '',
    date_long: s.data.date === undefined ? '' : longDate(s.data.date),
    summary: s.data.summary ?? '',
    excerpt: s.excerpt,
    reading_minutes: Math.max(1, Math.ceil(s.words / 200)),
    tags: s.tagRefs.map((t) => ({ name: t.name, slug: t.slug, url: t.url })),
  });
  const cards = new Map();
  for (const s of sources) cards.set(s, cardOf(s));
  const pageOf = (s) => ({
    ...cards.get(s),
    slug: s.slug,
    content: s.html,
    toc: s.toc.map((h) => ({ level: h.level, id: h.id, html: h.html })),
    newer: linkOf(s.newer ?? null),
    older: linkOf(s.older ?? null),
    is_post: s.post,
  });

  // Layouts.
  const baseScope = Object.create(null);
  baseScope.site = { title: input.site.title, base_url: base };
  baseScope.tags = tags.map((t) => ({ name: t.name, slug: t.slug, url: t.url, count: t.posts.length }));
  baseScope.recent = posts.slice(0, input.site.recent).map((p) => cards.get(p));
  const ctx = { templates };
  const output = {};
  const render = (name, page, postsSlice, pager, tag) => {
    const nodes = templates.get(name);
    if (nodes === undefined) return null;
    const scope = Object.create(baseScope);
    if (page !== undefined) scope.page = page;
    if (postsSlice !== undefined) scope.posts = postsSlice;
    if (pager !== undefined) scope.pager = pager;
    if (tag !== undefined) scope.tag = tag;
    const out = [];
    renderNodes(nodes, scope, ctx, 0, out);
    return out.join('');
  };
  for (const s of sources) output[`${s.outDir}/index.html`] = render(s.layout, pageOf(s));
  const per = input.site.per_page;
  const pages = Math.max(1, Math.ceil(posts.length / per));
  const indexUrl = (k) => (k === 1 ? `${base}/` : `${base}/page/${k}/`);
  for (let k = 1; k <= pages; k++) {
    const html = render('index', undefined, posts.slice((k - 1) * per, k * per).map((p) => cards.get(p)), { number: k, total: pages, url: indexUrl(k), newer_url: k === 1 ? '' : indexUrl(k - 1), older_url: k === pages ? '' : indexUrl(k + 1) });
    if (html !== null) output[k === 1 ? 'index.html' : `page/${k}/index.html`] = html;
  }
  for (const t of tags) {
    const html = render('tag', undefined, undefined, undefined, { name: t.name, slug: t.slug, url: t.url, count: t.posts.length, posts: t.posts.map((p) => cards.get(p)) });
    if (html !== null) output[`tags/${t.slug}/index.html`] = html;
  }
  const tagsHtml = render('tags');
  if (tagsHtml !== null) output['tags/index.html'] = tagsHtml;
  for (const f of statics) {
    if (Object.hasOwn(output, f.path)) report.push(`shadowed ${f.path}: a built page has its path`);
    else output[f.path] = f.content;
  }

  // Report.
  const lines = [...report, ...broken].sort(byCodeUnits);
  let pageCount = 0;
  for (const s of sources) if (!s.post) pageCount++;
  lines.push(`built ${pageCount} pages, ${posts.length} posts, ${tags.length} tags and ${statics.length} static files`);
  output['build-report.txt'] = `${lines.join('\n')}\n`;
  return output;
}

export function run(input) {
  return build(input);
}
