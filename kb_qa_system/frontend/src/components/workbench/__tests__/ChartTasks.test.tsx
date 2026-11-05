import { beforeEach, afterEach, expect, it, vi } from 'vitest';
import JSZip from 'jszip';
import { cleanup, fireEvent, render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import type { TaskRun } from '@/types/workbench';
import { checkChart } from '@/officeTasks/chart';
import { ChartTasks } from '../ChartTasks';

const { state, getState } = vi.hoisted(() => {
  const value = { taskRuns: [] as TaskRun[], artifacts: [] as { id: string; taskId: string; kind: string; content: string; name: string; sha256?: string }[], toolRuns: [], profiles: [] as { id: string; name: string; mode: 'local' | 'relay'; capabilities?: { vision?: { state: string } } }[], startChartTask: vi.fn(), reviewChartImage: vi.fn(), extractChartImage: vi.fn(), storageError: null as string | null, unlocked: true };
  return { state: value, getState: () => value };
});
vi.mock('@/store/workbenchStore', () => { const hook = () => state; Object.assign(hook, { getState }); return { useWorkbenchStore: hook }; });
vi.mock('@/hooks/useWorkbenchFence', () => ({ useWorkbenchFence: () => () => () => state.unlocked }));
vi.mock('@/officeTasks/chartImage', () => ({ chartSvgToPng: vi.fn(async () => ({ name: 'chart.png', mimeType: 'image/png', dataUrl: 'data:image/png;base64,iVBORw0KGgo=', bytes: 8 })) }));
beforeEach(() => { state.unlocked = true; state.taskRuns = []; state.artifacts = []; state.profiles = []; state.startChartTask.mockReset().mockResolvedValue('chart:fixture'); state.reviewChartImage.mockReset().mockResolvedValue(undefined); state.extractChartImage.mockReset(); vi.spyOn(URL, 'createObjectURL').mockReturnValue('blob:fixture'); vi.spyOn(URL, 'revokeObjectURL').mockImplementation(() => {}); });
afterEach(() => { cleanup(); vi.restoreAllMocks(); });

it('previews every selected series and clears approval when selection changes', async () => {
  const user = userEvent.setup(); render(<ChartTasks />);
  fireEvent.change(screen.getByLabelText('CSV 数据'), { target: { value: '月份,收入,成本\n一月,20,5\n二月,30,8' } });
  await user.click(screen.getByRole('checkbox', { name: '数值列：成本' }));
  await user.click(screen.getByRole('button', { name: '检查并预览' }));
  expect(screen.getByText(/2 个系列/)).toBeInTheDocument();
  await user.click(screen.getByText('查看完整数值'));
  const table = within(screen.getByRole('table', { name: '图表完整数据' }));
  expect(table.getByRole('columnheader', { name: '收入（元）' })).toBeInTheDocument();
  expect(table.getByRole('cell', { name: '8' })).toBeInTheDocument();
  await user.click(screen.getByRole('button', { name: '保存图表任务' }));
  expect(state.startChartTask).toHaveBeenCalledWith(expect.objectContaining({ valueColumn: 1, valueColumns: [1, 2] }), expect.any(String));
  await user.click(screen.getByRole('button', { name: '检查并预览' }));
  await user.click(screen.getByRole('checkbox', { name: '数值列：成本' }));
  expect(screen.getByRole('button', { name: '保存图表任务' })).toBeDisabled();
  expect(screen.queryByRole('img')).not.toBeInTheDocument();
});
it('selects and saves a single-series pie chart', async () => {
  const user = userEvent.setup(); render(<ChartTasks />);
  fireEvent.change(screen.getByLabelText('CSV 数据'), { target: { value: 'Category,Share\nA,3\nB,1' } });
  await user.selectOptions(screen.getByLabelText('图表类型'), 'pie');
  await user.click(screen.getByRole('button', { name: '检查并预览' }));
  expect(screen.getByRole('img')).toBeInTheDocument();
  await user.click(screen.getByRole('button', { name: '保存图表任务' }));
  expect(state.startChartTask).toHaveBeenCalledWith(expect.objectContaining({ chartType: 'pie', valueColumns: [1] }), expect.any(String));
});
it('selects and saves a horizontal bar chart without limiting multiple series', async () => {
  const user = userEvent.setup(); render(<ChartTasks />);
  fireEvent.change(screen.getByLabelText('CSV 数据'), { target: { value: '月份,收入,成本\n一月,20,5\n二月,30,8' } });
  await user.click(screen.getByRole('checkbox', { name: '数值列：成本' }));
  await user.selectOptions(screen.getByLabelText('图表类型'), 'horizontal_bar');
  await user.click(screen.getByRole('button', { name: '检查并预览' }));
  expect(screen.getByRole('img')).toBeInTheDocument();
  await user.click(screen.getByRole('button', { name: '保存图表任务' }));
  expect(state.startChartTask).toHaveBeenCalledWith(expect.objectContaining({ chartType: 'horizontal_bar', valueColumns: [1, 2] }), expect.any(String));
});
it('selects a numeric X column and saves a scatter chart', async () => {
  const user = userEvent.setup(); render(<ChartTasks />);
  fireEvent.change(screen.getByLabelText('CSV 数据'), { target: { value: '时间,温度\n1,20\n2,22' } });
  await user.selectOptions(screen.getByLabelText('图表类型'), 'scatter');
  expect(screen.getByLabelText('X 轴数值列')).toBeInTheDocument();
  await user.click(screen.getByRole('button', { name: '检查并预览' }));
  expect(screen.getByRole('img')).toBeInTheDocument();
  await user.click(screen.getByRole('button', { name: '保存图表任务' }));
  expect(state.startChartTask).toHaveBeenCalledWith(expect.objectContaining({ chartType: 'scatter', categoryColumn: 0, valueColumn: 1 }), expect.any(String));
});

it('removes a newly selected category from numeric series and rejects an empty selection', async () => {
  const user = userEvent.setup(); render(<ChartTasks />);
  fireEvent.change(screen.getByLabelText('CSV 数据'), { target: { value: '分类,值1,值2\na,2,3' } });
  await user.click(screen.getByRole('checkbox', { name: '数值列：值2' }));
  await user.selectOptions(screen.getByLabelText('分类列'), '1');
  expect(screen.getByRole('checkbox', { name: '数值列：值1' })).not.toBeChecked();
  expect(screen.getByRole('checkbox', { name: '数值列：值1' })).toBeDisabled();
  await user.click(screen.getByRole('checkbox', { name: '数值列：值2' }));
  await user.click(screen.getByRole('button', { name: '检查并预览' }));
  expect(screen.getByRole('alert')).toHaveTextContent('1–6');
  expect(state.startChartTask).not.toHaveBeenCalled();
});
it('restores legacy input after a multi-series draft without inheriting its selection', async () => {
  state.taskRuns = [{ id: 'legacy', type: 'chart.generate', title: '旧任务', status: 'succeeded', profileId: '', instruction: '', createdAt: '', updatedAt: '', toolRunIds: [], artifactIds: [], chartInput: { title: '旧任务', csv: '分类,数值\na,2', categoryColumn: 0, valueColumn: 1, chartType: 'bar', unit: '' } }];
  const user = userEvent.setup(); render(<ChartTasks />);
  fireEvent.change(screen.getByLabelText('CSV 数据'), { target: { value: '分类,数值,额外\na,2,3' } });
  await user.click(screen.getByRole('checkbox', { name: '数值列：额外' }));
  await user.click(screen.getByRole('button', { name: '复用图表输入' }));
  expect(screen.getAllByRole('checkbox').filter(input => (input as HTMLInputElement).checked)).toHaveLength(1);
  expect(screen.getByRole('checkbox', { name: '数值列：数值' })).toBeChecked();
  await user.click(screen.getByRole('button', { name: '检查并预览' }));
  expect(screen.queryByRole('alert')).not.toBeInTheDocument();
});

it('imports a bounded XLSX sheet into the chart editor without replacing other form fields', async () => {
  const zip = new JSZip();
  zip.file('xl/workbook.xml', '<workbook xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"><sheets><sheet name="季度数据" sheetId="1" r:id="rId1"/></sheets></workbook>');
  zip.file('xl/_rels/workbook.xml.rels', '<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="worksheets/sheet1.xml"/></Relationships>');
  zip.file('xl/worksheets/sheet1.xml', '<worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"><sheetData><row r="1"><c r="A1" t="inlineStr"><is><t>月份</t></is></c><c r="B1" t="inlineStr"><is><t>销售额</t></is></c></row><row r="2"><c r="A2" t="inlineStr"><is><t>一月</t></is></c><c r="B2"><v>12</v></c></row></sheetData></worksheet>');
  const bytes = await zip.generateAsync({ type: 'uint8array' });
  const file = new File([bytes], 'sales.xlsx');
  const user = userEvent.setup(); render(<ChartTasks />);
  await user.upload(screen.getByLabelText('选择图表 CSV 或 XLSX 文件'), file);
  expect(await screen.findByRole('status')).toHaveTextContent('工作表：季度数据');
  expect(screen.getByLabelText('CSV 数据')).toHaveValue('月份,销售额\n一月,12');
  expect(screen.getByLabelText('图表标题')).toHaveValue('季度销售额');
});

it('downloads the saved chart input as an XLSX workbook', async () => {
  state.taskRuns = [{ id: 'saved-chart', type: 'chart.generate', title: '销售', status: 'succeeded', profileId: '', instruction: '', createdAt: '', updatedAt: '', toolRunIds: [], artifactIds: ['svg-1'], chartInput: { title: '销售', csv: '分类,数值\n甲,2', categoryColumn: 0, valueColumn: 1, chartType: 'bar', unit: '元' } }];
  state.artifacts = [{ id: 'svg-1', taskId: 'saved-chart', kind: 'svg', content: '<svg/>', name: '销售.svg', sha256: 'fixture' }];
  const click = vi.spyOn(HTMLAnchorElement.prototype, 'click').mockImplementation(() => {}), user = userEvent.setup(); render(<ChartTasks />);
  await user.click(screen.getByRole('button', { name: '下载 XLSX 数据' }));
  await screen.findByRole('button', { name: '下载 XLSX 数据' });
  expect(click).toHaveBeenCalled();
  expect(URL.createObjectURL).toHaveBeenCalledWith(expect.objectContaining({ type: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet' }));
});

it('requests an explicitly chosen local model to review the generated chart image', async () => {
  state.profiles = [{ id: 'local', name: '本地视觉模型', mode: 'local', capabilities: { vision: { state: 'supported' } } }];
  state.taskRuns = [{ id: 'chart-task', type: 'chart.generate', title: '销售', status: 'succeeded', profileId: '', instruction: '', createdAt: '', updatedAt: '', toolRunIds: [], artifactIds: ['svg-1'], chartInput: { title: '销售', csv: '分类,数值\n甲,2', categoryColumn: 0, valueColumn: 1, chartType: 'bar', unit: '件' } }];
  state.artifacts = [{ id: 'svg-1', taskId: 'chart-task', kind: 'svg', content: '<svg xmlns="http://www.w3.org/2000/svg" width="800" height="644"></svg>', name: '销售.svg', sha256: 'a'.repeat(64) }];
  const user = userEvent.setup(); render(<ChartTasks />);
  await user.click(await screen.findByRole('button', { name: '请求视觉审阅' }));
  await screen.findByRole('status');
  expect(state.reviewChartImage).toHaveBeenCalledWith('chart-task', 'svg-1', 'local', expect.objectContaining({ mimeType: 'image/png' }), false, expect.any(AbortSignal));
});

it('requires fresh cloud consent for each chart image review', async () => {
  state.profiles = [{ id: 'relay', name: '云端视觉模型', mode: 'relay' }];
  state.taskRuns = [{ id: 'chart-task', type: 'chart.generate', title: '销售', status: 'succeeded', profileId: '', instruction: '', createdAt: '', updatedAt: '', toolRunIds: [], artifactIds: ['svg-1'], chartInput: { title: '销售', csv: '分类,数值\n甲,2', categoryColumn: 0, valueColumn: 1, chartType: 'bar', unit: '件' } }];
  state.artifacts = [{ id: 'svg-1', taskId: 'chart-task', kind: 'svg', content: '<svg xmlns="http://www.w3.org/2000/svg" width="800" height="644"></svg>', name: '销售.svg', sha256: 'a'.repeat(64) }];
  const user = userEvent.setup(); render(<ChartTasks />);
  const button = await screen.findByRole('button', { name: '请求视觉审阅' });
  expect(button).toBeDisabled();
  await user.click(screen.getByLabelText(/我允许本次将此图表图片/));
  expect(button).toBeEnabled();
  await user.click(button); await screen.findByRole('status');
  expect(state.reviewChartImage).toHaveBeenCalledWith('chart-task', 'svg-1', 'relay', expect.anything(), true, expect.any(AbortSignal));
});

const imageFile = (name = 'chart.png') => new File([new Uint8Array([137, 80, 78, 71, 13, 10, 26, 10])], name, { type: 'image/png' });
const imageChart = { title: '图片中的销售', csv: '月份,销售额\n一月,25\n二月,40', categoryColumn: 0, valueColumn: 1, chartType: 'line' as const, unit: '万元' };
it('requires cloud consent, loads an editable image draft and saves only after user review', async () => {
  state.profiles = [{ id: 'vision', name: '图片模型', mode: 'relay' }];
  state.extractChartImage.mockResolvedValue({ input: checkChart(imageChart).input, notes: ['部分数值为估读。'] });
  const user = userEvent.setup(); render(<ChartTasks />);
  await user.click(screen.getByText('从图表图片生成'));
  await user.upload(screen.getByLabelText('选择图表图片文件'), imageFile());
  const button = screen.getByRole('button', { name: '识别并生成图表草稿' });
  expect(button).toBeDisabled();
  await user.type(screen.getByLabelText('补充要求（可选）'), '改成折线图');
  await user.click(screen.getByLabelText(/我允许本次将上传的图表图片/));
  await user.click(button);
  expect(await screen.findByRole('status')).toHaveTextContent('估读');
  expect(state.extractChartImage).toHaveBeenCalledWith('vision', expect.objectContaining({ dataUrl: 'data:image/png;base64,iVBORw0KGgo=' }), '改成折线图', true, expect.any(AbortSignal));
  expect(screen.getByLabelText('图表标题')).toHaveValue(imageChart.title);
  expect(screen.getByLabelText('CSV 数据')).toHaveValue(imageChart.csv);
  expect(screen.getByRole('img', { name: /预览/ })).toBeInTheDocument();
  expect(state.startChartTask).not.toHaveBeenCalled();
  expect(button).toBeDisabled();
  await user.click(screen.getByRole('button', { name: '保存图表任务' }));
  expect(state.startChartTask).toHaveBeenCalledWith(expect.objectContaining(imageChart), expect.any(String));
});
it('cancels image recognition and ignores a late response after replacing the source image', async () => {
  state.profiles = [{ id: 'vision', name: '本机图片模型', mode: 'local' }];
  let resolve!: (value: unknown) => void;
  state.extractChartImage.mockImplementation(() => new Promise(done => { resolve = done; }));
  const user = userEvent.setup(); render(<ChartTasks />);
  await user.click(screen.getByText('从图表图片生成'));
  await user.upload(screen.getByLabelText('选择图表图片文件'), imageFile());
  await user.click(screen.getByRole('button', { name: '识别并生成图表草稿' }));
  expect(screen.getByLabelText('CSV 数据')).toBeDisabled();
  await user.upload(screen.getByLabelText('选择图表图片文件'), imageFile('replacement.png'));
  expect(state.extractChartImage.mock.calls[0][4].aborted).toBe(true);
  resolve({ input: imageChart, notes: [] });
  await screen.findByRole('button', { name: '识别并生成图表草稿' });
  expect(screen.getByLabelText('图表标题')).toHaveValue('季度销售额');
  expect(state.startChartTask).not.toHaveBeenCalled();
});
