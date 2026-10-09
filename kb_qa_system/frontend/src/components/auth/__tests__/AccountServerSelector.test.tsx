import { afterEach, expect, it } from 'vitest';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { AuthLayout } from '../AuthLayout';
import { getAccountServer, setAccountServer } from '@/services/accountServer';

afterEach(cleanup);
it('offers a public workbench exit and shows the applied credential destination', () => {
  setAccountServer('https://api.geiit.online');
  render(<MemoryRouter><AuthLayout title="登录"><div>表单</div></AuthLayout></MemoryRouter>);
  expect(screen.getByRole('link', { name: '关闭登录并返回工作台' })).toHaveAttribute('href', '/workbench');
  expect(screen.getByText('https://api.geiit.online/api/v1')).toBeInTheDocument();
  fireEvent.change(screen.getByLabelText('账号服务器地址'), { target: { value: 'https://org.example' } });
  expect(getAccountServer()).toBe('https://api.geiit.online/api/v1');
  fireEvent.click(screen.getByText('使用此地址'));
  expect(screen.getByText('https://org.example/api/v1')).toBeInTheDocument();
  fireEvent.change(screen.getByLabelText('账号服务器地址'), { target: { value: 'http://org.example' } });
  fireEvent.click(screen.getByText('使用此地址'));
  expect(screen.getByRole('alert')).toHaveTextContent('HTTPS');
  expect(getAccountServer()).toBe('https://org.example/api/v1');
});
