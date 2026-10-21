import { describe, expect, it } from 'vitest';
import { crc16, crc32, encodeGif, indexFrame, lzw, qrisPayload, xlsx, zip } from './encoders';
import { detectSlots } from './frames';

const ascii = (text: string) => new TextEncoder().encode(text);

describe('checksums', () => {
  it('match the published check values', () => {
    expect(crc32(ascii('123456789'))).toBe(0xcbf43926);
    expect(crc16('123456789')).toBe(0x29b1);
  });
});

describe('zip and xlsx', () => {
  it('writes one local header per file and a central directory', () => {
    const archive = zip([{ name: 'a.txt', data: ascii('hello') }, { name: 'b/c.txt', data: ascii('world') }]);
    const view = new DataView(archive.buffer);
    expect(view.getUint32(0, true)).toBe(0x04034b50);
    const end = archive.length - 22;
    expect(view.getUint32(end, true)).toBe(0x06054b50);
    expect(view.getUint16(end + 10, true)).toBe(2);
    // The stored bytes sit right after the first header and its name.
    expect(new TextDecoder().decode(archive.slice(30 + 5, 30 + 5 + 5))).toBe('hello');
  });

  it('builds a workbook with the sheet and escaped text', () => {
    const book = new TextDecoder().decode(xlsx('Revenue', ['Booth', 'Net'], [['Kiosk <1> & co', 35000]]));
    expect(book).toContain('<sheet name="Revenue"');
    expect(book).toContain('Kiosk &lt;1&gt; &amp; co');
    expect(book).toContain('<c r="B2"><v>35000</v></c>');
  });
});

describe('qrisPayload', () => {
  it('lays out the EMVCo fields and ends with a valid CRC', () => {
    const payload = qrisPayload({ merchantName: 'STUDIO RUPA', merchantCity: 'JAKARTA', merchantId: 'ID1234567890', amount: 35000, reference: 'INV-261019-0001' });
    expect(payload.startsWith('000201010212')).toBe(true);
    expect(payload).toContain('540535000');
    expect(payload).toContain('5303360');
    const body = payload.slice(0, -4);
    expect(payload.slice(-4)).toBe(crc16(body).toString(16).toUpperCase().padStart(4, '0'));
  });
});

/** A plain GIF LZW decoder, to prove the encoder round-trips. */
function unlzw(blocks: Uint8Array): number[] {
  const min = blocks[0];
  const bytes: number[] = [];
  for (let i = 1; blocks[i] !== 0; i += blocks[i] + 1) bytes.push(...blocks.slice(i + 1, i + 1 + blocks[i]));
  const clear = 1 << min;
  const end = clear + 1;
  let size = min + 1;
  let dict: number[][] = [];
  const reset = () => {
    dict = Array.from({ length: clear + 2 }, (_, i) => [i]);
    size = min + 1;
  };
  reset();
  const out: number[] = [];
  let bit = 0;
  let prev: number[] | null = null;
  for (;;) {
    let code = 0;
    for (let i = 0; i < size; i++, bit++) code |= ((bytes[bit >> 3] >> (bit & 7)) & 1) << i;
    if (code === clear) {
      reset();
      prev = null;
      continue;
    }
    if (code === end) return out;
    const entry: number[] = code < dict.length ? dict[code] : [...prev!, prev![0]];
    out.push(...entry);
    if (prev) dict.push([...prev, entry[0]]);
    prev = entry;
    if (dict.length === 1 << size && size < 12) size += 1;
  }
}

describe('gif', () => {
  it('round-trips indices through LZW, including a long run that fills the table', () => {
    const indices = Uint8Array.from({ length: 20_000 }, (_, i) => (i * 7 + (i >> 5)) % 251);
    expect(unlzw(lzw(indices))).toEqual([...indices]);
  });

  it('maps colours to the cube and writes a looping GIF89a', () => {
    const frame = { data: new Uint8ClampedArray([255, 0, 0, 255, 0, 0, 255, 255]), width: 2, height: 1 };
    const [red, blue] = indexFrame(frame);
    expect(red).toBe(5 * 7 * 6);
    expect(blue).toBe(5);
    const gif = encodeGif([frame, frame], 10);
    expect(new TextDecoder().decode(gif.slice(0, 6))).toBe('GIF89a');
    expect(gif.at(-1)).toBe(0x3b);
    expect(new TextDecoder().decode(gif)).toContain('NETSCAPE2.0');
  });
});

describe('detectSlots', () => {
  /** An opaque frame with transparent windows cut into it. */
  function frameWith(width: number, height: number, holes: [number, number, number, number][]): Uint8ClampedArray {
    const rgba = new Uint8ClampedArray(width * height * 4).fill(255);
    for (const [x, y, w, h] of holes) {
      for (let yy = y; yy < y + h; yy++) for (let xx = x; xx < x + w; xx++) rgba[(yy * width + xx) * 4 + 3] = 0;
    }
    return rgba;
  }

  it('finds a 2x2 grid of windows in reading order', () => {
    const rgba = frameWith(200, 300, [
      [110, 20, 80, 100],
      [10, 20, 80, 100],
      [10, 150, 80, 100],
      [110, 152, 80, 100],
    ]);
    const slots = detectSlots(rgba, 200, 300, { step: 1 });
    expect(slots).toEqual([
      { x: 10, y: 20, width: 80, height: 100 },
      { x: 110, y: 20, width: 80, height: 100 },
      { x: 10, y: 150, width: 80, height: 100 },
      { x: 110, y: 152, width: 80, height: 100 },
    ]);
  });

  it('ignores specks below the minimum size', () => {
    const rgba = frameWith(200, 200, [[10, 10, 2, 2], [50, 50, 100, 100]]);
    expect(detectSlots(rgba, 200, 200, { step: 1 })).toEqual([{ x: 50, y: 50, width: 100, height: 100 }]);
  });
});
