// File formats the app writes without a library: ZIP (stored), XLSX on top of it, the QRIS
// payload, and animated GIF.

// ---------- CRC ----------

const CRC32_TABLE = (() => {
  const table = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    table[n] = c >>> 0;
  }
  return table;
})();

export function crc32(data: Uint8Array): number {
  let crc = 0xffffffff;
  for (const byte of data) crc = CRC32_TABLE[(crc ^ byte) & 0xff] ^ (crc >>> 8);
  return (crc ^ 0xffffffff) >>> 0;
}

/** CRC-16/CCITT-FALSE, the checksum EMVCo QR payloads end with. */
export function crc16(text: string): number {
  let crc = 0xffff;
  for (const byte of new TextEncoder().encode(text)) {
    crc ^= byte << 8;
    for (let i = 0; i < 8; i++) crc = crc & 0x8000 ? ((crc << 1) ^ 0x1021) & 0xffff : (crc << 1) & 0xffff;
  }
  return crc;
}

// ---------- ZIP ----------

export interface ZipEntry {
  name: string;
  data: Uint8Array;
}

/** A ZIP with every file stored uncompressed: photos are compressed already, and XLSX accepts it. */
export function zip(entries: readonly ZipEntry[], date = new Date()): Uint8Array {
  const encoder = new TextEncoder();
  const dosTime = (date.getHours() << 11) | (date.getMinutes() << 5) | (date.getSeconds() >> 1);
  const dosDate = ((date.getFullYear() - 1980) << 9) | ((date.getMonth() + 1) << 5) | date.getDate();
  const locals: Uint8Array[] = [];
  const centrals: Uint8Array[] = [];
  let offset = 0;

  for (const entry of entries) {
    const name = encoder.encode(entry.name);
    const crc = crc32(entry.data);
    const local = new DataView(new ArrayBuffer(30));
    local.setUint32(0, 0x04034b50, true);
    local.setUint16(4, 20, true);
    local.setUint16(6, 0x0800, true); // UTF-8 names
    local.setUint16(10, dosTime, true);
    local.setUint16(12, dosDate, true);
    local.setUint32(14, crc, true);
    local.setUint32(18, entry.data.length, true);
    local.setUint32(22, entry.data.length, true);
    local.setUint16(26, name.length, true);
    locals.push(new Uint8Array(local.buffer), name, entry.data);

    const central = new DataView(new ArrayBuffer(46));
    central.setUint32(0, 0x02014b50, true);
    central.setUint16(4, 20, true);
    central.setUint16(6, 20, true);
    central.setUint16(8, 0x0800, true);
    central.setUint16(12, dosTime, true);
    central.setUint16(14, dosDate, true);
    central.setUint32(16, crc, true);
    central.setUint32(20, entry.data.length, true);
    central.setUint32(24, entry.data.length, true);
    central.setUint16(28, name.length, true);
    central.setUint32(42, offset, true);
    centrals.push(new Uint8Array(central.buffer), name);
    offset += 30 + name.length + entry.data.length;
  }

  const centralSize = centrals.reduce((sum, part) => sum + part.length, 0);
  const end = new DataView(new ArrayBuffer(22));
  end.setUint32(0, 0x06054b50, true);
  end.setUint16(8, entries.length, true);
  end.setUint16(10, entries.length, true);
  end.setUint32(12, centralSize, true);
  end.setUint32(16, offset, true);
  return concat([...locals, ...centrals, new Uint8Array(end.buffer)]);
}

function concat(parts: readonly Uint8Array[]): Uint8Array {
  const out = new Uint8Array(parts.reduce((sum, part) => sum + part.length, 0));
  let at = 0;
  for (const part of parts) {
    out.set(part, at);
    at += part.length;
  }
  return out;
}

// ---------- XLSX ----------

const xml = (text: string) => text.replace(/[<>&"]/g, (c) => ({ '<': '&lt;', '>': '&gt;', '&': '&amp;', '"': '&quot;' })[c]!);

function columnName(index: number): string {
  let name = '';
  for (let n = index + 1; n > 0; n = Math.floor((n - 1) / 26)) name = String.fromCharCode(65 + ((n - 1) % 26)) + name;
  return name;
}

/** A one-sheet workbook. Numbers stay numbers, so Excel can sum the columns. */
export function xlsx(sheetName: string, headers: readonly string[], rows: readonly (readonly (string | number)[])[]): Uint8Array {
  const cell = (value: string | number, ref: string, bold: boolean) =>
    typeof value === 'number'
      ? `<c r="${ref}"${bold ? ' s="1"' : ''}><v>${value}</v></c>`
      : `<c r="${ref}" t="inlineStr"${bold ? ' s="1"' : ''}><is><t xml:space="preserve">${xml(value)}</t></is></c>`;
  const sheetRows = [headers, ...rows]
    .map((row, r) => `<row r="${r + 1}">${row.map((value, c) => cell(value, `${columnName(c)}${r + 1}`, r === 0)).join('')}</row>`)
    .join('');
  const name = xml(sheetName.slice(0, 31) || 'Sheet1');
  const files: Record<string, string> = {
    '[Content_Types].xml':
      '<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Override PartName="/xl/workbook.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml"/><Override PartName="/xl/worksheets/sheet1.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/><Override PartName="/xl/styles.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.styles+xml"/></Types>',
    '_rels/.rels':
      '<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="xl/workbook.xml"/></Relationships>',
    'xl/workbook.xml': `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><workbook xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"><sheets><sheet name="${name}" sheetId="1" r:id="rId1"/></sheets></workbook>`,
    'xl/_rels/workbook.xml.rels':
      '<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="worksheets/sheet1.xml"/><Relationship Id="rId2" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/styles" Target="styles.xml"/></Relationships>',
    'xl/styles.xml':
      '<?xml version="1.0" encoding="UTF-8" standalone="yes"?><styleSheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"><fonts count="2"><font><sz val="11"/><name val="Calibri"/></font><font><b/><sz val="11"/><name val="Calibri"/></font></fonts><fills count="2"><fill><patternFill patternType="none"/></fill><fill><patternFill patternType="gray125"/></fill></fills><borders count="1"><border/></borders><cellStyleXfs count="1"><xf/></cellStyleXfs><cellXfs count="2"><xf fontId="0"/><xf fontId="1" applyFont="1"/></cellXfs></styleSheet>',
    'xl/worksheets/sheet1.xml': `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"><sheetData>${sheetRows}</sheetData></worksheet>`,
  };
  const encoder = new TextEncoder();
  return zip(Object.entries(files).map(([path, text]) => ({ name: path, data: encoder.encode(text) })));
}

// ---------- QRIS ----------

const tlv = (id: string, value: string) => `${id}${String(value.length).padStart(2, '0')}${value}`;

export interface QrisInput {
  merchantName: string;
  merchantCity: string;
  merchantId: string;
  amount: number;
  reference: string;
}

/**
 * A dynamic QRIS payload in the EMVCo merchant-presented layout. The gateway issues the real one;
 * the simulator builds this so the booth shows a QR with the right shape and amount.
 */
export function qrisPayload(input: QrisInput): string {
  const body = [
    tlv('00', '01'),
    tlv('01', '12'),
    tlv('26', tlv('00', 'ID.CO.QRIS.WWW') + tlv('01', input.merchantId) + tlv('03', 'UMI')),
    tlv('52', '7221'),
    tlv('53', '360'),
    tlv('54', String(Math.round(input.amount))),
    tlv('58', 'ID'),
    tlv('59', input.merchantName.slice(0, 25)),
    tlv('60', input.merchantCity.slice(0, 15)),
    tlv('62', tlv('01', input.reference.slice(0, 25))),
  ].join('');
  const withCrcTag = `${body}6304`;
  return withCrcTag + crc16(withCrcTag).toString(16).toUpperCase().padStart(4, '0');
}

// ---------- GIF ----------

export interface RgbaFrame {
  data: Uint8ClampedArray;
  width: number;
  height: number;
}

/** A fixed 6×7×6 colour cube: green gets the extra step, since eyes see it best. */
const LEVELS = { r: 6, g: 7, b: 6 };
const PALETTE = (() => {
  const colours: number[] = [];
  for (let r = 0; r < LEVELS.r; r++)
    for (let g = 0; g < LEVELS.g; g++)
      for (let b = 0; b < LEVELS.b; b++)
        colours.push(Math.round((r * 255) / (LEVELS.r - 1)), Math.round((g * 255) / (LEVELS.g - 1)), Math.round((b * 255) / (LEVELS.b - 1)));
  while (colours.length < 256 * 3) colours.push(0);
  return colours;
})();

/** 4×4 ordered dither, which hides banding in skin and sky better than plain rounding. */
const BAYER = [0, 8, 2, 10, 12, 4, 14, 6, 3, 11, 1, 9, 15, 7, 13, 5].map((v) => (v + 0.5) / 16 - 0.5);

export function indexFrame(frame: RgbaFrame): Uint8Array {
  const { data, width, height } = frame;
  const indices = new Uint8Array(width * height);
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const i = (y * width + x) * 4;
      const d = BAYER[(y & 3) * 4 + (x & 3)];
      const q = (value: number, levels: number) => Math.min(levels - 1, Math.max(0, Math.round((value / 255) * (levels - 1) + d)));
      indices[y * width + x] = (q(data[i], LEVELS.r) * LEVELS.g + q(data[i + 1], LEVELS.g)) * LEVELS.b + q(data[i + 2], LEVELS.b);
    }
  }
  return indices;
}

/** GIF's variable-width LZW, packed into 255-byte sub-blocks. */
export function lzw(indices: Uint8Array, minCodeSize = 8): Uint8Array {
  const clear = 1 << minCodeSize;
  const end = clear + 1;
  const out: number[] = [];
  let buffer = 0;
  let bits = 0;
  let codeSize = minCodeSize + 1;
  const write = (code: number) => {
    buffer |= code << bits;
    bits += codeSize;
    while (bits >= 8) {
      out.push(buffer & 0xff);
      buffer >>= 8;
      bits -= 8;
    }
  };

  let dict = new Map<string, number>();
  let next = end + 1;
  write(clear);
  let prefix = String(indices[0] ?? 0);
  for (let i = 1; i < indices.length; i++) {
    const key = `${prefix},${indices[i]}`;
    if (dict.has(key)) {
      prefix = key;
      continue;
    }
    write(prefix.includes(',') ? dict.get(prefix)! : Number(prefix));
    if (next < 4096) {
      dict.set(key, next++);
      if (next > 1 << codeSize && codeSize < 12) codeSize += 1;
    } else {
      write(clear);
      dict = new Map();
      next = end + 1;
      codeSize = minCodeSize + 1;
    }
    prefix = String(indices[i]);
  }
  write(prefix.includes(',') ? dict.get(prefix)! : Number(prefix));
  write(end);
  if (bits > 0) out.push(buffer & 0xff);

  const blocks: number[] = [minCodeSize];
  for (let i = 0; i < out.length; i += 255) {
    const chunk = out.slice(i, i + 255);
    blocks.push(chunk.length, ...chunk);
  }
  blocks.push(0);
  return Uint8Array.from(blocks);
}

/** An endlessly looping GIF. `delay` is in hundredths of a second. */
export function encodeGif(frames: readonly RgbaFrame[], delay = 20): Uint8Array {
  if (frames.length === 0) throw new Error('A GIF needs at least one frame.');
  const { width, height } = frames[0];
  const bytes: number[] = [];
  const word = (n: number) => bytes.push(n & 0xff, (n >> 8) & 0xff);
  bytes.push(...new TextEncoder().encode('GIF89a'));
  word(width);
  word(height);
  bytes.push(0xf7, 0, 0); // global table of 256 colours
  bytes.push(...PALETTE);
  bytes.push(0x21, 0xff, 0x0b, ...new TextEncoder().encode('NETSCAPE2.0'), 3, 1, 0, 0, 0); // loop forever
  const parts: Uint8Array[] = [Uint8Array.from(bytes)];
  for (const frame of frames) {
    const head: number[] = [0x21, 0xf9, 4, 0, delay & 0xff, (delay >> 8) & 0xff, 0, 0, 0x2c, 0, 0, 0, 0];
    head.push(width & 0xff, width >> 8, height & 0xff, height >> 8, 0);
    parts.push(Uint8Array.from(head), lzw(indexFrame(frame)));
  }
  parts.push(Uint8Array.from([0x3b]));
  return concat(parts);
}
