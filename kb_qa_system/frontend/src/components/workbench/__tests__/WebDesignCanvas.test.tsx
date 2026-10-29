import { useState } from 'react';
import { fireEvent, render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import type { WebDesignComponent } from '../webDesignerSchema';
import { createWebComponent } from '../webDesignerSchema';
import { WebDesignCanvas } from '../WebDesignCanvas';

function Harness() {
  const [components, setComponents] = useState<WebDesignComponent[]>([createWebComponent('text', 0)]);
  const [selectedId, setSelectedId] = useState(components[0].id);
  return <><WebDesignCanvas components={components} images={[]} selectedId={selectedId} onSelect={setSelectedId} onChange={setComponents} /><output data-testid="geometry">{JSON.stringify(components[0])}</output></>;
}

describe('WebDesignCanvas', () => {
  it('moves a component by its drag handle and resizes it from the corner', () => {
    render(<Harness />);
    const canvas = screen.getByRole('region', { name: '自由排版画布' });
    vi.spyOn(canvas, 'getBoundingClientRect').mockReturnValue({
      x: 0, y: 0, left: 0, top: 0, right: 1000, bottom: 660, width: 1000, height: 660, toJSON: () => ({}),
    });
    const geometry = () => JSON.parse(screen.getByTestId('geometry').textContent || '{}') as WebDesignComponent;

    fireEvent.pointerDown(screen.getByRole('button', { name: '拖动文本' }), { pointerId: 1, clientX: 100, clientY: 100 });
    fireEvent.pointerMove(window, { pointerId: 1, clientX: 200, clientY: 166 });
    fireEvent.pointerUp(window, { pointerId: 1 });
    expect(geometry()).toMatchObject({ x: 15, y: 20 });

    fireEvent.pointerDown(screen.getByRole('button', { name: '调整文本大小' }), { pointerId: 1, clientX: 100, clientY: 100 });
    fireEvent.pointerMove(window, { pointerId: 1, clientX: 200, clientY: 166 });
    fireEvent.pointerUp(window, { pointerId: 1 });
    expect(geometry()).toMatchObject({ width: 52, height: 32 });
  });
});
