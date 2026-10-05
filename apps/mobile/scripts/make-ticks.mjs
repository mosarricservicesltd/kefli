// Writes the Android test build's six-minute tick track, assets/spike/ticks-6min.wav (about 5.8 MB, kept out of git).
//   node scripts/make-ticks.mjs
// A soft 660 Hz tick every 2 s, and at each minute m a group of m beeps at 880 Hz, so a listener can hear how far
// playback got with the screen locked. 8 kHz, 16-bit, mono PCM.
import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const RATE = 8000, SECONDS = 360, N = RATE * SECONDS;
const data = Buffer.alloc(N * 2);

function tone(start, dur, freq, amp) {
  const len = Math.round(dur * RATE), at = Math.floor(start * RATE);
  for (let i = 0; i < len && at + i < N; i++) {
    const env = Math.min(1, i / 80, (len - i) / 80);   // 10 ms ramps, so the ticks don't click
    data.writeInt16LE(Math.round(amp * env * Math.sin(2 * Math.PI * freq * i / RATE)), (at + i) * 2);
  }
}
for (let s = 0; s < SECONDS; s += 2) tone(s, 0.12, 660, 5000);
for (let m = 1; m <= SECONDS / 60; m++) for (let j = 0; j < m; j++) tone(m * 60 - 1.5 + j * 0.25, 0.15, 880, 9000);

const header = Buffer.alloc(44);
header.write('RIFF', 0); header.writeUInt32LE(36 + data.length, 4); header.write('WAVE', 8);
header.write('fmt ', 12); header.writeUInt32LE(16, 16); header.writeUInt16LE(1, 20); header.writeUInt16LE(1, 22);
header.writeUInt32LE(RATE, 24); header.writeUInt32LE(RATE * 2, 28); header.writeUInt16LE(2, 32); header.writeUInt16LE(16, 34);
header.write('data', 36); header.writeUInt32LE(data.length, 40);

const out = join(dirname(fileURLToPath(import.meta.url)), '..', 'assets', 'spike', 'ticks-6min.wav');
mkdirSync(dirname(out), { recursive: true });
writeFileSync(out, Buffer.concat([header, data]));
console.log(`wrote ${out}`);
