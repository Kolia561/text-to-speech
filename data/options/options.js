/* Read Aloud — options page */

'use strict';

const DEFAULT_SETTINGS = {
  raEngine: 'web',
  raServerUrl: 'http://localhost:5050/v1/audio/speech',
  raServerVoice: 'en-US-AriaNeural',
  raSpeed: '1',
  raWebVoice: '',
  raWebLang: '',
  raHighlight: true
};

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

const $ = (id) => document.getElementById(id);
const statusEl = () => $('status');

function setStatus(msg, isError) {
  const el = statusEl();
  el.textContent = msg || '';
  el.classList.toggle('err', !!isError);
  if (msg) setTimeout(() => { el.textContent = ''; }, 4000);
}

function originPattern(serverUrl) {
  try {
    const u = new URL(serverUrl);
    return u.origin + '/*';
  } catch (e) {
    return null;
  }
}

function readForm() {
  return {
    raEngine: $('engine').value,
    raServerUrl: $('serverUrl').value.trim(),
    raServerVoice: $('voice').value.trim(),
    raSpeed: $('speed').value,
    raHighlight: $('highlight').checked,
    // keep existing web-speech choices untouched here
    raWebVoice: window.__raWebVoice || '',
    raWebLang: window.__raWebLang || ''
  };
}

function writeForm(settings) {
  $('engine').value = settings.raEngine;
  $('serverUrl').value = settings.raServerUrl;
  $('voice').value = settings.raServerVoice;
  $('speed').value = settings.raSpeed;
  $('speedValue').textContent = Number(settings.raSpeed).toFixed(1) + '×';
  $('highlight').checked = !!settings.raHighlight;
  window.__raWebVoice = settings.raWebVoice || '';
  window.__raWebLang = settings.raWebLang || '';
  syncEngineFields();
}

function syncEngineFields() {
  const isEdge = $('engine').value === 'edge';
  $('edge-fields').hidden = !isEdge;
  $('web-fields').hidden = isEdge;
  $('edge-hint').hidden = !isEdge;
}

function save(settings) {
  chrome.storage.local.set(settings, () => {
    setStatus('Saved.');
  });
}

function persist() {
  save(readForm());
}

$('engine').addEventListener('change', () => { syncEngineFields(); persist(); });
$('serverUrl').addEventListener('change', persist);
$('voice').addEventListener('change', persist);
$('speed').addEventListener('input', () => {
  $('speedValue').textContent = Number($('speed').value).toFixed(1) + '×';
});
$('speed').addEventListener('change', persist);
$('highlight').addEventListener('change', persist);

$('save').addEventListener('click', persist);

$('grant').addEventListener('click', async () => {
  const pattern = originPattern($('serverUrl').value);
  if (!pattern) {
    setStatus('Enter a valid server URL first (e.g. http://localhost:5050/v1/audio/speech).', true);
    return;
  }
  try {
    const granted = await chrome.permissions.request({ origins: [pattern] });
    setStatus(granted ? 'Access granted for ' + pattern : 'Access not granted.', !granted);
    if (granted) persist();
  } catch (e) {
    setStatus('Permission request failed: ' + (e && e.message ? e.message : e), true);
  }
});

// Fill the datalist of known Edge voices.
for (const v of EDGE_VOICES) {
  const opt = document.createElement('option');
  opt.value = v;
  $('edge-voices').appendChild(opt);
}

chrome.storage.local.get(DEFAULT_SETTINGS, writeForm);
syncEngineFields();
