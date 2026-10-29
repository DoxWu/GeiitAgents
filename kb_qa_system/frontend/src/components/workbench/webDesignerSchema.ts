export const layouts = [
  { id: 'editorial', label: '杂志纵向', description: '大标题、主视觉与章节内容' },
  { id: 'split', label: '左右分栏', description: '文字与图片并列呈现' },
  { id: 'dashboard', label: '卡片网格', description: '多列内容、数据与行动入口' },
  { id: 'custom', label: '自定义画布', description: '自由放置和调整组件' },
] as const;

export type WebLayoutId = (typeof layouts)[number]['id'];

export const webComponentKinds = [
  { id: 'text', label: '文本', content: '清晰表达页面主题', width: 42, height: 22 },
  { id: 'image', label: '图片', content: '展示主要产品或场景', width: 36, height: 28 },
  { id: 'table', label: '表格', content: '项目 | 说明\n服务一 | 按需定制\n服务二 | 专业支持', width: 55, height: 24 },
  { id: 'animation', label: '动画', content: '滚动进入时轻柔显现', width: 34, height: 14 },
  { id: 'button', label: '按钮', content: '了解更多', width: 22, height: 9 },
  { id: 'tabs', label: '多页签', content: '概览\n方案\n联系', width: 56, height: 12 },
  { id: 'form', label: '表单', content: '姓名\n邮箱\n提交咨询', width: 36, height: 25 },
  { id: 'navbar', label: '导航栏', content: '首页\n服务\n关于\n联系', width: 88, height: 10 },
  { id: 'panel', label: '悬浮窗', content: '需要帮助？欢迎联系我们。', width: 28, height: 16 },
  { id: 'floating-button', label: '悬浮按钮', content: '联系', width: 14, height: 10 },
  { id: 'link', label: '链接', content: '查看服务详情 →', width: 25, height: 9 },
] as const;

export type WebComponentKind = (typeof webComponentKinds)[number]['id'];
export type WebComponentShape = 'rectangle' | 'rounded' | 'pill' | 'circle' | 'outline';

export interface WebDesignComponent {
  id: string;
  kind: WebComponentKind;
  label: string;
  content: string;
  description: string;
  shape: WebComponentShape;
  x: number;
  y: number;
  width: number;
  height: number;
  background: string;
  color: string;
  imageIndex?: number;
}

export interface WebDesignColors {
  primary: string;
  secondary: string;
  background: string;
  text: string;
  surface: string;
  button: string;
}

export const initialColors: WebDesignColors = {
  primary: '#187a72', secondary: '#d59b45', background: '#f4f6f3',
  text: '#202b29', surface: '#ffffff', button: '#c94f39',
};

export const defaultWebComponents: WebDesignComponent[] = [
  { id: 'starter-nav', kind: 'navbar', label: '主导航', content: '首页\n服务\n案例\n联系', description: '顶部品牌导航，简洁清楚，移动端可折叠。', shape: 'outline', x: 4, y: 3, width: 92, height: 10, background: '#ffffff', color: initialColors.primary },
  { id: 'starter-title', kind: 'text', label: '主标题', content: '为你的内容设计一个清晰的入口', description: '页面首屏主标题与简短介绍，突出品牌价值。', shape: 'rectangle', x: 7, y: 21, width: 45, height: 24, background: '#ffffff', color: initialColors.text },
  { id: 'starter-image', kind: 'image', label: '主视觉', content: '展示品牌或产品图片', description: '使用上传的主视觉图片，保持主体完整。', shape: 'rounded', x: 57, y: 20, width: 36, height: 31, background: '#ffffff', color: initialColors.text, imageIndex: 0 },
  { id: 'starter-button', kind: 'button', label: '行动按钮', content: '了解更多', description: '引导访客查看服务或发起咨询。', shape: 'pill', x: 7, y: 51, width: 24, height: 9, background: initialColors.button, color: '#ffffff' },
  { id: 'starter-tabs', kind: 'tabs', label: '内容页签', content: '服务\n案例\n联系', description: '用页签切换服务、案例和联系信息。', shape: 'rounded', x: 7, y: 69, width: 86, height: 13, background: '#ffffff', color: initialColors.primary },
];

const allowedKinds = new Set<string>(webComponentKinds.map(item => item.id));
const allowedShapes = new Set<WebComponentShape>(['rectangle', 'rounded', 'pill', 'circle', 'outline']);
const COLOR = /^#[0-9a-f]{6}$/i;
const clamp = (value: number, min: number, max: number) => Math.min(max, Math.max(min, Number.isFinite(value) ? value : min));

function bounded(component: WebDesignComponent): WebDesignComponent {
  const width = clamp(component.width, 12, 100);
  const height = clamp(component.height, 8, 100);
  return {
    ...component,
    x: clamp(component.x, 0, 100 - width),
    y: clamp(component.y, 0, 100 - height),
    width,
    height,
  };
}

export function normalizeWebComponents(value: unknown): WebDesignComponent[] {
  if (!Array.isArray(value)) return structuredClone(defaultWebComponents);
  if (value.length === 0) return [];
  if (value.length > 16) return structuredClone(defaultWebComponents);
  const components: WebDesignComponent[] = [];
  const ids = new Set<string>();
  for (const raw of value) {
    if (!raw || typeof raw !== 'object') continue;
    const item = raw as Partial<WebDesignComponent>;
    if (typeof item.id !== 'string' || !item.id || item.id.length > 100 || ids.has(item.id)
      || !allowedKinds.has(String(item.kind))) continue;
    const kind = webComponentKinds.find(candidate => candidate.id === item.kind)!;
    const component = bounded({
      id: item.id,
      kind: kind.id,
      label: typeof item.label === 'string' ? item.label.slice(0, 60) : kind.label,
      content: typeof item.content === 'string' ? item.content.slice(0, 2000) : kind.content,
      description: typeof item.description === 'string' ? item.description.slice(0, 800) : '',
      shape: allowedShapes.has(item.shape as WebComponentShape) ? item.shape as WebComponentShape : 'rounded',
      x: Number(item.x) || 0,
      y: Number(item.y) || 0,
      width: Number(item.width) || kind.width,
      height: Number(item.height) || kind.height,
      background: typeof item.background === 'string' && COLOR.test(item.background) ? item.background : initialColors.surface,
      color: typeof item.color === 'string' && COLOR.test(item.color) ? item.color : initialColors.text,
      ...(Number.isInteger(item.imageIndex) && Number(item.imageIndex) >= 0 && Number(item.imageIndex) < 3 ? { imageIndex: item.imageIndex } : {}),
    });
    components.push(component);
    ids.add(component.id);
  }
  return components.length ? components : structuredClone(defaultWebComponents);
}

export function createWebComponent(kind: WebComponentKind, count: number): WebDesignComponent {
  const template = webComponentKinds.find(item => item.id === kind)!;
  const offset = count % 6;
  return bounded({
    id: `component-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`,
    kind,
    label: template.label,
    content: template.content,
    description: '',
    shape: ['button', 'floating-button'].includes(kind) ? 'pill' : 'rounded',
    x: 5 + offset * 4,
    y: 10 + offset * 6,
    width: template.width,
    height: template.height,
    background: ['button', 'floating-button'].includes(kind) ? initialColors.button : initialColors.surface,
    color: ['button', 'floating-button'].includes(kind) ? '#ffffff' : initialColors.text,
    ...(kind === 'image' ? { imageIndex: 0 } : {}),
  });
}

export function moveWebComponent(component: WebDesignComponent, dx: number, dy: number, canvasWidth: number, canvasHeight: number): WebDesignComponent {
  if (canvasWidth <= 0 || canvasHeight <= 0) return component;
  return bounded({ ...component, x: component.x + dx / canvasWidth * 100, y: component.y + dy / canvasHeight * 100 });
}

export function resizeWebComponent(component: WebDesignComponent, dx: number, dy: number, canvasWidth: number, canvasHeight: number): WebDesignComponent {
  if (canvasWidth <= 0 || canvasHeight <= 0) return component;
  return bounded({ ...component, width: component.width + dx / canvasWidth * 100, height: component.height + dy / canvasHeight * 100 });
}

export function arrangeWebComponents(components: WebDesignComponent[], layout: WebLayoutId): WebDesignComponent[] {
  if (layout === 'custom') return components;
  return components.map((component, index) => {
    const arranged = layout === 'split'
      ? component.kind === 'navbar' ? { ...component, x: 4, y: 3, width: 92, height: 10 }
        : component.kind === 'image' ? { ...component, x: 54, y: 22, width: 40, height: 42 }
          : component.kind === 'text' ? { ...component, x: 6, y: 23, width: 43, height: 27 }
            : { ...component, x: 8 + index % 3 * 29, y: 67 + Math.floor(index / 3) * 15, width: 25, height: 10 }
      : layout === 'dashboard'
        ? component.kind === 'navbar' ? { ...component, x: 4, y: 3, width: 92, height: 10 }
          : { ...component, x: 5 + index % 2 * 47, y: 18 + Math.floor(index / 2) * 19, width: 43, height: 16 }
        : component.kind === 'navbar' ? { ...component, x: 4, y: 3, width: 92, height: 10 }
          : { ...component, x: 7, y: Math.min(86, 18 + index * 16), width: 86, height: component.kind === 'image' ? 22 : 13 };
    return bounded(arranged);
  });
}

export function shapeRadius(shape: WebComponentShape): string {
  return { rectangle: '0', rounded: '12px', pill: '999px', circle: '50%', outline: '8px' }[shape];
}
