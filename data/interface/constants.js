const DEFAULT_SETTINGS = {
    serverUrl: 'http://localhost:5050/v1/audio/speech',
    voice: 'af_bella',
    speed: 2.0,
    recordAudio: false,
    preprocessText: true
  };
  
  if (typeof module !== 'undefined' && module.exports) {
    module.exports = { DEFAULT_SETTINGS };
  } else {
    self.DEFAULT_SETTINGS = DEFAULT_SETTINGS;
  }
