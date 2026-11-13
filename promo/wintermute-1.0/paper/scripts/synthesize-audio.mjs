import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import path from "node:path";

const root = fileURLToPath(new URL("../", import.meta.url));
const directory = path.join(root, "assets/audio");
const sampleRate = 44100;
const duration = 84;
const frameCount = sampleRate * duration;
const left = new Float32Array(frameCount);
const right = new Float32Array(frameCount);
mkdirSync(directory, { recursive: true });

const cues = [
  [0.8, "crumple", 0.75, 0.7, 0],
  [1.6, "contact", 0.18, 0.6, 0.1],
  [2.4, "contact", 0.13, 0.4, 0.1],
  [4.1, "fold", 0.7, 0.5, -0.6],
  [7.6, "crumple", 0.75, 0.6, 0],
  [9.2, "tear", 0.55, 0.6, 0],
  [9.9, "tear", 0.65, 0.65, 0],
  [10.6, "tear", 0.5, 0.55, 0],
  [13.0, "slide", 0.6, 0.45, 0],
  [16.0, "slide", 0.5, 0.4, 0],
  [17.4, "fold", 0.6, 0.55, -0.2],
  [19.0, "fold", 0.6, 0.5, 0],
  [20.6, "fold", 0.6, 0.5, 0.2],
  [22.2, "fold", 0.6, 0.55, 0.3],
  [24.7, "flutter", 0.8, 0.45, -0.3],
  [26.1, "slide", 0.8, 0.4, 0.3],
  [29.1, "fold", 0.45, 0.45, 0.1],
  [30.2, "slide", 0.8, 0.4, 0.3],
  [33.8, "contact", 0.15, 0.4, -0.3],
  [35.3, "flutter", 0.5, 0.4, -0.3],
  [37.5, "fold", 0.65, 0.5, -0.4],
  [38.6, "slide", 0.55, 0.5, -0.2],
  [40.1, "contact", 0.18, 0.35, -0.2],
  [42.8, "flutter", 0.6, 0.45, 0.2],
  [44.1, "fold", 0.7, 0.5, 0],
  [45.1, "fold", 0.65, 0.45, 0.2],
  [47.4, "contact", 0.12, 0.35, 0.2],
  [48.5, "fold", 0.4, 0.4, 0],
  [50.5, "stamp", 0.2, 0.8, 0.1],
  [51.6, "pencil", 0.5, 0.6, 0.2],
  [52.4, "fold", 0.6, 0.5, 0.2],
  [53.5, "pencil", 0.6, 0.55, 0.2],
  [54.2, "fold", 0.55, 0.5, 0.2],
  [56.6, "slide", 0.8, 0.45, 0],
  [59.3, "slide", 0.5, 0.4, 0],
  [61.1, "contact", 0.15, 0.4, 0],
  [64.4, "fold", 1.1, 0.65, 0],
  [65.7, "fold", 0.8, 0.55, 0],
  [70.6, "pencil", 0.45, 0.6, 0.3],
  [73.7, "fold", 0.8, 0.55, -0.2],
  [75.0, "slide", 0.9, 0.5, 0.3],
  [76.0, "drawer", 1.0, 0.6, 0.5],
  [77.7, "contact", 0.25, 0.5, 0.6],
  [79.4, "fold", 0.9, 0.55, -0.2],
];

function noise(seed) {
  let state = seed >>> 0;
  return () => {
    state = (Math.imul(state, 1664525) + 1013904223) >>> 0;
    return (state / 4294967296) * 2 - 1;
  };
}

for (const [cueIndex, [time, kind, seconds, gain, pan]] of cues.entries()) {
  const random = noise(0x50415045 + cueIndex * 73);
  const start = Math.round((time + 1 / 30) * sampleRate);
  const count = Math.round(seconds * sampleRate);
  let low = 0;
  let dark = 0;
  let previous = 0;
  const lGain = Math.sqrt((1 - pan) / 2);
  const rGain = Math.sqrt((1 + pan) / 2);
  for (let i = 0; i < count && start + i < frameCount; i++) {
    const t = i / count;
    const raw = random();
    low += (raw - low) * 0.06;
    dark += (raw - dark) * 0.008;
    const bright = raw - low;
    let envelope = Math.min(1, t * 35) * Math.pow(1 - t, 1.4);
    let sample = bright * 0.16 + low * 0.55;
    if (kind === "crumple" || kind === "fold" || kind === "flutter") {
      const pulse = 0.22 + Math.pow(Math.sin(t * Math.PI * (kind === "flutter" ? 8 : 5)), 4);
      sample = (bright * 0.27 + low * 0.8) * pulse;
      if (Math.abs(raw - previous) > 1.87) sample += raw * 0.18;
    } else if (kind === "tear") {
      sample = bright * 0.34 + low * 0.5;
      envelope *= 0.45 + Math.abs(Math.sin(t * 38)) * 0.55;
    } else if (kind === "contact" || kind === "stamp") {
      sample = low * 1.6 + dark * 2.3 + bright * 0.11;
      envelope = Math.exp(-t * (kind === "stamp" ? 9 : 14));
    } else if (kind === "pencil") {
      sample = bright * 0.2;
      envelope *= Math.pow(Math.sin(t * Math.PI * 3), 2);
    } else if (kind === "drawer") {
      sample = low * 0.9 + dark * 2;
    }
    previous = raw;
    const value = sample * envelope * gain;
    left[start + i] += value * lGain;
    right[start + i] += value * rGain;
  }
}

let peak = 0;
for (let i = 0; i < frameCount; i++) {
  peak = Math.max(peak, Math.abs(left[i]), Math.abs(right[i]));
}
if (peak === 0) throw new Error("The paper-effects score unexpectedly contains no sound.");
const scale = 0.42 / peak;
const buffer = Buffer.alloc(44 + frameCount * 4);
buffer.write("RIFF", 0);
buffer.writeUInt32LE(buffer.length - 8, 4);
buffer.write("WAVEfmt ", 8);
buffer.writeUInt32LE(16, 16);
buffer.writeUInt16LE(1, 20);
buffer.writeUInt16LE(2, 22);
buffer.writeUInt32LE(sampleRate, 24);
buffer.writeUInt32LE(sampleRate * 4, 28);
buffer.writeUInt16LE(4, 32);
buffer.writeUInt16LE(16, 34);
buffer.write("data", 36);
buffer.writeUInt32LE(frameCount * 4, 40);
for (let i = 0; i < frameCount; i++) {
  buffer.writeInt16LE(Math.round(left[i] * scale * 32767), 44 + i * 4);
  buffer.writeInt16LE(Math.round(right[i] * scale * 32767), 46 + i * 4);
}
writeFileSync(path.join(directory, "paper-sfx.wav"), buffer);

const music = path.join(directory, "music.mp3");
if (!existsSync(music)) {
  const result = spawnSync("ffmpeg", [
    "-v", "error", "-f", "lavfi", "-i", "anullsrc=r=44100:cl=stereo",
    "-t", String(duration), "-c:a", "libmp3lame", "-b:a", "32k", music,
  ], { stdio: "inherit" });
  if (result.error) throw result.error;
  if (result.status !== 0) throw new Error(`Silent music-slot export failed: ${result.status}`);
}

writeFileSync(path.join(directory, "provenance.json"), JSON.stringify({
  "paper-sfx.wav": {
    source: "scripts/synthesize-audio.mjs",
    method: "Seeded, filtered noise; no samples, recordings, music or hosted generation",
    license: "CC0-1.0",
    duration,
    sampleRate,
    channels: 2,
    cueCount: cues.length,
  },
  "music.mp3": {
    status: "User-supplied music slot; hidden in the composition until provided",
    placeholder: "Local digital silence, not music",
  },
}, null, 2) + "\n");
console.log(`Original CC0 paper effects: ${cues.length} cues, ${duration}s, stereo ${sampleRate}Hz.`);
console.log("Music slot preserved; #paper-music remains hidden until the user's track is supplied.");
