/**
 * A real, dependency-free GIF89a encoder (and, for test verification, a matching general
 * LZW decoder) — the animated-image equivalent of image-mock's hand-rolled SVG (docs/26
 * ADR-009/ADR-028): genuinely valid, openable-in-any-browser bytes, not opaque placeholder
 * data. There is no practical way to hand-write a valid MP4/WebM container without a real
 * video encoder library, so the mock "video clip" format is an animated GIF — a real,
 * inspectable moving image — rather than a fake file wearing an `.mp4` extension (see
 * ADR-030 for the full reasoning).
 *
 * The encoder deliberately skips LZW dictionary compression: it emits the Clear Code once,
 * then every pixel's own palette index as a literal "root" code, and finally the
 * End-of-Information code. This is a well-known, spec-correct minimal LZW encoding — the
 * root codes are valid by definition, so no dictionary lookups are needed to produce
 * correct output. It sacrifices compression ratio (irrelevant for small mock clips) for a
 * simple, obviously-correct implementation.
 *
 * The decoder, in contrast, is a full general-purpose GIF LZW decompressor (dictionary
 * growth, code-size increases, Clear Code resets included) so the round-trip test in
 * gif-encoder.test.ts is a real correctness check, not one hard-coded to only understand
 * this encoder's own trivial output.
 */

export interface GifFrame {
  /** One palette index per pixel, row-major, length === width * height. */
  indices: Uint8Array;
}

export interface RgbColor {
  r: number;
  g: number;
  b: number;
}

export interface EncodeGifOptions {
  width: number;
  height: number;
  palette: RgbColor[];
  frames: GifFrame[];
  /** Per-frame display time, in hundredths of a second. */
  delayCentiseconds: number;
  /** 0 = loop forever (Netscape extension). Omit to encode a single non-looping playback. */
  loopCount?: number;
}

export function encodeGif(opts: EncodeGifOptions): Buffer {
  const { width, height, palette, frames, delayCentiseconds } = opts;
  if (palette.length < 2 || palette.length > 256) {
    throw new Error(`GIF palette must have 2-256 colors, got ${palette.length}.`);
  }
  const minCodeSize = Math.max(2, Math.ceil(Math.log2(palette.length)));
  const gctSizeExponent = minCodeSize - 1; // Size of Global Color Table field: 2^(N+1) entries
  const gctEntries = 1 << (gctSizeExponent + 1);

  const bytes: number[] = [];
  pushString(bytes, "GIF89a");

  // Logical Screen Descriptor
  pushUint16LE(bytes, width);
  pushUint16LE(bytes, height);
  const lsdPacked = 0b1_111_0_000 | gctSizeExponent; // GCT present, color resolution=7, not sorted
  bytes.push(lsdPacked);
  bytes.push(0); // background color index
  bytes.push(0); // pixel aspect ratio

  // Global Color Table (padded with black up to gctEntries)
  for (let i = 0; i < gctEntries; i++) {
    const c = palette[i] ?? { r: 0, g: 0, b: 0 };
    bytes.push(c.r, c.g, c.b);
  }

  if (opts.loopCount !== undefined) {
    bytes.push(0x21, 0xff, 0x0b);
    pushString(bytes, "NETSCAPE2.0");
    bytes.push(0x03, 0x01);
    pushUint16LE(bytes, opts.loopCount);
    bytes.push(0x00);
  }

  for (const frame of frames) {
    if (frame.indices.length !== width * height) {
      throw new Error(`Frame has ${frame.indices.length} pixels, expected ${width * height}.`);
    }

    // Graphic Control Extension — sets the per-frame delay.
    bytes.push(0x21, 0xf9, 0x04);
    bytes.push(0b00000100); // disposal method 1 (do not dispose), no transparency
    pushUint16LE(bytes, delayCentiseconds);
    bytes.push(0x00); // transparent color index (unused)
    bytes.push(0x00); // block terminator

    // Image Descriptor
    bytes.push(0x2c);
    pushUint16LE(bytes, 0); // left
    pushUint16LE(bytes, 0); // top
    pushUint16LE(bytes, width);
    pushUint16LE(bytes, height);
    bytes.push(0x00); // no local color table, no interlace

    bytes.push(minCodeSize);
    const lzwBytes = lzwEncodeLiteral(frame.indices, minCodeSize);
    writeSubBlocks(bytes, lzwBytes);
  }

  bytes.push(0x3b); // trailer
  return Buffer.from(bytes);
}

/**
 * Emits a Clear Code before every single pixel's literal palette-index code, then a final
 * EOI. A compliant LZW decoder grows its dictionary (and, at fixed thresholds, its code
 * bit-width) on *every* code it decodes once a previous code exists in the current run —
 * this happens automatically as a side effect of decoding, even though this encoder never
 * emits any of the synthesized multi-symbol codes itself (found the hard way: an earlier
 * version emitted one Clear Code up front and then a flat stream of root codes, which
 * decoded correctly only until the dictionary crossed a power-of-two size and the decoder
 * widened its code size while this encoder kept writing at the original width, desyncing
 * the bitstream). Clearing before every pixel resets the decoder's `prev` to null each
 * time, so no dictionary entry is ever created and the code width can never drift — at the
 * cost of roughly 2x the code count, which is irrelevant for these small mock clips.
 */
function lzwEncodeLiteral(indices: Uint8Array, minCodeSize: number): number[] {
  const clearCode = 1 << minCodeSize;
  const eoiCode = clearCode + 1;
  const codeSize = minCodeSize + 1; // root codes + clear + eoi all fit in minCodeSize+1 bits

  const writer = new LzwBitWriter();
  for (const index of indices) {
    writer.writeCode(clearCode, codeSize);
    writer.writeCode(index, codeSize);
  }
  writer.writeCode(eoiCode, codeSize);
  writer.flush();
  return writer.bytes;
}

class LzwBitWriter {
  bytes: number[] = [];
  private bitBuffer = 0;
  private bitCount = 0;

  writeCode(code: number, codeSize: number): void {
    this.bitBuffer |= code << this.bitCount;
    this.bitCount += codeSize;
    while (this.bitCount >= 8) {
      this.bytes.push(this.bitBuffer & 0xff);
      this.bitBuffer >>= 8;
      this.bitCount -= 8;
    }
  }

  flush(): void {
    if (this.bitCount > 0) {
      this.bytes.push(this.bitBuffer & 0xff);
      this.bitBuffer = 0;
      this.bitCount = 0;
    }
  }
}

function writeSubBlocks(out: number[], data: number[]): void {
  let offset = 0;
  while (offset < data.length) {
    const chunk = data.slice(offset, offset + 255);
    out.push(chunk.length, ...chunk);
    offset += 255;
  }
  out.push(0x00); // block terminator
}

function pushString(out: number[], s: string): void {
  for (let i = 0; i < s.length; i++) out.push(s.charCodeAt(i));
}

function pushUint16LE(out: number[], value: number): void {
  out.push(value & 0xff, (value >> 8) & 0xff);
}

// ---------------------------------------------------------------------------------------
// Decoder (test-only consumer, but a real general-purpose one — see file header).
// ---------------------------------------------------------------------------------------

export interface DecodedGif {
  width: number;
  height: number;
  palette: RgbColor[];
  frames: Uint8Array[];
  delayCentiseconds: number[];
}

export function decodeGif(buf: Buffer): DecodedGif {
  let pos = 0;
  const readString = (n: number) => {
    const s = buf.toString("ascii", pos, pos + n);
    pos += n;
    return s;
  };
  const readUint16LE = () => {
    const v = buf[pos] | (buf[pos + 1] << 8);
    pos += 2;
    return v;
  };

  const header = readString(6);
  if (header !== "GIF87a" && header !== "GIF89a") throw new Error(`Not a GIF: bad header "${header}".`);

  const width = readUint16LE();
  const height = readUint16LE();
  const lsdPacked = buf[pos++];
  pos += 2; // background color index + pixel aspect ratio
  const hasGct = (lsdPacked & 0b10000000) !== 0;
  const gctEntries = 1 << ((lsdPacked & 0b111) + 1);

  let palette: RgbColor[] = [];
  if (hasGct) {
    for (let i = 0; i < gctEntries; i++) {
      palette.push({ r: buf[pos], g: buf[pos + 1], b: buf[pos + 2] });
      pos += 3;
    }
  }

  const frames: Uint8Array[] = [];
  const delays: number[] = [];
  let pendingDelay = 0;

  while (pos < buf.length) {
    const marker = buf[pos++];
    if (marker === 0x3b) break; // trailer

    if (marker === 0x21) {
      const label = buf[pos++];
      if (label === 0xf9) {
        const blockSize = buf[pos++]; // always 4
        pos++; // packed disposal/transparency byte
        pendingDelay = readUint16LE();
        pos += blockSize - 3; // skip transparent color index
        pos++; // block terminator
      } else {
        skipSubBlocks();
      }
      continue;
    }

    if (marker === 0x2c) {
      pos += 8; // left, top, width, height (this MVP only ever emits full-canvas frames)
      const idPacked = buf[pos++];
      const hasLct = (idPacked & 0b10000000) !== 0;
      let localPalette = palette;
      if (hasLct) {
        const lctEntries = 1 << ((idPacked & 0b111) + 1);
        localPalette = [];
        for (let i = 0; i < lctEntries; i++) {
          localPalette.push({ r: buf[pos], g: buf[pos + 1], b: buf[pos + 2] });
          pos += 3;
        }
      }
      const minCodeSize = buf[pos++];
      const lzwData = readSubBlocks();
      const pixels = lzwDecode(minCodeSize, lzwData, width * height);
      frames.push(pixels);
      delays.push(pendingDelay);
      if (hasLct) palette = localPalette; // last-seen palette, fine for this MVP's single-GCT files
      continue;
    }

    throw new Error(`Unexpected GIF block marker 0x${marker.toString(16)} at byte ${pos - 1}.`);
  }

  function skipSubBlocks(): void {
    while (true) {
      const len = buf[pos++];
      if (len === 0) return;
      pos += len;
    }
  }

  function readSubBlocks(): Uint8Array {
    const chunks: number[] = [];
    while (true) {
      const len = buf[pos++];
      if (len === 0) break;
      for (let i = 0; i < len; i++) chunks.push(buf[pos + i]);
      pos += len;
    }
    return Uint8Array.from(chunks);
  }

  return { width, height, palette, frames, delayCentiseconds: delays };
}

/** Standard GIF LZW decompression — dictionary growth, code-size growth, Clear Code resets. */
function lzwDecode(minCodeSize: number, data: Uint8Array, expectedPixelCount: number): Uint8Array {
  const clearCode = 1 << minCodeSize;
  const eoiCode = clearCode + 1;

  let dict: number[][] = [];
  let codeSize = minCodeSize + 1;
  const resetDict = () => {
    dict = [];
    for (let i = 0; i < clearCode; i++) dict.push([i]);
    dict.push([]); // placeholder at clearCode's index
    dict.push([]); // placeholder at eoiCode's index
    codeSize = minCodeSize + 1;
  };
  resetDict();

  let bitBuffer = 0;
  let bitCount = 0;
  let bytePos = 0;
  const readCode = (): number => {
    while (bitCount < codeSize) {
      bitBuffer |= data[bytePos++] << bitCount;
      bitCount += 8;
    }
    const code = bitBuffer & ((1 << codeSize) - 1);
    bitBuffer >>= codeSize;
    bitCount -= codeSize;
    return code;
  };

  const output: number[] = [];
  let prev: number[] | null = null;

  while (output.length < expectedPixelCount) {
    const code = readCode();
    if (code === clearCode) {
      resetDict();
      prev = null;
      continue;
    }
    if (code === eoiCode) break;

    let entry: number[];
    if (code < dict.length && dict[code].length > 0) {
      entry = dict[code];
    } else if (code === dict.length && prev) {
      entry = [...prev, prev[0]];
    } else {
      throw new Error(`Invalid LZW code ${code} at dict length ${dict.length}.`);
    }

    output.push(...entry);

    if (prev) {
      dict.push([...prev, entry[0]]);
      if (dict.length === 1 << codeSize && codeSize < 12) codeSize++;
    }
    prev = entry;
  }

  return Uint8Array.from(output.slice(0, expectedPixelCount));
}
