import { validatePptxDesign, type PptxDesignDeck } from './pptxDesign';

export function pptxContentTargets(deck: PptxDesignDeck) {
  return deck.slides.flatMap(slide => slide.layout === 'custom'
    ? (slide.regions ?? []).filter(region => region.kind !== 'image' && region.description.trim()).map(region => ({
      key: `region:${slide.id}:${region.id}`, page: slide.title, topic: region.description, existing: region.text,
    }))
    : !slide.content.trim() || slide.topic.trim() ? [{ key: `slide:${slide.id}`, page: slide.title,
      topic: slide.topic || `根据演示主题补齐本页内容：${slide.title}`, existing: slide.content }] : []);
}

export function applyPptxContent(deck: PptxDesignDeck, content: string): PptxDesignDeck {
  const targets = pptxContentTargets(deck);
  const values: unknown = JSON.parse(content.trim().replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/, ''));
  if (!values || typeof values !== 'object' || Array.isArray(values)
    || Object.keys(values).length !== targets.length
    || targets.some(target => !Object.prototype.hasOwnProperty.call(values, target.key)
      || typeof (values as Record<string, unknown>)[target.key] !== 'string'
      || String((values as Record<string, unknown>)[target.key]).length > 12000)) {
    throw new Error('模型输出与页面区域不匹配，原设计已保留；可在生成记录中检查结果。');
  }
  const text = values as Record<string, string>;
  return validatePptxDesign({ ...deck, slides: deck.slides.map(slide => ({ ...slide,
    content: text[`slide:${slide.id}`] ?? slide.content,
    regions: slide.regions?.map(region => ({ ...region, text: text[`region:${slide.id}:${region.id}`] ?? region.text })),
  })) });
}
