// Minimal CBOR (RFC 8949) decoder for WebAuthn: unsigned and negative integers, byte and
// text strings, arrays, maps and simple values. Indefinite lengths and floats are refused.
import { HttpError } from './util';

export type CborValue =
  | number
  | Uint8Array
  | string
  | boolean
  | null
  | CborValue[]
  | Map<CborValue, CborValue>;

const invalid = () => new HttpError(400, 'Invalid passkey data.');

export function decodeCbor(bytes: Uint8Array, offset = 0) {
  let position = offset;
  function length(info: number) {
    if (info < 24) return info;
    const size = { 24: 1, 25: 2, 26: 4 }[info];
    if (!size || position + size > bytes.length) throw invalid();
    let value = 0;
    for (let i = 0; i < size; i++) value = value * 256 + bytes[position + i];
    position += size;
    return value;
  }
  function item(depth: number): CborValue {
    if (depth > 16 || position >= bytes.length) throw invalid();
    const initial = bytes[position++];
    const major = initial >> 5;
    const info = initial & 31;
    if (major === 7) {
      if (info === 20) return false;
      if (info === 21) return true;
      if (info === 22) return null;
      throw invalid();
    }
    const size = length(info);
    switch (major) {
      case 0:
        return size;
      case 1:
        return -1 - size;
      case 2:
      case 3: {
        if (position + size > bytes.length) throw invalid();
        const slice = bytes.slice(position, position + size);
        position += size;
        return major === 2 ? slice : new TextDecoder().decode(slice);
      }
      case 4: {
        const list: CborValue[] = [];
        for (let i = 0; i < size; i++) list.push(item(depth + 1));
        return list;
      }
      case 5: {
        const map = new Map<CborValue, CborValue>();
        for (let i = 0; i < size; i++)
          map.set(item(depth + 1), item(depth + 1));
        return map;
      }
      default:
        throw invalid();
    }
  }
  const value = item(0);
  return { value, end: position };
}
