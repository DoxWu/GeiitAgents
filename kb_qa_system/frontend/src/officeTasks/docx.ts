import { AlignmentType, BorderStyle, Document, Footer, HeadingLevel, Header, LevelFormat, PageNumber, Packer, Paragraph, Table, TableCell, TableLayoutType, TableOfContents, TableRow, TextRun, WidthType, type IRunOptions } from 'docx';
import { unified } from 'unified';
import remarkParse from 'remark-parse';
import remarkGfm from 'remark-gfm';
import type { Root, RootContent, PhrasingContent, List, ListItem } from 'mdast';
import { isDocxStyle, validateDocxFormat, type DocxFormatOptions, type DocxStyle } from './docxStyles';

export const DOCX_CONVERTER_VERSION = 'markdown-docx/5';
export const DOCX_MIME = 'application/vnd.openxmlformats-officedocument.wordprocessingml.document';
export interface DocxResult { bytes: ArrayBuffer; warnings: string[]; converterVersion: string }

// Runs only in the on-demand export Worker. No network, HTML, external relationships or image fetching.
export async function markdownToDocx(content: string, title: string, style: DocxStyle = 'standard', format: DocxFormatOptions = {}): Promise<DocxResult> {
  if (!isDocxStyle(style)) throw new Error('请选择受支持的 DOCX 样式。');
  const options = validateDocxFormat(format);
  const theme = style === 'business' ? { accent: '1F4E79', paper: { width: 11906, height: 16838, margin: { top: 1417, right: 1276, bottom: 1417, left: 1276 } } }
    : style === 'meeting' ? { accent: '0F6B78', paper: { width: 11906, height: 16838, margin: { top: 1440, right: 1440, bottom: 1440, left: 1440 } } }
      : { accent: '000000', paper: { width: 12240, height: 15840, margin: { top: 1440, right: 1440, bottom: 1440, left: 1440 } } };
  const page = options.paperSize === 'A4' ? { width: 11906, height: 16838 } : options.paperSize === 'Letter' ? { width: 12240, height: 15840 } : theme.paper;
  const margin = options.marginInches === undefined ? theme.paper.margin : Object.fromEntries(['top', 'right', 'bottom', 'left'].map(side => [side, Math.round(options.marginInches! * 1440)]));
  const contentWidth = page.width - margin.left - margin.right;
  if (!content.trim() || content.length > 200_000 || Array.from(content).some(char => char.charCodeAt(0) < 32 && !'\t\n\r'.includes(char))) throw new Error('DOCX 导出支持最多 200000 字符的有效 Markdown 文本。');
  const root = unified().use(remarkParse).use(remarkGfm).parse(content) as Root;
  let count = 0;
  function check(node: { children?: unknown[] }, depth = 0) {
    if (++count > 15000 || depth > 32) throw new Error('文档结构过于复杂，请分段导出。');
    node.children?.forEach(child => check(child as typeof node, depth + 1));
  }
  check(root);
  const warnings = new Set<string>();
  const definitions = new Map(root.children.filter(node => node.type === 'definition').map(node => [node.identifier.toLowerCase(), node.url]));
  const text = (value: string, style: IRunOptions = {}) => new TextRun({ ...style, text: value });
  function inline(nodes: PhrasingContent[], style: IRunOptions = {}): TextRun[] {
    return nodes.flatMap(node => {
      switch (node.type) {
        case 'text': return [text(node.value, style)];
        case 'strong': return inline(node.children, { ...style, bold: true });
        case 'emphasis': return inline(node.children, { ...style, italics: true });
        case 'delete': return inline(node.children, { ...style, strike: true });
        case 'inlineCode': return [text(node.value, { ...style, font: 'Consolas', shading: { fill: 'F2F2F2' } })];
        case 'break': return [new TextRun({ ...style, break: 1 })];
        case 'link': warnings.add('链接保留为文字和地址，不创建可点击链接。'); return [...inline(node.children, style), text(` (${node.url})`, style)];
        case 'linkReference': warnings.add('链接保留为文字和地址，不创建可点击链接。'); return [...inline(node.children, style), text(` (${definitions.get(node.identifier.toLowerCase()) ?? node.identifier})`, style)];
        case 'image': warnings.add('图片保留为说明和地址，未下载或嵌入图片。'); return [text(`[图片：${node.alt ?? ''}] (${node.url})`, style)];
        case 'imageReference': warnings.add('图片保留为说明和地址，未下载或嵌入图片。'); return [text(`[图片：${node.alt ?? ''}] (${definitions.get(node.identifier.toLowerCase()) ?? node.identifier})`, style)];
        case 'html': warnings.add('HTML 以原始文字保留，不执行或渲染。'); return [text(node.value, style)];
        case 'footnoteReference': warnings.add('脚注以编号和正文段落保留。'); return [text(`[${node.identifier}]`, style)];
        default: throw new Error('暂不支持此 Markdown 行内节点。');
      }
    });
  }
  const numbering: { reference: string; levels: { level: number; format: typeof LevelFormat.DECIMAL; text: string; start: number; alignment: typeof AlignmentType.START; style: { paragraph: { indent: { left: number; hanging: number } } } }[] }[] = [];
  function list(node: List, depth: number): (Paragraph | Table)[] {
    if (depth > 8) throw new Error('DOCX 最多支持 9 层嵌套列表。');
    const reference = `list-${numbering.length}`;
    if (node.ordered) numbering.push({ reference, levels: [{ level: depth, format: LevelFormat.DECIMAL, text: `%${depth + 1}.`, start: node.start ?? 1, alignment: AlignmentType.START, style: { paragraph: { indent: { left: 360 * (depth + 1), hanging: 260 } } } }] });
    return node.children.flatMap((item: ListItem) => {
      let first = true;
      return item.children.flatMap(child => {
        if (child.type === 'list') return list(child, depth + 1);
        if (child.type !== 'paragraph') return blocks([child]);
        const marker = first; first = false;
        return [new Paragraph({ widowControl: true, children: [...(marker && item.checked != null ? [text(item.checked ? '[x] ' : '[ ] ')] : []), ...inline(child.children)],
          ...(marker ? node.ordered ? { numbering: { reference, level: depth } } : { bullet: { level: depth } } : { indent: { left: 360 * (depth + 1) } }) })];
      });
    });
  }
  function blocks(nodes: RootContent[]): (Paragraph | Table)[] {
    return nodes.flatMap((node): (Paragraph | Table)[] => {
      switch (node.type) {
        case 'paragraph': return [new Paragraph({ widowControl: true, children: inline(node.children) })];
        case 'heading': return [new Paragraph({ widowControl: true, children: inline(node.children), heading: node === root.children[0] && node.depth === 1 ? HeadingLevel.TITLE : [HeadingLevel.HEADING_1, HeadingLevel.HEADING_2, HeadingLevel.HEADING_3, HeadingLevel.HEADING_4, HeadingLevel.HEADING_5, HeadingLevel.HEADING_6][node.depth - 1], keepNext: true })];
        case 'list': return list(node, 0);
        case 'blockquote': warnings.add('引用内容按普通段落保留。'); return blocks(node.children);
        case 'code': return node.value.split('\n').map(line => new Paragraph({ children: [text(line || ' ', { font: 'Consolas', size: 20 })], spacing: { after: 0, line: 260 }, shading: { fill: 'F2F2F2' } }));
        case 'thematicBreak': return [new Paragraph({ children: [text('———')], spacing: { after: 160 } })];
        case 'html':
          if (/^<!--\s*pagebreak\s*-->$/i.test(node.value.trim())) return [new Paragraph({ pageBreakBefore: true, children: [] })];
          warnings.add('HTML 以原始文字保留，不执行或渲染。'); return [new Paragraph({ children: [text(node.value)] })];
        case 'definition': return [];
        case 'footnoteDefinition': warnings.add('脚注以编号和正文段落保留。'); return [new Paragraph({ children: [text(`[${node.identifier}]`)] }), ...blocks(node.children)];
        case 'table': {
          const columns = node.children[0]?.children.length ?? 0;
          if (!columns || columns > 8 || node.children.length * columns > 2000) throw new Error('DOCX 表格最多 8 列、2000 个单元格，请拆分后导出。');
          const border = { style: BorderStyle.SINGLE, size: 4, color: 'D9D9D9' };
          // Keep the grid and cells inside the actual page's writing area.
          const columnWidths = Array.from({ length: columns }, (_, i) => Math.floor(contentWidth / columns) + (i < contentWidth % columns ? 1 : 0));
          return [new Table({ width: { size: contentWidth, type: WidthType.DXA }, columnWidths, layout: TableLayoutType.FIXED,
            borders: { top: border, bottom: border, left: border, right: border, insideHorizontal: border, insideVertical: border },
            rows: node.children.map((row, rowIndex) => new TableRow({ tableHeader: rowIndex === 0,
              children: Array.from({ length: columns }, (_, index) => new TableCell({ width: { size: columnWidths[index], type: WidthType.DXA },
                margins: { top: 90, bottom: 90, left: 100, right: 100 }, shading: rowIndex === 0 ? { fill: 'F2F2F2' } : undefined,
                children: [new Paragraph({ widowControl: true, children: inline(row.children[index]?.children ?? [], { bold: rowIndex === 0 }), spacing: { after: 40 }, alignment: node.align?.[index] === 'right' ? AlignmentType.RIGHT : node.align?.[index] === 'center' ? AlignmentType.CENTER : AlignmentType.LEFT })] })) })),
          }), new Paragraph({ children: [] })];
        }
        default: throw new Error(`暂不支持 Markdown 节点：${node.type}`);
      }
    });
  }
  const children = blocks(root.children);
  if (options.tableOfContents) children.splice(Math.min(1, children.length), 0,
    new Paragraph({ children: [text('目录', { bold: true, size: 32 })], spacing: { after: 160 }, keepNext: true }),
    new TableOfContents('TOC', { hyperlink: true, headingStyleRange: '1-3' }),
    new Paragraph({ pageBreakBefore: true, children: [] }),
  );
  const headings = ['heading1', 'heading2', 'heading3', 'heading4', 'heading5', 'heading6'];
  const font = options.fontFamily ?? 'Calibri';
  const styles = Object.fromEntries(headings.map((key, i) => [key, { run: { color: theme.accent, bold: true, size: [32, 28, 26, 24, 23, 22][i] }, paragraph: { spacing: { before: 240, after: 120 } } }]));
  const header = options.headerText?.trim() ? new Header({ children: [new Paragraph({ alignment: AlignmentType.RIGHT, children: [text(options.headerText.trim(), { color: '666666', size: 18 })] })] }) : undefined;
  const footer = options.pageNumbers ? new Footer({ children: [new Paragraph({ alignment: AlignmentType.CENTER, children: [text('第 '), new TextRun({ children: [PageNumber.CURRENT] }), text(' 页')] })] }) : undefined;
  const doc = new Document({ creator: 'GeiIt Agents', title, description: `${DOCX_CONVERTER_VERSION}:${style}`, features: { updateFields: true },
    styles: { default: { document: { run: { font: { ascii: font, hAnsi: font, eastAsia: options.fontFamily ?? 'Microsoft YaHei' }, size: (options.fontSize ?? 11) * 2, color: '000000' }, paragraph: { spacing: { after: 140, line: Math.round((options.lineSpacing ?? 1.25) * 240) } } }, title: { run: { color: theme.accent, bold: true, size: 40 }, paragraph: { spacing: { after: 240, ...(style === 'meeting' ? { alignment: AlignmentType.CENTER } : {}) } } }, ...styles } },
    numbering: { config: numbering }, sections: [{ headers: header ? { default: header } : undefined, footers: footer ? { default: footer } : undefined,
      properties: { page: { size: { width: page.width, height: page.height }, margin } }, children }] });
  const buffer = await Packer.toArrayBuffer(doc);
  const formatVersion = [options.paperSize, options.fontFamily, options.fontSize, options.lineSpacing, options.marginInches,
    options.tableOfContents, options.pageNumbers, options.headerText].map(value => value ?? '-').join(',');
  return { bytes: buffer, warnings: [...warnings], converterVersion: `${DOCX_CONVERTER_VERSION}:${style}:${formatVersion}` };
}
