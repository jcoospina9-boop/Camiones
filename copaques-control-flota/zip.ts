import fs from 'fs';
import path from 'path';
import zlib from 'zlib';

interface ZipEntry {
  name: string;
  data: Buffer;
}

function buildZipBuffer(entries: ZipEntry[]): Buffer {
  const localParts: Buffer[] = [];
  const centralParts: Buffer[] = [];
  let offset = 0;

  const now = new Date();
  const dosTime =
    ((now.getHours() & 0x1f) << 11) |
    ((now.getMinutes() & 0x3f) << 5) |
    ((now.getSeconds() >> 1) & 0x1f);
  const dosDate =
    (((Math.max(1980, now.getFullYear()) - 1980) & 0x7f) << 9) |
    (((now.getMonth() + 1) & 0x0f) << 5) |
    (now.getDate() & 0x1f);

  for (const entry of entries) {
    const nameBuf = Buffer.from(entry.name.replace(/\\/g, '/'), 'utf8');
    const crc = zlib.crc32(entry.data) >>> 0;
    const compressed = zlib.deflateRawSync(entry.data);

    // Local file header (30 bytes + filename)
    const localHeader = Buffer.alloc(30);
    localHeader.writeUInt32LE(0x04034b50, 0);
    localHeader.writeUInt16LE(20, 4); // version needed
    localHeader.writeUInt16LE(0x0800, 6); // UTF-8 filename flag
    localHeader.writeUInt16LE(8, 8); // deflate compression
    localHeader.writeUInt16LE(dosTime, 10);
    localHeader.writeUInt16LE(dosDate, 12);
    localHeader.writeUInt32LE(crc, 14);
    localHeader.writeUInt32LE(compressed.length, 18);
    localHeader.writeUInt32LE(entry.data.length, 22);
    localHeader.writeUInt16LE(nameBuf.length, 26);
    localHeader.writeUInt16LE(0, 28);

    localParts.push(localHeader, nameBuf, compressed);

    // Central directory header (46 bytes + filename)
    const centralHeader = Buffer.alloc(46);
    centralHeader.writeUInt32LE(0x02014b50, 0);
    centralHeader.writeUInt16LE(20, 4);
    centralHeader.writeUInt16LE(20, 6);
    centralHeader.writeUInt16LE(0x0800, 8);
    centralHeader.writeUInt16LE(8, 10);
    centralHeader.writeUInt16LE(dosTime, 12);
    centralHeader.writeUInt16LE(dosDate, 14);
    centralHeader.writeUInt32LE(crc, 16);
    centralHeader.writeUInt32LE(compressed.length, 20);
    centralHeader.writeUInt32LE(entry.data.length, 24);
    centralHeader.writeUInt16LE(nameBuf.length, 28);
    centralHeader.writeUInt16LE(0, 30);
    centralHeader.writeUInt16LE(0, 32);
    centralHeader.writeUInt16LE(0, 34);
    centralHeader.writeUInt16LE(0, 36);
    centralHeader.writeUInt32LE(0, 38);
    centralHeader.writeUInt32LE(offset, 42);

    centralParts.push(centralHeader, nameBuf);
    offset += localHeader.length + nameBuf.length + compressed.length;
  }

  const centralDir = Buffer.concat(centralParts);
  const eocd = Buffer.alloc(22);
  eocd.writeUInt32LE(0x06054b50, 0);
  eocd.writeUInt16LE(0, 4);
  eocd.writeUInt16LE(0, 6);
  eocd.writeUInt16LE(entries.length, 8);
  eocd.writeUInt16LE(entries.length, 10);
  eocd.writeUInt32LE(centralDir.length, 12);
  eocd.writeUInt32LE(offset, 16);
  eocd.writeUInt16LE(0, 20);

  return Buffer.concat([...localParts, centralDir, eocd]);
}

const ALLOWED_ROOT_FILES = [
  'package.json',
  'tsconfig.json',
  'vite.config.ts',
  'index.html',
  'metadata.json',
  'server.ts',
  'Dockerfile',
  '.dockerignore',
  '.npmrc',
  'railway.json',
  '.env.example',
  '.gitignore',
  'README.md',
];

const ALLOWED_ROOT_DIRS = ['src', 'server', 'public', 'docs', 'scripts'];

function collectDirFiles(
  baseDir: string,
  relDir: string,
  entries: ZipEntry[]
): void {
  const fullDir = path.resolve(baseDir, relDir);
  if (!fullDir.startsWith(baseDir + path.sep)) return;
  if (!fs.existsSync(fullDir)) return;

  const items = fs.readdirSync(fullDir, { withFileTypes: true });
  for (const item of items) {
    if (item.name.startsWith('.env') && item.name !== '.env.example') continue;
    const childRel = path.join(relDir, item.name);
    const childFull = path.resolve(baseDir, childRel);
    if (!childFull.startsWith(baseDir + path.sep)) continue;

    if (item.isDirectory()) {
      collectDirFiles(baseDir, childRel, entries);
    } else if (item.isFile()) {
      entries.push({
        name: childRel.replace(/\\/g, '/'),
        data: fs.readFileSync(childFull),
      });
    }
  }
}

export function createProjectZipBuffer(): Buffer {
  const rootDir = path.resolve(process.cwd());
  const entries: ZipEntry[] = [];

  for (const file of ALLOWED_ROOT_FILES) {
    const fullPath = path.resolve(rootDir, file);
    if (fullPath.startsWith(rootDir + path.sep) && fs.existsSync(fullPath)) {
      entries.push({
        name: file,
        data: fs.readFileSync(fullPath),
      });
    }
  }

  for (const dir of ALLOWED_ROOT_DIRS) {
    collectDirFiles(rootDir, dir, entries);
  }

  return buildZipBuffer(entries);
}
