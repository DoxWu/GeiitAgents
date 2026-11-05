import type { GeneratedWorkImage } from '@/types/workbench';
import { base64ByteLength, decodeBase64 } from './binaryBase64';
import { imageType, validateGeneratedWorkImage } from './workbenchImages';
import { GENERATED_IMAGE_TOO_LARGE, MAX_GENERATED_IMAGE_BYTES } from './workbenchCapacity';

const INVALID = '模型已返回结果，但图片内容无效或包含不支持的活动内容。';
const SVG_ELEMENTS = new Set('svg a switch view g defs symbol use path rect circle ellipse line polyline polygon text tspan textPath title desc metadata clipPath mask pattern marker linearGradient radialGradient stop filter feBlend feColorMatrix feComponentTransfer feComposite feConvolveMatrix feDiffuseLighting feDisplacementMap feDistantLight feDropShadow feFlood feFuncA feFuncB feFuncG feFuncR feGaussianBlur feMerge feMergeNode feMorphology feOffset fePointLight feSpecularLighting feSpotLight feTile feTurbulence style'.split(' '));

export function validateStaticSvg(bytes: Uint8Array): void {
  const xml = new TextDecoder('utf-8', { fatal: true }).decode(bytes);
  if (/<!DOCTYPE|<!ENTITY/i.test(xml)) throw new Error(INVALID);
  const doc = new DOMParser().parseFromString(xml, 'image/svg+xml');
  if (doc.querySelector('parsererror') || doc.documentElement.localName !== 'svg' || doc.documentElement.namespaceURI !== 'http://www.w3.org/2000/svg') throw new Error(INVALID);
  const safeCss = (value: string) => {
    const css = value.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\\([0-9a-f]{1,6}\s?|[^0-9a-f\r\n])/gi, (_, escaped: string) => /^[0-9a-f]/i.test(escaped) ? String.fromCodePoint(Math.min(parseInt(escaped.trim(), 16), 0x10ffff)) : escaped);
    return !/\\|\/\*|@(?:import|font-face|(?:-webkit-)?keyframes)\b|(?:expression|image|(?:-webkit-)?image-set)\s*\(|(?:javascript|vbscript)\s*:|-moz-binding|behavior\s*:/i.test(css)
      && [...css.matchAll(/url\s*\(([^)]*)\)/gi)].every(match => /^\s*['"]?#[\w:.-]+['"]?\s*$/.test(match[1]));
  };
  for (const node of [doc.documentElement, ...doc.documentElement.querySelectorAll('*')]) {
    if (!SVG_ELEMENTS.has(node.localName) || node.namespaceURI !== 'http://www.w3.org/2000/svg') throw new Error(INVALID);
    if (node.localName === 'style' && !safeCss(node.textContent ?? '')) throw new Error(INVALID);
    for (const attr of node.attributes) {
      if (/^on/i.test(attr.localName) || attr.localName === 'base'
          || attr.namespaceURI && !['http://www.w3.org/2000/xmlns/', 'http://www.w3.org/1999/xlink', 'http://www.w3.org/XML/1998/namespace'].includes(attr.namespaceURI)
          || attr.localName === 'href' && !/^#[\w:.-]+$/.test(attr.value)
          || !safeCss(attr.value)) throw new Error(INVALID);
    }
  }
  // Processing instructions may load an external stylesheet outside the SVG tree.
  if (doc.createTreeWalker(doc, NodeFilter.SHOW_PROCESSING_INSTRUCTION).nextNode()) throw new Error(INVALID);
}

export function generatedImageType(bytes: Uint8Array): GeneratedWorkImage['mimeType'] | undefined {
  const raster = imageType(bytes);
  if (raster) return raster;
  if (bytes.length >= 13 && ['GIF87a', 'GIF89a'].includes(String.fromCharCode(...bytes.subarray(0, 6))) && (bytes[6] || bytes[7]) && (bytes[8] || bytes[9])) return 'image/gif';
  if (/^\s*(?:<\?xml\b|<!--|<svg\b)/.test(new TextDecoder().decode(bytes.subarray(0, 512)))) {
    validateStaticSvg(bytes); return 'image/svg+xml';
  }
}

export function generatedImageFromBase64(encoded: string, name = 'generated-image'): GeneratedWorkImage {
  if (typeof encoded !== 'string' || encoded.length > Math.ceil(MAX_GENERATED_IMAGE_BYTES / 3) * 4) throw new Error(GENERATED_IMAGE_TOO_LARGE);
  if (!/^[A-Za-z0-9+/]+={0,2}$/.test(encoded) || encoded.length % 4 !== 0) throw new Error(INVALID);
  const bytes = base64ByteLength(encoded);
  if (bytes > MAX_GENERATED_IMAGE_BYTES) throw new Error(GENERATED_IMAGE_TOO_LARGE);
  const prefix = decodeBase64(encoded.slice(0, Math.min(684, encoded.length)));
  const mimeType = imageType(prefix) ?? (String.fromCharCode(...prefix.subarray(0, 6)).startsWith('GIF') ? generatedImageType(prefix) : generatedImageType(decodeBase64(encoded)));
  if (!mimeType) throw new Error(INVALID);
  return { name: name.slice(0, 240), bytes, mimeType, dataUrl: `data:${mimeType};base64,${encoded}` };
}

export function generatedImageFromDataUrl(value: string, name = 'generated-image'): GeneratedWorkImage {
  if (typeof value !== 'string' || value.length > Math.ceil(MAX_GENERATED_IMAGE_BYTES / 3) * 4 + 64) throw new Error(GENERATED_IMAGE_TOO_LARGE);
  const match = /^data:(image\/(?:png|jpeg|webp|gif|svg\+xml));base64,([A-Za-z0-9+/]+={0,2})$/.exec(value);
  if (!match) throw new Error(INVALID);
  const result = generatedImageFromBase64(match[2], name);
  if (result.mimeType !== match[1]) throw new Error(INVALID);
  return result;
}

export function validateGeneratedImageAsset(image: GeneratedWorkImage): void {
  if (!image || typeof image.name !== 'string' || image.name.length > 240) throw new Error(INVALID);
  if (!['image/gif', 'image/svg+xml'].includes(image.mimeType)) { validateGeneratedWorkImage(image as Parameters<typeof validateGeneratedWorkImage>[0]); return; }
  const result = generatedImageFromDataUrl(image.dataUrl, image.name);
  if (result.bytes !== image.bytes || result.mimeType !== image.mimeType) throw new Error(INVALID);
}
