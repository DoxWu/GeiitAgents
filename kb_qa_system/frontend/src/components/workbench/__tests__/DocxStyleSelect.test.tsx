import { fireEvent, render, screen } from '@testing-library/react';
import { expect, it, vi } from 'vitest';
import { DocxStyleSelect } from '../DocxStyleSelect';

it('offers named local DOCX presets and reports the selected style', () => {
  const onChange = vi.fn();
  const onFormatChange = vi.fn();
  render(<DocxStyleSelect value="standard" onChange={onChange} format={{}} onFormatChange={onFormatChange} />);
  const select = screen.getByRole('combobox', { name: 'Word 样式' });
  expect(select).toHaveDisplayValue('经典 · Letter');
  expect(screen.getByRole('option', { name: '商务报告 · A4' })).toBeInTheDocument();
  expect(screen.getByRole('option', { name: '会议纪要 · A4' })).toBeInTheDocument();
  fireEvent.change(select, { target: { value: 'business' } });
  expect(onChange).toHaveBeenCalledWith('business');
  fireEvent.change(screen.getByRole('combobox', { name: 'Word 纸张' }), { target: { value: 'A4' } });
  expect(onFormatChange).toHaveBeenCalledWith({ paperSize: 'A4' });
  fireEvent.change(screen.getByRole('combobox', { name: 'Word 字号' }), { target: { value: '14' } });
  expect(onFormatChange).toHaveBeenLastCalledWith({ fontSize: 14 });
  fireEvent.click(screen.getByRole('checkbox', { name: 'Word 自动目录' }));
  expect(onFormatChange).toHaveBeenLastCalledWith({ tableOfContents: true });
  fireEvent.change(screen.getByRole('textbox', { name: 'Word 页眉文字' }), { target: { value: '工作报告' } });
  expect(onFormatChange).toHaveBeenLastCalledWith({ headerText: '工作报告' });
});
