import { describe, expect, it } from "vitest";
import { markdownToHtml } from "./html";

describe("markdownToHtml", () => {
  it("exports common Markdown as a standalone safe document", () => {
    const result = markdownToHtml('# 标题\n\n**正文**\n\n| A | B |\n| - | - |\n| 1 | 2 |', "报告");
    expect(result.html).toContain('<title>报告</title>');
    expect(result.html).toContain('<h1>标题</h1>');
    expect(result.html).toContain('<strong>正文</strong>');
    expect(result.html).toContain('<table>');
  });

  it("escapes HTML and keeps links/images as inert text", () => {
    const result = markdownToHtml('<script>alert(1)</script>\n\n[外链](https://outside.example) ![图](https://outside.example/a.png)', "安全");
    expect(result.html).not.toContain("<script>");
    expect(result.html).not.toContain('<a ');
    expect(result.html).not.toContain('<img ');
    expect(result.html).toContain("outside.example");
    expect(result.warnings).toHaveLength(3);
  });

  it("rejects oversized or control-character input", () => {
    expect(() => markdownToHtml("\0", "x")).toThrow();
    expect(() => markdownToHtml("x".repeat(200_001), "x")).toThrow();
  });
});
