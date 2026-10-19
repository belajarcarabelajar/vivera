// scripts/lib/docs-gen-links.mjs
//
// Link rewriting for scripts/docs-gen.mjs: every Markdown link, reference
// definition, and HTML href/src/srcset on one line goes through a rewrite
// callback, with code spans left untouched.

function splitCode(line) {
  const parts = [];
  let i = 0;
  let last = 0;
  while (i < line.length) {
    if (line[i] !== '`') { i++; continue; }
    let j = i;
    while (j < line.length && line[j] === '`') j++;
    const len = j - i;
    let k = j;
    let close = -1;
    while (k < line.length) {
      if (line[k] !== '`') { k++; continue; }
      let e = k;
      while (e < line.length && line[e] === '`') e++;
      if (e - k === len) { close = k; break; }
      k = e;
    }
    if (close === -1) { i = j; continue; }
    if (i > last) parts.push({ code: false, text: line.slice(last, i) });
    parts.push({ code: true, text: line.slice(i, close + len) });
    i = last = close + len;
  }
  if (last < line.length) parts.push({ code: false, text: line.slice(last) });
  return parts;
}

function rewriteDest(dest, kind, rewrite) {
  if (dest.startsWith('<') && dest.endsWith('>')) {
    const r = rewrite(dest.slice(1, -1), kind);
    return { dest: `<${r.url}>`, dead: r.dead };
  }
  const r = rewrite(dest, kind);
  return { dest: r.url, dead: r.dead };
}

function matchBracket(s, open) {
  let depth = 0;
  for (let i = open; i < s.length; i++) {
    if (s[i] === '\\') { i++; continue; }
    if (s[i] === '[') depth++;
    else if (s[i] === ']' && --depth === 0) return i;
  }
  return -1;
}

const LINK_TAIL = /^\((\s*)(<[^>\n]*>|[^\s)]+)((?:\s+(?:"[^"]*"|'[^']*'))?\s*)\)/;

// A forward scan rather than a regex, so a dead link can be replaced by its
// whole text, including a nested image or code span inside the brackets.
function rewriteMarkdownLinks(s, rewrite) {
  let out = '';
  let i = 0;
  while (i < s.length) {
    const image = s[i] === '!' && s[i + 1] === '[';
    if (s[i] === '[' || image) {
      const open = image ? i + 1 : i;
      const close = matchBracket(s, open);
      const m = close === -1 ? null : LINK_TAIL.exec(s.slice(close + 1));
      if (m) {
        const text = rewriteMarkdownLinks(s.slice(open + 1, close), rewrite);
        const r = rewriteDest(m[2], image ? 'image' : 'link', rewrite);
        out += r.dead ? text : `${image ? '!' : ''}[${text}](${m[1]}${r.dest}${m[3]})`;
        i = close + 1 + m[0].length;
        continue;
      }
    }
    out += s[i];
    i++;
  }
  return out;
}

export function rewriteLine(line, rewrite) {
  const codes = [];
  let s = splitCode(line).map((p) => {
    if (!p.code) return p.text;
    codes.push(p.text);
    return `${codes.length - 1}`;
  }).join('');
  s = s.replace(/^( {0,3}\[(?!\^)[^\]]+\]:[ \t]*)(<[^>]*>|\S+)/, (_, pre, dest) => pre + rewriteDest(dest, 'link', rewrite).dest);
  s = rewriteMarkdownLinks(s, rewrite);
  s = s.replace(/(\s(href|src)\s*=\s*)(["'])(.*?)\3/gi, (_, pre, attr, q, url) => {
    const isSrc = attr.toLowerCase() === 'src';
    const r = rewrite(url, isSrc ? 'image' : 'link');
    return r.dead && !isSrc ? '' : `${pre}${q}${r.url}${q}`;
  });
  s = s.replace(/(\ssrcset\s*=\s*)(["'])(.*?)\2/gi, (_, pre, q, list) => {
    const items = list.split(',').map((item) => {
      const m = item.match(/^(\s*)(\S+)(.*)$/);
      return m ? m[1] + rewrite(m[2], 'image').url + m[3] : item;
    });
    return `${pre}${q}${items.join(',')}${q}`;
  });
  // A dead href was removed above; an anchor element left with no attributes is plain text.
  s = s.replace(/<a>([\s\S]*?)<\/a>/g, '$1');
  return s.replace(/(\d+)/g, (_, n) => codes[Number(n)]);
}
