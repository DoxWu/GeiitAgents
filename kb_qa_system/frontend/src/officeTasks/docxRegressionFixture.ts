// Synthetic, deterministic input shared by structural tests and future native
// pagination QA. No customer documents, API credentials or external assets.
export function docxRegressionFixture(): string {
  const prose = Array.from({ length: 18 }, (_, index) => `## 验证章节 ${index + 1}\n\n段落-${index + 1}：${'这是一段用于验证中文换行、段间距与内容完整性的固定测试说明。'.repeat(12)}\n`).join('\n');
  const table = '| 编号 | 工作说明 | 状态 |\n| --- | --- | --- |\n' + Array.from({ length: 120 }, (_, index) => `| 行-${index + 1} | 逐行核对任务状态，检查跨页后表头与中文内容。 | 待确认 |`).join('\n');
  const code = Array.from({ length: 80 }, (_, index) => `line_${index + 1}: check("<中文 & data>");`).join('\n');
  return `# 长文档回归样例\n\n${prose}\n## 长表格\n\n${table}\n\n## 多行代码\n\n\`\`\`text\n${code}\n\`\`\`\n\n## 列表\n\n3. 第一项\n4. 第二项\n   1. 嵌套条目\n\n- [x] 已完成\n- [ ] 待检查\n\n结束标记：全文应完整保留。\n`;
}
