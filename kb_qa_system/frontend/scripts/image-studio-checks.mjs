import { expect as baseExpect } from '@playwright/test';
import path from 'node:path';

// Real 4K PNG decoding and encrypted IndexedDB writes can exceed the default
// five-second assertion window. Assertions still finish as soon as ready.
const expect = baseExpect.configure({ timeout: 30000 });

// Shared by the packaged WebView2 acceptance harness. Only synthetic materials.
export async function checkImageStudio(page, output, bodies, png, checks = [], expectedImageWidth = 1024) {
  const studio = page.getByRole('region', { name: '图片生成工作室' });
  const field = name => studio.getByLabel(name, { exact: true });
  const button = name => studio.getByRole('button', { name, exact: true });
  await field('图片任务名称').fill('人物甲');
  const firstId = await field('图片任务').inputValue();
  await field('图片比例').selectOption('1536x864');
  await field('画布背景颜色').fill('#d8e8f8');
  for (const [name, value] of Object.entries({ x: '14.79', y: '16.11', w: '12.08', h: '14.04', '旋转角度': '30', '层号': '3', '区域描述 / 内容主题': '左上方的小人物，保留右侧空白' })) await field(name).fill(value);
  await field('参考图片').setInputFiles({ name: 'synthetic-reference.png', mimeType: 'image/png', buffer: png });
  await expect(studio.getByRole('img', { name: 'synthetic-reference.png', exact: true })).toBeVisible();
  await button('生成图片并放入设计').click();
  await expect(studio.getByRole('img', { name: '模型生成结果', exact: true })).toBeVisible();
  await expect.poll(() => studio.getByRole('img', { name: '模型生成结果', exact: true }).evaluate(image => image.naturalWidth), { timeout: 30000 }).toBe(expectedImageWidth);
  await expect.poll(() => bodies.at(-1)?.size).toBe('1536x864');
  expect(bodies.at(-1).prompt).toContain('左上角(14.79%,16.11%)');
  expect(bodies.at(-1).prompt).toContain('旋转30°，层3');
  expect(bodies.at(-1).prompt).toContain('#d8e8f8');
  expect(bodies.at(-1).referenceCount).toBe(1);
  checks.push('native image request includes selected size, background and exact geometry');
  checks.push('uploaded reference original reaches the native image edit API without vision summarization');
  await studio.getByText(/本次将直接发送1张参考原图/).scrollIntoViewIfNeeded();
  await page.screenshot({ path: path.join(output, 'reference-forwarding.png') });
  await button('新建图片任务').click();
  await expect(field('图片提示词')).toHaveValue('');
  await expect(field('图片比例')).toHaveValue('1024x1024');
  await expect(studio.locator('[data-shape-id]')).toHaveCount(1);
  await expect(studio.getByRole('img')).toHaveCount(0);
  await field('图片任务名称').fill('人物乙');
  await field('图片提示词').fill('人物乙的独立提示词');
  await field('图片比例').selectOption('864x1536');
  await button('添加区域').click();
  const secondId = await field('图片任务').inputValue();
  await field('图片任务').selectOption(firstId);
  await expect(field('图片任务名称')).toHaveValue('人物甲');
  await expect(field('图片比例')).toHaveValue('1536x864');
  await expect(field('x')).toHaveValue('14.79');
  await expect(field('层号')).toHaveValue('3');
  await expect(studio.getByRole('img', { name: '模型生成结果', exact: true })).toBeVisible();
  await expect(studio.getByRole('img', { name: 'synthetic-reference.png', exact: true })).toBeVisible();
  checks.push('new and switched tasks isolate prompt, geometry, canvas, references and result');
  await button('复制图片任务').click();
  await expect(field('图片任务名称')).toHaveValue('人物甲 副本');
  const copyId = await field('图片任务').inputValue(); expect(copyId).not.toBe(firstId);
  await field('图片提示词').fill('仅修改副本');
  await field('图片任务').selectOption(firstId);
  await expect(field('图片提示词')).not.toHaveValue('仅修改副本');
  await field('图片任务').selectOption(copyId);
  await expect(field('图片提示词')).toHaveValue('仅修改副本');
  await button('删除图片任务').click(); await button('确认删除图片任务').click();
  await expect(field('图片任务').locator(`option[value="${copyId}"]`)).toHaveCount(0);
  checks.push('copy edits do not mutate original; delete removes only the selected task');
  await field('图片任务').selectOption(secondId);
  await expect(studio.locator('[data-shape-id]')).toHaveCount(2);
  await expect(field('图片比例')).toHaveValue('864x1536');
  await field('图片提示词').fill('DELAYED synthetic task-switch image');
  await studio.getByText('由模型生成图片', { exact: true }).click();
  const priorRequests = bodies.length;
  await button('生成图片并放入设计').click();
  await expect.poll(() => bodies.length).toBe(priorRequests + 1);
  await button('新建图片任务').click();
  await expect(field('图片提示词')).toHaveValue('');
  await page.waitForTimeout(1700);
  await expect(studio.getByRole('img', { name: '模型生成结果', exact: true })).toHaveCount(0);
  await field('图片任务').selectOption(secondId);
  await expect(studio.getByRole('img', { name: '模型生成结果', exact: true })).toHaveCount(0);
  checks.push('switch cancels in-flight generation; late response does not enter either task');

  await field('图片宽度（像素）').fill('1008'); await field('图片高度（像素）').fill('784');
  await button('应用尺寸').click();
  await expect(field('图片比例')).toHaveValue('');
  await field('图片宽度（像素）').fill('513'); await button('应用尺寸').click();
  await expect(studio.getByRole('alert')).toContainText('16的倍数');
  await field('图片宽度（像素）').fill('1008'); await button('应用尺寸').click();
  await field('图片提示词').fill('锁库前最后一刻输入');
  await page.getByRole('button', { name: '锁定本机密钥库', exact: true }).click({ force: true });
  await page.getByLabel('解锁口令', { exact: true }).fill('synthetic-image-passphrase');
  await page.getByRole('button', { name: '解锁', exact: true }).click();
  await page.getByRole('tab', { name: '图片生成', exact: true }).click();
  await expect(field('图片提示词')).toHaveValue('锁库前最后一刻输入');
  await page.reload();
  await page.getByLabel('解锁口令', { exact: true }).fill('synthetic-image-passphrase');
  await page.getByRole('button', { name: '解锁', exact: true }).click();
  await page.getByRole('tab', { name: '任务', exact: true }).click();
  await page.getByRole('tab', { name: '图片生成', exact: true }).click();
  await expect(field('图片任务')).toHaveValue(secondId);
  await expect(field('图片提示词')).toHaveValue('锁库前最后一刻输入');
  await expect(field('图片宽度（像素）')).toHaveValue('1008');
  checks.push('custom dimensions validate; immediate lock and encrypted reload preserve latest task');
  await field('图片任务').selectOption(firstId);
  await expect(field('图片任务')).toHaveValue(firstId);
  await expect(field('图片任务名称')).toBeEnabled();
  await expect(studio.getByRole('img', { name: '模型生成结果', exact: true })).toBeVisible();
  await expect.poll(() => studio.getByRole('img', { name: '模型生成结果', exact: true }).evaluate(image => image.naturalWidth), { timeout: 30000 }).toBe(expectedImageWidth);
  await field('图片任务').selectOption(secondId);
  await expect(field('图片任务')).toHaveValue(secondId);
  await expect(field('图片任务名称')).toBeEnabled();
  checks.push('generated PNG above 1.5 MB remains decodable after encrypted save, lock and full reload');
  // A reopened saved task must accept results even without editing its prompt.
  await studio.getByText('由模型生成图片', { exact: true }).click();
  await button('生成图片并放入设计').click();
  await expect(studio.getByRole('img', { name: '模型生成结果', exact: true })).toBeVisible();
  checks.push('reopened task accepts new generation without a preliminary edit');

  await field('图片提示词').fill('长提示词'.repeat(180));
  await field('区域描述 / 内容主题').fill('较长区域说明'.repeat(200));
  for (const dark of [false, true]) for (const width of [390, 768, 1280, 1600]) {
    await page.setViewportSize({ width, height: 1000 });
    await page.evaluate(dark => document.documentElement.classList.toggle('dark', dark), dark);
    for (const size of ['864x1536', '1536x864']) {
      await field('图片比例').selectOption(size);
      const geometry = await studio.evaluate(section => {
        const canvas = section.querySelector('[aria-label="构图画布"]'), editor = section.querySelector('[data-image-editor]'), controls = section.querySelector('[data-image-controls]');
        const a = canvas.getBoundingClientRect(), b = editor.getBoundingClientRect(), c = controls.getBoundingClientRect();
        return { ratio: a.width / a.height, within: a.left >= b.left - 1 && a.right <= b.right + 1 && a.top >= b.top - 1 && a.bottom <= b.bottom + 1,
          overlap: Math.min(a.right, c.right) - Math.max(a.left, c.left) > 1 && Math.min(a.bottom, c.bottom) - Math.max(a.top, c.top) > 1,
          overflow: section.scrollWidth > section.clientWidth + 2 || document.documentElement.scrollWidth > innerWidth + 2 };
      });
      expect(geometry.within).toBe(true); expect(geometry.overlap).toBe(false); expect(geometry.overflow).toBe(false);
      expect(geometry.ratio).toBeCloseTo(size === '864x1536' ? 864 / 1536 : 1536 / 864, 2);
    }
    await studio.getByLabel('构图画布', { exact: true }).scrollIntoViewIfNeeded();
    await page.screenshot({ path: path.join(output, `image-layout-${width}-${dark ? 'dark' : 'light'}.png`) });
    checks.push(`canvas containment and layout ${width}px ${dark ? 'dark' : 'light'}`);
  }
  await page.setViewportSize({ width: 1280, height: 1000 });
  await page.getByRole('tab', { name: '文档生成', exact: true }).click();
  await page.getByLabel('输出文件类型', { exact: true }).selectOption('pptx');
  await page.getByLabel('页面版式', { exact: true }).selectOption('custom');
  const pptCanvas = page.getByLabel('PPT 页面设计器', { exact: true }).getByLabel('构图画布', { exact: true });
  const ppt = await pptCanvas.boundingBox(); expect(ppt.width / ppt.height).toBeCloseTo(16 / 9, 2);
  checks.push('shared PPT composition keeps 16:9 geometry');
  await page.getByRole('tab', { name: '图片生成', exact: true }).click();
  await studio.evaluate(section => { section.scrollTop = 0; });
  return checks;
}
