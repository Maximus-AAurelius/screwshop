// Screw engine: tempo grid and chop plans. Run: node tests/test_screw_chop.js
const assert = require('node:assert/strict');
const C = require('../docs/screw-chop.js');

// 84 BPM synthetic record, 60 s: click on every beat, tone changes each bar, "vocal" bursts on bars 3-4 of every 4.
function record(bpm, seconds, sr = 44100) {
  const d = new Float32Array(sr * seconds), beat = 60 / bpm;
  for (let i = 0; i < d.length; i++) {
    const t = i / sr, b = t / beat, ph = b % 1, bar = Math.floor(b / 4);
    d[i] = 0.6 * Math.exp(-ph * 30) * Math.sin(2 * Math.PI * 1000 * t) + 0.2 * Math.sin(2 * Math.PI * 200 * (1 + (bar % 3) * 0.3) * t) + (bar % 4 >= 2 ? 0.3 * Math.sin(2 * Math.PI * 600 * t) : 0);
  }
  return { sampleRate: sr, numberOfChannels: 1, length: d.length, duration: d.length / sr, getChannelData: () => d };
}

const rec = record(84, 60);
const tempo = C.detectTempo(rec);
assert.ok(Math.abs(tempo.bpm - 84) < 0.5, 'tempo ' + tempo.bpm);
const beat = 60 / tempo.bpm;
const phase = ((tempo.firstBeat % beat) + beat) % beat;
assert.ok(Math.min(phase, beat - phase) < 0.03, 'first beat on the click, got ' + tempo.firstBeat);

// Run-back length locks onto the record even when the tempo estimate is 1.5% off.
for (const beats of [0.5, 1, 2, 4, 8]) {
  const truth = beats * 60 / 84;
  for (const wrong of [0.985, 1, 1.015]) {
    for (const pos of [20.37, 33.9, 47.05]) {
      const got = C.runBackLength(rec, pos, beats, (60 / 84) * wrong);
      assert.ok(Math.abs(got - truth) < 0.002, `${beats} beats at ${pos}s with tempo x${wrong}: ${got} vs ${truth}`);
    }
  }
}
assert.equal(C.runBackLength(rec, 1.0, 4, 60 / 84), 4 * 60 / 84, 'too early to measure: keep the estimate');
const an = C.analyzeSong(rec, null, tempo);
assert.ok(an.bars.length >= 20);
for (const style of ['screw', 'watts']) {
  const plan = C.planVersion(an, style, { rate: 0.75, seed: 3 });
  assert.ok(plan.notes.length >= 2, style + ' should plan chops');
  // Segments only ever move forward, except for run-backs that replay audio just heard.
  let cursor = 0;
  for (const seg of plan.segments) {
    assert.ok(seg.to > seg.from && seg.from >= 0 && seg.to <= an.duration + 1e-6);
    assert.ok(seg.to <= cursor + 1e-6 || Math.abs(seg.from - cursor) < 1e-6, 'gap or skip at ' + seg.from);
    cursor = Math.max(cursor, seg.to);
  }
  assert.ok(Math.abs(cursor - an.duration) < 1e-6, 'plan reaches the end of the record');
  const played = plan.segments.reduce((s, x) => s + x.to - x.from, 0);
  assert.ok(Math.abs(plan.outDuration - played / 0.75) < 1e-6);
  assert.ok(played > an.duration, 'run-backs add time');
}
// A run back of N beats replays exactly N beats ending where the song continues.
const watts = C.planVersion(an, 'watts', { rate: 0.8, seed: 1 });
for (let i = 1; i < watts.segments.length; i++) {
  const prev = watts.segments[i - 1], seg = watts.segments[i];
  if (seg.from < prev.to - 1e-6) {
    const beats = (seg.to - seg.from) / beat;
    assert.ok([0.5, 1, 2, 4, 8].some(n => Math.abs(beats - n) < 1e-6), 'run-back length ' + beats + ' beats');
    assert.ok(Math.abs(seg.to - prev.to) < 1e-6, 'repeat ends where the line ended');
  }
}
// Marked hook drives the hook chop.
const hooked = C.planVersion(an, 'watts', { rate: 0.8, hook: { start: an.bars[8].start, end: an.bars[10].start } });
assert.ok(hooked.notes.some(n => n.text.includes('(hook)')));
// Slowed only never chops.
const slowed = C.planVersion(an, 'slowed', { rate: 0.7 });
assert.equal(slowed.segments.length, 1);
assert.ok(Math.abs(slowed.outDuration - an.duration / 0.7) < 1e-6);
console.log('PASS: tempo', tempo.bpm, '· screw/watts plans replay exact beats and drop back in');
