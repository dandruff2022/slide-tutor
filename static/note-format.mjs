export const markerColors = ['yellow', 'green', 'blue', 'pink', 'purple'];
const escapeHTML = text => text.replace(/[&<>"']/g, char => ({'&':'&amp;', '<':'&lt;', '>':'&gt;', '"':'&quot;', "'":'&#39;'}[char]));
const mathPattern = /\$\$[\s\S]*?\$\$|\\\[[\s\S]*?\\\]|\\\([\s\S]*?\\\)|(?<!\\)\$(?!\$)(?:\\.|[^$\n])+?\$/g;
const codePattern = /(`+)[^\n]*?\1/g;

export function protectedSpans(text) {
  return [...text.matchAll(mathPattern), ...text.matchAll(codePattern)]
    .map(match => [match.index, match.index + match[0].length]);
}
function overlap(start, end, [a, b]) { return start < b && end > a; }
export function highlights(text) {
  const protectedParts = protectedSpans(text);
  return [...text.matchAll(/==(?:\{(yellow|green|blue|pink|purple)\})?((?:(?!==)[^\n])+)==/g)]
    .filter(match => !(!match[1] && /^\{[^}]*\}/.test(match[2])) && !protectedParts.some(([a, b]) =>
      (match.index >= a && match.index < b) || (match.index + match[0].length > a && match.index + match[0].length <= b)))
    .map(match => ({start: match.index, end: match.index + match[0].length, color: match[1] || 'yellow',
      content: match[2], inner: match.index + 2 + (match[1] ? match[1].length + 2 : 0)}));
}

// Marked owns emphasis/code parsing. These extensions never accept arbitrary colors or styles.
const configured = new WeakSet();
export function installNoteSyntax(marked) {
  if (configured.has(marked)) return;
  configured.add(marked);
  marked.use({extensions: [{
    name: 'noteHighlight', level: 'inline',
    start: source => source.indexOf('=='),
    tokenizer(source) {
      const match = /^==(?:\{(yellow|green|blue|pink|purple)\})?((?:(?!==)[^\n])+)==/.exec(source);
      if (!match || (!match[1] && /^\{[^}]*\}/.test(match[2]))) return;
      return {type: 'noteHighlight', raw: match[0], color: match[1] || 'yellow', text: match[2],
        tokens: this.lexer.inlineTokens(match[2])};
    },
    renderer(token) { return `<mark class="note-highlight-${token.color}">${this.parser.parseInline(token.tokens)}</mark>`; }
  }, {
    name: 'noteMath', level: 'inline',
    start: source => source.search(/\$|\\[([]/),
    tokenizer(source) {
      const match = new RegExp('^(?:' + mathPattern.source + ')').exec(source);
      if (match) return {type: 'noteMath', raw: match[0]};
    },
    renderer(token) { return escapeHTML(token.raw); }
  }]});
}

// Offsets are relative to a source line, not its rendered text. Every repeated word keeps its own range.
export function mappedInline(source, offset, marked) {
  installNoteSyntax(marked);
  const span = (html, start, end, kind = 'text') => `<span data-note-start="${start}" data-note-end="${end}" data-note-kind="${kind}">${html}</span>`;
  function tokensHTML(tokens, base) {
    let cursor = base;
    return tokens.map(token => {
      const start = cursor; cursor += token.raw.length;
      if (token.type === 'text' && !token.tokens) {
        let at = start;
        return token.raw.split(/(&(?:#\d+|#x[\da-f]+|[a-z][\da-z]+);)/gi).map(part => {
          const end = at + part.length, entity = /^&.*;$/.test(part);
          const html = span(entity ? part : escapeHTML(part), at, end, entity ? 'entity' : 'text');
          at = end; return html;
        }).join('');
      }
      if (token.type === 'noteMath') return span(escapeHTML(token.raw), start, cursor, 'math');
      if (token.type === 'codespan') return span(`<code>${escapeHTML(token.text)}</code>`, start, cursor, 'code');
      if (token.type === 'escape') return span(escapeHTML(token.text), start, cursor, 'escape');
      if (['strong', 'em', 'del', 'noteHighlight', 'link', 'text'].includes(token.type) && token.tokens) {
        const innerOffset = token.type === 'link' ? token.raw.indexOf('[') + 1 :
          token.type === 'noteHighlight' ? 2 + (token.raw.startsWith('=={') ? token.color.length + 2 : 0) :
          token.type === 'text' ? 0 : (token.raw.length - token.text.length) / 2;
        const html = tokensHTML(token.tokens, start + innerOffset);
        if (token.type === 'text') return html;
        if (token.type === 'link') return `<a href="${escapeHTML(token.href)}">${html}</a>`;
        if (token.type === 'noteHighlight') return `<mark class="note-highlight-${token.color}">${html}</mark>`;
        const tag = {strong: 'strong', em: 'em', del: 'del'}[token.type];
        return `<${tag}>${html}</${tag}>`;
      }
      if (token.type === 'html') return span(escapeHTML(token.raw), start, cursor, 'atomic');
      // Unsupported images/line breaks remain atomic; their attributes are never source-edit targets.
      return span(marked.Parser.parseInline([token], marked.defaults), start, cursor, 'atomic');
    }).join('');
  }
  return tokensHTML(marked.Lexer.lexInline(source, marked.defaults), offset);
}

export function rawFormula(line) {
  const text = line.trim().replace(/^(?:\d+[.)]|[-+*])\s+/, '');
  const outside = text.replace(/\\(?:text|mathrm|operatorname)\{[^{}]*\}/g, '').replace(/\\[a-zA-Z]+/g, '');
  return !/[$`]|==|^[*#]/.test(text) && /[\\^_]/.test(text) && !/[㐀-鿿]|[A-Za-z]{2,}\s+[A-Za-z]{2,}/.test(outside);
}
function proseStart(line) {
  return /^(?:\s*)(?:(?:\d+[.)]|[-+*])\s+|#{1,6}\s+)?/.exec(line)[0].length;
}

// Apply edits from right to left. Ranges in the result still select the content, not its new delimiters.
export function formatNote(text, ranges, kind) {
  if (!['italic', 'bold', 'both', 'clear', ...markerColors].includes(kind)) throw new Error('Unknown note format');
  const lines = text.split('\n'), edits = [];
  for (const range of ranges) {
    const line = lines[range.line];
    if (line === undefined || line.trimStart().startsWith('|') || rawFormula(line)) continue;
    let start = Math.max(range.start, proseStart(line)), end = Math.min(range.end, line.length);
    if (start >= end) continue;
    const protectedParts = protectedSpans(line);
    // Code and math are indivisible: formatting prose must not change their internal source.
    const pieces = [[start, end]];
    for (const [a, b] of protectedParts) {
      for (let i = pieces.length - 1; i >= 0; i--) {
        const [s, e] = pieces[i];
        if (overlap(s, e, [a, b])) pieces.splice(i, 1, ...[[s, Math.min(a, e)], [Math.max(s, b), e]].filter(([x, y]) => x < y));
      }
    }
    for (let [s, e] of pieces) {
      while (s < e && /\s/.test(line[s])) s++;
      while (e > s && /\s/.test(line[e - 1])) e--;
      if (s >= e) continue;
      let content = line.slice(s, e), open = '', close = '';
      if (markerColors.includes(kind) || kind === 'clear') {
        const existing = highlights(line).filter(mark => overlap(s, e, [mark.start, mark.end]));
        if (existing.length) {
          s = Math.min(s, existing[0].start); e = Math.max(e, existing.at(-1).end);
          content = line.slice(s, e);
          for (const mark of [...existing].reverse()) content = content.slice(0, mark.start - s) + mark.content + content.slice(mark.end - s);
        } else if (kind === 'clear') continue;
        if (kind !== 'clear') { open = kind === 'yellow' ? '==' : `=={${kind}}`; close = '=='; }
      } else {
        // Recognize an exact surrounding emphasis wrapper, including source selections of the wrapper itself.
        let wrapped = false;
        for (let count = 3; count >= 1; count--) {
          for (const char of ['*', '_']) {
            const delimiter = char.repeat(count);
            if (!wrapped && line.slice(Math.max(0, s - count), s) === delimiter && line.slice(e, e + count) === delimiter) {
              s -= count; e += count; wrapped = true;
            } else if (!wrapped && content.startsWith(delimiter) && content.endsWith(delimiter) && content.length > count * 2) {
              content = content.slice(count, -count); wrapped = true;
            }
          }
        }
        open = close = '*'.repeat({italic: 1, bold: 2, both: 3}[kind]);
      }
      edits.push({line: range.line, start: s, end: e, content, open, close});
    }
  }
  edits.sort((a, b) => a.line - b.line || a.start - b.start);
  // A selection crossing one highlight may yield several pieces; apply its replacement once.
  const unique = edits.filter((edit, i) => !i || edit.line !== edits[i - 1].line || edit.start >= edits[i - 1].end);
  const selected = [];
  let shift = 0, previousLine = -1;
  for (const edit of unique) {
    if (edit.line !== previousLine) { shift = 0; previousLine = edit.line; }
    const start = edit.start + shift + edit.open.length;
    selected.push({line: edit.line, start, end: start + edit.content.length});
    shift += edit.open.length + edit.content.length + edit.close.length - (edit.end - edit.start);
  }
  for (const edit of [...unique].reverse()) {
    lines[edit.line] = lines[edit.line].slice(0, edit.start) + edit.open + edit.content + edit.close + lines[edit.line].slice(edit.end);
  }
  return {text: lines.join('\n'), ranges: selected};
}
