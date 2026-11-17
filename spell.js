/* spell.js — a small offline spellchecker for CodeMirror 6.
   Shared by Ginkgo and Tree; keep both copies identical.

   - Word list: spell-words.txt next to this file (Hunspell en_US / SCOWL plus
     common modern words), loaded once and cached by the service worker.
   - Misspelled words get a wavy underline. Click one (or press Ctrl/Cmd+;)
     for suggestions, "add to dictionary" or "ignore".
   - Nothing leaves the device. Added words live in localStorage.

   Usage:  const ext = Spell.extension(CM6, { wordsUrl, storageKey });
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

  function extension(CM, opts) {
    opts = opts || {};
    if (opts.storageKey) storageKey = opts.storageKey;
    loadUserWords();
    const { ViewPlugin, Decoration, keymap, StateEffect, syntaxTree } = CM;
    const mark = Decoration.mark({ class: 'cm-misspelled' });
    const refresh = StateEffect.define();
    let enabled = opts.enabled !== false;
    let views = new Set();

    function refreshAll() { cache.clear(); views.forEach(v => v.dispatch({ effects: refresh.of(null) })); }

    const plugin = ViewPlugin.fromClass(class {
      constructor(view) {
        this.view = view;
        this.decorations = Decoration.none;
        this.typingAt = -1;
        this.popup = null;
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
          this.closePopup();
        } else if (u.selectionSet && this.typingAt >= 0) {
          // Moving the cursor off the word you were typing lets it be checked.
          const h = u.state.selection.main.head;
          if (!u.state.selection.main.empty || Math.abs(h - this.typingAt) > 0 ||
              u.transactions.some(t => t.isUserEvent('select'))) { this.typingAt = -1; forced = true; }
        }
        if (u.viewportChanged) this.closePopup();
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
            const text = line.text;
            for (const w of wordsIn(text, line.from)) {
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
      openPopup(range) {
        this.closePopup();
        if (!range) return false;
        const view = this.view;
        const word = view.state.sliceDoc(range.from, range.to);
        const sugs = suggest(word, 5);
        const coords = view.coordsAtPos(range.from);
        if (!coords) return false;
        const box = document.createElement('div');
        box.className = 'cm-spell-popup';
        box.setAttribute('role', 'menu');
        const items = [];
        const add = (label, cls, fn) => {
          const b = document.createElement('button');
          b.type = 'button';
          b.className = 'cm-spell-item' + (cls ? ' ' + cls : '');
          b.textContent = label;
          b.addEventListener('mousedown', e => { e.preventDefault(); fn(); });
          box.appendChild(b);
          items.push({ el: b, fn });
        };
        const replace = s => {
          this.closePopup();
          view.dispatch({ changes: { from: range.from, to: range.to, insert: s },
            selection: { anchor: range.from + s.length }, userEvent: 'input.spell' });
          view.focus();
        };
        if (sugs.length) sugs.forEach(s => add(s, 'cm-spell-sug', () => replace(s)));
        else {
          const none = document.createElement('div');
          none.className = 'cm-spell-none';
          none.textContent = 'no suggestions';
          box.appendChild(none);
        }
        const sep = document.createElement('div');
        sep.className = 'cm-spell-sep';
        box.appendChild(sep);
        const lw = word.toLowerCase().replace(/’/g, "'");
        add('add to dictionary', 'cm-spell-action', () => {
          userWords.add(lw); saveUserWords(); this.closePopup(); refreshAll(); view.focus();
        });
        add('ignore', 'cm-spell-action', () => {
          ignored.add(lw); this.closePopup(); refreshAll(); view.focus();
        });
        document.body.appendChild(box);
        // Below the word; flip above if it would run off the bottom.
        const bw = box.offsetWidth, bh = box.offsetHeight;
        let left = Math.max(8, Math.min(coords.left - 6, window.innerWidth - bw - 8));
        let top = coords.bottom + 6;
        if (top + bh > window.innerHeight - 8) top = Math.max(8, coords.top - bh - 6);
        box.style.left = left + 'px';
        box.style.top = top + 'px';
        this.popup = { box, items, sel: -1 };
        this.onDocDown = e => { if (!box.contains(e.target)) this.closePopup(); };
        document.addEventListener('mousedown', this.onDocDown, true);
        this.onScroll = () => this.closePopup();
        window.addEventListener('scroll', this.onScroll, true);
        window.addEventListener('resize', this.onScroll);
        return true;
      }
      closePopup() {
        if (!this.popup) return;
        this.popup.box.remove();
        this.popup = null;
        document.removeEventListener('mousedown', this.onDocDown, true);
        window.removeEventListener('scroll', this.onScroll, true);
        window.removeEventListener('resize', this.onScroll);
      }
      moveSel(d) {
        const p = this.popup;
        if (p.sel >= 0) p.items[p.sel].el.classList.remove('cm-spell-active');
        p.sel = (p.sel + d + p.items.length) % p.items.length;
        p.items[p.sel].el.classList.add('cm-spell-active');
      }
      destroy() { clearTimeout(this.pendingOpen); this.closePopup(); views.delete(this.view); }
    }, {
      decorations: v => v.decorations,
      eventHandlers: {
        // A second click cancels a pending popup, so double-click is left to
        // the app's own word menu (define / synonyms) without a flash.
        mousedown(e, view) {
          const p = view.plugin(plugin);
          if (p && p.pendingOpen) { clearTimeout(p.pendingOpen); p.pendingOpen = null; }
        },
        mouseup(e, view) {
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
            if (r) p.openPopup(r);
          }, 250);
        }
      }
    });

    // No Prec in the bundle: put this extension first so these keys win.
    const keys = keymap.of([
      { key: 'Mod-;', run: view => {
        const p = view.plugin(plugin);
        if (!p || !enabled) return false;
        if (p.popup) { p.closePopup(); return true; }
        const head = view.state.selection.main.head;
        return p.openPopup(p.markAt(head) || p.nextMark(head));
      }},
      { key: 'ArrowDown', run: v => { const p = v.plugin(plugin); if (!p || !p.popup) return false; p.moveSel(1); return true; } },
      { key: 'ArrowUp', run: v => { const p = v.plugin(plugin); if (!p || !p.popup) return false; p.moveSel(-1); return true; } },
      { key: 'Enter', run: v => {
        const p = v.plugin(plugin);
        if (!p || !p.popup || p.popup.sel < 0) return false;
        p.popup.items[p.popup.sel].fn(); return true;
      }},
      { key: 'Escape', run: v => { const p = v.plugin(plugin); if (!p || !p.popup) return false; p.closePopup(); return true; } }
    ]);

    // Plain stylesheet: the popup lives outside the editor DOM.
    if (!document.getElementById('cm-spell-style')) {
      const st = document.createElement('style');
      st.id = 'cm-spell-style';
      // !important: the apps reset text-decoration on every span in a line.
      st.textContent =
        '.cm-content .cm-misspelled,.cm-line .cm-misspelled{text-decoration-line:underline!important;' +
        'text-decoration-style:wavy!important;text-decoration-color:rgba(224,96,96,.8)!important;' +
        'text-decoration-thickness:1px!important;text-underline-offset:3px;text-decoration-skip-ink:none}' +
        '.cm-spell-popup{position:fixed;z-index:10000;min-width:150px;max-width:260px;padding:4px;' +
        'background:var(--surface,var(--bg,#fff));color:var(--text,#222);border:1px solid var(--border,rgba(128,128,128,.3));' +
        'border-radius:6px;box-shadow:0 6px 24px rgba(0,0,0,.22);font-family:var(--ui-font,var(--editor-font,inherit));font-size:13px;line-height:1.3}' +
        '.cm-spell-item{display:block;width:100%;text-align:left;background:none;border:0;color:inherit;font:inherit;' +
        'padding:6px 10px;border-radius:4px;cursor:pointer}' +
        '.cm-spell-sug{font-weight:600}' +
        '.cm-spell-action,.cm-spell-none{color:var(--muted,#888)}' +
        '.cm-spell-none{padding:6px 10px;font-style:italic}' +
        '.cm-spell-item:hover,.cm-spell-item.cm-spell-active{background:var(--border,rgba(128,128,128,.18));color:var(--text,#222)}' +
        '.cm-spell-sep{height:1px;margin:4px 6px;background:var(--border,rgba(128,128,128,.3))}';
      document.head.appendChild(st);
    }

    api.setEnabled = function (view, on) {
      enabled = !!on;
      const p = view && view.plugin(plugin);
      if (p) { if (!on) p.closePopup(); if (on) p.ensureLoaded(); }
      refreshAll();
    };
    return [plugin, keys];
  }

  const api = {
    extension,
    setEnabled() {},
    // Exposed for testing.
    _parse: t => { WORDS = parseWords(t); buildIndex(); },
    isCorrect: w => !!WORDS && isCorrect(w),
    suggest,
    wordsIn: (t, o) => [...wordsIn(t, o || 0)]
  };
  root.Spell = api;
  if (typeof module === 'object' && module.exports) module.exports = api;
})(typeof window !== 'undefined' ? window : globalThis);
