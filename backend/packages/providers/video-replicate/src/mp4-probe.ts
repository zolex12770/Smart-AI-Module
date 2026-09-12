/**
 * A minimal ISO base media file format (MP4) reader — just enough to answer the two
 * questions `GeneratedVideo` asks and the Replicate API does not: how big is this clip, and
 * how long is it really?
 *
 * Why this exists at all. `VideoProvider.generateVideo` must return `width`, `height` and
 * `durationSeconds`, and a Replicate prediction response carries none of them: the model's
 * `output` is a bare delivery URL, and the echoed `input` only repeats what we asked for —
 * `num_frames`, not the frame rate the model actually rendered at, nor the resolution it
 * chose. The options a caller passes are equally untrustworthy for this: Replicate is an
 * aggregator (docs/05_IMAGE_GENERATION_RESEARCH.md §2.5), one API shape over hundreds of
 * models, so "what size does this model emit" is not a property of the adapter. The only
 * authority on the clip's real dimensions is the clip, so this reads them out of the bytes
 * that were actually produced rather than reporting a number nobody measured.
 *
 * Scope is deliberately tiny: walk the box tree to `moov`, read `mvhd` for the timescale and
 * duration, and read the first video `trak`'s `tkhd` for the display size. No sample tables,
 * no codec parsing — nothing here decodes video, and nothing here needs to. A container this
 * cannot read (a WebM, a truncated download) returns `null`, and the caller reports the
 * dimensions as unknown instead of inventing them.
 */

export interface Mp4Probe {
  width: number;
  height: number;
  /** From `mvhd` duration/timescale. `null` when the header declares an unknown duration. */
  durationSeconds: number | null;
}

interface Box {
  type: string;
  /** First byte of the box's payload, i.e. past the size/type (and any 64-bit largesize). */
  contentStart: number;
  /** One past the box's last byte. */
  boxEnd: number;
}

/**
 * `tkhd` payload offsets, counted from the start of the payload (past the 4-byte
 * version+flags). Version 1 widens creation time, modification time and duration from 32 to
 * 64 bits, which pushes everything after them 12 bytes later — the single reason this
 * function branches on version at all.
 */
const TKHD_DIMENSION_OFFSET = { 0: 76, 1: 88 } as const;
const MVHD_TIMESCALE_OFFSET = { 0: 12, 1: 20 } as const;

/**
 * Reads the real geometry of an MP4. Returns `null` — never a guess — for anything it cannot
 * parse: a non-MP4 container, a file whose `moov` sits after a `mdat` this truncated
 * download never reached, or a box structure that does not agree with its own declared sizes.
 */
export function probeMp4(bytes: Buffer): Mp4Probe | null {
  const moov = findBox(bytes, "moov", 0, bytes.length);
  if (!moov) return null;

  const track = findVideoTrackDimensions(bytes, moov);
  if (!track) return null;

  return { width: track.width, height: track.height, durationSeconds: readMovieDuration(bytes, moov) };
}

/**
 * The first `trak` whose `tkhd` declares a non-zero display size. Zero is how an audio track
 * (and a timed-metadata track) declares "I have no picture", so skipping those is what stops
 * a soundtrack from being reported as the video's dimensions.
 */
function findVideoTrackDimensions(bytes: Buffer, moov: Box): { width: number; height: number } | null {
  for (const trak of childBoxes(bytes, moov)) {
    if (trak.type !== "trak") continue;
    const tkhd = findBox(bytes, "tkhd", trak.contentStart, trak.boxEnd);
    if (!tkhd) continue;

    const version = readBoxVersion(bytes, tkhd);
    if (version === null) continue;
    const offset = tkhd.contentStart + TKHD_DIMENSION_OFFSET[version];
    if (offset + 8 > tkhd.boxEnd) continue;

    // 16.16 fixed point, not integers: a 1920-wide track stores 0x07800000.
    const width = Math.round(bytes.readUInt32BE(offset) / 65_536);
    const height = Math.round(bytes.readUInt32BE(offset + 4) / 65_536);
    if (width > 0 && height > 0) return { width, height };
  }
  return null;
}

function readMovieDuration(bytes: Buffer, moov: Box): number | null {
  const mvhd = findBox(bytes, "mvhd", moov.contentStart, moov.boxEnd);
  if (!mvhd) return null;
  const version = readBoxVersion(bytes, mvhd);
  if (version === null) return null;

  const timescaleOffset = mvhd.contentStart + MVHD_TIMESCALE_OFFSET[version];
  const durationOffset = timescaleOffset + 4;
  const durationBytes = version === 1 ? 8 : 4;
  if (durationOffset + durationBytes > mvhd.boxEnd) return null;

  const timescale = bytes.readUInt32BE(timescaleOffset);
  if (timescale === 0) return null;

  // All-ones is the format's own "duration not known" sentinel — a file still being written,
  // or a live capture. It is checked at the width the version actually stores, because read
  // as a plain number the 64-bit form is not the 32-bit one: reporting 585 billion years of
  // video would be worse than reporting nothing.
  let duration: number;
  if (version === 1) {
    const raw = bytes.readBigUInt64BE(durationOffset);
    if (raw === 0xffff_ffff_ffff_ffffn || raw > BigInt(Number.MAX_SAFE_INTEGER)) return null;
    duration = Number(raw);
  } else {
    duration = bytes.readUInt32BE(durationOffset);
    if (duration === 0xffff_ffff) return null;
  }
  return duration / timescale;
}

/**
 * Both `mvhd` and `tkhd` are "full boxes": their payload opens with a one-byte version that
 * decides every offset after it. Only versions 0 and 1 are defined; an unrecognised one is
 * reported as unreadable rather than parsed against guessed offsets.
 */
function readBoxVersion(bytes: Buffer, box: Box): 0 | 1 | null {
  if (box.contentStart >= box.boxEnd) return null;
  const version = bytes[box.contentStart];
  if (version === 0) return 0;
  if (version === 1) return 1;
  return null;
}

function findBox(bytes: Buffer, type: string, start: number, end: number): Box | null {
  for (const box of boxesIn(bytes, start, end)) {
    if (box.type === type) return box;
  }
  return null;
}

function childBoxes(bytes: Buffer, parent: Box): Box[] {
  return [...boxesIn(bytes, parent.contentStart, parent.boxEnd)];
}

/**
 * Iterates sibling boxes in `[start, end)`. Stops at the first structurally impossible
 * header rather than resynchronising: a box whose declared size runs past its parent means
 * the bytes are not the file this parser thinks they are, and scanning on from there would
 * turn arbitrary payload data into plausible-looking dimensions.
 */
function* boxesIn(bytes: Buffer, start: number, end: number): Generator<Box> {
  let offset = start;
  while (offset + 8 <= end) {
    const declaredSize = bytes.readUInt32BE(offset);
    const type = bytes.toString("latin1", offset + 4, offset + 8);
    let headerSize = 8;
    let size = declaredSize;

    if (declaredSize === 1) {
      // Size 1 means the real size is a 64-bit `largesize` that follows the type — how files
      // above 4 GiB declare a `mdat`.
      if (offset + 16 > end) return;
      const large = bytes.readBigUInt64BE(offset + 8);
      if (large > BigInt(Number.MAX_SAFE_INTEGER)) return;
      size = Number(large);
      headerSize = 16;
    } else if (declaredSize === 0) {
      // Size 0 means "to the end of the enclosing container" — only legal for the last box.
      size = end - offset;
    }

    if (size < headerSize || offset + size > end) return;
    yield { type, contentStart: offset + headerSize, boxEnd: offset + size };
    offset += size;
  }
}
