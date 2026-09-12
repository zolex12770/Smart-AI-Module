import { inflateRawSync } from "node:zlib";

const EOCD_SIGNATURE = 0x06054b50;
const CENTRAL_DIR_SIGNATURE = 0x02014b50;
const LOCAL_FILE_SIGNATURE = 0x04034b50;

/**
 * A minimal real ZIP reader (no npm dependency — the format is well-specified and DOCX
 * only ever needs "read one named entry out of the archive," not general-purpose ZIP
 * read/write). Reads the End-of-Central-Directory record and central directory entries
 * per the PKWARE APPNOTE.TXT layout, then decompresses the requested entry's data from
 * its local file header. Supports the two compression methods every real DOCX writer
 * (Word, LibreOffice, Google Docs) actually uses: 0 (stored) and 8 (deflate) — any other
 * method throws an honest "unsupported" error rather than silently returning garbage.
 */
export function readZipEntry(buffer: Buffer, entryName: string): Buffer {
  const eocdOffset = findEndOfCentralDirectory(buffer);
  const centralDirOffset = buffer.readUInt32LE(eocdOffset + 16);
  const totalEntries = buffer.readUInt16LE(eocdOffset + 10);

  let offset = centralDirOffset;
  for (let i = 0; i < totalEntries; i++) {
    if (buffer.readUInt32LE(offset) !== CENTRAL_DIR_SIGNATURE) {
      throw new Error(`Corrupt ZIP archive: expected central directory entry at offset ${offset}.`);
    }
    const compressionMethod = buffer.readUInt16LE(offset + 10);
    const compressedSize = buffer.readUInt32LE(offset + 20);
    const filenameLength = buffer.readUInt16LE(offset + 28);
    const extraLength = buffer.readUInt16LE(offset + 30);
    const commentLength = buffer.readUInt16LE(offset + 32);
    const localHeaderOffset = buffer.readUInt32LE(offset + 42);
    const filename = buffer.toString("utf8", offset + 46, offset + 46 + filenameLength);

    if (filename === entryName) {
      return extractLocalFileData(buffer, localHeaderOffset, compressionMethod, compressedSize);
    }

    offset += 46 + filenameLength + extraLength + commentLength;
  }

  throw new Error(`ZIP archive does not contain an entry named "${entryName}".`);
}

function findEndOfCentralDirectory(buffer: Buffer): number {
  // The EOCD record is fixed-size (22 bytes) plus a variable-length comment (max 65535
  // bytes), so it must be searched for from the end rather than assumed to be at a fixed
  // offset. Real-world ZIPs (including every DOCX observed) carry no comment, so this loop
  // typically terminates on its first iteration.
  const maxCommentLength = 65535;
  const searchStart = Math.max(0, buffer.length - 22 - maxCommentLength);
  for (let i = buffer.length - 22; i >= searchStart; i--) {
    if (buffer.readUInt32LE(i) === EOCD_SIGNATURE) return i;
  }
  throw new Error("Not a valid ZIP archive: End-of-Central-Directory record not found.");
}

function extractLocalFileData(buffer: Buffer, localHeaderOffset: number, compressionMethod: number, compressedSize: number): Buffer {
  if (buffer.readUInt32LE(localHeaderOffset) !== LOCAL_FILE_SIGNATURE) {
    throw new Error(`Corrupt ZIP archive: expected local file header at offset ${localHeaderOffset}.`);
  }
  const filenameLength = buffer.readUInt16LE(localHeaderOffset + 26);
  const extraLength = buffer.readUInt16LE(localHeaderOffset + 28);
  const dataOffset = localHeaderOffset + 30 + filenameLength + extraLength;
  const compressedData = buffer.subarray(dataOffset, dataOffset + compressedSize);

  if (compressionMethod === 0) return Buffer.from(compressedData);
  if (compressionMethod === 8) return inflateRawSync(compressedData);
  throw new Error(`Unsupported ZIP compression method ${compressionMethod} (only stored/deflate are supported).`);
}
