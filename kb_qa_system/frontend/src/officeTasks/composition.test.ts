import { beforeEach, expect, it, vi } from 'vitest';
import { webcrypto } from 'node:crypto';
import JSZip from 'jszip';
import { newCompositionShape, validateShapes } from './composition';
import { exportDesignedPptx } from './pptxDesign';
beforeEach(()=>vi.stubGlobal('crypto',webcrypto));
it('rejects invalid geometry and preserves rotation and layer order in editable PPT shapes',async()=>{
  const a={...newCompositionShape(0),text:'Foreground',layer:5,rotation:30},b={...newCompositionShape(1),text:'Background',layer:1};
  expect(()=>validateShapes([{...a,w:101}])).toThrow();expect(()=>validateShapes([{...a,layer:1.5}])).toThrow();
  const bytes=await exportDesignedPptx({title:'Design',theme:{primary:'#000000',secondary:'#aaaaaa',background:'#ffffff',surface:'#eeeeee',text:'#111111'},slides:[{id:'page',title:'Page',content:'',topic:'',layout:'custom',regions:[a,b]}]});
  const zip=await JSZip.loadAsync(bytes),xml=await zip.file('ppt/slides/slide1.xml')!.async('string');
  expect(xml.indexOf('Background')).toBeLessThan(xml.indexOf('Foreground'));expect(xml).toContain('rot="1800000"');expect(xml).toContain('<a:t>Foreground</a:t>');
});
