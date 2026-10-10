/**
 * 用户协议页面
 *
 * 作用：
 *   展示 GeiIt企业知识库 的用户服务协议，明确服务范围、用户责任、
 *   禁止行为、知识产权、免责声明等内容，满足合规要求。
 *
 * 使用方式：
 *   通过路由 /terms 访问，公开页面（无需登录）。
 */

import { useNavigate } from "react-router-dom";
import { ArrowLeft, BookOpen, FileText } from "lucide-react";

/** 用户协议章节 */
interface TermsSection {
  /** 章节标题 */
  title: string;
  /** 章节内容（段落列表） */
  paragraphs: string[];
}

/** 用户协议章节内容 */
const SECTIONS: TermsSection[] = [
  {
    title: "一、服务说明",
    paragraphs: [
      "GeiIt企业知识库（以下简称「本系统」）是一个基于 RAG（检索增强生成）技术的企业级知识库问答系统，提供文档上传、解析、向量检索和智能问答服务。",
      "本系统允许用户上传企业文档（PDF、Word、Markdown、TXT 等），系统自动解析、分块、向量化并存储，用户可通过自然语言提问获取基于知识库的准确回答。",
      "本服务仅供已注册用户使用，注册需通过管理员审批。",
    ],
  },
  {
    title: "二、用户账号",
    paragraphs: [
      "1. 注册条件：用户需使用有效邮箱地址注册，同一邮箱仅可注册一个账号。",
      "2. 账号安全：用户应妥善保管账号和密码，因密码泄露导致的损失由用户自行承担。",
      "3. 真实信息：用户注册时应提供真实信息，不得冒用他人身份。",
      "4. 账号转让：用户账号不得出售、出租、转让或出借给第三方。",
      "5. 账号删除：用户可通过账号设置申请删除账号。在线关联数据库记录在删除事务中移除；服务器文件清理异步执行，失败或共享目录会进入重试/人工复核。既有备份、已发送邮件和客户端本机数据不由此操作立即删除。",
    ],
  },
  {
    title: "三、用户责任",
    paragraphs: [
      "用户在使用本系统时应遵守以下规范：",
      "1. 合法使用：不得利用本系统从事任何违反法律法规的活动。",
      "2. 文档合规：上传的文档不得包含违法、侵权、色情、暴力等内容。",
      "3. 知识产权：上传的文档应确保拥有合法使用权，不得上传侵犯他人知识产权的内容。",
      "4. 不得滥用：不得进行批量爬取、恶意攻击、尝试突破权限限制等行为。",
      "5. 数据保密：用户应对通过本系统获取的企业敏感信息承担保密义务。",
      "6. 合理使用：遵守系统限流策略，不得通过技术手段绕过使用限制。",
    ],
  },
  {
    title: "四、禁止行为",
    paragraphs: [
      "以下行为被严格禁止，违规者将被立即封禁账号：",
      "1. 上传恶意文件（病毒、木马、勒索软件等）。",
      "2. 尝试获取其他用户的文档、对话或个人信息。",
      "3. 对系统进行拒绝服务攻击（DoS/DDoS）或暴力破解。",
      "4. 利用系统漏洞进行未授权操作。",
      "5. 逆向工程、反编译或试图获取系统源代码。",
      "6. 在文档中嵌入恶意脚本或试图执行代码注入攻击。",
    ],
  },
  {
    title: "五、知识产权",
    paragraphs: [
      "1. 用户上传的文档：知识产权归原所有者所有，本系统仅在用户授权范围内进行处理和检索。",
      "2. 系统生成的回答：基于用户上传的文档内容生成，回答的知识产权归文档所有者所有。",
      "3. 系统本身：本系统的软件、架构、设计、品牌等知识产权归开发团队所有。",
      "4. 文档处理产物：文档的分块、向量化等处理产物属于衍生数据，随原文档知识产权归属。",
    ],
  },
  {
    title: "六、服务变更与终止",
    paragraphs: [
      "1. 服务变更：我们保留随时修改、暂停或终止部分或全部服务的权利，重大变更将提前通知。",
      "2. 服务终止：如用户违反本协议，我们有权随时限制或终止其账号使用。",
      "3. 账号注销：用户可主动删除账号。在线关联记录会按删除流程移除，服务器文件清理异步执行；既有备份可能在运营方配置的保留周期内继续包含相关数据，客户端本机数据及已发送邮件须另行处理。",
      "4. 数据迁移：服务终止前，用户可通过「数据导出」功能导出个人数据。",
    ],
  },
  {
    title: "七、免责声明",
    paragraphs: [
      "1. 回答准确性：本系统基于 RAG 技术生成回答，虽经多轮优化但仍可能存在不准确之处，用户应自行判断并核实重要信息。",
      "2. 服务可用性：本系统不保证 7×24 小时不间断运行，因维护、故障等原因导致的服务中断不承担赔偿责任。",
      "3. 数据安全：尽管我们采取了多重安全措施，但无法保证绝对安全。因不可抗力或第三方攻击导致的数据泄露，我们不承担连带责任。",
      "4. 第三方服务：本系统依赖第三方 LLM 服务生成回答，第三方服务的可用性和准确性不在我们控制范围内。",
      "5. 用户决策：用户基于系统回答做出的任何决策和行动，由用户自行承担后果。",
    ],
  },
  {
    title: "八、协议变更",
    paragraphs: [
      "1. 本协议可能不时更新，更新后将在本页面公布并修改「最后更新」日期。",
      "2. 重大变更时我们会通过系统通知提醒用户。",
      "3. 用户继续使用本系统即表示同意更新后的协议。",
      "4. 如用户不同意更新内容，可选择停止使用并删除账号。",
    ],
  },
];

/** 最后更新日期 */
const LAST_UPDATED = "2026年10月10日";

/** TermsPage 组件 */
export default function TermsPage() {
  const navigate = useNavigate();

  /** 返回上一页 */
  const handleBack = () => {
    if (window.history.length > 1) {
      navigate(-1);
    } else {
      navigate("/");
    }
  };

  return (
    <div className="min-h-screen bg-canvas">
      {/* 顶部导航栏 */}
      <header className="sticky top-0 z-10 border-b border-line bg-surface/95 backdrop-blur">
        <div className="mx-auto flex max-w-3xl items-center gap-3 px-4 py-4">
          <button
            onClick={handleBack}
            className="rounded-md p-1.5 text-ink-secondary transition-colors hover:bg-muted hover:text-ink"
            aria-label="返回"
          >
            <ArrowLeft className="h-5 w-5" />
          </button>
          <div className="flex items-center gap-2">
            <div className="inline-flex h-8 w-8 items-center justify-center rounded bg-brand text-white">
              <BookOpen className="h-4 w-4" />
            </div>
            <span className="font-semibold text-ink">GeiIt企业知识库</span>
          </div>
        </div>
      </header>

      {/* 内容区 */}
      <main className="mx-auto max-w-3xl px-4 py-8">
        {/* 标题区 */}
        <div className="mb-8 text-center">
          <div className="mb-4 inline-flex h-12 w-12 items-center justify-center rounded-full bg-brand-light text-brand">
            <FileText className="h-6 w-6" />
          </div>
          <h1 className="text-2xl font-bold text-ink">用户协议</h1>
          <p className="mt-2 text-sm text-ink-secondary">
            最后更新：{LAST_UPDATED}
          </p>
        </div>

        {/* 引言 */}
        <div className="mb-8 rounded-lg border border-line bg-surface p-5">
          <p className="text-sm leading-relaxed text-ink-secondary">
            欢迎使用 GeiIt企业知识库（以下简称"本系统"）。在使用本系统前，请仔细阅读本用户协议（以下简称"本协议"）。使用本系统即表示您已阅读、理解并同意接受本协议的全部条款。如您不同意本协议的任何内容，请勿使用本系统。
          </p>
        </div>

        {/* 各章节 */}
        <div className="space-y-8">
          {SECTIONS.map((section) => (
            <section key={section.title}>
              <h2 className="mb-3 text-lg font-semibold text-ink">
                {section.title}
              </h2>
              <div className="space-y-2">
                {section.paragraphs.map((para, idx) => (
                  <p
                    key={idx}
                    className="text-sm leading-relaxed text-ink-secondary"
                  >
                    {para}
                  </p>
                ))}
              </div>
            </section>
          ))}
        </div>

        {/* 底部声明 */}
        <div className="mt-12 rounded-lg border border-line bg-muted/30 p-5">
          <p className="text-xs leading-relaxed text-ink-tertiary">
            本用户协议构成您与本系统之间的完整协议。如本协议的任何条款被认定为无效或不可执行，不影响其余条款的效力。本协议的解释及争议解决适用中华人民共和国法律。
          </p>
        </div>

        {/* 返回按钮 */}
        <div className="mt-8 text-center">
          <button
            onClick={handleBack}
            className="inline-flex items-center gap-1.5 rounded-md border border-line bg-surface px-4 py-2 text-sm font-medium text-ink-secondary transition-colors hover:bg-muted hover:text-ink"
          >
            <ArrowLeft className="h-4 w-4" />
            返回
          </button>
        </div>
      </main>
    </div>
  );
}
