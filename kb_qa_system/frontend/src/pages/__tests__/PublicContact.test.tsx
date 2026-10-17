import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { MemoryRouter } from "react-router-dom";
import HelpPage from "@/pages/HelpPage";
import PrivacyPage from "@/pages/PrivacyPage";

beforeEach(() => {
  delete window.__KB_PUBLIC_CONFIG__;
});

afterEach(() => {
  cleanup();
  delete window.__KB_PUBLIC_CONFIG__;
});

describe("deployment public contact", () => {
  it("does not promise an unavailable self-service password reset", () => {
    render(
      <MemoryRouter>
        <HelpPage />
      </MemoryRouter>,
    );

    expect(screen.getByText(/当前没有自助找回或重置密码流程/)).toBeInTheDocument();
    expect(screen.queryByText(/管理员会发送密码设置邮件/)).toBeNull();
  });

  it("hides feedback email links when no valid address is configured", () => {
    window.__KB_PUBLIC_CONFIG__ = { contactEmail: "not-an-email" };
    const { container } = render(
      <MemoryRouter>
        <PrivacyPage />
      </MemoryRouter>,
    );
    expect(container.querySelector('a[href^="mailto:"]')).toBeNull();

    cleanup();
    const help = render(
      <MemoryRouter>
        <HelpPage />
      </MemoryRouter>,
    );
    expect(help.container.querySelector('a[href^="mailto:"]')).toBeNull();
  });

  it("shows only configured deployment details and the feedback mailto", () => {
    window.__KB_PUBLIC_CONFIG__ = {
      contactEmail: "admin@example.com",
      operatorName: "部署运营方",
      processingRegion: "由部署者核实的区域",
    };
    render(
      <MemoryRouter>
        <PrivacyPage />
      </MemoryRouter>,
    );

    expect(screen.getByText("运营主体：部署运营方")).toBeInTheDocument();
    expect(screen.getByText("数据处理区域：由部署者核实的区域")).toBeInTheDocument();
    expect(screen.getByRole("link", { name: "admin@example.com" })).toHaveAttribute(
      "href",
      "mailto:admin@example.com",
    );
  });
});
