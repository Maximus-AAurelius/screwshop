const fs = require('fs');
const vm = require('vm');

const context = {
  window: {
    ScrewShop: { id: () => 'test-id' },
    addEventListener() {},
    AudioContext: function AudioContext() {},
    webkitAudioContext: function WebkitAudioContext() {},
  },
  document: {
    addEventListener() {},
    querySelectorAll() { return []; },
    createElement() {
      return {
        style: {},
        dataset: {},
        className: '',
        getContext() {
          return {
            clearRect() {}, fillRect() {}, fillText() {}, beginPath() {}, moveTo() {}, lineTo() {}, stroke() {}, fill() {}, arc() {}, closePath() {}, setLineDash() {},
          };
        },
        querySelectorAll() { return []; },
        querySelector() { return null; },
      };
    },
  },
  setInterval() { return 1; },
  clearInterval() {},
  performance: { now: () => 0 },
  console,
};
context.global = context;
context.self = context;
vm.runInNewContext(fs.readFileSync('docs/recording-studio.js', 'utf8'), context);

const studio = new context.window.RecordingStudio({ setState() {}, stopPlayback() {} });
studio.bpm = 82;
const values = [studio.snapCycle(0.02), studio.snapCycle(0.11), studio.snapCycle(0.29)];
const allValid = values.every(v => typeof v === 'number' && Number.isFinite(v));
if (!allValid) {
  console.error('snapCycle should return numeric values', values);
  process.exit(1);
}
if (Math.abs(values[0] - 0.02) > 0.02 || Math.abs(values[1] - 0.11) > 0.02 || Math.abs(values[2] - 0.29) > 0.02) {
  console.error('Unexpected snap precision output', values);
  process.exit(1);
}
console.log('recording studio precision check passed');
