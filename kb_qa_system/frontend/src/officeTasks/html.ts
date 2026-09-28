import { unified } from "unified";
import remarkGfm from "remark-gfm";
import remarkParse from "remark-parse";
import type { Root, RootContent, PhrasingContent, List, ListItem, Table } from "mdast";

export const HTML_CONVERTER_VERSION = "markdown-html/1";

export interface HtmlResult {
  html: string;
  warnings: string[];
  converterVersion: string;
}

function escape(value: string) {
  return value.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;").replace(/'/g, "&#39;");
}

function safeText(value: string) {
  return escape(Array.from(value).filter(char => {
    const code = char.charCodeAt(0);
    return code >= 32 || code === 9 || code === 10 || code === 13;
  }).join(""));
}

export function markdownToHtml(content: string, title: string): HtmlResult {
  if (!content.trim() || content.length > 200_000 || Array.from(content).some(char => char.charCodeAt(0) < 32 && !"\t\n\r".includes(char))) {
    throw new Error("HTML 导出支持最多 200000 字符的有效 Markdown 文本。");
  }
  const root = unified().use(remarkParse).use(remarkGfm).parse(content) as Root;
  let count = 0;
  function check(node: { children?: unknown[] }, depth = 0) {
    if (++count > 15_000 || depth > 32) throw new Error("文档结构过于复杂，请分段导出。");
    node.children?.forEach(child => check(child as typeof node, depth + 1));
  }
  check(root);
  const warnings = new Set<string>();
  const definitions = new Map(root.children.filter(node => node.type === "definition").map(node => [node.identifier.toLowerCase(), node.url]));

  function inline(nodes: PhrasingContent[]): string {
    return nodes.map(node => {
      switch (node.type) {
        case "text": return safeText(node.value);
        case "strong": return `<strong>${inline(node.children)}</strong>`;
        case "emphasis": return `<em>${inline(node.children)}</em>`;
        case "delete": return `<del>${inline(node.children)}</del>`;
        case "inlineCode": return `<code>${safeText(node.value)}</code>`;
        case "break": return "<br>";
        case "link": warnings.add("链接保留为文字和地址，不创建可点击链接。"); return `${inline(node.children)} <span class="plain-url">(${safeText(node.url)})</span>`;
        case "linkReference": warnings.add("链接保留为文字和地址，不创建可点击链接。"); return `${inline(node.children)} <span class="plain-url">(${safeText(definitions.get(node.identifier.toLowerCase()) ?? node.identifier)})</span>`;
        case "image": warnings.add("图片保留为说明和地址，未下载或嵌入图片。"); return `<span class="omitted-media">[图片：${safeText(node.alt ?? "")}] (${safeText(node.url)})</span>`;
        case "imageReference": warnings.add("图片保留为说明和地址，未下载或嵌入图片。"); return `<span class="omitted-media">[图片：${safeText(node.alt ?? "")}] (${safeText(definitions.get(node.identifier.toLowerCase()) ?? node.identifier)})</span>`;
        case "html": warnings.add("HTML 以原始文字保留，不执行或渲染。"); return `<code class="raw-html">${safeText(node.value)}</code>`;
        case "footnoteReference": warnings.add("脚注以编号和正文段落保留。"); return `<sup>[${safeText(node.identifier)}]</sup>`;
        default: return safeText((node as { value?: string }).value ?? "");
      }
    }).join("");
  }

  function list(node: List): string {
    const tag = node.ordered ? "ol" : "ul";
    const start = node.ordered && node.start && node.start !== 1 ? ` start="${node.start}"` : "";
    return `<${tag}${start}>${node.children.map((item: ListItem) => `<li>${item.checked == null ? "" : `<span class="checkbox">${item.checked ? "☑" : "☐"}</span>`}${blocks(item.children)}</li>`).join("")}</${tag}>`;
  }

  function table(node: Table): string {
    const rows = node.children.map((row, rowIndex) => `<tr>${row.children.map((cell, column) => {
      const tag = rowIndex === 0 ? "th" : "td";
      const align = node.align?.[column];
      return `<${tag}${align ? ` style="text-align:${align}"` : ""}>${inline(cell.children)}</${tag}>`;
    }).join("")}</tr>`).join("");
    return `<table>${rows}</table>`;
  }

  function blocks(nodes: RootContent[]): string {
    return nodes.map(node => {
      switch (node.type) {
        case "paragraph": return `<p>${inline(node.children)}</p>`;
        case "heading": return `<h${node.depth}>${inline(node.children)}</h${node.depth}>`;
        case "list": return list(node);
        case "blockquote": return `<blockquote>${blocks(node.children)}</blockquote>`;
        case "code": return `<pre><code class="language-${safeText(node.lang ?? "text")}">${safeText(node.value)}</code></pre>`;
        case "thematicBreak": return "<hr>";
        case "html": warnings.add("HTML 以原始文字保留，不执行或渲染。"); return `<pre class="raw-html">${safeText(node.value)}</pre>`;
        case "definition": return "";
        case "footnoteDefinition": warnings.add("脚注以编号和正文段落保留。"); return `<aside><strong>[${safeText(node.identifier)}]</strong>${blocks(node.children)}</aside>`;
        case "table": return table(node);
        default: return "";
      }
    }).join("\n");
  }

  const documentTitle = title.trim() || "文档成果";
  const html = `<!doctype html>\n<html lang="zh-CN"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${safeText(documentTitle)}</title><style>body{font-family:system-ui,-apple-system,"Microsoft YaHei",sans-serif;line-height:1.7;max-width:920px;margin:2rem auto;padding:0 1rem;color:#202124}h1,h2,h3,h4,h5,h6{line-height:1.3;margin-top:1.5em}pre{background:#f4f4f5;padding:1rem;overflow:auto}code{font-family:ui-monospace,SFMono-Regular,Consolas,monospace}table{border-collapse:collapse;width:100%;margin:1rem 0}th,td{border:1px solid #c9cdd3;padding:.45rem .6rem;vertical-align:top}th{background:#f1f3f5}.plain-url,.omitted-media{color:#5f6368}.raw-html{white-space:pre-wrap}.checkbox{margin-right:.35rem}blockquote{border-left:4px solid #c9cdd3;padding-left:1rem;color:#5f6368}</style></head><body>${blocks(root.children)}</body></html>`;
  return { html, warnings: [...warnings], converterVersion: HTML_CONVERTER_VERSION };
}
