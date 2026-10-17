// Versioned synthetic fixtures. No customer documents or model-generated relevance labels.
export const fixtureVersion = 'office-bilingual-v1';
const policies = [
  ['报销', '员工出差报销须提交发票、付款凭证和主管审批记录，在出差结束后十个工作日内交给财务。', '出差费用报销需要哪些凭证？', 'Which documents are required for travel reimbursement?'],
  ['年假', '员工申请年假应提前三个工作日提交人事系统，经直属经理批准后方可休假。', '请年假要提前多久申请？', 'How far in advance should annual leave be requested?'],
  ['发布', '生产软件发布前必须通过自动化测试和代码评审。上线健康检查失败时，值班工程师立即回滚到上一版本。', '上线检查失败后应该怎么办？', 'What should the engineer do if a deployment health check fails?'],
  ['访客', '访客到达前由接待人登记姓名和来访时间。前台核验身份证件并发放临时胸卡，离开时归还胸卡。', '来访客人如何领用和归还胸卡？', 'How does a visitor obtain and return a temporary badge?'],
  ['采购', '单笔超过五千元的设备采购须取得部门负责人和财务双重批准，并保存三家供应商的报价。', '设备采购金额超过五千需要什么审批？', 'What approvals are needed for equipment purchases above five thousand yuan?'],
  ['密码', '忘记公司账号密码时，应联系服务台核验身份后重置。禁止向同事发送验证码或共享登录密码。', '忘记账号密码应该找谁处理？', 'Who can reset a forgotten corporate account password?'],
  ['数据保留', '合同扫描件保留七年，期满由法务确认无未决争议后批准销毁。含个人信息的副本也须同步清理。', '合同扫描文件要保管几年？', 'How long must scanned contracts be retained?'],
  ['会议室', '会议室需通过预约系统预订。会议开始十五分钟后仍未签到，系统自动释放预约供他人使用。', '预订会议室但没有签到会怎样？', 'When is an unused meeting room reservation released?'],
  ['工伤', '发生工伤时首先呼叫急救并通知现场负责人。人事应在二十四小时内收集事件经过和目击者信息。', '工伤发生后首先应该做什么？', 'What is the first response to a workplace injury?'],
  ['远程办公', '远程办公须提前向经理申请，使用公司 VPN 接入内部系统。不得在公共电脑保存业务资料。', '在家访问内部系统需要使用什么连接？', 'How should remote staff connect to internal systems?'],
  ['离职设备', '员工离职最后一天应向信息技术部门归还笔记本、充电器和门禁卡，签署设备交接单。', '离职时需要归还什么设备？', 'Which items must departing employees return?'],
  ['发票抬头', '开具增值税发票前应核对公司全称和纳税人识别号。抬头错误的发票需联系销售方重新开具。', '发票公司名称开错了如何处理？', 'What should be done when an invoice has the wrong company name?'],
  ['快递', '私人快递放在一楼收件架，收件人应在两天内取走。保密业务文件必须由指定员工签收，不得代放。', '保密文件的快递可以放在收件架吗？', 'Can confidential business deliveries be left on the parcel shelf?'],
  ['培训', '新入职员工应在入职两周内完成安全培训和知识测验，成绩达到八十分才可申请生产系统权限。', '新员工申请生产权限之前需完成什么？', 'What training is required before new hires get production access?'],
  ['加班', '计划加班须事先在考勤系统登记，由主管批准。调休申请应在加班后九十天内提交。', '加班后多久以内可以申请调休？', 'What is the deadline for requesting time off in lieu of overtime?'],
  ['故障通报', '重大业务故障由值班负责人在发现后十五分钟内通报管理团队，每三十分钟更新一次处理进展。', '重大故障需要多久通报一次进展？', 'How frequently should updates be sent during a major service outage?'],
  ['备份', '业务数据库每天凌晨两点执行加密备份，保留最近七份。每周进行一次独立测试库恢复演练。', '数据库备份多久做一次恢复演练？', 'How often should database backup restoration be rehearsed?'],
  ['供应商付款', '供应商付款前必须核对合同、验收单和发票三项材料。收款账号变更须通过已备案电话二次确认。', '供应商更换收款账户应该怎么核实？', 'How must a vendor bank account change be verified?'],
  ['差旅酒店', '国内差旅酒店标准为每晚五百元以内，超标须出行前取得书面批准。住宿发票附酒店水单提交。', '酒店超过住宿标准时应何时申请批准？', 'When is approval needed for a hotel above the travel allowance?'],
  ['代码密钥', '禁止将 API 密钥提交代码仓库。发现密钥泄露时应立即撤销旧密钥、签发新密钥并检查调用日志。', '代码仓库暴露了密钥后需要哪些处理？', 'What actions are required after an API key is exposed in a repository?'],
  ['客户投诉', '客户投诉由客服建立工单并在一个工作日内首次回复。退款请求必须由财务审核后执行。', '客户提出投诉后多久应该首次回复？', 'How quickly must customer complaints receive an initial response?'],
  ['消防', '发现火情立即按下手动报警按钮，沿安全出口撤离到楼外集合点。疏散过程中禁止乘坐电梯。', '火灾疏散过程中能否使用电梯？', 'May employees use elevators during a fire evacuation?'],
  ['印章', '公司印章使用须提交盖章申请和合同定稿，由行政登记用途、份数与经办人，禁止携章外出。', '申请盖公司章要提供什么材料？', 'What documents are required to use the company seal?'],
  ['设备维修', '办公笔记本故障应先在服务台提交工单，附资产编号和错误截图。未经批准不得交外部维修店拆机。', '办公电脑坏了如何申请维修？', 'How should an employee request repair of a company laptop?'],
];
export const questions = policies.flatMap(([topic, evidence, zh, en], i) => [
  { id: `q${i}-zh`, language: 'zh', question: zh, relevant: [{ name: `${topic}.md`, evidence }] },
  { id: `q${i}-en`, language: 'en-to-zh', question: en, relevant: [{ name: `${topic}.md`, evidence }] },
]);
export function makeCorpus(scale, paragraphsPerDocument = 24) {
  const documents = policies.map(([topic, evidence]) => ({ name: `${topic}.md`, text: `# ${topic}\n\n${evidence}\n\n此制度仅为软件性能测试的虚构内容，不代表任何真实公司政策。` }));
  if (scale === 'small') return documents;
  const subjects = ['园艺种植', '摄影构图', '烘焙课程', '社区跑步', '天文观测', '书法练习', '音乐欣赏', '自行车保养', '棋类活动', '陶艺制作', '电影讨论', '宠物护理'];
  if (!Number.isInteger(paragraphsPerDocument) || paragraphsPerDocument < 1 || paragraphsPerDocument > 180) {
    throw new Error('Synthetic corpus paragraphsPerDocument must be between 1 and 180.');
  }
  const appendJournal = (document, index) => {
    const subject = subjects[index % subjects.length];
    const paragraphs = Array.from({ length: paragraphsPerDocument }, (_, n) => `第 ${n + 1} 节：${subject}兴趣活动记录。小组 ${index} 讨论课程安排、参与感受和下一次活动的准备清单。大家可以自由交流经验，记录不同方法的实际效果，活动结束后整理材料。This fictional hobby journal describes community activities and personal learning notes.\n`).join('\n');
    document.text += document.text ? `\n\n${paragraphs}` : `# ${subject}\n${paragraphs}`;
  };
  if (paragraphsPerDocument > 24) {
    for (let i = 0; i < documents.length; i++) appendJournal(documents[i], i);
  }
  for (let i = documents.length; i < 100; i++) {
    const document = { name: `兴趣记录-${i}.txt`, text: '' };
    appendJournal(document, i);
    documents.push(document);
  }
  return documents;
}
