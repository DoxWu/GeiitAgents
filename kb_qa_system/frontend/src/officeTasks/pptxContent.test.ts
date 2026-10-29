import { expect, it } from 'vitest';
import { applyPptxContent, pptxContentTargets } from './pptxContent';
import { newCompositionShape } from './composition';
import type { PptxDesignDeck } from './pptxDesign';

it('fills mixed preset and custom pages without changing fixed text or geometry', () => {
  const region = { ...newCompositionShape(0), id: 'body', kind: 'text' as const, description: 'Explain evidence', rotation: 25, layer: 8 };
  const deck: PptxDesignDeck = { title: 'Review', theme: { primary: '#112233', secondary: '#445566', background: '#ffffff', surface: '#eeeeee', text: '#111111' }, slides: [
    { id: 'fixed', title: 'Fixed', layout: 'bullets', content: 'Confirmed content', topic: '' },
    { id: 'preset', title: 'Preset', layout: 'split', content: '', topic: 'Summary' },
    { id: 'custom', title: 'Custom', layout: 'custom', content: '', topic: '', regions: [region] },
  ] };
  expect(pptxContentTargets(deck).map(target => target.key)).toEqual(['slide:preset', 'region:custom:body']);
  const output = JSON.stringify({ 'slide:preset': 'New summary', 'region:custom:body': 'New evidence' });
  const generated = applyPptxContent(deck, output);
  expect(generated.slides[0]).toEqual(deck.slides[0]);
  expect(generated.slides[1].content).toBe('New summary');
  expect(generated.slides[2].regions![0]).toEqual({ ...region, text: 'New evidence' });
  for (const invalid of ['{}', JSON.stringify({ 'slide:preset': 'ok', unexpected: 'wrong' }), JSON.stringify({ 'slide:preset': 1, 'region:custom:body': 'ok' })]) {
    expect(() => applyPptxContent(deck, invalid)).toThrow();
  }
  expect(deck.slides[1].content).toBe('');
});
