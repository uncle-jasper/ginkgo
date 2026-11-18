/* spell.js — a small offline spellchecker for CodeMirror 6.
   Shared by Ginkgo and Tree; keep both copies identical.

   - Word list: spell-words.txt next to this file (Hunspell en_US / SCOWL plus
     common modern words), loaded once and cached by the service worker.
   - Misspelled words get a wavy underline. The app's word menu shows
     suggestions, "add to dictionary" and "ignore" (see extension()).
   - Nothing leaves the device. Added words live in localStorage.

   Usage:  const ext = Spell.extension(CM6, { wordsUrl, storageKey, onMenu });
           ...put ext in the editor's extensions; Spell.setEnabled(view, bool). */
(function (root) {
  'use strict';

  // ── Dictionary ──────────────────────────────────────────────────────
  let WORDS = null;            // Map: lowercase word -> frequency tier (0..15)
  let loadPromise = null;
  let userWords = new Set();
  let ignored = new Set();     // session-only "ignore"
  let storageKey = 'spell-user-words';

  // spell-words.txt is front-coded: each line is [shared-prefix length][rest of
  // word][tier letter A–P]. Lines starting with '#' are comments.
  function parseWords(text) {
    const map = new Map();
    let prev = '';
    const lines = text.split('\n');
    for (let i = 0; i < lines.length; i++) {
      const line = lines[i];
      if (!line || line[0] === '#') continue;
      let j = 0, n = 0;
      while (j < line.length && line.charCodeAt(j) >= 48 && line.charCodeAt(j) <= 57) {
        n = n * 10 + (line.charCodeAt(j) - 48); j++;
      }
      const tier = line.charCodeAt(line.length - 1) - 65;
      const w = prev.slice(0, n) + line.slice(j, line.length - 1);
      map.set(w, tier);
      prev = w;
    }
    return map;
  }

  function load(url) {
    if (WORDS) return Promise.resolve(WORDS);
    if (!loadPromise) {
      loadPromise = fetch(url)
        .then(r => { if (!r.ok) throw new Error('spell words ' + r.status); return r.text(); })
        .then(t => { WORDS = parseWords(t); buildIndex(); return WORDS; })
        .catch(e => { loadPromise = null; throw e; });
    }
    return loadPromise;
  }

  function loadUserWords() {
    try {
      const raw = localStorage.getItem(storageKey);
      userWords = new Set(raw ? JSON.parse(raw) : []);
    } catch (e) { userWords = new Set(); }
  }
  function saveUserWords() {
    try { localStorage.setItem(storageKey, JSON.stringify([...userWords].sort())); } catch (e) {}
  }

  // ── Checking ────────────────────────────────────────────────────────
  // Hyphen prefixes that aren't words on their own ("pre-work", "re-read").
  const PREFIXES = new Set(['pre', 're', 'non', 'co', 'anti', 'semi', 'multi', 'mid', 'self',
    'ex', 'post', 'sub', 'un', 'bi', 'tri', 'mini', 'micro', 'mega', 'ultra', 'inter', 'intra',
    'over', 'under', 'out', 'counter', 'pseudo', 'quasi', 'neo', 'proto', 'meta', 'e']);

  const cache = new Map();

  function known(lw) {
    return WORDS.has(lw) || userWords.has(lw);
  }

  // lw: lowercase word with straight apostrophes, no hyphens.
  function knownPart(lw) {
    if (known(lw)) return true;
    // Possessives: week's, James', Ricoh's
    if (lw.endsWith("'s") && known(lw.slice(0, -2))) return true;
    if (lw.endsWith("'") && known(lw.slice(0, -1))) return true;
    return false;
  }

  function isCorrect(word) {
    const lw = word.toLowerCase().replace(/’/g, "'");
    if (ignored.has(lw)) return true;
    let r = cache.get(lw);
    if (r !== undefined) return r;
    if (knownPart(lw)) r = true;
    else if (lw.indexOf('-') > 0) {
      const parts = lw.split('-');
      r = parts.every((p, i) => !p || knownPart(p) || (i < parts.length - 1 && PREFIXES.has(p)));
    } else r = false;
    cache.set(lw, r);
    return r;
  }

  // Splits text into words worth checking. Skips anything that looks like a
  // URL, email, path, number, handle, hashtag, code-ish or ALL-CAPS token.
  const CHUNK_RE = /\S+/g;
  const WORD_RE = /[A-Za-zÀ-ɏ]+(?:['’-][A-Za-zÀ-ɏ]+)*/g;
  function* wordsIn(text, offset) {
    CHUNK_RE.lastIndex = 0;
    let c;
    while ((c = CHUNK_RE.exec(text))) {
      const chunk = c[0];
      if (/[0-9_@#\\/=<>|~^$%{}]/.test(chunk)) continue;
      if (/[A-Za-z]\.[A-Za-z]/.test(chunk)) continue;      // domains, e.g., i.e.
      if (/:\/\/|^www\./i.test(chunk)) continue;
      WORD_RE.lastIndex = 0;
      let m;
      while ((m = WORD_RE.exec(chunk))) {
        const w = m[0];
        if (w.length < 2) continue;
        if (w === w.toUpperCase()) continue;                    // NYPD, OK, TV
        if (/[a-zà-ɏ][A-Z]/.test(w)) continue;        // iPhone, macOS
        if (/[^\x00-\x7F]/.test(w)) continue;                   // café, naïve, non-English
        yield { from: offset + c.index + m.index, to: offset + c.index + m.index + w.length, word: w };
      }
    }
  }

  // ── Suggestions ─────────────────────────────────────────────────────
  let byFirst = null;   // Map: first letter -> array of [word, tier]
  function buildIndex() {
    byFirst = new Map();
    for (const [w, t] of WORDS) {
      const k = w[0];
      let a = byFirst.get(k);
      if (!a) byFirst.set(k, a = []);
      a.push([w, t]);
    }
  }

  const VOWELS = new Set('aeiouy');
  // Letters people mix up because they sound alike or sit side by side.
  const NEAR = {};
  [['c', 'k'], ['c', 's'], ['s', 'z'], ['k', 'q'], ['f', 'v'], ['g', 'j'], ['m', 'n'], ['b', 'p'],
   ['d', 't'], ['x', 'z'], ['w', 'v'],
   // keyboard neighbours (QWERTY)
   ['q', 'w'], ['w', 'e'], ['e', 'r'], ['r', 't'], ['t', 'y'], ['y', 'u'], ['u', 'i'], ['i', 'o'], ['o', 'p'],
   ['a', 's'], ['s', 'd'], ['d', 'f'], ['f', 'g'], ['g', 'h'], ['h', 'j'], ['j', 'k'], ['k', 'l'],
   ['z', 'x'], ['x', 'c'], ['c', 'v'], ['v', 'b'], ['b', 'n'], ['n', 'm']
  ].forEach(([a, b]) => { NEAR[a + b] = NEAR[b + a] = 1; });

  // First letters worth searching besides the word's own.
  const FIRST_ALT = { c: 'ks', k: 'cq', s: 'cz', q: 'k', f: 'p', p: 'f', g: 'j', j: 'g', n: 'k',
    w: 'r', r: 'w', a: 'eiou', e: 'aiou', i: 'aeouy', o: 'aeiu', u: 'aeio', y: 'i', x: 'e', z: 's' };

  function subCost(a, b) {
    if (a === b) return 0;
    if (VOWELS.has(a) && VOWELS.has(b)) return 0.5;
    if (NEAR[a + b]) return 0.7;
    return 1;
  }
  // Cost of a letter that's in one word but not the other. Doubled letters
  // (untill, ocured) and vowels are the usual culprits, so they cost less.
  function indelCost(s, i) {
    const ch = s[i];
    if ((i > 0 && s[i - 1] === ch) || (i + 1 < s.length && s[i + 1] === ch)) return 0.4;
    if (VOWELS.has(ch)) return 0.7;
    if (ch === 'h' && i > 0 && 'cgstwpr'.includes(s[i - 1])) return 0.6; // rythm, wich
    return 1;
  }

  // Weighted Damerau–Levenshtein with an early exit once every cell > max.
  const rowA = new Float32Array(64), rowB = new Float32Array(64), rowC = new Float32Array(64);
  function distance(a, b, max) {
    const n = a.length, m = b.length;
    if (n > 60 || m > 60) return Infinity;
    let prev2 = rowA, prev = rowB, cur = rowC;
    prev[0] = 0;
    for (let j = 1; j <= m; j++) prev[j] = prev[j - 1] + indelCost(b, j - 1);
    for (let i = 1; i <= n; i++) {
      cur[0] = prev[0] + indelCost(a, i - 1);
      let rowMin = cur[0];
      const ai = a[i - 1];
      for (let j = 1; j <= m; j++) {
        const bj = b[j - 1];
        let v = prev[j - 1] + subCost(ai, bj);
        const del = prev[j] + indelCost(a, i - 1);
        if (del < v) v = del;
        const ins = cur[j - 1] + indelCost(b, j - 1);
        if (ins < v) v = ins;
        if (i > 1 && j > 1 && ai === b[j - 2] && a[i - 2] === bj) {
          const tr = prev2[j - 2] + 0.6;
          if (tr < v) v = tr;
        }
        cur[j] = v;
        if (v < rowMin) rowMin = v;
      }
      if (rowMin > max) return Infinity;
      const t = prev2; prev2 = prev; prev = cur; cur = t;
    }
    return prev[m];
  }

  // Rough sound key: collapses spellings that sound the same.
  function soundKey(w) {
    return w
      .replace(/ph/g, 'f').replace(/gh/g, 'g').replace(/ck/g, 'k').replace(/qu/g, 'kw')
      .replace(/c([eiy])/g, 's$1').replace(/c/g, 'k').replace(/z/g, 's').replace(/x/g, 'ks')
      .replace(/wr/g, 'r').replace(/kn/g, 'n').replace(/[aeiouy]+/g, 'a')
      .replace(/(.)\1+/g, '$1');
  }

  // Short words that commonly get run together with a neighbour.
  const SHORT_OK = new Set(['a', 'i', 'an', 'as', 'at', 'be', 'by', 'do', 'go', 'he', 'if', 'in', 'is',
    'it', 'me', 'my', 'no', 'of', 'on', 'or', 'so', 'to', 'up', 'us', 'we']);
  function splitPartOk(p) { return p.length > 2 || SHORT_OK.has(p); }

  function suggest(word, limit) {
    limit = limit || 5;
    if (!WORDS) return [];
    const lw = word.toLowerCase().replace(/’/g, "'");
    const len = lw.length;
    const maxLenDiff = len <= 4 ? 1 : len <= 7 ? 2 : len <= 11 ? 3 : 4;
    const maxCost = len <= 3 ? 1 : len <= 5 ? 1.5 : len <= 8 ? 2.2 : 3;
    const key = soundKey(lw);
    const firsts = lw[0] + (FIRST_ALT[lw[0]] || '');
    const scored = [];
    for (const f of firsts) {
      const list = byFirst.get(f);
      if (!list) continue;
      const firstPenalty = f === lw[0] ? 0 : 0.5;
      for (let k = 0; k < list.length; k++) {
        const w = list[k][0];
        if (Math.abs(w.length - len) > maxLenDiff) continue;
        const d = distance(lw, w, maxCost);
        if (d > maxCost) continue;
        const tier = list[k][1];
        let score = d + firstPenalty - tier * 0.12;
        if (soundKey(w) === key) score -= 0.6;
        scored.push([w, score]);
      }
    }
    for (const w of userWords) {
      if (Math.abs(w.length - len) > maxLenDiff) continue;
      const d = distance(lw, w, maxCost);
      if (d <= maxCost) scored.push([w, d - 1]);
    }
    // Run-together words: "alot" -> "a lot", "eachother" -> "each other".
    for (let i = 1; i < len; i++) {
      const a = lw.slice(0, i), b = lw.slice(i);
      const ta = WORDS.get(a), tb = WORDS.get(b);
      if (ta === undefined || tb === undefined) continue;
      if (!splitPartOk(a) || !splitPartOk(b) || b === 'a' || b === 'i') continue;
      if (Math.min(ta, tb) < 10) continue;
      scored.push([a + ' ' + b, 0.3 - Math.min(ta, tb) * 0.12]);
    }
    scored.sort((x, y) => x[1] - y[1]);
    const out = [], seen = new Set();
    for (const [w] of scored) {
      if (seen.has(w) || w === lw) continue;
      seen.add(w);
      out.push(matchCase(word, w));
      if (out.length >= limit) break;
    }
    return out;
  }

  function matchCase(orig, sug) {
    if (orig.length > 1 && orig === orig.toUpperCase()) return sug.toUpperCase();
    if (orig[0] === orig[0].toUpperCase() && orig[0] !== orig[0].toLowerCase())
      return sug[0].toUpperCase() + sug.slice(1);
    return sug;
  }

  // ── CodeMirror extension ────────────────────────────────────────────
  // Markdown nodes whose text shouldn't be checked.
  const SKIP_NODES = /^(URL|LinkLabel|LinkTitle|CodeText|InlineCode|FencedCode|CodeBlock|CodeInfo|HTMLTag|HTMLBlock|Autolink|Comment|CommentBlock|ProcessingInstruction)$/;

  // Underlines misspelled words. It draws no menu of its own: clicking an
  // underlined word, or Ctrl/Cmd+;, calls opts.onMenu(view, {from, to}) and
  // the app shows its word menu (suggestions, define, synonyms) there.
  function extension(CM, opts) {
    opts = opts || {};
    if (opts.storageKey) storageKey = opts.storageKey;
    loadUserWords();
    const { ViewPlugin, Decoration, keymap, StateEffect, syntaxTree } = CM;
    const mark = Decoration.mark({ class: 'cm-misspelled' });
    const refresh = StateEffect.define();
    let enabled = opts.enabled !== false;
    const views = new Set();

    function refreshAll() { cache.clear(); views.forEach(v => v.dispatch({ effects: refresh.of(null) })); }

    function skipped(state, from, to) {
      let skip = false;
      syntaxTree(state).iterate({ from, to, enter: n => {
        if (SKIP_NODES.test(n.name) && n.from < to && n.to > from) { skip = true; return false; }
      }});
      return skip || !!(opts.skip && opts.skip(state, from, to));
    }

    const plugin = ViewPlugin.fromClass(class {
      constructor(view) {
        this.view = view;
        this.decorations = Decoration.none;
        this.typingAt = -1;
        this.pendingOpen = null;
        views.add(view);
        if (enabled) this.ensureLoaded();
        this.build();
      }
      ensureLoaded() {
        if (WORDS) return;
        load(opts.wordsUrl || 'spell-words.txt').then(() => {
          if (views.has(this.view)) this.view.dispatch({ effects: refresh.of(null) });
        }, () => {});
      }
      update(u) {
        let forced = u.transactions.some(t => t.effects.some(e => e.is(refresh)));
        if (u.docChanged) {
          const typed = u.transactions.some(t => t.isUserEvent('input.type') || t.isUserEvent('delete'));
          this.typingAt = typed ? u.state.selection.main.head : -1;
        } else if (u.selectionSet && this.typingAt >= 0) {
          // Moving the cursor off the word you were typing lets it be checked.
          const h = u.state.selection.main.head;
          if (!u.state.selection.main.empty || h !== this.typingAt ||
              u.transactions.some(t => t.isUserEvent('select'))) { this.typingAt = -1; forced = true; }
        }
        if (forced || u.docChanged || u.viewportChanged) this.build();
      }
      build() {
        if (!enabled || !WORDS) { this.decorations = Decoration.none; return; }
        const { state } = this.view;
        const ranges = [];
        const tree = syntaxTree(state);
        for (const { from, to } of this.view.visibleRanges) {
          // Collect regions to skip (code, URLs, HTML) in this range.
          const skips = [];
          tree.iterate({ from, to, enter: n => {
            if (SKIP_NODES.test(n.name)) { skips.push([n.from, n.to]); return false; }
          }});
          let line = state.doc.lineAt(from);
          for (;;) {
            for (const w of wordsIn(line.text, line.from)) {
              if (w.to < from || w.from > to) continue;
              if (this.typingAt >= w.from && this.typingAt <= w.to) continue;
              if (skips.some(([a, b]) => w.from < b && w.to > a)) continue;
              if (opts.skip && opts.skip(state, w.from, w.to)) continue;
              if (!isCorrect(w.word)) ranges.push(mark.range(w.from, w.to));
            }
            if (line.to >= to || line.number >= state.doc.lines) break;
            line = state.doc.line(line.number + 1);
          }
        }
        this.decorations = Decoration.set(ranges, true);
      }
      markAt(pos) {
        let found = null;
        this.decorations.between(pos, pos, (from, to) => { found = { from, to }; return false; });
        return found;
      }
      // First flagged word at or after the cursor (wrapping to the top).
      nextMark(pos) {
        let first = null, after = null;
        this.decorations.between(0, this.view.state.doc.length, (from, to) => {
          if (!first) first = { from, to };
          if (!after && to >= pos) after = { from, to };
        });
        return after || first;
      }
      destroy() { clearTimeout(this.pendingOpen); views.delete(this.view); }
    }, {
      decorations: v => v.decorations,
      eventHandlers: {
        // A second click cancels the pending single-click menu: a double-click
        // opens the same menu through the app's own handler.
        mousedown(e, view) {
          const p = view.plugin(plugin);
          if (p && p.pendingOpen) { clearTimeout(p.pendingOpen); p.pendingOpen = null; }
        },
        mouseup(e, view) {
          if (!opts.onMenu) return;
          if (e.button !== 0 || e.detail > 1 || e.shiftKey || e.metaKey || e.ctrlKey || e.altKey) return;
          const p = view.plugin(plugin);
          if (!p) return;
          const pos = view.posAtCoords({ x: e.clientX, y: e.clientY });
          if (pos == null || !p.markAt(pos)) return;
          // Check after the delay: clicking a selected word only clears the
          // selection once the click finishes.
          p.pendingOpen = setTimeout(() => {
            p.pendingOpen = null;
            if (!view.state.selection.main.empty) return;
            const r = p.markAt(pos);
            if (r) opts.onMenu(view, r);
          }, 250);
        }
      }
    });

    const keys = keymap.of([
      { key: 'Mod-;', run: view => {
        const p = view.plugin(plugin);
        if (!p || !enabled || !opts.onMenu) return false;
        const head = view.state.selection.main.head;
        const r = p.markAt(head) || p.nextMark(head);
        if (r) opts.onMenu(view, r);
        return true;
      }}
    ]);

    if (!document.getElementById('cm-spell-style')) {
      const st = document.createElement('style');
      st.id = 'cm-spell-style';
      // !important: the apps reset text-decoration on every span in a line.
      st.textContent =
        '.cm-content .cm-misspelled,.cm-line .cm-misspelled{text-decoration-line:underline!important;' +
        'text-decoration-style:wavy!important;text-decoration-color:rgba(224,96,96,.8)!important;' +
        'text-decoration-thickness:1px!important;text-underline-offset:3px;text-decoration-skip-ink:none}';
      document.head.appendChild(st);
    }

    api.setEnabled = function (view, on) {
      enabled = !!on;
      const p = view && view.plugin(plugin);
      if (p && on) p.ensureLoaded();
      refreshAll();
    };
    api.isEnabled = () => enabled && !!WORDS;
    // Misspelled = spellcheck on, list loaded, and the word isn't known.
    api.isMisspelled = word => enabled && !!WORDS && !isCorrect(word);
    api.markAt = (view, pos) => { const p = view.plugin(plugin); return p ? p.markAt(pos) : null; };
    api.isSkipped = skipped;
    api.addWord = word => { userWords.add(norm(word)); saveUserWords(); refreshAll(); };
    api.ignoreWord = word => { ignored.add(norm(word)); refreshAll(); };
    return [plugin, keys];
  }

  function norm(w) { return w.toLowerCase().replace(/’/g, "'"); }

  const api = {
    extension,
    setEnabled() {},
    isEnabled: () => false,
    isMisspelled: () => false,
    markAt: () => null,
    isSkipped: () => false,
    addWord() {},
    ignoreWord() {},
    suggest,
    matchCase,
    // Exposed for testing.
    _parse: t => { WORDS = parseWords(t); buildIndex(); },
    isCorrect: w => !!WORDS && isCorrect(w),
    wordsIn: (t, o) => [...wordsIn(t, o || 0)]
  };
  root.Spell = api;
  if (typeof module === 'object' && module.exports) module.exports = api;
})(typeof window !== 'undefined' ? window : globalThis);
