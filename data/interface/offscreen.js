/*
 * Read Aloud — offscreen audio document
 *
 * Plays one paragraph of audio at a time. The service worker fetches the
 * audio from the (Edge) TTS server and hands the raw bytes to this page via
 * "processAudioData". Events that matter for the reader are reported back:
 *
 *   playerEnded    — the current paragraph finished playing naturally
 *   streamError    — playback failed
 *
 * All pause/play/stop transitions are initiated from the content script, so
 * no state events are echoed back (they would only cause UI flicker).
 */

'use strict';

const audioElement = document.getElementById('audioElement');
let currentUrl = null;
let currentToken = null;

function clearSource() {
  audioElement.pause();
  if (currentUrl) {
    URL.revokeObjectURL(currentUrl);
    currentUrl = null;
  }
  audioElement.removeAttribute('src');
  audioElement.load();
}

function playAudioUrl(audioUrl) {
  try {
    clearSource();
    currentUrl = audioUrl;
    audioElement.src = audioUrl;
    const p = audioElement.play();
    if (p && typeof p.catch === 'function') {
      p.catch((err) => {
        chrome.runtime.sendMessage({ type: 'streamError', token: currentToken, error: err && err.message ? err.message : String(err) });
      });
    }
  } catch (error) {
    chrome.runtime.sendMessage({ type: 'streamError', token: currentToken, error: error && error.message ? error.message : String(error) });
  }
}

function processAudioData(audioData, mimeType, token) {
  try {
    currentToken = (typeof token === 'number') ? token : null;
    let blob;
    if (ArrayBuffer.isView(audioData)) {
      blob = new Blob([audioData], { type: mimeType });
    } else if (audioData instanceof ArrayBuffer) {
      blob = new Blob([audioData], { type: mimeType });
    } else if (Array.isArray(audioData)) {
      blob = new Blob([new Uint8Array(audioData)], { type: mimeType });
    } else {
      throw new Error('Unsupported audio payload.');
    }
    playAudioUrl(URL.createObjectURL(blob));
  } catch (error) {
    chrome.runtime.sendMessage({ type: 'streamError', token: currentToken, error: error && error.message ? error.message : String(error) });
  }
}

chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
  switch (message.type) {
    case 'processAudioData':
      if (message.audioData) processAudioData(message.audioData, message.mimeType || 'audio/mpeg', message.token);
      break;
    case 'play':
      audioElement.play().catch(() => {});
      break;
    case 'pause':
      audioElement.pause();
      break;
    case 'stop':
      clearSource();
      chrome.runtime.sendMessage({ type: 'playerStopped', token: currentToken });
      break;
  }
  sendResponse({ ok: true });
});

audioElement.onplay = () => {};
audioElement.onpause = () => {};

audioElement.onended = () => {
  if (currentUrl) {
    URL.revokeObjectURL(currentUrl);
    currentUrl = null;
  }
  audioElement.removeAttribute('src');
  chrome.runtime.sendMessage({ type: 'playerEnded', token: currentToken });
};
