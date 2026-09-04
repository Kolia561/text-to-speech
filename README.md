# Read Aloud — Chromium extension

A single-purpose extension that reads the **current page** aloud,
**paragraph by paragraph**, with word-level highlighting and full transport
controls. It was built from two earlier, separately merged extensions (a
server-backed TTS popup and an in-page reader window) and replaces both with
one coherent flow.

## Features

- **Reads the page directly** — no copy/paste into a separate window.
  - If text is selected, the paragraphs covered by the selection are read.
  - Otherwise the readable paragraphs of the whole page are read in order.
- **Floating control bar** overlaid on the page (draggable):
  - previous paragraph · play / pause · stop · next paragraph · progress
  - **✕ exit** — fully leaves the reading state and hides the bar; the
    toolbar icon starts over whenever you want.
  - settings: engine, voice, speed, highlight toggle
  - **Self-healing:** if the page removes the bar (DOM cleanup, SPA
    re-render) while reading continues, it is restored automatically; the
    toolbar icon also brings the controls back at any time.
- **Word-level ("karaoke") highlighting:**
  - with **browser voices** the word currently being spoken is highlighted
    and moves word by word;
  - with the **Edge TTS server** (whose audio has no word timings) the first
    word of the current paragraph is highlighted as an anchor.
- **Click or select another paragraph while reading** and playback jumps to
  it.
- **Right-click → "Start reading from here"** starts a new session at (or
  jumps an existing session to) the paragraph you right-clicked.
- **Keyboard shortcut (Alt+Shift+R)** starts reading at the first paragraph
  visible in the viewport — handy when you have no mouse point to click
  (rebindable under `edge://extensions/shortcuts` / `chrome://extensions/shortcuts`).
- **Keeps playing when you switch tabs** (no auto-pause). Refreshing or
  loading *other* tabs doesn't cancel the speech either — leftover audio is
  only cleaned up when the tab that was reading is itself reloaded.
- **Focus follows only while you are at the paragraph.** While the spoken word
  stays in view it is kept comfortably centred; scroll away to explore the
  page and the reader stops rubber-banding you back (and stops stealing your
  text selection) until the paragraph scrolls back into view.
- **Two engines:**
  - **Browser voices** *(Web Speech API, default)* — no server needed; choose
    language and voice from the ones installed in the browser. Paragraphs are
    read through a continuous utterance queue (the next paragraph is queued
    while the current one plays), which avoids the Chrome stutter that
    happens when a new utterance is started right after the previous one
    ended.
  - **Edge TTS server** — an HTTP server exposing an OpenAI-compatible
    `/v1/audio/speech` endpoint. The default URL is
    `http://localhost:5050/v1/audio/speech` (configurable), the default voice
    is `en-US-AriaNeural` (the field accepts any Edge TTS voice id). While a
    paragraph plays, the **next paragraph is pre-fetched**, so paragraphs
    flow into each other and pressing "next" starts instantly.
- Speed control shared by both engines.
- Clicking the toolbar icon always creates/shows the control bar on the page
  (and starts reading from the current page or selection). Pages that were
  open before the extension was loaded get the bar styles injected too.

## How to use

1. Load the unpacked extension from `chrome://extensions` (Developer mode →
   "Load unpacked") pointing at this folder.
2. Click the toolbar icon (or right-click → *Read Aloud*):
   - no selection → reads the whole page from the top;
   - text selected → reads the selected paragraphs;
   - clicking the icon again while reading pauses / resumes.
   - right-click → *Start reading from here* begins reading at the paragraph
     you clicked (or jumps an already-running session to it).
3. While reading:
   - use the bar to jump between paragraphs, stop, exit, change voice/speed;
   - **click any paragraph** on the page to start reading from it;
   - press the keyboard shortcut (default **Alt+Shift+R**) to read from the
     first paragraph visible on screen;
   - switch tabs / work in another window — reading continues.

## Architecture

```
┌─────────────────────────── content script (data/content_script/reader.js) ─┐
│ extracts paragraphs → floating bar UI → word-level highlight (selection)  │
│ click-to-jump paragraphs                                                   │
│ engine "web"  : window.speechSynthesis + boundary events (in page)         │
│ engine "edge" : asks the service worker for each paragraph's audio         │
│                 + pre-fetches the next paragraph                           │
└──────────────┬────────────────────────────────────────────────────────────┘
               │ chrome.runtime messages (tts-para play/prefetch/pause/...)
┌──────────────▼─────────────────────────────── service worker (background.js) ┐
│ POST {voice, input, speed} to the TTS server → LRU audio cache → hands      │
│ bytes to the offscreen document → relays "paragraph ended" back to the      │
│ content script                                                              │
└──────────────┬──────────────────────────────────────────────────────────────┘
               │
   data/interface/offscreen.html/js — hidden audio element (MV3 offscreen doc)
```

Paragraph events are tagged with a token, so stale "ended" events (e.g. after
a quick skip or a click-jump) never advance the reader twice.

## Notes on the TTS server

The Edge TTS engine expects an OpenAI-compatible endpoint such as:

- an **edge-tts HTTP server** (voice ids like `en-US-AriaNeural`), or
- any local TTS server that implements `POST /v1/audio/speech` returning raw
  audio (e.g. the Kokoro server previously used in this project, with voice
  ids like `af_bella`).

Request format sent by the extension:

```json
POST {serverUrl}
Content-Type: application/json
{ "model": "tts-1", "voice": "en-US-AriaNeural", "input": "<paragraph>", "speed": 1 }
```

### Access to non-localhost servers

The extension ships with permission for `http://localhost/*` and
`http://127.0.0.1/*`. If you point it at a server on another host, open the
extension's **Options** page, enter the URL and press
**"Allow this server (permission prompt)"** to grant access for that origin.

## Files

```
manifest.json                          MV3 manifest
background.js                          service worker (server audio, cache, toolbar entry)
data/content_script/reader.js          paragraph extraction, reader UI, engines, highlight
data/content_script/reader.css         bar styles + word-highlight rules (CSP-exempt)
data/interface/offscreen.html|js       hidden audio playback document
data/options/options.html|js           default settings + host permission helper
data/icons/*                           toolbar icons
```

The legacy code from the two merged extensions (window UI with Web Speech /
Kokoro, the old popup, `lib/`, unused content-script helpers) has been removed;
see the git history for the previous state.
