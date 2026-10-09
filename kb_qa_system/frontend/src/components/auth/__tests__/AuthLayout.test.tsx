/**
 * AuthLayout 组件单元测试
 *
 * 覆盖范围：
 *   - 渲染品牌标题"GeiIt 工作台"
 *   - 渲染传入的 title 和 subtitle
 *   - 渲染子内容
 *   - 渲染 footer 区域
 *   - 无 subtitle 时不渲染副标题
 *   - 无 footer 时不渲染底部区域
 */

import { describe, it, expect } from "vitest";
import { render, screen } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import { AuthLayout } from "../AuthLayout";

/**
 * 渲染 AuthLayout 并注入 Router 上下文
 *
 * 作用：AuthLayout 使用 <Link to="/privacy"> 组件，需要 Router 上下文才能渲染。
 */
const renderWithRouter = (ui: React.ReactElement) =>
  render(ui, { wrapper: MemoryRouter });

describe("AuthLayout 组件", () => {
  it("渲染品牌标题", () => {
    renderWithRouter(
      <AuthLayout title="登录">
        <div>表单内容</div>
      </AuthLayout>,
    );
    expect(screen.getByRole("heading", { name: "GeiIt 工作台" })).toBeInTheDocument();
  });

  it("渲染传入的 title", () => {
    renderWithRouter(
      <AuthLayout title="设置密码">
        <div>表单内容</div>
      </AuthLayout>,
    );
    expect(screen.getByRole("heading", { name: "设置密码" })).toBeInTheDocument();
  });

  it("渲染 subtitle 副标题", () => {
    renderWithRouter(
      <AuthLayout title="登录" subtitle="欢迎回来">
        <div>表单内容</div>
      </AuthLayout>,
    );
    expect(screen.getByText("欢迎回来")).toBeInTheDocument();
  });

  it("无 subtitle 时不渲染副标题", () => {
    renderWithRouter(
      <AuthLayout title="登录">
        <div>表单内容</div>
      </AuthLayout>,
    );
    expect(screen.queryByText("欢迎回来")).not.toBeInTheDocument();
  });

  it("渲染子内容", () => {
    renderWithRouter(
      <AuthLayout title="登录">
        <div data-testid="child">表单内容</div>
      </AuthLayout>,
    );
    expect(screen.getByTestId("child")).toBeInTheDocument();
  });

  it("渲染 footer 底部区域", () => {
    renderWithRouter(
      <AuthLayout title="登录" footer={<a href="/register">注册申请</a>}>
        <div>表单内容</div>
      </AuthLayout>,
    );
    expect(screen.getByText("注册申请")).toBeInTheDocument();
  });

  it("无 footer 时不渲染底部区域", () => {
    const { container } = renderWithRouter(
      <AuthLayout title="登录">
        <div>表单内容</div>
      </AuthLayout>,
    );
    // footer 渲染在 mt-4 text-center 的 div 中，无 footer 时不渲染该 div
    const footerDiv = container.querySelector(".mt-4.text-center");
    expect(footerDiv).toBeNull();
  });
});
