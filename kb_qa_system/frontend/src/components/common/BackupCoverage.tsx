const coverage = [
  ['工作台加密包', '本机对话、办公任务与成果、资料库、个人记录及设置；可选模型密钥', '本地知识库、云端数据、模型权重、外部目录文件'],
  ['本地知识库加密包', '本地文档、片段、向量及模型设置', '工作台记录、云端数据、模型权重与 API Key'],
  ['服务器数据库快照', '云端账号、文档记录、向量、对话及个人数据', '上传文件、部署配置、本机工作台和本地知识库'],
  ['服务器离线联合包', '云端数据库、上传目录内原件及派生文件、管理员选定的配置文件', '本机数据、Redis 队列与会话、未选中的配置及外部存储'],
];

export function BackupCoverage() {
  return <details className="py-3 text-sm">
    <summary className="cursor-pointer font-medium">比较备份范围</summary>
    <div className="mt-3 overflow-x-auto">
      <table className="w-full border-collapse text-left text-xs">
        <caption className="sr-only">不同备份方式包含和需要另行保存的数据</caption>
        <thead><tr>{['备份方式', '包含', '需另行保存'].map(label => <th key={label} scope="col" className="border-b border-line p-2">{label}</th>)}</tr></thead>
        <tbody>{coverage.map(([name, included, separate]) => <tr key={name}>
          <th scope="row" className="border-b border-line p-2 align-top font-medium">{name}</th>
          <td className="border-b border-line p-2 align-top">{included}</td>
          <td className="border-b border-line p-2 align-top text-ink-secondary">{separate}</td>
        </tr>)}</tbody>
      </table>
    </div>
    <p className="mt-3 text-xs text-ink-secondary">服务器离线联合包由部署管理员停写后在终端创建和恢复，本页的数据库快照操作不会生成联合包。各备份的解密口令或密钥需独立妥善保管。</p>
  </details>;
}
