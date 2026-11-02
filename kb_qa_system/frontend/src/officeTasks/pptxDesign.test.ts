import JSZip from 'jszip';
import { expect, it } from 'vitest';
import { exportDesignedPptx, validatePptxDesign, type PptxDesignDeck } from './pptxDesign';

const deck: PptxDesignDeck = {
  title: 'Designed deck',
  theme: { primary: '#187a72', secondary: '#d59b45', background: '#f4f6f3', surface: '#ffffff', text: '#202b29' },
  slides: [
    { id: 'bullets', title: 'Every item', layout: 'bullets', topic: '', content: Array.from({ length: 12 }, (_, index) => `Item-${index + 1}`).join('\n') },
    { id: 'image', title: 'Image and text', layout: 'image', topic: '', content: 'This body must remain editable.' },
    { id: 'split', title: 'Split', layout: 'split', topic: '', content: 'Split body' },
  ],
};

it('exports every editable text item across designed slide layouts without truncating', async () => {
  const bytes = await exportDesignedPptx(deck);
  const archive = await JSZip.loadAsync(bytes);
  const slides = Object.keys(archive.files).filter(path => /^ppt\/slides\/slide\d+\.xml$/.test(path));
  expect(slides).toHaveLength(3);
  const text = (await Promise.all(slides.map(path => archive.file(path)!.async('text')))).join('\n');
  for (let index = 1; index <= 12; index++) expect(text).toContain(`Item-${index}`);
  expect(text).toContain('This body must remain editable.');
  expect(text).toContain('Split body');
});

it('rejects malformed images and out-of-range decks before export', async () => {
  await expect(exportDesignedPptx({ ...deck, slides: [] })).rejects.toThrow('1–50');
  await expect(exportDesignedPptx({ ...deck, slides: [{ ...deck.slides[0], image: { name: 'x', mimeType: 'image/png', dataUrl: 'data:image/png;base64,AAAA', bytes: 3 } }] })).rejects.toThrow('图片');
});

it('accepts generated slide art above 4 MiB within the shared image budget', () => {
  const bytes = new Uint8Array(5_000_000); bytes.set([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
  const image = { name: 'generated.png', mimeType: 'image/png' as const, dataUrl: `data:image/png;base64,${Buffer.from(bytes).toString('base64')}`, bytes: bytes.length };
  expect(() => validatePptxDesign({ ...deck, slides: [{ ...deck.slides[0], image }] })).not.toThrow();
});
