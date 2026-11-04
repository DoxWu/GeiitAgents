// Keep temporary binary strings bounded: Array.from/Uint8Array.from on a large
// base64 string otherwise creates one intermediate JS element per byte.
export function encodeBase64(bytes: Uint8Array): string {
  const parts: string[] = [];
  for (let offset = 0; offset < bytes.length; offset += 24576) {
    parts.push(btoa(String.fromCharCode(...bytes.subarray(offset, offset + 24576))));
  }
  return parts.join('');
}

export function base64ByteLength(value: string): number {
  if (value.length % 4 || !/^[A-Za-z0-9+/]*={0,2}$/.test(value)) throw new Error('无效的 Base64 数据。');
  return value.length / 4 * 3 - (value.endsWith('==') ? 2 : value.endsWith('=') ? 1 : 0);
}

export function decodeBase64(value: string): Uint8Array<ArrayBuffer> {
  const bytes = new Uint8Array(base64ByteLength(value));
  for (let offset = 0, target = 0; offset < value.length; offset += 32768) {
    const binary = atob(value.slice(offset, offset + 32768));
    for (let i = 0; i < binary.length; i++) bytes[target++] = binary.charCodeAt(i);
  }
  return bytes;
}
