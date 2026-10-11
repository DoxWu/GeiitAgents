/**
 * 隐私政策页面
 *
 * 作用：
 *   展示 GeiIt企业知识库 的隐私政策，说明数据收集、使用、存储、保护
 *   及用户权利等内容。页面描述不替代部署运营方的法律审查。
 *
 * 使用方式：
 *   通过路由 /privacy 访问，公开页面（无需登录）。
 */

import { useNavigate } from "react-router-dom";
import { ArrowLeft, BookOpen, Shield } from "lucide-react";
import { getPublicConfig, getPublicContactEmail } from "@/config/publicConfig";

/** 隐私政策章节 */
interface PrivacySection {
  /** 章节标题 */
  title: string;
  /** 章节内容（段落列表） */
  paragraphs: string[];
}

/** 隐私政策章节内容 */
const SECTIONS: PrivacySection[] = [
  {
    title: "一、数据收集范围",
    paragraphs: [
      "GeiIt企业知识库（以下简称「本系统」）在您使用过程中会收集以下个人数据：",
      "1. 账号信息：用户名、邮箱地址（用于注册、登录和账户管理）。",
      "2. 文档数据：您上传的文档文件、解析后的文本和向量化表示。",
      "3. 个人内容：问答对话、笔记、待办、提醒及提醒投递状态；提醒可能包含收件人和正文。",
      "4. 使用日志：访问时间、操作行为、网络地址和客户端标识（用于有限的安全审计和故障排查）。",
      "5. 质量埋点：问答状态、检索/生成耗时、Token 数量和模型标识；不复制问题或回答正文。埋点在账号删除前仍可关联账号。",
    ],
  },
  {
    title: "二、数据使用目的",
    paragraphs: [
      "本系统收集的个人数据仅用于以下目的：",
      "1. 提供知识库问答服务：基于您上传的文档进行检索增强生成（RAG）。",
      "2. 账户管理：身份验证、会话维持、权限控制。",
      "3. 质量优化：通过问答性能与状态指标分析服务运行情况。",
      "4. 安全防护：异常行为检测、有限的操作审计和防止滥用。",
      "我们不会将您的数据出售给第三方，也不会用于定向广告推送。",
    ],
  },
  {
    title: "三、数据存储与保护",
    paragraphs: [
      "当前代码提供以下保护机制；实际网络、基础设施和运维设置由部署运营方负责核实：",
      "1. 密码保护：用户密码以单向哈希存储，不保存明文。",
      "2. Token 认证：采用 Access Token + Refresh Token 双令牌机制，Access Token 短时效。",
      "3. 访问隔离：用户只能访问自己上传的文档和公共文档库，模型检索严格限定在授权范围。",
      "4. 传输加密：请仅通过部署运营方提供的 HTTPS 地址使用服务；仓库配置不能证明具体部署的 TLS 状态。",
      "5. 数据库存储：服务端数据库保存账号、文档处理结果、对话和个人记录；具体数据库与托管方由部署运营方配置。",
      "6. 本机数据：加密工作台和本地知识库保存在用户设备上，不包含在服务端账号导出或账号删除中，须在设备上单独管理。本地知识库原文和向量当前未加密；其导出备份单独加密。",
    ],
  },
  {
    title: "四、数据保留期限",
    paragraphs: [
      "1. 账号存续期间：服务端保存账号、文档、对话、个人记录和有限的审计/投递元数据；部署方应公布适用的日志与备份周期。",
      "2. 账号删除后：删除事务移除在线账号及关联数据库记录，并清除关联 QA 正文、审计详情和待发送邮件正文。服务器文件通过持久队列异步清理；共享旧目录或文件系统故障会转入人工复核。",
      "3. 定时清理：代码提供过期数据清理任务，但必须由部署环境运行 Celery Beat；本页面不宣称具体部署已经启用或完成清理。",
      "   - 问答埋点不保存问题/回答正文；升级迁移会清空历史埋点正文。",
      "4. 备份：账号删除不会改写已经生成的备份；其中数据会在部署方配置的备份过期或销毁流程完成后退出保留。",
      "5. 已发送邮件无法从接收方或邮件服务商处撤回；客户端本机数据须在设备上另行删除。",
    ],
  },
  {
    title: "五、用户权利",
    paragraphs: [
      "您可按适用法律向负责该部署的运营方提出访问、更正、删除或导出请求：",
      "1. 访问权：您可随时通过系统查看自己的账号信息、文档和对话记录。",
      "2. 更正权：如需更正账号信息，请联系管理员。",
      "3. 删除：可通过「设置 → 删除账号」删除服务端账号及在线关联记录。物理文件清理异步进行；已发送邮件、既有备份和客户端本机数据不由此操作撤回或删除。",
      "4. 数据导出：账号导出包含服务端账号、文档元数据、对话、笔记、待办、提醒及投递状态，设有数量和 16 MiB 大小限制；不含原始文件、向量、审计/邮件正文或客户端本机数据。超限时可使用分模块导出。",
      "5. 其他权利请求由部署运营方按适用规则处理。",
      "行使上述权利时，系统会要求您验证身份（如输入密码）以防止未授权操作。",
    ],
  },
  {
    title: "六、Cookie 与 Token 说明",
    paragraphs: [
      "1. 本系统不使用追踪类 Cookie 进行用户行为分析。",
      "2. 身份认证采用 JWT（JSON Web Token）机制，Token 存储在浏览器 localStorage 中。",
      "3. Token 有效期由部署配置决定，过期后需重新登录或刷新。",
      "4. 登出会请求服务器吊销会话；若服务器未确认，界面会提示本机状态已清理但服务器会话可能仍有效。",
      "5. 请勿在公共设备上保持登录状态，使用完毕请及时登出。",
    ],
  },
  {
    title: "七、第三方服务说明",
    paragraphs: [
      "1. 模型服务：问答时可能将问题和检索片段发送至当前部署配置的文本模型；文档索引可能调用配置的嵌入模型。具体服务商、数据地点、保留方式和合同条件由部署运营方确认。",
      "2. 客户端直连：自配置模型或服务端点时，客户端可能直接向所选端点发送请求；请求不一定经过本系统服务器。",
      "3. 基础设施：数据库、缓存、邮件和云托管服务依部署配置而异；本页面不代表特定供应商已经接入或完成验收。",
      "部署运营方应告知用户实际接收方及适用的数据处理安排。",
    ],
  },
  {
    title: "八、联系方式",
    paragraphs: [
      "本部署公开的运营主体、数据处理和联系方式如下。未公开的事项请向组织管理员核实；默认配置不代表实际处理区域或跨境情况已经确认。",
    ],
  },
];

/** 最后更新日期 */
const LAST_UPDATED = "2026年10月11日";

/** PrivacyPage 组件 */
export default function PrivacyPage() {
  const navigate = useNavigate();
  const publicConfig = getPublicConfig();
  const contactEmail = getPublicContactEmail();
  const notPublished = "此部署尚未公开，请向部署运营方核实。";
  const deploymentDetails = [
    `运营主体：${publicConfig.operatorName || notPublished}`,
    `运营主体所在地：${publicConfig.operatorLocation || notPublished}`,
    `第三方服务：${publicConfig.thirdPartyNotice || notPublished}`,
    `数据处理区域：${publicConfig.processingRegion || notPublished}`,
    `数据保留：${publicConfig.retentionNotice || notPublished}`,
    `跨境处理：${publicConfig.crossBorderNotice || notPublished}`,
  ];

  /** 返回上一页 */
  const handleBack = () => {
    // 优先返回上一页，无历史记录时回到首页
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
            <Shield className="h-6 w-6" />
          </div>
          <h1 className="text-2xl font-bold text-ink">隐私政策</h1>
          <p className="mt-2 text-sm text-ink-secondary">
            最后更新：{LAST_UPDATED}
          </p>
        </div>

        {/* 引言 */}
        <div className="mb-8 rounded-lg border border-line bg-surface p-5">
          <p className="text-sm leading-relaxed text-ink-secondary">
            本页面根据当前代码说明服务端与客户端可能处理的数据。实际部署方式、供应商、保留期限和权利请求渠道由运营方配置并确认；本页面不构成法律合规认证。
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
                {section.title === "八、联系方式" && (
                  <>
                    {deploymentDetails.map((detail) => (
                      <p key={detail} className="text-sm leading-relaxed text-ink-secondary">
                        {detail}
                      </p>
                    ))}
                    {contactEmail && (
                      <p className="text-sm leading-relaxed text-ink-secondary">
                        反馈与隐私请求：{" "}
                        <a className="text-brand underline" href={`mailto:${contactEmail}`}>
                          {contactEmail}
                        </a>
                      </p>
                    )}
                  </>
                )}
              </div>
            </section>
          ))}
        </div>

        {/* 底部声明 */}
        <div className="mt-12 rounded-lg border border-line bg-muted/30 p-5">
          <p className="text-xs leading-relaxed text-ink-tertiary">
            本隐私政策可能不时更新，更新后将在本页面公布并修改"最后更新"日期。重大变更时我们会通过系统通知提醒您。继续使用本系统即表示您同意更新后的隐私政策。
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
