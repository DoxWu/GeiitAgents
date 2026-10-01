import { fireEvent, render, screen } from '@testing-library/react';
import { expect, it, vi } from 'vitest';
import { DocxStyleSelect } from '../DocxStyleSelect';

it('offers named local DOCX presets and reports the selected style', () => {
  const onChange = vi.fn();
  render(<DocxStyleSelect value="standard" onChange={onChange} />);
  const select = screen.getByRole('combobox', { name: 'Word 样式' });
  expect(select).toHaveDisplayValue('经典 · Letter');
  expect(screen.getByRole('option', { name: '商务报告 · A4' })).toBeInTheDocument();
  expect(screen.getByRole('option', { name: '会议纪要 · A4' })).toBeInTheDocument();
  fireEvent.change(select, { target: { value: 'business' } });
  expect(onChange).toHaveBeenCalledWith('business');
});
