/*
 * Read Aloud — service worker
 *
 * Responsibilities:
 *  - Own the single offscreen audio document that plays the audio returned
 *    by an (Edge) TTS HTTP server.
 *  - Synthesize one paragraph at a time: fetch the audio for the text, hand
 *    it to the offscreen document and let it play.
 *  - Relay natural playback completion ("ended") and errors back to the tab
 *    whose content script requested the paragraph, so it can advance the
 *    highlight to the next paragraph.
 *  - Toolbar / context-menu / keyboard-shortcut entry point: ask the tab's
 *    content script to toggle reading, to start/jump reading at the
 *    paragraph the user right-clicked, or to start reading at the first
 *    paragraph visible in the viewport (injecting on demand when needed).
 */

'use strict';

const OFESCREEN_PATH = 'data/interface/offscreen.html';
const OFESCREEN_URL = chrome.runtime.getURL(OFESCREEN_PATH);

let creating = null;              // promise guarding offscreen creation
let currentSession = null;        // {tabId, frameId} of the active paragraph requester
let currentParaId = 0;            // token of the paragraph audio currently in flight

/* The service worker may be suspended and restarted between the moment a
 * paragraph is requested and the moment its audio finishes playing. The two
 * values above then reset, so the "paragraph ended" event would be dropped as
 * stale and reading would stall silently (audio stops after the current
 * paragraph because nothing advances to the next one). They are mirrored to
 * storage.session (which survives worker restarts) so an "ended" event can be
 * matched and forwarded even after a restart. */
const PLAYBACK_SESSION_KEY = 'ra:playbackSession';
const PLAYBACK_PARA_KEY = 'ra:playbackParaId';
let persistedPlayback = null;       // cached { session, paraId } from storage.session
let persistedPlaybackLoaded = false;

function cachePlayback(session, paraId) {
  persistedPlayback = { session: session, paraId: paraId };
  persistedPlaybackLoaded = true;
  try {
    chrome.storage.session.set({
      [PLAYBACK_SESSION_KEY]: session,
      [PLAYBACK_PARA_KEY]: paraId
    });
  } catch (e) { /* storage.session unavailable — in-memory values still work */ }
}

function loadPlayback() {
  if (persistedPlaybackLoaded) return Promise.resolve(persistedPlayback);
  return new Promise((resolve) => {
    if (!chrome.storage || !chrome.storage.session) {
      persistedPlayback = null;
      persistedPlaybackLoaded = true;
      resolve(null);
      return;
    }
    try {
      chrome.storage.session.get([PLAYBACK_SESSION_KEY, PLAYBACK_PARA_KEY], (res) => {
        void chrome.runtime.lastError; // swallow "session storage cleared" errors
        persistedPlayback = {
          session: (res && res[PLAYBACK_SESSION_KEY]) || null,
          paraId: (typeof (res && res[PLAYBACK_PARA_KEY]) === 'number')
            ? res[PLAYBACK_PARA_KEY]
            : null
        };
        persistedPlaybackLoaded = true;
        resolve(persistedPlayback);
      });
    } catch (e) {
      persistedPlayback = null;
      persistedPlaybackLoaded = true;
      resolve(null);
    }
  });
}

/* Small LRU cache of fetched paragraph audio, keyed by paragraph request id.
 * The content script pre-fetches the *next* paragraph while the current one
 * plays, so consecutive paragraphs (and "next" presses) start instantly. */
const audioCache = new Map();     // paraId -> { buffer, mime, fp }
const CACHE_MAX = 6;

function fingerprint(settings) {
  return [
    settings && settings.serverUrl,
    settings && settings.voice,
    settings && settings.speed,
    settings && settings.model
  ].join('|');
}

function cacheGet(paraId, fp) {
  const hit = audioCache.get(paraId);
  if (hit && hit.fp === fp) return hit;
  return null;
}

function cachePut(paraId, fp, buffer, mime) {
  // A change of voice/speed/server invalidates all cached audio.
  if (audioCache.size && [...audioCache.values()].some((c) => c.fp !== fp)) {
    audioCache.clear();
  }
  audioCache.set(paraId, { buffer: buffer, mime: mime, fp: fp });
  while (audioCache.size > CACHE_MAX) {
    const oldest = audioCache.keys().next().value;
    audioCache.delete(oldest);
  }
}

async function fetchParagraphAudio(text, settings) {
  const response = await fetch(settings.serverUrl, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Accept': 'audio/mpeg, audio/wav, audio/*'
    },
    body: JSON.stringify({
      model: settings.model || 'tts-1',
      voice: settings.voice || '',
      input: text,
      speed: Number.parseFloat(settings.speed) || 1
    })
  });

  if (!response.ok) {
    let reason = 'TTS server responded with HTTP ' + response.status;
    try {
      const body = await response.text();
      if (body && body.length < 400) reason += ': ' + body.trim();
    } catch (e) { /* not a text body */ }
    throw new Error(reason);
  }

  return {
    buffer: await response.arrayBuffer(),
    mime: response.headers.get('Content-Type') || 'audio/mpeg'
  };
}

/* ---------------- offscreen document ---------------- */

async function ensureOffscreen() {
  const existing = await chrome.runtime.getContexts({
    contextTypes: ['OFFSCREEN_DOCUMENT'],
    documentUrls: [OFESCREEN_URL]
  });
  if (existing.length > 0) return;

  if (!creating) {
    creating = chrome.offscreen.createDocument({
      url: OFESCREEN_URL,
      reasons: ['AUDIO_PLAYBACK'],
      justification: 'Play TTS audio (Edge TTS server output) in the background'
    });
  }
  try {
    await creating;
  } finally {
    creating = null;
  }
}

/* ---------------- messaging helpers ---------------- */

function sendToOffscreen(message) {
  return new Promise((resolve) => {
    try {
      chrome.runtime.sendMessage(message, () => {
        void chrome.runtime.lastError; // swallow "no receiving end" errors
        resolve();
      });
    } catch (e) {
      resolve();
    }
  });
}

function sessionOf(sender) {
  if (!sender || !sender.tab) return null;
  return {
    tabId: sender.tab.id,
    frameId: sender.frameId != null ? sender.frameId : 0
  };
}

function notifyContent(session, event, detail, paraId) {
  if (!session) return;
  chrome.tabs.sendMessage(
    session.tabId,
    { type: 'tts-event', event: event, detail: detail || null, paraId: paraId },
    { frameId: session.frameId }
  ).catch(() => {
    // Tab navigated away or was closed while audio finished — nothing to update.
  });
}

/* ---------------- TTS paragraph playback ---------------- */

async function playParagraph(sender, text, settings, paraId, natural) {
  const session = sessionOf(sender);
  if (!session) {
    notifyContent(session, 'error', 'Missing tab context.');
    return;
  }
  currentSession = session;
  const sessionParaId = (typeof paraId === 'number') ? paraId : (currentParaId + 1);
  currentParaId = sessionParaId;
  cachePlayback(session, currentParaId);
  const fp = fingerprint(settings);

  const serverUrl = settings && settings.serverUrl;
  if (!serverUrl) {
    notifyContent(session, 'error', 'TTS server URL is not set.');
    return;
  }

  try {
    await ensureOffscreen();

    // After a paragraph ended naturally the offscreen document has already
    // cleared its source, so a redundant "stop" only adds latency. Interrupts
    // (skip / jump / restart) always stop first.
    if (!natural) {
      await sendToOffscreen({ type: 'stop' });
    }

    // Prefer a pre-fetched copy of this paragraph when available.
    let audio = cacheGet(sessionParaId, fp);
    if (!audio) {
      audio = await fetchParagraphAudio(text, settings);
      cachePut(sessionParaId, fp, audio.buffer, audio.mime);
    }

    await sendToOffscreen({
      type: 'processAudioData',
      audioData: audio.buffer,
      mimeType: audio.mime,
      token: currentParaId
    });
  } catch (error) {
    console.error('[read-aloud] paragraph synthesis failed:', error);
    const message = error && error.message ? error.message : String(error);
    notifyContent(session, 'error', message, currentParaId);
  }
}

/* Fire-and-forget pre-fetch of the next paragraph's audio. */
async function prefetchParagraph(paraId, text, settings) {
  if (!settings || !settings.serverUrl || typeof paraId !== 'number') return;
  const fp = fingerprint(settings);
  if (cacheGet(paraId, fp)) return;
  try {
    const audio = await fetchParagraphAudio(text, settings);
    cachePut(paraId, fp, audio.buffer, audio.mime);
  } catch (e) {
    // Pre-fetch is best-effort; playback will fetch on demand if it fails.
  }
}

async function controlParagraph(action) {
  const offscreenAction = action === 'pause' ? 'pause' : action === 'resume' ? 'play' : action === 'stop' ? 'stop' : null;
  if (offscreenAction) await sendToOffscreen({ type: offscreenAction });
}

/* ---------------- entry points ---------------- */

async function ensureReaderInTab(tabId, messageType) {
  messageType = messageType || 'reader-toggle';
  try {
    await chrome.tabs.sendMessage(tabId, { type: messageType });
    return;
  } catch (e) {
    // No content script in this tab yet — inject on demand and retry once.
  }
  try {
    // Injecting with chrome.scripting only runs the JS, so the bar styles
    // must be inserted explicitly too (manifest CSS only applies to pages
    // that were loaded with the content script registered).
    await chrome.scripting.insertCSS({
      target: { tabId: tabId },
      files: ['data/content_script/reader.css']
    });
    await chrome.scripting.executeScript({
      target: { tabId: tabId },
      files: ['data/content_script/reader.js']
    });
    await chrome.tabs.sendMessage(tabId, { type: messageType });
  } catch (e) {
    // Unsupported page (chrome://, Web Store, ...) — nothing we can do.
  }
}

chrome.action.onClicked.addListener((tab) => {
  if (tab && tab.id != null) ensureReaderInTab(tab.id, 'reader-toggle');
});

// Keyboard shortcut (Alt+Shift+R by default, rebindable at
// chrome://extensions/shortcuts). Unlike the context menu there is no
// "right-clicked here", so the reader starts at the first paragraph that is
// visible in the current tab's viewport.
if (chrome.commands && chrome.commands.onCommand) {
  chrome.commands.onCommand.addListener((command) => {
    if (command !== 'read-aloud-start-visible') return;
    chrome.tabs.query({ active: true, currentWindow: true }, (tabs) => {
      const tab = tabs && tabs[0];
      if (tab && tab.id != null) {
        ensureReaderInTab(tab.id, 'reader-start-visible');
      }
    });
  });
}

// Context menus persist for the lifetime of the extension, so they are only
// (re)created on install/update, never on every service-worker wake-up.
chrome.runtime.onInstalled.addListener(() => {
  if (!chrome.contextMenus) return;
  try {
    chrome.contextMenus.create({
      id: 'read-aloud',
      title: 'Read Aloud',
      contexts: ['page', 'selection']
    });
    chrome.contextMenus.create({
      id: 'read-aloud-here',
      title: 'Start reading from here',
      contexts: ['page', 'selection']
    });
  } catch (e) {
    // Items already exist (should not happen after install/update).
  }
});

if (chrome.contextMenus) {
  chrome.contextMenus.onClicked.addListener((info, tab) => {
    if (!tab || tab.id == null) return;
    if (info.menuItemId === 'read-aloud') {
      ensureReaderInTab(tab.id, 'reader-toggle');
    } else if (info.menuItemId === 'read-aloud-here') {
      ensureReaderInTab(tab.id, 'reader-start-here');
    }
  });
}

/* ---------------- message router ---------------- */

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (!message || message.type !== 'tts-para') return;

  switch (message.action) {
    case 'play':
      playParagraph(sender, message.text, message.settings, message.paraId, !!message.natural);
      break;
    case 'prefetch':
      prefetchParagraph(message.paraId, message.text, message.settings);
      break;
    case 'pause':
    case 'resume':
    case 'stop':
      controlParagraph(message.action);
      break;
  }
  sendResponse({ ok: true });
  return false;
});

/* ---------------- offscreen -> content events ---------------- */

chrome.runtime.onMessage.addListener((message) => {
  if (!message || !message.type) return;

  // These events are sent by the offscreen document (no sender tab). Only
  // forward what the content script genuinely needs: the natural end of a
  // paragraph and playback errors. Every other state change originates in
  // the content script itself, so relaying it would only cause flicker.
  if (message.type === 'playerEnded') {
    void forwardPlaybackEvent('ended', message.token, null);
  } else if (message.type === 'streamError') {
    void forwardPlaybackEvent('error', message.token, message.error || 'Audio playback failed');
  }
});

/**
 * Forward an offscreen playback event to the content script that owns the
 * currently playing paragraph. Falls back to the values persisted when the
 * paragraph was requested, so the event still reaches the right tab after a
 * service-worker restart (otherwise reading silently stalls at the end of
 * the current paragraph).
 */
async function forwardPlaybackEvent(event, token, detail) {
  const saved = await loadPlayback();
  const session = currentSession || (saved && saved.session) || null;
  const paraId = (currentParaId !== 0) ? currentParaId : (saved ? saved.paraId : null);

  // Only forward when the event belongs to the paragraph we are playing
  // right now; stale events from an earlier paragraph are dropped.
  if (token !== undefined && token !== null && paraId != null && token !== paraId) return;
  notifyContent(session, event, detail, paraId);
}
