import { describe, expect, it } from 'vitest';
import {
  arrangeWebComponents, createWebComponent, defaultWebComponents, layouts, moveWebComponent,
  normalizeWebComponents, resizeWebComponent, webComponentKinds,
} from '../webDesignerSchema';

describe('visual web layout model', () => {
  it('covers the requested component catalogue with movable, resizable defaults', () => {
    expect(webComponentKinds.map(item => item.id)).toEqual([
      'text', 'image', 'table', 'animation', 'button', 'tabs', 'form', 'navbar', 'panel', 'floating-button', 'link',
    ]);
    expect(defaultWebComponents.every(item => item.width >= 12 && item.height >= 8
      && item.x + item.width <= 100 && item.y + item.height <= 100)).toBe(true);
    expect(createWebComponent('form', 3)).toMatchObject({ kind: 'form', label: '表单', width: 36, height: 25 });
  });

  it('moves and resizes within the canvas while keeping normalized percentages', () => {
    const source = createWebComponent('text', 0);
    const moved = moveWebComponent(source, 200, 132, 1000, 660);
    expect(moved).toMatchObject({ x: 25, y: 30, width: 42, height: 22 });
    const resized = resizeWebComponent(moved, 2000, 2000, 1000, 660);
    expect(resized.width + resized.x).toBe(100);
    expect(resized.height + resized.y).toBe(100);
    const minimum = resizeWebComponent(source, -2000, -2000, 1000, 660);
    expect(minimum).toMatchObject({ width: 12, height: 8 });
  });

  it('preserves component guidance in custom mode and arranges selected presets', () => {
    const source = [{ ...defaultWebComponents[1], description: '保留这段组件说明' }];
    expect(arrangeWebComponents(source, 'custom')).toEqual(source);
    for (const layout of layouts.filter(item => item.id !== 'custom')) {
      const arranged = arrangeWebComponents(Array.from({ length: 16 }, (_, index) => ({ ...source[0], id: `item-${index}` })), layout.id);
      const component = arranged[0];
      expect(component.description).toBe('保留这段组件说明');
      expect(arranged.every(item => item.x + item.width <= 100 && item.y + item.height <= 100)).toBe(true);
    }
  });

  it('loads old designs, preserves empty canvases, and clamps untrusted geometry', () => {
    expect(normalizeWebComponents(undefined)).toHaveLength(defaultWebComponents.length);
    expect(normalizeWebComponents([])).toEqual([]);
    const [component] = normalizeWebComponents([{ ...defaultWebComponents[1], x: 99, y: -10, width: 80, height: 200, background: 'url(unsafe)' }]);
    expect(component.x + component.width).toBe(100);
    expect(component.y).toBe(0);
    expect(component.height).toBe(100);
    expect(component.background).toBe('#ffffff');
  });
});
