/**
 * What a generated file IS, measured from its bytes — for scripts/acceptance/full-system.mjs.
 *
 * "A file exists" and "the job said succeeded" are both things a broken pipeline can produce. These
 * read the file the way a viewer would: a PNG is decoded (IHDR, every IDAT row un-filtered) and its
 * pixels measured, so a blank or single-colour image fails; a WAV's samples are measured, so
 * silence fails; an MP4 is described by ffprobe, stream by stream.
 */
import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { inflateSync } from "node:zlib";

const PNG_SIGNATURE = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

/** Decodes an 8-bit RGB/RGBA/grey PNG far enough to measure its pixels. */
export function inspectPng(bytes) {
  if (bytes.length < 33 || !bytes.subarray(0, 8).equals(PNG_SIGNATURE)) {
    return { ok: false, reason: "not a PNG (signature missing)" };
  }
  let offset = 8;
  let header;
  const idat = [];
  while (offset + 8 <= bytes.length) {
    const length = bytes.readUInt32BE(offset);
    const type = bytes.toString("ascii", offset + 4, offset + 8);
    const data = bytes.subarray(offset + 8, offset + 8 + length);
    if (type === "IHDR") {
      header = {
        width: data.readUInt32BE(0),
        height: data.readUInt32BE(4),
        bitDepth: data[8],
        colorType: data[9],
        interlace: data[12],
      };
    } else if (type === "IDAT") {
      idat.push(data);
    } else if (type === "IEND") {
      break;
    }
    offset += 12 + length;
  }
  if (!header) return { ok: false, reason: "no IHDR chunk" };
  const channels = { 0: 1, 2: 3, 4: 2, 6: 4 }[header.colorType];
  if (header.bitDepth !== 8 || !channels || header.interlace !== 0) {
    // Valid PNGs this checker does not decode; dimensions are still real.
    return { ok: true, ...header, pixelsMeasured: false };
  }
  const raw = inflateSync(Buffer.concat(idat));
  const stride = header.width * channels;
  const pixels = Buffer.alloc(stride * header.height);
  let prev = Buffer.alloc(stride);
  for (let y = 0; y < header.height; y++) {
    const filter = raw[y * (stride + 1)];
    const line = raw.subarray(y * (stride + 1) + 1, (y + 1) * (stride + 1));
    const out = pixels.subarray(y * stride, (y + 1) * stride);
    for (let x = 0; x < stride; x++) {
      const a = x >= channels ? out[x - channels] : 0;
      const b = prev[x];
      const c = x >= channels ? prev[x - channels] : 0;
      let value = line[x];
      if (filter === 1) value += a;
      else if (filter === 2) value += b;
      else if (filter === 3) value += Math.floor((a + b) / 2);
      else if (filter === 4) {
        const p = a + b - c;
        const pa = Math.abs(p - a);
        const pb = Math.abs(p - b);
        const pc = Math.abs(p - c);
        value += pa <= pb && pa <= pc ? a : pb <= pc ? b : c;
      }
      out[x] = value & 0xff;
    }
    prev = out;
  }
  // Luminance spread and the number of distinct (quantised) colours: a blank, flat or
  // single-colour "image" has a standard deviation near zero and a handful of colours.
  let sum = 0;
  let sumSq = 0;
  const colours = new Set();
  const count = header.width * header.height;
  for (let i = 0; i < count; i++) {
    const p = i * channels;
    const r = pixels[p];
    const g = channels >= 3 ? pixels[p + 1] : r;
    const b = channels >= 3 ? pixels[p + 2] : r;
    const lum = 0.299 * r + 0.587 * g + 0.114 * b;
    sum += lum;
    sumSq += lum * lum;
    colours.add(((r >> 4) << 8) | ((g >> 4) << 4) | (b >> 4));
  }
  const mean = sum / count;
  const stddev = Math.sqrt(Math.max(0, sumSq / count - mean * mean));
  // Red dominance, for a prompt that asks for something red: the share of pixels whose red
  // channel clearly leads. Reported, never asserted — whether a model drew an apple is not
  // something byte statistics can decide.
  let reddish = 0;
  if (channels >= 3) {
    for (let i = 0; i < count; i++) {
      const p = i * channels;
      if (pixels[p] > 110 && pixels[p] > pixels[p + 1] * 1.4 && pixels[p] > pixels[p + 2] * 1.4) reddish++;
    }
  }
  return {
    ok: true,
    ...header,
    pixelsMeasured: true,
    luminanceMean: Math.round(mean),
    luminanceStddev: Math.round(stddev * 10) / 10,
    distinctColours: colours.size,
    reddishShare: Math.round((reddish / count) * 1000) / 1000,
  };
}

/** RIFF/WAVE: format, duration and loudness, from the header and the samples themselves. */
export function inspectWav(bytes) {
  if (bytes.toString("ascii", 0, 4) !== "RIFF" || bytes.toString("ascii", 8, 12) !== "WAVE") {
    return { ok: false, reason: "not a RIFF/WAVE file" };
  }
  let offset = 12;
  let fmt;
  let data;
  while (offset + 8 <= bytes.length) {
    const id = bytes.toString("ascii", offset, offset + 4);
    const size = bytes.readUInt32LE(offset + 4);
    if (id === "fmt ") {
      fmt = {
        audioFormat: bytes.readUInt16LE(offset + 8),
        channels: bytes.readUInt16LE(offset + 10),
        sampleRate: bytes.readUInt32LE(offset + 12),
        bitsPerSample: bytes.readUInt16LE(offset + 22),
      };
    } else if (id === "data") {
      data = bytes.subarray(offset + 8, offset + 8 + Math.min(size, bytes.length - offset - 8));
    }
    offset += 8 + size + (size % 2);
  }
  if (!fmt || !data) return { ok: false, reason: "missing fmt or data chunk" };
  const bytesPerSample = fmt.bitsPerSample / 8;
  const durationSeconds = data.length / (fmt.sampleRate * fmt.channels * bytesPerSample);
  let rms = 0;
  if (fmt.audioFormat === 1 && fmt.bitsPerSample === 16) {
    let acc = 0;
    const n = Math.floor(data.length / 2);
    for (let i = 0; i < n; i++) acc += data.readInt16LE(i * 2) ** 2;
    rms = Math.sqrt(acc / Math.max(1, n)) / 32768;
  }
  return { ok: true, ...fmt, durationSeconds: Math.round(durationSeconds * 100) / 100, rms: Math.round(rms * 1000) / 1000 };
}

/** ffprobe's description of a media file, or null when ffprobe is not installed. */
export function ffprobe(bytes, ext = "mp4") {
  const bin = process.env.FFPROBE_PATH ?? "ffprobe";
  try {
    execFileSync(bin, ["-version"], { stdio: "ignore" });
  } catch {
    return null;
  }
  const dir = mkdtempSync(join(tmpdir(), "accept-probe-"));
  try {
    const file = join(dir, `media.${ext}`);
    writeFileSync(file, bytes);
    const out = execFileSync(bin, ["-v", "error", "-show_entries", "format=duration,format_name:stream=codec_type,codec_name,width,height,duration", "-of", "json", file]);
    return JSON.parse(out.toString());
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}
