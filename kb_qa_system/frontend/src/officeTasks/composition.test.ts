import { beforeEach, expect, it, vi } from 'vitest';
import { webcrypto } from 'node:crypto';
import JSZip from 'jszip';
import { compositionPrompt, imageCanvas, imageStudioBytes, newCompositionShape, validateImageStudio, validateImageTasks, validateShapes } from './composition';
import { imageSizeValue } from '@/services/imageGeneration';
import { exportDesignedPptx } from './pptxDesign';
beforeEach(()=>vi.stubGlobal('crypto',webcrypto));
it('rejects invalid geometry and preserves rotation and layer order in editable PPT shapes',async()=>{
  const a={...newCompositionShape(0),text:'Foreground',layer:5,rotation:30},b={...newCompositionShape(1),text:'Background',layer:1};
  expect(()=>validateShapes([{...a,w:101}])).toThrow();expect(()=>validateShapes([{...a,layer:1.5}])).toThrow();
  const bytes=await exportDesignedPptx({title:'Design',theme:{primary:'#000000',secondary:'#aaaaaa',background:'#ffffff',surface:'#eeeeee',text:'#111111'},slides:[{id:'page',title:'Page',content:'',topic:'',layout:'custom',regions:[a,b]}]});
  const zip=await JSZip.loadAsync(bytes),xml=await zip.file('ppt/slides/slide1.xml')!.async('string');
  expect(xml.indexOf('Background')).toBeLessThan(xml.indexOf('Foreground'));expect(xml).toContain('rot="1800000"');expect(xml).toContain('<a:t>Foreground</a:t>');
});

it('keeps legacy landscape drafts and validates new canvas dimensions without moving regions', () => {
  const legacy = { prompt: '', shapes: [newCompositionShape(0)], references: [] };
  expect(validateImageStudio(legacy)).toEqual(legacy);
  expect(imageCanvas()).toMatchObject({ width: 1536, height: 864 });
  const canvas = { width: 864, height: 1536, background: '#aabbcc' };
  expect(validateImageStudio({ ...legacy, canvas }).shapes).toEqual(legacy.shapes);
  expect(() => validateImageStudio({ ...legacy, canvas: { ...canvas, width: 1 } })).toThrow();
  expect(() => imageSizeValue({ width: 1025, height: 1024 })).toThrow();
  expect(() => validateImageStudio({ ...legacy, canvas: { ...canvas, background: 'url(secret)' } })).toThrow();
});

it('builds final prompts from current geometry and layers even without visual-model summarization', () => {
  const shape = { ...newCompositionShape(0), x: 14.79, y: 16.11, w: 12.08, h: 14.04, layer: 3, description: '绿色斗篷', rotation: 30 };
  const prompt = compositionPrompt({ prompt: '人物与背景', canvas: { width: 1536, height: 864, background: '#112233' }, shapes: [shape], references: [] });
  expect(prompt).toContain('1536×864'); expect(prompt).toContain('#112233');
  expect(prompt).toContain('(14.79%,16.11%)'); expect(prompt).toContain('宽12.08%、高14.04%');
  expect(prompt).toContain('旋转30°，层3'); expect(prompt).toContain('绿色斗篷');
  expect(prompt).toContain('不绘制示意标签文字');
  expect(compositionPrompt({ prompt: '', shapes: [], references: [] })).toContain('根据下列区域主题生成图片');
  expect(() => compositionPrompt({ prompt: 'x'.repeat(6000), shapes: [shape], references: [] })).toThrow('缩短');
});

it('validates isolated image task identities and counts every task in the shared image budget', () => {
  const draft = { prompt: 'test', shapes: [], references: [], result: { name: 'result.png', mimeType: 'image/png' as const, dataUrl: 'data:image/png;base64,iVBORw0KGgo=', bytes: 8 } };
  const task = { id: 'image-task', name: '图像一', updatedAt: new Date().toISOString(), draft };
  expect(validateImageTasks([task])).toEqual([task]);
  expect(() => validateImageTasks([task, task])).toThrow();
  expect(imageStudioBytes({ imageDraft: draft, imageTasks: [task, { ...task, id: 'two' }] })).toBe(24);
});
