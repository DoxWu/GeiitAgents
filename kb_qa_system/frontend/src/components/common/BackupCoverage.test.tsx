import { render, screen } from '@testing-library/react';
import { expect, it } from 'vitest';
import { BackupCoverage } from './BackupCoverage';

it('compares client backups, server snapshots and the offline joint bundle', () => {
  render(<BackupCoverage />);
  screen.getByText('比较备份范围').click();
  expect(screen.getByRole('row', { name: /工作台加密包/ })).toBeInTheDocument();
  expect(screen.getByRole('row', { name: /本地知识库加密包/ })).toBeInTheDocument();
  expect(screen.getByRole('row', { name: /服务器数据库快照/ })).toBeInTheDocument();
  expect(screen.getByRole('row', { name: /服务器离线联合包/ })).toHaveTextContent('上传目录内原件及派生文件');
  expect(screen.getByText(/不会生成联合包/)).toBeInTheDocument();
});
