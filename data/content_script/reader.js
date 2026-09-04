/*
 * Read Aloud — content script
 *
 * Runs on every http(s) page (top frame only) and provides:
 *  1. Paragraph extraction from the current page. If the user has made a
 *     text selection, the paragraphs that overlap it are read; otherwise the
 *     readable paragraphs of the whole page are used.
 *  2. A floating control bar (previous / play-pause / stop / next
 *     paragraph, exit, plus a settings panel: engine, voice, speed, server
 *     URL).
 *  3. Word-level ("karaoke") highlighting while reading:
 *       - Browser voices: the word currently being spoken is highlighted
 *         (Web Speech "boundary" events).
 *       - Edge TTS server: server audio has no word timings, so the first
 *         word of the current paragraph stays highlighted as an anchor.
 *  4. Click / select any paragraph while reading to jump playback there.
 *  5. Reading keeps playing when you switch tabs, and refreshing another tab
 *     never cancels it (speech is only cleaned up when the *same* tab reloads
 *     while it was reading).
 *  6. The viewport follows the spoken word only while you are reading along:
 *     scroll away to explore the page and the reader stops pulling you back
 *     until the paragraph comes back into view.
 *  7. Context menu "Start reading from here": right-click a paragraph to
 *     start (or jump) the reading at exactly that spot.
 *  8. Keyboard shortcut (Alt+Shift+R, rebindable): starts reading at the
 *     first paragraph currently visible in the viewport.
 *
 * Two audio engines are supported:
 *  - "web":   browser Web Speech API (default). Browser-level speech keeps
 *             playing while the tab is in the background.
 *  - "edge":  an (Edge) TTS HTTP server with an OpenAI-compatible
 *             /v1/audio/speech endpoint. Audio plays in the extension's
 *             offscreen document. The next paragraph is pre-fetched while
 *             the current one plays so paragraphs flow into each other.
 *
 * The script is idempotent: re-injecting it (e.g. from the toolbar fallback)
 * does not create a second bar.
 */

'use strict';

if (window.top !== window) {
  // The reader UI is only meaningful in the top frame.
} else if (window.__dshReadAloudLoaded) {
  // Already injected.
} else {
  window.__dshReadAloudLoaded = true;

  const READER = (() => {
    const $ = (id) => document.getElementById(id);

    /* ------------------------------------------------------------------ *
     * Settings
     * ------------------------------------------------------------------ */

    const DEFAULT_SETTINGS = {
      raEngine: 'web',                           // 'web' (default) | 'edge'
      raServerUrl: 'http://localhost:5050/v1/audio/speech',
      raServerVoice: 'en-US-AriaNeural',
      raSpeed: '1',
      raWebVoice: '',
      raWebLang: '',
      raHighlight: true
    };

    const storageGet = (defaults) =>
      new Promise((resolve) => chrome.storage.local.get(defaults, resolve));

    const storageSet = (obj) =>
      new Promise((resolve) => chrome.storage.local.set(obj, resolve));

    /* Some well-known Edge TTS voices (a datalist — free text is allowed). */
    const EDGE_VOICES = [
      'en-US-AriaNeural', 'en-US-JennyNeural', 'en-US-GuyNeural',
      'en-US-MichelleNeural', 'en-US-ChristopherNeural', 'en-US-EricNeural',
      'en-US-AnaNeural', 'en-US-RogerNeural', 'en-US-SteffanNeural',
      'en-GB-SoniaNeural', 'en-GB-RyanNeural', 'en-GB-LibbyNeural',
      'en-GB-ThomasNeural', 'en-GB-MaisieNeural',
      'en-AU-NatashaNeural', 'en-AU-WilliamNeural',
      'en-CA-ClaraNeural', 'en-CA-LiamNeural',
      'en-IN-NeerjaNeural', 'en-IN-PrabhatNeural',
      'en-IE-EmilyNeural', 'en-NZ-MitchellNeural',
      'es-ES-ElviraNeural', 'es-ES-AlvaroNeural',
      'es-MX-DaliaNeural', 'es-MX-JorgeNeural',
      'fr-FR-DeniseNeural', 'fr-FR-HenriNeural',
      'de-DE-KatjaNeural', 'de-DE-ConradNeural',
      'it-IT-ElsaNeural', 'it-IT-IsabellaNeural',
      'pt-BR-FranciscaNeural', 'pt-BR-AntonioNeural',
      'pt-PT-RaquelNeural', 'pt-PT-DuarteNeural',
      'ja-JP-NanamiNeural', 'ja-JP-KeitaNeural',
      'ko-KR-SunHiNeural', 'ko-KR-InJoonNeural',
      'zh-CN-XiaoxiaoNeural', 'zh-CN-YunxiNeural',
      'zh-TW-HsiaoChenNeural', 'zh-TW-YunJheNeural',
      'ar-EG-SalmaNeural',
      'nl-NL-ColetteNeural', 'nl-NL-FennaNeural',
      'pl-PL-ZofiaNeural', 'pl-PL-MarekNeural',
      'ru-RU-SvetlanaNeural', 'ru-RU-DmitryNeural',
      'tr-TR-EmelNeural', 'tr-TR-AhmetNeural',
      'sv-SE-SofieNeural', 'sv-SE-MattiasNeural'
    ];

    /* ------------------------------------------------------------------ *
     * Reader state
     * ------------------------------------------------------------------ */

    const state = {
      settings: Object.assign({}, DEFAULT_SETTINGS),
      started: false,      // a reading session exists (paras collected)
      playing: false,      // audio currently playing
      paused: false,       // user paused the current paragraph
      paras: [],           // [{ text, el }]
      elIndex: new Map(),  // paragraph element -> index in paras
      index: 0,
      voices: [],          // cached speechSynthesis voices
      reqId: 0,            // id of the paragraph audio request currently in flight
      interrupted: false,  // user stopped since the last paragraph start
      follow: true,        // auto-scroll engaged (viewport follows the spoken word)
      hl: { el: null, tokens: null, cursor: 0 }  // word-highlight data
    };

    /* ------------------------------------------------------------------ *
     * Message bus (background <-> reader)
     * ------------------------------------------------------------------ */

    function sendToBackground(message) {
      return new Promise((resolve) => {
        try {
          chrome.runtime.sendMessage(message, () => {
            void chrome.runtime.lastError;
            resolve();
          });
        } catch (e) {
          resolve();
        }
      });
    }

    /* ------------------------------------------------------------------ *
     * Paragraph collection
     * ------------------------------------------------------------------ */

    const LEAF_TAGS = 'p,li,blockquote,pre,td,th,dd,dt,figcaption,caption,address,h1,h2,h3,h4,h5,h6';
    const CONTAINER_TAGS = 'div,article,section,main';
    const SKIP_ANCESTOR =
      'script,style,noscript,svg,canvas,template,iframe,object,embed,audio,video,' +
      'textarea,input,select,option,button,nav,aside,[hidden],[aria-hidden="true"]';

    function selector(includeContainers) {
      return includeContainers ? LEAF_TAGS + ',' + CONTAINER_TAGS : LEAF_TAGS;
    }

    function cleanParagraphText(raw) {
      if (!raw) return '';
      return raw
        .replace(/\s+/g, ' ')
        .trim();
    }

    function isReadableParagraph(text) {
      if (!text || text.length < 2) return false;
      const letters = text.replace(/[\s\p{P}\p{S}]/gu, '');
      return letters.length >= 1;
    }

    function isVisible(el) {
      try {
        const style = getComputedStyle(el);
        if (style.display === 'none' || style.visibility === 'hidden' || style.opacity === '0') return false;
        return (el.getClientRects().length > 0);
      } catch (e) {
        return false;
      }
    }

    function isCandidateLeaf(el) {
      return /^(P|LI|BLOCKQUOTE|PRE|TD|TH|DD|DT|FIGCAPTION|CAPTION|ADDRESS|H1|H2|H3|H4|H5|H6|DIV|ARTICLE|SECTION|MAIN)$/.test(el.tagName);
    }

    function collectPageBlocks() {
      let includeContainers = true;
      let nodes = Array.from(document.querySelectorAll(selector(true)));
      if (nodes.length > 9000) {
        includeContainers = false;
        nodes = Array.from(document.querySelectorAll(selector(false)));
      }
      const query = selector(includeContainers);

      const blocks = [];
      for (const el of nodes) {
        if (!el.querySelector(query)) blocks.push(el);
      }

      const paras = [];
      let previous = null;
      for (const el of blocks) {
        if (el.closest(SKIP_ANCESTOR)) continue;
        if (el.closest('#dsh-ra-host')) continue; // never read our own UI
        if (!isVisible(el)) continue;
        const text = cleanParagraphText(el.innerText !== undefined ? el.innerText : el.textContent);
        if (!isReadableParagraph(text)) continue;
        if (text === previous) continue;
        previous = text;
        paras.push({ text: text, el: el });
        if (paras.length >= 3000) break;
      }
      return paras;
    }

    function blockAncestor(node) {
      let el = node.nodeType === Node.ELEMENT_NODE ? node : (node.parentElement || null);
      while (el) {
        if (isCandidateLeaf(el)) return el;
        el = el.parentElement;
      }
      return null;
    }

    function collectSelectionBlocks() {
      const sel = window.getSelection();
      if (!sel || sel.isCollapsed || sel.rangeCount === 0) return null;
      const text = cleanParagraphText(sel.toString());
      if (!isReadableParagraph(text)) return null;

      const all = collectPageBlocks();
      const range = sel.getRangeAt(0);
      const startBlock = blockAncestor(range.startContainer);
      const endBlock = blockAncestor(range.endContainer);
      const si = startBlock ? all.findIndex((p) => p.el === startBlock) : -1;
      const ei = endBlock ? all.findIndex((p) => p.el === endBlock) : -1;

      if (si !== -1 && ei !== -1 && si <= ei) {
        return all.slice(si, ei + 1).map((p) => ({ text: p.text, el: p.el }));
      }

      const intersecting = all.filter((p) => {
        try {
          return range.intersectsNode(p.el);
        } catch (e) {
          return false;
        }
      });
      if (intersecting.length) {
        return intersecting.map((p) => ({ text: p.text, el: p.el }));
      }

      return [{ text: text, el: startBlock }];
    }

    function collectParagraphs() {
      const selectionBlocks = collectSelectionBlocks();
      return selectionBlocks && selectionBlocks.length ? selectionBlocks : collectPageBlocks();
    }

    function setParagraphList(paras) {
      state.paras = paras;
      state.elIndex = new Map();
      for (let i = 0; i < paras.length; i++) {
        if (paras[i].el) state.elIndex.set(paras[i].el, i);
      }
    }

    function paragraphIndexFromNode(node) {
      let el = node && node.nodeType === Node.ELEMENT_NODE ? node : (node && node.parentElement);
      while (el) {
        if (state.elIndex.has(el)) return state.elIndex.get(el);
        el = el.parentElement;
      }
      return -1;
    }

    /* ------------------------------------------------------------------ *
     * Word-level (karaoke) highlighting
     * ------------------------------------------------------------------ */

    // Token indexes are cached per paragraph element so a paragraph start
    // does not pay the tokenizing cost synchronously.
    const tokenCache = new WeakMap();

    function updateReadingClass() {
      const active = state.settings.raHighlight && state.started && (state.playing || state.paused);
      document.documentElement.classList.toggle('dsh-ra-reading', active);
    }

    /** Split an element's text into word tokens [{node,start,end,text}]. */
    function buildTokenIndex(el) {
      if (!el || !el.firstChild) return null;
      const tokens = [];
      const walker = document.createTreeWalker(el, NodeFilter.SHOW_TEXT);
      let n;
      while ((n = walker.nextNode())) {
        const value = n.nodeValue;
        if (!value) continue;
        // Skip text inside hidden elements (innerText — and therefore the
        // spoken text — excludes it, so it would desync word tracking).
        const parent = n.parentElement;
        if (parent) {
          try {
            const cs = getComputedStyle(parent);
            if (cs.display === 'none' || cs.visibility === 'hidden') continue;
          } catch (e) { /* keep token */ }
        }
        const re = /\S+/g;
        let m;
        while ((m = re.exec(value)) !== null) {
          tokens.push({ node: n, start: m.index, end: m.index + m[0].length, text: m[0] });
        }
      }
      return tokens.length ? tokens : null;
    }

    function getTokenIndex(el) {
      if (!el || !el.isConnected) return null;
      if (tokenCache.has(el)) return tokenCache.get(el);
      const tokens = buildTokenIndex(el);
      tokenCache.set(el, tokens);
      return tokens;
    }

    function selectTokenRange(token) {
      if (!token) return;
      try {
        const range = document.createRange();
        range.setStart(token.node, token.start);
        range.setEnd(token.node, token.end);
        const sel = window.getSelection();
        sel.removeAllRanges();
        sel.addRange(range);
      } catch (e) { /* node detached mid-read */ }
    }

    function clearWordHighlight() {
      state.hl.el = null;
      state.hl.tokens = null;
      state.hl.cursor = 0;
      const sel = window.getSelection();
      if (sel && sel.rangeCount) {
        try { sel.removeAllRanges(); } catch (e) { /* ignore */ }
      }
    }

    /** Highlight the first word of the paragraph (anchor, used by both engines). */
    function anchorParagraph(el) {
      state.hl.el = el && el.isConnected ? el : null;
      state.hl.tokens = state.hl.el ? getTokenIndex(state.hl.el) : null;
      state.hl.cursor = 1;
      if (!state.settings.raHighlight) return;
      // While the user has scrolled away to explore the page on their own we
      // leave their viewport and any text selection alone; the anchor is
      // re-selected the moment they come back (see reselectCurrentWord()).
      if (state.hl.tokens && state.hl.tokens.length && state.follow) {
        selectTokenRange(state.hl.tokens[0]);
      }
    }

    /** Compare spoken words ignoring leading/trailing punctuation. */
    function wordKey(w) {
      return String(w).replace(/^[^\p{L}\p{N}]+|[^\p{L}\p{N}]+$/gu, '').toLowerCase();
    }

    /** 0-based index of the word that starts at (or contains) charIndex in the
     *  engine's own text, i.e. the number of complete words before it. The
     *  engine reports charIndex inside the spoken (cleaned) paragraph text,
     *  so this ordinal corresponds 1:1 to the DOM token order — matching on
     *  it (instead of only on the word text) is what keeps repeated words on
     *  the correct occurrence. */
    function wordIndexAt(text, charIndex) {
      if (!text || typeof charIndex !== 'number' || charIndex <= 0) return 0;
      const prefix = String(text).slice(0, charIndex);
      if (!prefix.trim()) return 0;
      return (prefix.match(/\S+/g) || []).length;
    }

    /** Advance the cursor to the spoken token. While the reader is following
     *  the user's viewport this also updates the highlight selection and may
     *  scroll; when the user has scrolled away to explore, only the cursor
     *  moves so we never steal their selection or yank them back. */
    function markSpoken(k) {
      const tokens = state.hl.tokens;
      state.hl.cursor = k + 1;
      if (!state.follow) return;
      selectTokenRange(tokens[k]);
      scrollWordIntoView(tokens[k]);
    }

    /**
     * Called on Web Speech boundary events: highlight the word that starts at
     * charIndex. Matching is anchored to the word's position in the text the
     * engine reports (charIndex -> word ordinal), so when the same word
     * appears several times the highlight lands on the occurrence that was
     * actually spoken, not on an identical word elsewhere.
     */
    function handleWordBoundary(charIndex, text) {
      const hl = state.hl;
      if (!hl || !hl.tokens || !state.settings.raHighlight) return;
      if (!text || typeof charIndex !== 'number') return;

      let s = charIndex;
      while (s < text.length && /\s/.test(text[s])) s++;
      let e = s;
      while (e < text.length && !/\s/.test(text[e])) e++;
      const word = text.slice(s, e);
      if (!word) return;
      const key = wordKey(word);

      const tokens = hl.tokens;
      if (!tokens.length) return;

      // Exact position match first: the engine's word ordinal maps directly
      // onto the DOM token list (both follow the spoken word order).
      const ordinal = wordIndexAt(text, charIndex);
      if (ordinal >= 0 && ordinal < tokens.length && wordKey(tokens[ordinal].text) === key) {
        markSpoken(ordinal);
        return;
      }

      // Near miss: DOM text can differ slightly from the spoken text (hidden
      // spans, entities, line breaks), which shifts ordinals by a word or
      // two. Search outward from the ordinal for the same word.
      if (ordinal >= 0) {
        const radius = Math.min(12, tokens.length);
        for (let d = 1; d <= radius; d++) {
          const lo = ordinal - d;
          const hi = ordinal + d;
          if (lo >= 0 && wordKey(tokens[lo].text) === key) {
            markSpoken(lo);
            return;
          }
          if (hi < tokens.length && wordKey(tokens[hi].text) === key) {
            markSpoken(hi);
            return;
          }
          if (lo < 0 && hi >= tokens.length) break;
        }
      }

      // Fallback: ordered search from the cursor (covers skipped words), then
      // a full scan (e.g. an engine reported a word twice).
      for (let k = Math.max(0, hl.cursor); k < tokens.length; k++) {
        if (wordKey(tokens[k].text) === key) {
          markSpoken(k);
          return;
        }
      }
      for (let k = 0; k < tokens.length; k++) {
        if (wordKey(tokens[k].text) === key) {
          markSpoken(k);
          return;
        }
      }
    }

    function scrollWordIntoView(token) {
      if (!state.follow) return;  // user is elsewhere on the page — don't pull them back
      try {
        const range = document.createRange();
        range.setStart(token.node, token.start);
        range.setEnd(token.node, token.end);
        const r = range.getBoundingClientRect();
        const vh = window.innerHeight;
        if (r.top < 44 || r.bottom > vh - 44) {
          const p = state.paras[state.index];
          if (p && p.el && p.el.isConnected) {
            p.el.scrollIntoView({ block: 'center', behavior: 'smooth' });
          }
        }
      } catch (e) { /* ignore */ }
    }

    /* ------------------------------------------------------------------ *
     * Tab-aware cleanup of stale Web Speech audio
     *
     * Chrome's speechSynthesis engine is shared across the whole profile, so
     * an unconditional speechSynthesis.cancel() on every page load (the old
     * behaviour, meant to silence leftovers after reloading the reading tab)
     * also killed reading that was playing in *other* tabs whenever one of
     * them was refreshed or navigated.
     *
     * sessionStorage is per-tab and survives a reload of the same tab, so we
     * record there whether *this* tab had a Web Speech session when it
     * unloaded. The next load of this tab then knows to clean up stale audio;
     * a load of any other tab never does.
     * ------------------------------------------------------------------ */

    function webSessionActiveNow() {
      // Only playing or paused states hold the (profile-shared) speech
      // engine. A stopped-but-not-exited session has no audio in flight, so
      // reloading its tab must not trigger a cleanup cancel either.
      return state.started && (state.playing || state.paused) &&
             state.settings.raEngine === 'web';
    }

    function markWebSessionAtUnload() {
      try {
        if (webSessionActiveNow()) {
          window.sessionStorage.setItem('dshRaWebSessionAtUnload', '1');
        } else {
          window.sessionStorage.removeItem('dshRaWebSessionAtUnload');
        }
      } catch (e) { /* storage blocked — fall back to no cleanup */ }
    }

    function takeWebSessionAtUnloadFlag() {
      try {
        const value = window.sessionStorage.getItem('dshRaWebSessionAtUnload');
        window.sessionStorage.removeItem('dshRaWebSessionAtUnload');
        return value === '1';
      } catch (e) {
        return false;
      }
    }

    /* ------------------------------------------------------------------ *
     * Auto-follow (viewport intent)
     *
     * While the user is reading along, the spoken word is kept comfortably in
     * view (the classic behaviour). As soon as the user scrolls away to look
     * at something else, following stops: no more "rubber-band" scrolls back
     * to the paragraph and no more stealing of a selection the user is making
     * elsewhere. Following resumes only when the spoken word scrolls back
     * into the viewport, so "focus" is kept only while the user is actually
     * at the paragraph.
     * ------------------------------------------------------------------ */

    function currentParagraph() {
      return state.paras[state.index];
    }

    /** Rect of the word currently being spoken (or the anchor word). */
    function spokenWordRect() {
      const hl = state.hl;
      if (hl && hl.el && hl.el.isConnected && hl.tokens && hl.tokens.length) {
        const idx = Math.min(Math.max(0, (hl.cursor || 1) - 1), hl.tokens.length - 1);
        const token = hl.tokens[idx];
        if (token && token.node && token.node.parentNode) {
          try {
            const range = document.createRange();
            range.setStart(token.node, token.start);
            range.setEnd(token.node, token.end);
            const r = range.getBoundingClientRect();
            if (r.width || r.height) return r;
          } catch (e) { /* detached mid-read — fall through */ }
        }
      }
      const para = currentParagraph();
      if (para && para.el && para.el.isConnected) return para.el.getBoundingClientRect();
      return null;
    }

    /** Re-select the spoken word once the user comes back to the paragraph. */
    function reselectCurrentWord() {
      if (!state.settings.raHighlight || !state.follow) return;
      const hl = state.hl;
      if (!hl || !hl.tokens || !hl.tokens.length) return;
      const idx = Math.min(Math.max(0, (hl.cursor || 1) - 1), hl.tokens.length - 1);
      selectTokenRange(hl.tokens[idx]);
    }

    /**
     * Recompute the follow state from where the spoken word currently sits in
     * the viewport. allowDisengage is only true for scroll input that can only
     * come from the user (wheel / touch / scroll keys); plain scroll events
     * also fire for our own programmatic smooth scrolls, so they may
     * re-engage but never disengage (covers scrollbar dragging too).
     */
    function updateFollowState(allowDisengage) {
      if (!state.started || !(state.playing || state.paused)) return;
      const r = spokenWordRect();
      if (!r) return;
      const vh = window.innerHeight || 1;
      if (!state.follow) {
        // Re-engage the moment the spoken word is visible again.
        if (r.top < vh && r.bottom > 0) {
          state.follow = true;
          reselectCurrentWord();
        }
      } else if (allowDisengage && (r.bottom < 0 || r.top > vh)) {
        // The user scrolled the spoken word completely out of view — let them
        // explore without the page pulling them back.
        state.follow = false;
      }
    }

    let followFrame = 0;
    function scheduleFollowUpdate(allowDisengage) {
      if (followFrame) return;
      followFrame = window.requestAnimationFrame(() => {
        followFrame = 0;
        updateFollowState(allowDisengage);
      });
    }

    function isInsideReaderUi(target) {
      return !!(target && target.closest && target.closest('#dsh-ra-host'));
    }

    function onUserScrollInput(event) {
      if (isInsideReaderUi(event && event.target)) return;
      scheduleFollowUpdate(true);
    }

    function onUserKeyScroll(event) {
      if (!event) return;
      const scrollKeys = { ' ': 1, ArrowUp: 1, ArrowDown: 1, PageUp: 1, PageDown: 1, Home: 1, End: 1 };
      if (!scrollKeys[event.key]) return;
      const t = event.target;
      if (isInsideReaderUi(t)) return;
      if (t && (t.isContentEditable || /^(INPUT|TEXTAREA|SELECT)$/.test(t.tagName))) return;
      scheduleFollowUpdate(true);
    }

    function onPageScroll() {
      // Never disengage here: programmatic smooth scrolling fires these too.
      scheduleFollowUpdate(false);
    }

    function wireFollowListeners() {
      window.addEventListener('wheel', onUserScrollInput, { passive: true, capture: true });
      window.addEventListener('touchmove', onUserScrollInput, { passive: true, capture: true });
      window.addEventListener('keydown', onUserKeyScroll, { capture: true });
      window.addEventListener('scroll', onPageScroll, { passive: true, capture: true });
      window.addEventListener('pagehide', markWebSessionAtUnload);
    }

    /* ------------------------------------------------------------------ *
     * Engines
     * ------------------------------------------------------------------ */

    function engineSettings() {
      const s = state.settings;
      return {
        serverUrl: s.raServerUrl,
        voice: s.raServerVoice,
        speed: Number.parseFloat(s.raSpeed) || 1,
        model: 'tts-1'
      };
    }

    function speakWithServer(text, natural) {
      const payload = {
        type: 'tts-para',
        action: 'play',
        text: text,
        paraId: state.reqId,
        natural: !!natural,
        settings: engineSettings()
      };
      sendToBackground(payload);
      // Pre-fetch the following paragraph while this one plays, so the gap
      // between paragraphs (and the wait when pressing "next") disappears.
      const next = state.paras[state.index + 1];
      if (next) {
        sendToBackground({
          type: 'tts-para',
          action: 'prefetch',
          text: next.text,
          paraId: state.reqId + 1,
          settings: engineSettings()
        });
      }
    }

    function pauseServer() { sendToBackground({ type: 'tts-para', action: 'pause' }); }
    function resumeServer() { sendToBackground({ type: 'tts-para', action: 'resume' }); }
    function stopServer() { sendToBackground({ type: 'tts-para', action: 'stop' }); }

    function pickWebVoice() {
      const vs = state.voices;
      if (!vs.length) return null;
      const wantedName = state.settings.raWebVoice;
      if (wantedName) {
        const found = vs.find((v) => v.name === wantedName);
        if (found) return found;
      }
      const wantedLang = state.settings.raWebLang || document.documentElement.lang || '';
      if (wantedLang) {
        const langVoices = vs.filter((v) => (v.lang || '').toLowerCase().startsWith(wantedLang.toLowerCase().split('-')[0]));
        if (langVoices.length) return langVoices[0];
      }
      return null;
    }

    /* ------------------------------------------------------------------ *
     * Browser voices (Web Speech API) — queued playback
     *
     * Chrome stutters when a new utterance is started at the exact moment the
     * previous one ends (it speaks one or two words, then hiccups). The
     * reliable fix is to keep the *next* paragraph's utterance queued while
     * the current one is still playing, so Chrome switches between utterances
     * internally and the audio stays continuous.
     * ------------------------------------------------------------------ */

    let webQueuedIndex = null;   // paragraph index whose utterance is queued (not started yet)
    let webWatchdog = null;      // autoplay watchdog for the first utterance of a session

    function webSupported() {
      return 'speechSynthesis' in window && 'SpeechSynthesisUtterance' in window;
    }

    function webCancel() {
      if (webWatchdog) { window.clearTimeout(webWatchdog); webWatchdog = null; }
      webQueuedIndex = null;
      if ('speechSynthesis' in window) window.speechSynthesis.cancel();
    }

    /** Start (or restart) the web engine at a given paragraph index. */
    function webStartParagraph(index) {
      if (!webSupported()) {
        setStatus('Browser speech synthesis is not available on this page.', true);
        return;
      }
      webCancel();
      state.index = index;
      state.playing = true;
      state.paused = false;
      state.interrupted = false;
      setProgress();
      updateButtons();
      const p = state.paras[index];
      if (p) {
        anchorParagraph(p.el);
        if (p.el && p.el.isConnected) scrollIntoViewIfNeeded(p.el);
      }
      updateReadingClass();
      prewarmNextTokens();
      webQueueParagraph(index, true);
    }

    function webQueueParagraph(index, first) {
      const para = state.paras[index];
      if (!para) return;

      const u = new SpeechSynthesisUtterance(para.text);
      const voice = pickWebVoice();
      if (voice) {
        u.voice = voice;
        u.lang = voice.lang;
      }
      u.rate = Math.min(4, Math.max(0.25, Number.parseFloat(state.settings.raSpeed) || 1));

      if (first) {
        // Watchdog for the very first utterance of a fresh session: if the
        // browser never starts it (blocked autoplay / no voices), fall back
        // to a "click play" state instead of being silent.
        webWatchdog = window.setTimeout(() => {
          webWatchdog = null;
          if (!state.playing || state.paused) return;
          if ('speechSynthesis' in window && window.speechSynthesis.speaking) return;
          setStatus('Nothing started playing — click ▶ or switch to the Edge TTS server.', true);
          state.playing = false;
          state.paused = false;
          state.interrupted = false;
          updateReadingClass();
          updateButtons();
        }, 1200);
      }

      u.onstart = () => {
        if (webWatchdog) { window.clearTimeout(webWatchdog); webWatchdog = null; }
        if (!state.playing || state.paused) return;
        const wasCurrent = state.index === index;
        webQueuedIndex = null;
        if (!wasCurrent) {
          state.index = index;
          setProgress();
          updateButtons();
          const p = state.paras[index];
          if (p) {
            anchorParagraph(p.el);
            if (p.el && p.el.isConnected) scrollIntoViewIfNeeded(p.el);
          }
          prewarmNextTokens();
          updateReadingClass();
        }
        // Always start the highlight at the first word of this utterance
        // (user clicks collapse the previous selection, so re-anchor) —
        // unless the user has scrolled away to explore the page.
        if (state.settings.raHighlight && state.follow) {
          const hl = state.hl;
          if (hl && hl.tokens && hl.tokens.length) {
            hl.cursor = 1;
            selectTokenRange(hl.tokens[0]);
          }
        }
        // Keep the next paragraph queued while this one plays → seamless
        // paragraph transitions with no engine restart.
        if (index + 1 < state.paras.length) {
          webQueuedIndex = index + 1;
          webQueueParagraph(index + 1, false);
        }
      };
      u.onboundary = (e) => {
        if (e && typeof e.charIndex === 'number') handleWordBoundary(e.charIndex, u.text);
      };
      u.onend = () => {
        if (index === state.paras.length - 1) {
          finishReading();
        } else if (webQueuedIndex === null && state.playing && !state.paused) {
          // Safety net: queue was empty, start the next one now.
          webQueuedIndex = index + 1;
          webQueueParagraph(index + 1, false);
        }
      };
      u.onerror = (e) => {
        if (e && (e.error === 'canceled' || e.error === 'interrupted')) return;
        setStatus('Speech synthesis error.', true);
        webCancel();
        state.playing = false;
        state.paused = false;
        state.interrupted = true;
        updateReadingClass();
        updateButtons();
      };

      window.speechSynthesis.speak(u);
    }

    function startEngine(index, natural) {
      if (state.settings.raEngine === 'edge') {
        const para = state.paras[index];
        if (para) {
          // Only clear the previous word's selection when we are following the
          // user's viewport; while they explore elsewhere, leave any text
          // they are selecting alone (anchorParagraph re-arms the bookkeeping).
          if (state.follow) clearWordHighlight();
          anchorParagraph(para.el);
          if (para.el && para.el.isConnected) scrollIntoViewIfNeeded(para.el);
          updateReadingClass();
          prewarmNextTokens();
          speakWithServer(para.text, natural);
        }
      } else {
        webStartParagraph(index);
      }
    }

    function pauseEngine() {
      if (state.settings.raEngine === 'edge') pauseServer();
      else if ('speechSynthesis' in window) window.speechSynthesis.pause();
    }

    function resumeEngine() {
      if (state.settings.raEngine === 'edge') {
        resumeServer();
      } else if ('speechSynthesis' in window) {
        window.speechSynthesis.resume();
        // Chrome sometimes needs a nudge for network voices. If nothing is
        // speaking, paused or queued shortly after resuming, restart the
        // current paragraph cleanly.
        window.setTimeout(() => {
          if (!('speechSynthesis' in window)) return;
          if (state.playing && !state.paused &&
              !window.speechSynthesis.speaking && !window.speechSynthesis.pending &&
              webQueuedIndex === null) {
            webStartParagraph(state.index);
          }
        }, 250);
      }
    }

    function stopEngine() {
      if (state.settings.raEngine === 'edge') stopServer();
      else webCancel();
    }

    // Stop playback on both engines without consulting the current setting.
    function rawStopAll() {
      webCancel();
      sendToBackground({ type: 'tts-para', action: 'stop' });
    }

    /* ------------------------------------------------------------------ *
     * Reading flow
     * ------------------------------------------------------------------ */

    function setProgress() {
      const label = $('ra-progress');
      if (!label) return;
      label.textContent = state.started ? (state.index + 1) + ' / ' + state.paras.length : '—';
    }

    function updateButtons() {
      const playBtn = $('ra-play');
      if (!playBtn) return;
      playBtn.innerHTML = iconPlayPause();
      playBtn.title = !state.started ? 'Read'
        : state.playing ? 'Pause'
        : state.paused ? 'Resume' : 'Play';
    }

    function iconPlayPause() {
      const playing = state.started && state.playing && !state.paused;
      if (playing) {
        return '<svg class="dsh-ra-ic" viewBox="0 0 24 24"><path d="M7 5h4v14H7zM13 5h4v14h-4z"/></svg>';
      }
      return '<svg class="dsh-ra-ic" viewBox="0 0 24 24"><path d="M7 4.5v15l12-7.5z"/></svg>';
    }

    function playParagraphAt(index, natural) {
      const para = state.paras[index];
      if (!para) return;
      // Explicit starts (toolbar next/prev/play, click-to-jump, session
      // start) re-engage the viewport; natural auto-advance keeps following
      // whatever state the user is in (following, or exploring elsewhere).
      if (!natural) state.follow = true;
      state.index = index;
      state.started = true;
      state.playing = true;
      state.paused = false;
      state.interrupted = false;
      state.reqId = state.reqId + 1;
      setProgress();
      updateButtons();
      startEngine(index, natural);
    }

    /** Warm up the word index + layout of the paragraph that comes next. */
    function prewarmNextTokens() {
      const next = state.paras[state.index + 1];
      if (!next || !next.el || !next.el.isConnected) return;
      const idle = window.requestIdleCallback || ((fn) => window.setTimeout(fn, 200));
      idle(() => {
        if (!state.started) return;
        try { getTokenIndex(next.el); } catch (e) { /* ignore */ }
      });
    }

    function startReading() {
      // The toolbar message can arrive before the page finished parsing
      // (e.g. on-demand injection into an already open tab). Wait for a real
      // DOM before collecting paragraphs, otherwise the bar "never appears".
      if (!document.body) {
        document.addEventListener('DOMContentLoaded', startReading, { once: true });
        return;
      }
      showBar();
      setStatus('');
      // Collect first — collectParagraphs() uses the user's current text
      // selection to decide what to read. Highlighting is anchored later.
      const paras = collectParagraphs();
      if (!paras.length) {
        setStatus('No readable text found on this page.', true);
        return;
      }
      setParagraphList(paras);
      state.index = 0;
      state.started = true;
      state.playing = false;
      state.paused = false;
      playParagraphAt(0);
    }

    /** Index of the paragraph that sits under the last right-click (the
     *  "here" of "start reading from here"), or -1 when unknown. */
    function paragraphUnderLastRightClick() {
      const point = lastRightClick;
      if (!point) return -1;
      // Prefer the element captured at click time (stable under scrolling).
      if (point.el && point.el.isConnected) {
        const index = paragraphIndexFromNode(point.el);
        if (index !== -1) return index;
      }
      // Fallback: resolve the stored coordinates onto whatever is there now.
      let x = point.x;
      let y = point.y;
      try {
        x = Math.min(Math.max(0, x), window.innerWidth - 1);
        y = Math.min(Math.max(0, y), window.innerHeight - 1);
        const el = document.elementFromPoint(x, y);
        if (!el || (el.closest && el.closest('#dsh-ra-host'))) return -1;
        return paragraphIndexFromNode(el);
      } catch (e) {
        return -1;
      }
    }

    /** Index of the first paragraph the current text selection starts in,
     *  or -1 when there is no usable selection. */
    function firstSelectedParagraphIndex() {
      const sel = window.getSelection();
      if (!sel || sel.isCollapsed || !sel.rangeCount) return -1;
      try {
        return paragraphIndexFromNode(sel.getRangeAt(0).startContainer);
      } catch (e) {
        return -1;
      }
    }

    /** Collect the paragraphs for a fresh session (keeps an existing session's
     *  list untouched). Returns false when there is nothing to read. */
    function ensureParagraphs() {
      if (state.started) return true;
      const paras = collectParagraphs();
      if (!paras.length) {
        showBar();
        setStatus('No readable text found on this page.', true);
        return false;
      }
      setParagraphList(paras);
      return true;
    }

    /** Shared tail of every "start/jump" entry point. */
    function beginReadingAt(index) {
      showBar();
      setStatus('');
      index = Math.min(Math.max(0, index), state.paras.length - 1);
      state.started = true;
      state.playing = false;
      state.paused = false;
      playParagraphAt(index);
    }

    /**
     * "Start reading from here" (context menu): begin a fresh session at the
     * paragraph that was right-clicked, or jump an existing session there.
     */
    function startFromHere() {
      if (!document.body) {
        document.addEventListener('DOMContentLoaded', startFromHere, { once: true });
        return;
      }
      const fresh = !state.started;
      if (!ensureParagraphs()) return;
      let index = paragraphUnderLastRightClick();
      if (index < 0) index = firstSelectedParagraphIndex();
      if (index < 0) index = fresh ? 0 : state.index;
      beginReadingAt(index);
    }

    /**
     * Index of the first paragraph visible in the current viewport (reading
     * order), or -1 when none of the paragraphs is on screen.
     */
    function firstVisibleParagraphIndex() {
      const vh = window.innerHeight || 1;
      const minVisible = Math.min(24, Math.round(vh * 0.06)); // ignore slivers
      let topSliver = -1;      // topmost paragraph even barely visible
      let nextBelow = -1;      // first paragraph fully below the viewport
      let nextBelowTop = Infinity;
      for (let i = 0; i < state.paras.length; i++) {
        const el = state.paras[i].el;
        if (!el || !el.isConnected) continue;
        const r = el.getBoundingClientRect();
        if (!(r.width || r.height)) continue; // not rendered
        if (r.top < vh && r.bottom > 0) {
          if (topSliver === -1) topSliver = i;
          // First (in reading order) paragraph with a substantial part on
          // screen is the one to read from.
          if (r.bottom > minVisible) return i;
        } else if (r.top >= vh && r.top < nextBelowTop) {
          nextBelowTop = r.top;
          nextBelow = i;
        }
      }
      // Nothing substantial is on screen (big images/gaps): prefer the next
      // paragraph below the fold over re-reading a nearly-scrolled-past one.
      if (nextBelow !== -1) return nextBelow;
      return topSliver;
    }

    /**
     * Keyboard shortcut "start reading from here": with no right-click point,
     * reading begins at the first paragraph currently visible in the viewport
     * (or jumps an existing session there).
     */
    function startFromVisible() {
      if (!document.body) {
        document.addEventListener('DOMContentLoaded', startFromVisible, { once: true });
        return;
      }
      const fresh = !state.started;
      if (!ensureParagraphs()) return;
      let index = firstVisibleParagraphIndex();
      if (index < 0) index = fresh ? 0 : state.index;
      beginReadingAt(index);
    }

    function pauseReading() {
      if (!state.started) return;
      if (state.playing && !state.paused) {
        pauseEngine();
        state.playing = false;
        state.paused = true;
        updateButtons();
      }
    }

    function resumeReading() {
      if (!state.started) return;
      if (state.paused) {
        state.playing = true;
        state.paused = false;
        updateButtons();
        resumeEngine();
      } else if (!state.playing) {
        // stopped in the middle of a session -> continue from current paragraph
        playParagraphAt(state.index);
      }
    }

    function stopReading() {
      if (!state.started && !state.playing) return;
      stopEngine();
      state.playing = false;
      state.paused = false;
      state.interrupted = true;
      clearWordHighlight();
      updateReadingClass();
      setProgress();
      updateButtons();
    }

    function jumpToParagraph(index) {
      if (index < 0 || index >= state.paras.length) return;
      rawStopAll();
      state.playing = false;
      state.paused = false;
      playParagraphAt(index);
      if (state.settings.raEngine === 'edge') {
        // The browser's default click behaviour collapses the selection right
        // after mouseup, so re-anchor the first-word marker shortly after.
        window.setTimeout(() => {
          if (state.started && state.index === index && state.settings.raEngine === 'edge') {
            const p = state.paras[index];
            if (p) anchorParagraph(p.el);
          }
        }, 60);
      }
    }

    function advanceParagraph() {
      if (!state.playing || state.paused) return;
      if (state.index < state.paras.length - 1) {
        playParagraphAt(state.index + 1, true);
      } else {
        finishReading();
      }
    }

    function finishReading() {
      state.playing = false;
      state.paused = false;
      state.started = false;
      state.index = 0;
      state.follow = true;
      clearWordHighlight();
      updateReadingClass();
      setProgress();
      updateButtons();
      setStatus('Finished.');
    }

    /** Leave the reading state completely and hide the bar. */
    function exitReading() {
      rawStopAll();
      state.started = false;
      state.playing = false;
      state.paused = false;
      state.interrupted = false;
      state.index = 0;
      state.follow = true;
      state.paras = [];
      state.elIndex = new Map();
      clearWordHighlight();
      updateReadingClass();
      const host = document.getElementById('dsh-ra-host');
      if (host) {
        host.classList.remove('dsh-ra-active');
        host.style.right = '';
        host.style.bottom = '';
        host.style.left = '';
        host.style.top = '';
      }
      setStatus('');
      setProgress();
      updateButtons();
    }

    function nextParagraph() {
      if (!state.started) { startReading(); return; }
      stopEngine();
      state.playing = false;
      state.paused = false;
      if (state.index < state.paras.length - 1) {
        playParagraphAt(state.index + 1);
      } else {
        finishReading();
      }
    }

    function previousParagraph() {
      if (!state.started) { startReading(); return; }
      stopEngine();
      state.playing = false;
      state.paused = false;
      playParagraphAt(state.index > 0 ? state.index - 1 : 0);
    }

    function togglePlayPause() {
      if (!state.started) {
        startReading();
      } else if (state.playing && !state.paused) {
        pauseReading();
      } else {
        resumeReading();
      }
    }

    /* ------------------------------------------------------------------ *
     * Status line
     * ------------------------------------------------------------------ */

    let statusTimer = null;
    function setStatus(message, isError) {
      const el = $('ra-status');
      if (!el) return;
      el.textContent = message || '';
      el.classList.toggle('dsh-ra-error', !!isError);
      if (statusTimer) window.clearTimeout(statusTimer);
      if (message) {
        statusTimer = window.setTimeout(() => { el.textContent = ''; }, 7000);
      }
    }

    /* ------------------------------------------------------------------ *
     * Floating bar
     * ------------------------------------------------------------------ */

    const SVG_ICONS = {
      prev: '<svg class="dsh-ra-ic" viewBox="0 0 24 24"><path d="M6 5h2v14H6zM20 5l-9 7 9 7z"/></svg>',
      play: '<svg class="dsh-ra-ic" viewBox="0 0 24 24"><path d="M7 4.5v15l12-7.5z"/></svg>',
      pause: '<svg class="dsh-ra-ic" viewBox="0 0 24 24"><path d="M7 5h4v14H7zM13 5h4v14h-4z"/></svg>',
      stop: '<svg class="dsh-ra-ic" viewBox="0 0 24 24"><rect x="6" y="6" width="12" height="12" rx="1"/></svg>',
      next: '<svg class="dsh-ra-ic" viewBox="0 0 24 24"><path d="M16 5h2v14h-2zM4 5l9 7-9 7z"/></svg>',
      gear: '<svg class="dsh-ra-ic" viewBox="0 0 24 24"><path d="M19.4 13a7.6 7.6 0 0 0 .1-1 7.6 7.6 0 0 0-.1-1l2-1.6-2-3.4-2.4 1a7.6 7.6 0 0 0-1.7-1l-.4-2.6h-4L10.5 6a7.6 7.6 0 0 0-1.7 1l-2.4-1-2 3.4L6.5 11a7.6 7.6 0 0 0 0 2l-2.1 1.6 2 3.4 2.4-1a7.6 7.6 0 0 0 1.7 1l.4 2.6h4l.4-2.6a7.6 7.6 0 0 0 1.7-1l2.4 1 2-3.4zM12 15.5A3.5 3.5 0 1 1 12 8.5a3.5 3.5 0 0 1 0 7z"/></svg>',
      close: '<svg class="dsh-ra-ic" viewBox="0 0 24 24"><path d="M6 6l12 12M18 6L6 18" stroke="currentColor" stroke-width="2" fill="none"/></svg>'
    };

    function escapeHtml(s) {
      return String(s).replace(/[&<>"']/g, (c) => (
        { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]
      ));
    }

    function buildBar() {
      const host = document.createElement('div');
      host.id = 'dsh-ra-host';
      host.innerHTML = `
        <div id="ra-bar" class="dsh-ra-bar">
          <div id="ra-main" class="dsh-ra-main">
            <button id="ra-prev" class="dsh-ra-btn" title="Previous paragraph">${SVG_ICONS.prev}</button>
            <button id="ra-play" class="dsh-ra-btn dsh-ra-play" title="Read">${SVG_ICONS.play}</button>
            <button id="ra-stop" class="dsh-ra-btn" title="Stop">${SVG_ICONS.stop}</button>
            <button id="ra-next" class="dsh-ra-btn" title="Next paragraph">${SVG_ICONS.next}</button>
            <span id="ra-progress" class="dsh-ra-progress">—</span>
            <button id="ra-settings" class="dsh-ra-btn" title="Settings">${SVG_ICONS.gear}</button>
            <button id="ra-close" class="dsh-ra-btn dsh-ra-close" title="Exit reader">${SVG_ICONS.close}</button>
          </div>
          <div id="ra-status" class="dsh-ra-status"></div>
          <div id="ra-settings-panel" class="dsh-ra-panel dsh-ra-hidden">
            <div class="dsh-ra-row">
              <label class="dsh-ra-label" for="ra-engine">Engine</label>
              <select id="ra-engine" class="dsh-ra-input">
                <option value="web">Browser voices (Web Speech API)</option>
                <option value="edge">Edge TTS server</option>
              </select>
            </div>
            <div id="ra-edge-fields" class="dsh-ra-hidden">
              <div class="dsh-ra-row">
                <label class="dsh-ra-label" for="ra-server">Server URL</label>
                <input id="ra-server" class="dsh-ra-input" type="text" spellcheck="false" placeholder="http://localhost:5050/v1/audio/speech">
              </div>
              <div class="dsh-ra-row">
                <label class="dsh-ra-label" for="ra-voice">Voice</label>
                <input id="ra-voice" class="dsh-ra-input" type="text" list="dsh-ra-edge-voices" spellcheck="false" placeholder="en-US-AriaNeural">
                <datalist id="dsh-ra-edge-voices">${EDGE_VOICES.map((v) => `<option value="${escapeHtml(v)}">`).join('')}</datalist>
              </div>
            </div>
            <div id="ra-web-fields">
              <div class="dsh-ra-row">
                <label class="dsh-ra-label" for="ra-lang">Language</label>
                <select id="ra-lang" class="dsh-ra-input"></select>
              </div>
              <div class="dsh-ra-row">
                <label class="dsh-ra-label" for="ra-web-voice">Voice</label>
                <select id="ra-web-voice" class="dsh-ra-input"></select>
              </div>
            </div>
            <div class="dsh-ra-row">
              <label class="dsh-ra-label" for="ra-speed">Speed</label>
              <div class="dsh-ra-speedwrap">
                <input id="ra-speed" class="dsh-ra-slider" type="range" min="0.5" max="3" step="0.1">
                <span id="ra-speed-value" class="dsh-ra-speedvalue">1.0×</span>
              </div>
            </div>
            <div class="dsh-ra-row">
              <label class="dsh-ra-check">
                <input id="ra-highlight" type="checkbox"> Highlight the spoken word
              </label>
            </div>
            <div class="dsh-ra-hint">Default engine: browser voices. Use "Edge TTS server" for higher quality; the next paragraph is pre-loaded so it flows without gaps.</div>
          </div>
        </div>`;
      document.documentElement.appendChild(host);
      bindBar();
    }

    function bindBar() {
      $('ra-prev').addEventListener('click', previousParagraph);
      $('ra-play').addEventListener('click', togglePlayPause);
      $('ra-stop').addEventListener('click', stopReading);
      $('ra-next').addEventListener('click', nextParagraph);
      $('ra-close').addEventListener('click', exitReading);
      $('ra-settings').addEventListener('click', () => {
        $('ra-settings-panel').classList.toggle('dsh-ra-hidden');
      });
      $('ra-engine').addEventListener('change', onEngineChange);
      $('ra-server').addEventListener('change', saveFromUi);
      $('ra-voice').addEventListener('change', saveFromUi);
      $('ra-speed').addEventListener('input', (e) => {
        $('ra-speed-value').textContent = Number(e.target.value).toFixed(1) + '×';
      });
      $('ra-speed').addEventListener('change', saveFromUi);
      $('ra-highlight').addEventListener('change', saveFromUi);
      $('ra-lang').addEventListener('change', onLangChange);
      $('ra-web-voice').addEventListener('change', saveFromUi);

      // Drag: move the bar by dragging its main row.
      const main = $('ra-main');
      const host = document.getElementById('dsh-ra-host');
      let dragging = null;
      main.addEventListener('pointerdown', (e) => {
        if (e.target.closest('button')) return;
        host.style.right = 'auto';
        host.style.bottom = 'auto';
        dragging = {
          x: e.clientX, y: e.clientY,
          left: parseInt(host.getBoundingClientRect().left, 10),
          top: parseInt(host.getBoundingClientRect().top, 10)
        };
        main.setPointerCapture(e.pointerId);
      });
      main.addEventListener('pointermove', (e) => {
        if (!dragging) return;
        const dx = e.clientX - dragging.x;
        const dy = e.clientY - dragging.y;
        host.style.left = Math.max(0, Math.min(window.innerWidth - 60, dragging.left + dx)) + 'px';
        host.style.top = Math.max(0, Math.min(window.innerHeight - 40, dragging.top + dy)) + 'px';
      });
      const endDrag = () => { dragging = null; };
      main.addEventListener('pointerup', endDrag);
      main.addEventListener('pointercancel', endDrag);
    }

    function showBar() {
      ensureBarPresent();
      const host = document.getElementById('dsh-ra-host');
      if (!host) return;
      host.classList.add('dsh-ra-active');
      host.style.right = '';
      host.style.bottom = '';
      host.style.left = '';
      host.style.top = '';
    }

    /* ------------------------------------------------------------------ *
     * Bar recovery
     *
     * Some sites remove injected nodes (DOM cleanup, SPA re-renders), which
     * makes the control bar vanish while audio keeps playing. We watch for
     * that and rebuild + re-show the bar automatically; the toolbar icon also
     * brings the bar back if it ever goes missing.
     * ------------------------------------------------------------------ */

    function barIsVisible() {
      const host = document.getElementById('dsh-ra-host');
      return !!(host && host.isConnected && host.classList.contains('dsh-ra-active'));
    }

    /** Rebuild the bar DOM (with fresh listeners) if it was removed. */
    function ensureBarPresent() {
      const host = document.getElementById('dsh-ra-host');
      if (host && host.isConnected) return true;
      buildBar();
      hydrateUi();
      return true;
    }

    /** Re-map paragraph elements after the page replaced its DOM. */
    function remapParagraphElements() {
      try {
        const fresh = collectPageBlocks();
        const byText = new Map();
        for (const p of fresh) {
          if (!byText.has(p.text)) byText.set(p.text, p.el);
        }
        for (const p of state.paras) {
          if (!p.el || !p.el.isConnected) {
            const el = byText.get(p.text);
            if (el) p.el = el;
          }
        }
        setParagraphList(state.paras);
      } catch (e) { /* keep old mapping */ }
    }

    /** Make the bar visible again and re-anchor the current paragraph. */
    function restoreBar() {
      if (!ensureBarPresent()) return;
      showBar();
      if (!state.started || !state.paras.length) {
        setProgress();
        updateButtons();
        return;
      }
      const cur = state.paras[state.index];
      if (!cur || !cur.el || !cur.el.isConnected) {
        remapParagraphElements();
      }
      const cur2 = state.paras[state.index];
      if (state.settings.raHighlight && cur2 && cur2.el && cur2.el.isConnected) {
        anchorParagraph(cur2.el);
      }
      setProgress();
      updateButtons();
    }

    let recoveryStarted = false;
    function startRecovery() {
      if (recoveryStarted) return;
      recoveryStarted = true;

      const hostParent = document.documentElement;
      const observer = new MutationObserver(() => {
        if (state.started && (state.playing || state.paused)) {
          if (!barIsVisible()) restoreBar();
        }
      });
      try {
        observer.observe(hostParent, { childList: true });
      } catch (e) { /* ignore */ }

      // Safety-net poll in case the observer target itself was replaced.
      window.setInterval(() => {
        if (!state.started || !(state.playing || state.paused)) return;
        if (!barIsVisible()) restoreBar();
      }, 1500);
    }

    /* ------------------------------------------------------------------ *
     * Click / selection -> jump to paragraph
     * ------------------------------------------------------------------ */

    document.addEventListener('mouseup', (e) => {
      if (!state.started || state.paras.length < 2) return;
      if (!e.target || e.target.nodeType !== Node.ELEMENT_NODE) return;
      if (e.button !== 0) return;
      if (e.target.closest('#dsh-ra-host, a, button, input, textarea, select, option, [contenteditable], iframe')) return;
      const index = paragraphIndexFromNode(e.target);
      if (index !== -1 && index !== state.index) {
        jumpToParagraph(index);
      }
    });

    /* ------------------------------------------------------------------ *
     * Right-click ("start reading from here")
     *
     * The context menu can't tell the content script *where* the user right-
     * clicked, so we remember the element (plus page coordinates as a
     * fallback for pages that re-render) of the last contextmenu event —
     * capture phase, so even sites that replace their own menu still fire it.
     * ------------------------------------------------------------------ */

    let lastRightClick = null;

    document.addEventListener('contextmenu', (e) => {
      if (e.target && e.target.closest && e.target.closest('#dsh-ra-host')) {
        lastRightClick = null;
        return;
      }
      // Only remember clicks that land on (or inside) a plausible paragraph,
      // so "from here" never resolves to arbitrary chrome like the body tag.
      const block = blockAncestor(e.target);
      lastRightClick = block ? { el: block, x: e.clientX, y: e.clientY } : null;
    }, true);

    /* ------------------------------------------------------------------ *
     * Settings UI plumbing
     * ------------------------------------------------------------------ */

    function applyEngineFields() {
      const edge = state.settings.raEngine === 'edge';
      document.getElementById('ra-edge-fields').classList.toggle('dsh-ra-hidden', !edge);
      document.getElementById('ra-web-fields').classList.toggle('dsh-ra-hidden', edge);
    }

    function populateWebVoices() {
      const langSelect = $('ra-lang');
      const voiceSelect = $('ra-web-voice');
      const voices = state.voices;
      const docLang = (document.documentElement.lang || '').split('-')[0];

      const langs = [];
      const seen = new Set();
      for (const v of voices) {
        const base = (v.lang || '').split('-')[0];
        if (!base || seen.has(base)) continue;
        seen.add(base);
        langs.push({ code: base, label: languageName(base) });
      }
      langs.sort((a, b) => a.label.localeCompare(b.label));
      langSelect.textContent = '';
      for (const l of langs) {
        const opt = document.createElement('option');
        opt.value = l.code;
        opt.textContent = l.label;
        langSelect.appendChild(opt);
      }
      const chosenLang = state.settings.raWebLang || (docLang && seen.has(docLang) ? docLang : '');
      if (chosenLang && [...langSelect.options].some((o) => o.value === chosenLang)) {
        langSelect.value = chosenLang;
      }
      fillWebVoicesFor(langSelect.value);
      voiceSelect.value = state.settings.raWebVoice;
    }

    function languageName(code) {
      try {
        return new Intl.DisplayNames(['en'], { type: 'language' }).of(code);
      } catch (e) {
        return code;
      }
    }

    function fillWebVoicesFor(langCode) {
      const voiceSelect = $('ra-web-voice');
      voiceSelect.textContent = '';
      const docLang = (document.documentElement.lang || '').split('-')[0];
      const base = langCode || docLang || '';
      for (const v of state.voices) {
        if ((v.lang || '').split('-')[0] === base) {
          const opt = document.createElement('option');
          opt.value = v.name;
          opt.textContent = v.name + ' — ' + (v.lang || '');
          voiceSelect.appendChild(opt);
        }
      }
      if (!voiceSelect.options.length) {
        const opt = document.createElement('option');
        opt.value = '';
        opt.textContent = 'Default voice';
        voiceSelect.appendChild(opt);
      }
    }

    function onLangChange() {
      const lang = $('ra-lang').value;
      fillWebVoicesFor(lang);
      const voiceSelect = $('ra-web-voice');
      if (voiceSelect.options.length) {
        const prev = state.settings.raWebVoice;
        voiceSelect.value = [...voiceSelect.options].some((o) => o.value === prev) ? prev : voiceSelect.options[0].value;
      }
      saveFromUi();
    }

    function onEngineChange() {
      const oldEngine = state.settings.raEngine;
      const wasPlaying = state.started && state.playing && !state.paused;
      saveFromUi();
      applyEngineFields();

      if (wasPlaying || (state.started && state.paused)) {
        rawStopAll();
        state.playing = false;
        state.paused = false;
        if (wasPlaying) {
          // Continue the session with the newly selected engine, unless the
          // user stopped during the short engine switch delay.
          window.setTimeout(() => {
            if (state.started && !state.interrupted) playParagraphAt(state.index);
          }, 120);
        } else {
          updateButtons();
        }
      }
      if (state.settings.raEngine === 'web') {
        loadWebVoices().then(populateWebVoices);
      }
    }

    function saveFromUi() {
      const s = {
        raEngine: $('ra-engine').value,
        raServerUrl: $('ra-server').value.trim(),
        raServerVoice: $('ra-voice').value.trim(),
        raSpeed: $('ra-speed').value,
        raWebLang: $('ra-lang') ? $('ra-lang').value : '',
        raWebVoice: $('ra-web-voice') ? $('ra-web-voice').value : '',
        raHighlight: $('ra-highlight').checked
      };
      Object.assign(state.settings, s);
      storageSet(s);
    }

    function hydrateUi() {
      const s = state.settings;
      $('ra-engine').value = s.raEngine;
      $('ra-server').value = s.raServerUrl;
      $('ra-voice').value = s.raServerVoice;
      $('ra-speed').value = s.raSpeed;
      $('ra-speed-value').textContent = Number(s.raSpeed).toFixed(1) + '×';
      $('ra-highlight').checked = !!s.raHighlight;
      applyEngineFields();
    }

    function loadWebVoices() {
      return new Promise((resolve) => {
        if (!('speechSynthesis' in window)) { state.voices = []; resolve([]); return; }
        const got = () => {
          const list = window.speechSynthesis.getVoices();
          state.voices = list || [];
          resolve(state.voices);
        };
        const voices = window.speechSynthesis.getVoices();
        if (voices && voices.length) {
          state.voices = voices;
          resolve(state.voices);
        } else {
          window.speechSynthesis.addEventListener('voiceschanged', got, { once: true });
          window.setTimeout(got, 1200);
        }
      });
    }

    /* ------------------------------------------------------------------ *
     * Runtime listeners
     * ------------------------------------------------------------------ */

    function onRuntimeMessage(message) {
      if (!message) return;

      if (message.type === 'reader-toggle') {
        if (!state.started) {
          startReading();
        } else if (!barIsVisible()) {
          // Reading continues but the bar went away (DOM cleanup, SPA
          // re-render, ...): bring the controls back instead of toggling.
          restoreBar();
        } else if (state.playing && !state.paused) {
          pauseReading();
        } else {
          resumeReading();
        }
        return;
      }

      if (message.type === 'reader-start') {
        startReading();
        return;
      }

      if (message.type === 'reader-start-here') {
        startFromHere();
        return;
      }

      if (message.type === 'reader-start-visible') {
        startFromVisible();
        return;
      }

      if (message.type === 'tts-event') {
        if (message.paraId !== undefined && message.paraId !== state.reqId) return;
        if (message.event === 'ended') {
          advanceParagraph();
        } else if (message.event === 'error') {
          setStatus('Server error: ' + (message.detail || 'unknown'), true);
          stopEngine();
          state.playing = false;
          state.paused = false;
          state.interrupted = true;
          updateReadingClass();
          updateButtons();
        }
      }
    }

    chrome.runtime.onMessage.addListener(onRuntimeMessage);

    /* ------------------------------------------------------------------ *
     * Init
     * ------------------------------------------------------------------ */

    function scrollIntoViewIfNeeded(el) {
      if (!state.follow) return;  // user is elsewhere on the page — don't pull them back
      try {
        const r = el.getBoundingClientRect();
        const vh = window.innerHeight;
        const fullyOut = r.bottom < 0 || r.top > vh;
        const scrolledPast = r.top < 0 && r.bottom < 60;
        // Only scroll when the paragraph is really out of view (or was
        // scrolled past). Partially visible paragraphs are handled by the
        // word-level scroll as the highlight moves, which avoids the
        // "page jumps at every paragraph" hiccup.
        if (fullyOut) {
          el.scrollIntoView({ block: 'center', behavior: 'smooth' });
        } else if (scrolledPast) {
          el.scrollIntoView({ block: 'start', behavior: 'smooth' });
        }
      } catch (e) { /* ignore */ }
    }

    async function init() {
      const saved = await storageGet(DEFAULT_SETTINGS);
      state.settings = Object.assign({}, DEFAULT_SETTINGS, saved);

      hydrateUi();
      await loadWebVoices();
      if (state.settings.raEngine === 'web') {
        populateWebVoices();
      }

      // Silence speech left over from a *previous load of this tab* (e.g.
      // the user refreshed the page mid-sentence). The per-tab sessionStorage
      // flag set on pagehide tells us whether this tab was itself reading
      // aloud; refreshing any *other* tab therefore never cancels speech
      // here, because Chrome's speech engine is shared per profile and the
      // old unconditional cancel stopped reading in other tabs.
      if (takeWebSessionAtUnloadFlag() && 'speechSynthesis' in window) {
        window.speechSynthesis.cancel();
      }

      updateButtons();
    }

    function boot() {
      const start = () => {
        buildBar();
        startRecovery();
        wireFollowListeners();
        init().catch((e) => console.error('[read-aloud] init failed', e));
      };
      if (document.body) {
        start();
      } else {
        document.addEventListener('DOMContentLoaded', () => start(), { once: true });
      }
    }

    boot();

    return { startReading: startReading, exitReading: exitReading };
  })();
}
