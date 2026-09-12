/**
 * Builds a real ISO base media file (MP4) in memory — correct box headers and correct
 * `mvhd`/`tkhd` field layouts per ISO/IEC 14496-12 — so mp4-probe.test.ts and index.test.ts
 * can exercise the probe against genuine container bytes rather than a hand-written buffer
 * that happens to satisfy it. Test-only, not part of the package's public API; the same
 * arrangement `backend/packages/rag/src/parsers/zip-fixtures.ts` uses, and excluded from the build in
 * tsconfig.json for the same reason.
 *
 * What it is NOT: a playable video. There is no sample table and no encoded frame here, only
 * the header boxes the probe reads and a `mdat` of filler. That is deliberate — producing a
 * decodable H.264 bitstream would need a real encoder, and the probe never looks at one.
 */

/** The identity video matrix every real file writes: 16.16 fixed point, except the last, 2.30. */
const IDENTITY_MATRIX = [0x0001_0000, 0, 0, 0, 0x0001_0000, 0, 0, 0, 0x4000_0000];

export interface Mp4FixtureTrack {
  /** Display size in pixels. A track with 0×0 is how an audio track declares "no picture". */
  width: number;
  height: number;
}

export interface Mp4FixtureOptions {
  tracks: Mp4FixtureTrack[];
  /** Written into `mvhd` as `duration / timescale`; omit for the format's "unknown" sentinel. */
  durationSeconds?: number;
  timescale?: number;
  /** `mvhd`/`tkhd` version. 1 widens the time fields to 64 bits and shifts everything after. */
  version?: 0 | 1;
  mediaBytes?: Buffer;
}

export function buildMp4(options: Mp4FixtureOptions): Buffer {
  const version = options.version ?? 0;
  const timescale = options.timescale ?? 1000;
  const duration =
    options.durationSeconds === undefined ? 0xffff_ffff : Math.round(options.durationSeconds * timescale);

  const traks = options.tracks.map((track, index) => box("trak", tkhd(version, index + 1, duration, track)));
  return Buffer.concat([
    ftyp(),
    box("moov", mvhd(version, timescale, duration), ...traks),
    box("mdat", options.mediaBytes ?? Buffer.alloc(64, 0x11)),
  ]);
}

function box(type: string, ...payload: Buffer[]): Buffer {
  const content = Buffer.concat(payload);
  const header = Buffer.alloc(8);
  header.writeUInt32BE(8 + content.length, 0);
  header.write(type, 4, "latin1");
  return Buffer.concat([header, content]);
}

function ftyp(): Buffer {
  const payload = Buffer.alloc(16);
  payload.write("isom", 0, "latin1");
  payload.writeUInt32BE(512, 4); // minor version
  payload.write("isom", 8, "latin1");
  payload.write("mp41", 12, "latin1");
  return box("ftyp", payload);
}

function mvhd(version: 0 | 1, timescale: number, duration: number): Buffer {
  const wide = version === 1;
  const payload = Buffer.alloc(wide ? 112 : 100);
  payload.writeUInt32BE(version << 24, 0); // version + 24 zero flag bits
  let offset = wide ? 20 : 12; // past creation and modification time
  payload.writeUInt32BE(timescale, offset);
  offset += 4;
  if (wide) {
    // The "unknown duration" sentinel is all-ones at the field's own width, so the 64-bit
    // form is not 0xFFFFFFFF — writing it correctly is what makes the probe's check testable.
    payload.writeBigUInt64BE(duration === 0xffff_ffff ? 0xffff_ffff_ffff_ffffn : BigInt(duration), offset);
    offset += 8;
  } else {
    payload.writeUInt32BE(duration, offset);
    offset += 4;
  }
  payload.writeUInt32BE(0x0001_0000, offset); // rate 1.0
  payload.writeUInt16BE(0x0100, offset + 4); // volume 1.0
  offset += 4 + 2 + 10; // past rate, volume, reserved
  writeMatrix(payload, offset);
  payload.writeUInt32BE(2, payload.length - 4); // next track id
  return box("mvhd", payload);
}

function tkhd(version: 0 | 1, trackId: number, duration: number, track: Mp4FixtureTrack): Buffer {
  const wide = version === 1;
  const payload = Buffer.alloc(wide ? 96 : 84);
  payload.writeUInt32BE((version << 24) | 0x7, 0); // enabled | in movie | in preview
  let offset = wide ? 20 : 12; // past creation and modification time
  payload.writeUInt32BE(trackId, offset);
  offset += 8; // past track id and the reserved word after it
  if (wide) {
    payload.writeBigUInt64BE(BigInt(duration === 0xffff_ffff ? 0 : duration), offset);
    offset += 8;
  } else {
    payload.writeUInt32BE(duration, offset);
    offset += 4;
  }
  offset += 8 + 2 + 2 + 2 + 2; // past reserved, layer, alternate group, volume, reserved
  writeMatrix(payload, offset);
  offset += 36;
  // 16.16 fixed point — the exact encoding the probe has to undo.
  payload.writeUInt32BE(Math.round(track.width * 65_536), offset);
  payload.writeUInt32BE(Math.round(track.height * 65_536), offset + 4);
  return box("tkhd", payload);
}

function writeMatrix(target: Buffer, offset: number): void {
  IDENTITY_MATRIX.forEach((value, index) => target.writeUInt32BE(value, offset + index * 4));
}
