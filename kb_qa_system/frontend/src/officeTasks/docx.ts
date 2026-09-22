import { AlignmentType, BorderStyle, Document, HeadingLevel, LevelFormat, Packer, Paragraph, Table, TableCell, TableRow, TextRun, WidthType, type IRunOptions } from 'docx';
import { unified } from 'unified';
import remarkParse from 'remark-parse';
import remarkGfm from 'remark-gfm';
import type { Root, RootContent, PhrasingContent, List, ListItem } from 'mdast';

export const DOCX_CONVERTER_VERSION = 'markdown-docx/1';
export const DOCX_MIME = 'application/vnd.openxmlformats-officedocument.wordprocessingml.document';
export interface DocxResult { bytes: ArrayBuffer; warnings: string[]; converterVersion: string }

// Runs only in the on-demand export Worker. No network, HTML, external relationships or image fetching.
export async function markdownToDocx(content: string, title: string): Promise<DocxResult> {
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
        return [new Paragraph({ children: [...(marker && item.checked != null ? [text(item.checked ? '[x] ' : '[ ] ')] : []), ...inline(child.children)],
          ...(marker ? node.ordered ? { numbering: { reference, level: depth } } : { bullet: { level: depth } } : { indent: { left: 360 * (depth + 1) } }) })];
      });
    });
  }
  function blocks(nodes: RootContent[]): (Paragraph | Table)[] {
    return nodes.flatMap((node): (Paragraph | Table)[] => {
      switch (node.type) {
        case 'paragraph': return [new Paragraph({ children: inline(node.children) })];
        case 'heading': return [new Paragraph({ children: inline(node.children), heading: node === root.children[0] && node.depth === 1 ? HeadingLevel.TITLE : [HeadingLevel.HEADING_1, HeadingLevel.HEADING_2, HeadingLevel.HEADING_3, HeadingLevel.HEADING_4, HeadingLevel.HEADING_5, HeadingLevel.HEADING_6][node.depth - 1], keepNext: true })];
        case 'list': return list(node, 0);
        case 'blockquote': warnings.add('引用内容按普通段落保留。'); return blocks(node.children);
        case 'code': return node.value.split('\n').map(line => new Paragraph({ children: [text(line || ' ', { font: 'Consolas', size: 20 })], spacing: { after: 0, line: 260 }, shading: { fill: 'F2F2F2' } }));
        case 'thematicBreak': return [new Paragraph({ children: [text('———')], spacing: { after: 160 } })];
        case 'html': warnings.add('HTML 以原始文字保留，不执行或渲染。'); return [new Paragraph({ children: [text(node.value)] })];
        case 'definition': return [];
        case 'footnoteDefinition': warnings.add('脚注以编号和正文段落保留。'); return [new Paragraph({ children: [text(`[${node.identifier}]`)] }), ...blocks(node.children)];
        case 'table': {
          const columns = node.children[0]?.children.length ?? 0;
          if (!columns || columns > 8 || node.children.length * columns > 2000) throw new Error('DOCX 表格最多 8 列、2000 个单元格，请拆分后导出。');
          const border = { style: BorderStyle.SINGLE, size: 4, color: 'D9D9D9' };
          return [new Table({ width: { size: 9360, type: WidthType.DXA }, columnWidths: Array(columns).fill(Math.floor(9360 / columns)),
            borders: { top: border, bottom: border, left: border, right: border, insideHorizontal: border, insideVertical: border },
            rows: node.children.map((row, rowIndex) => new TableRow({ tableHeader: rowIndex === 0,
              children: Array.from({ length: columns }, (_, index) => new TableCell({ width: { size: Math.floor(9360 / columns), type: WidthType.DXA },
                margins: { top: 90, bottom: 90, left: 100, right: 100 }, shading: rowIndex === 0 ? { fill: 'F2F2F2' } : undefined,
                children: [new Paragraph({ children: inline(row.children[index]?.children ?? [], { bold: rowIndex === 0 }), spacing: { after: 40 }, alignment: node.align?.[index] === 'right' ? AlignmentType.RIGHT : node.align?.[index] === 'center' ? AlignmentType.CENTER : AlignmentType.LEFT })] })) })),
          }), new Paragraph({ children: [] })];
        }
        default: throw new Error(`暂不支持 Markdown 节点：${node.type}`);
      }
    });
  }
  const children = blocks(root.children);
  const headings = ['heading1', 'heading2', 'heading3', 'heading4', 'heading5', 'heading6'];
  const styles = Object.fromEntries(headings.map((key, i) => [key, { run: { color: '000000', bold: true, size: [32, 28, 26, 24, 23, 22][i] }, paragraph: { spacing: { before: 240, after: 120 } } }]));
  const doc = new Document({ creator: 'GeiIt Agents', title, description: DOCX_CONVERTER_VERSION,
    styles: { default: { document: { run: { font: { ascii: 'Calibri', hAnsi: 'Calibri', eastAsia: 'Microsoft YaHei' }, size: 22, color: '000000' }, paragraph: { spacing: { after: 140, line: 300 } } }, title: { run: { color: '000000', bold: true, size: 40 }, paragraph: { spacing: { after: 240 } } }, ...styles } },
    numbering: { config: numbering }, sections: [{ properties: { page: { size: { width: 12240, height: 15840 }, margin: { top: 1440, right: 1440, bottom: 1440, left: 1440 } } }, children }] });
  const buffer = await Packer.toArrayBuffer(doc);
  return { bytes: buffer, warnings: [...warnings], converterVersion: DOCX_CONVERTER_VERSION };
}
