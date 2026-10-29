import { chromium, expect } from '@playwright/test';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
const native=process.env.WORKBENCH_CDP_URL, production=process.env.WORKBENCH_PRODUCTION==='1', output=process.env.WORKBENCH_REVIEW_OUTPUT??'../../.tools/unified-workbench-20261029';
await mkdir(output,{recursive:true});
const browser=native?await chromium.connectOverCDP(native):await chromium.launch({headless:true}),context=native?browser.contexts()[0]:await browser.newContext({viewport:{width:1280,height:900}}),page=native?context.pages()[0]:await context.newPage(),errors=[],requests=[],checks=[];
const base=native?new URL(page.url()).origin:process.env.WORKBENCH_REVIEW_URL??'http://127.0.0.1:5181';
page.on('pageerror',e=>errors.push(e.message));
await context.addInitScript(()=>{
  localStorage.setItem('kb_account_server','https://account.example.test/api/v1');localStorage.setItem('kb_auth_server','https://account.example.test/api/v1');
  localStorage.setItem('kb_auth_tokens',JSON.stringify({access_token:'synthetic-workbench',refresh_token:'synthetic-workbench'}));
  localStorage.setItem('kb_auth_user',JSON.stringify({id:202,username:'fixture',email:'fixture@example.test',is_active:true,is_superuser:false,user_type:'regular',created_at:''}));
});
await context.route('**/api/v1/**',route=>{const path=new URL(route.request().url()).pathname;requests.push(path);return route.fulfill({json:path.endsWith('/private-models/account')?{available:true,model:'fixture'}:path.endsWith('/organizations/mine')?[]:path.includes('server-images')?{models:[]}:[]});});
if(production&&!native){
  const headers=await readFile('security-headers.conf','utf8'),csp=headers.match(/Content-Security-Policy "([^"]+)"/)[1];
  await context.route(`${base}/**`,async route=>{if(route.request().resourceType()!=='document')return route.continue();const response=await route.fetch();return route.fulfill({response,headers:{...response.headers(),'Content-Security-Policy':csp}});});
}
try{
  if(native)await page.reload();else await page.goto(`${base}/workbench`);await page.getByLabel('解锁口令',{exact:true}).fill('fixture-1234');await page.getByLabel('确认口令',{exact:true}).fill('fixture-1234');await page.getByRole('button',{name:'创建',exact:true}).click();await page.getByRole('tab',{name:'任务',exact:true}).click();
  await expect(page.getByRole('tab',{name:'长任务',exact:true})).toBeVisible();await expect(page.getByRole('tab',{name:'多步骤任务',exact:true})).toHaveCount(0);checks.push('unified entries');
  if(!production){const worker=await page.evaluate(async()=>{const {newFunction,executeWorkflowFunction}=await import('/src/workflows/functions.ts');return executeWorkflowFunction({...newFunction(),reviewed:true},{context:' worker fixture '},new AbortController().signal);});expect(worker).toEqual({result:'worker fixture'});checks.push('real QuickJS web worker and WASM');}
  await page.getByLabel('文档标题',{exact:true}).fill('跨标签保留');await page.getByRole('tab',{name:'图片生成',exact:true}).click();
  await page.getByLabel('图片提示词',{exact:true}).fill('合成图片');await page.getByLabel('旋转角度',{exact:true}).fill('45');await page.getByLabel('层号',{exact:true}).fill('8');
  const shape=page.locator('[data-shape-id]').first();await expect(shape).toHaveCSS('z-index','8');await expect(shape).toHaveAttribute('style',/rotate\(45deg\)/);await page.getByRole('button',{name:'复制区域',exact:true}).click();await expect(page.locator('[data-shape-id]')).toHaveCount(2);checks.push('rotation layers duplicate');
  await page.getByRole('tab',{name:'长任务',exact:true}).click();await expect(page.getByRole('button',{name:'添加调用函数',exact:true})).toBeVisible();await page.getByRole('button',{name:'添加调用函数',exact:true}).click();await expect(page.getByLabel('函数代码',{exact:true})).toBeVisible();await page.getByRole('button',{name:'隔离试运行',exact:true}).click();await expect(page.getByRole('status').filter({hasText:'示例文本'})).toBeVisible();checks.push('function UI execution');
  const node=page.locator('[data-workflow-node]').first(),before=await node.boundingBox(),handle=page.getByRole('button',{name:'移动步骤 1',exact:true});
  await handle.hover();await page.mouse.down();await page.mouse.move(before.x+160,before.y+90,{steps:8});await page.mouse.up();const after=await node.boundingBox();expect(Math.abs(after.x-before.x)+Math.abs(after.y-before.y)).toBeGreaterThan(20);checks.push('drag workflow node');
  await page.getByRole('button',{name:'添加整理 Markdown',exact:true}).click();
  for(let i=0;i<10;i++)await page.getByRole('button',{name:'移动步骤 2',exact:true}).press('ArrowDown');
  await page.getByRole('button',{name:'调用函数出口',exact:true}).click();await page.getByRole('button',{name:'整理 Markdown入口',exact:true}).click();
  const arrow=page.getByRole('button',{name:/删除箭头 调用函数\s+→ 整理 Markdown/});await expect(arrow).toBeVisible();checks.push('connect workflow ports');
  await arrow.press('Delete');await expect(page.locator('svg [role=button]')).toHaveCount(0);checks.push('delete workflow arrow');
  await page.getByRole('button',{name:'步骤列表',exact:true}).click();await page.getByRole('button',{name:'流程画布',exact:true}).click();checks.push('shared list topology');
  await page.getByRole('tab',{name:'文档生成',exact:true}).click();await expect(page.getByLabel('文档标题',{exact:true})).toHaveValue('跨标签保留');await page.getByLabel('输出文件类型',{exact:true}).selectOption('pptx');await page.getByLabel('页面版式',{exact:true}).selectOption('custom');await expect(page.getByLabel('PPT 页面设计器',{exact:true}).getByLabel('构图编辑器',{exact:true})).toBeVisible();checks.push('format first PPT integration');
  await page.getByRole('tab',{name:'图片生成',exact:true}).click();await expect(page.getByLabel('图片提示词',{exact:true})).toHaveValue('合成图片');checks.push('drafts survive tabs');
  for(const dark of [false,true])for(const width of [1280,390]){
    await page.setViewportSize({width,height:900});await page.evaluate(d=>document.documentElement.classList.toggle('dark',d),dark);
    for(const name of ['文档生成','长任务','图片生成','智能体仓库','资源仓库','网页设计','图表工具']){
      await page.getByRole('tab',{name,exact:true}).click();await page.waitForTimeout(150);const overflow=await page.evaluate(()=>document.documentElement.scrollWidth>innerWidth+2);expect(overflow,`${name} ${width} ${dark}`).toBe(false);checks.push(`layout ${name} ${width} ${dark}`);
    }
    await page.screenshot({path:`${output}/workbench-${width}-${dark?'dark':'light'}.png`,fullPage:true});
  }
  await page.getByRole('tab',{name:'图片生成',exact:true}).click();await page.screenshot({path:`${output}/image-studio.png`,fullPage:true});
  await page.getByRole('tab',{name:'长任务',exact:true}).click();await page.screenshot({path:`${output}/long-tasks.png`,fullPage:true});
  await page.getByRole('tab',{name:'文档生成',exact:true}).click();await page.screenshot({path:`${output}/pptx-studio.png`,fullPage:true});
  expect(errors).toEqual([]);expect(requests.some(p=>p.includes('/complete'))).toBe(false);
  await writeFile(`${output}/result.json`,JSON.stringify({checks,errors,requests,providerRequests:0},null,2));console.log(JSON.stringify({passed:checks.length,errors}));
}catch(e){await page.screenshot({path:`${output}/failure.png`,fullPage:true});await writeFile(`${output}/error.json`,JSON.stringify({error:String(e),errors,checks},null,2));throw e;}finally{await browser.close();}
