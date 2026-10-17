/**
 * 帮助文档页面（D10-02）
 *
 * 作用：
 *   提供系统使用指南、常见问题解答、快捷键说明和联系方式。
 *   帮助用户快速上手和理解系统功能。
 *
 * 使用方式：
 *   通过路由 /help 访问，公开页面（无需登录）。
 */

import { useNavigate } from "react-router-dom";
import { ArrowLeft, BookOpen, HelpCircle, Keyboard, Mail } from "lucide-react";
import { getPublicContactEmail } from "@/config/publicConfig";

/** 帮助章节 */
interface HelpSection {
  /** 章节图标 */
  icon: React.ReactNode;
  /** 章节标题 */
  title: string;
  /** 章节内容（段落列表） */
  items: string[];
}

/** 帮助章节内容 */
const SECTIONS: HelpSection[] = [
  {
    icon: <BookOpen className="h-5 w-5" />,
    title: "快速入门",
    items: [
      "1. 使用本机模型或自购 API：从登录页右上角进入工作台，无需登录。",
      "2. 使用云端知识库：登录已获授权的账号；注册、审批和游客登录方式由当前部署配置决定。",
      "3. 上传文档：进入「文档管理」页面，点击上传按钮或拖拽文件到上传区。",
      "4. 提问问答：进入「聊天问答」页面，输入问题，系统将基于您有权访问的文档生成回答。",
    ],
  },
  {
    icon: <HelpCircle className="h-5 w-5" />,
    title: "常见问题",
    items: [
      "Q：支持哪些文档格式？\nA：支持 PDF、Markdown、Word（.docx）、纯文本（.txt）和网页链接（URL导入）。",
      "Q：文档上传后多久可以问答？\nA：处理时间取决于文件大小、格式和任务队列。请等状态变为「已完成」或「低质量」后再检索；失败或处理中不会进入检索结果。",
      "Q：问答回答的依据是什么？\nA：系统基于您上传的文档进行检索增强生成（RAG），回答末尾会附引用来源，标注原文出处。",
      "Q：可以删除已上传的文档吗？\nA：可以，在文档管理页面选择文档并删除。删除后文档不再参与检索；当前服务端删除流程不承诺立即物理删除原文件，也不会改写已有备份。",
      "Q：本地知识库与云端知识库共用设置吗？\nA：不共用。本地知识库在桌面工作台中单独启用，默认向量模型为 Xenova/multilingual-e5-small，仅在您主动启用后下载和初始化，也可单独配置兼容模型；云端模型、文档和索引由服务端账户分别管理。",
      "Q：账号导出或删除会处理本机资料吗？\nA：不会。账号导出包含服务端账号、文档元数据、对话、笔记、待办、提醒及投递状态，不含原始文件、向量或本机资料；数量或大小超限时可使用分模块导出。删除账号会移除在线账号及关联记录，服务器文件可能异步清理；既有备份、已发送邮件和本机资料不会由此撤回或删除。",
      "Q：忘记密码怎么办？\nA：当前没有自助找回或重置密码流程。请通过本部署的组织管理员咨询账号恢复方式；注册审批邮件中的密码设置链接仅用于首次设置账号密码。",
      "Q：支持多轮对话吗？\nA：支持。系统会保留对话上下文，可以基于前文进行追问。",
    ],
  },
  {
    icon: <Keyboard className="h-5 w-5" />,
    title: "快捷键与操作提示",
    items: [
      "Enter：在聊天输入框中按 Enter 发送消息",
      "Shift + Enter：换行输入（不发送）",
      "文档搜索：在搜索框输入关键词，支持模糊匹配，自动防抖（300ms）",
      "文档排序：点击列头可按创建时间、文件名等排序",
      "暗色模式：点击导航栏的主题切换按钮，在亮色/暗色间切换",
    ],
  },
  {
    icon: <Mail className="h-5 w-5" />,
    title: "联系方式与技术支持",
    items: [
      "如遇到问题或有功能建议，请联系提供当前部署的组织管理员。",
      "数据权利与隐私事项请先查阅「隐私政策」，并向部署运营方确认受理渠道。",
    ],
  },
];

/** HelpPage 组件 */
export default function HelpPage() {
  const navigate = useNavigate();
  const contactEmail = getPublicContactEmail();

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
            <HelpCircle className="h-6 w-6" />
          </div>
          <h1 className="text-2xl font-bold text-ink">帮助中心</h1>
          <p className="mt-2 text-sm text-ink-secondary">
            快速了解系统功能，解答常见疑问
          </p>
        </div>

        {/* 各章节 */}
        <div className="space-y-6">
          {SECTIONS.map((section) => (
            <section
              key={section.title}
              className="rounded-lg border border-line bg-surface p-5"
            >
              <div className="mb-3 flex items-center gap-2">
                <span className="text-brand">{section.icon}</span>
                <h2 className="text-lg font-semibold text-ink">
                  {section.title}
                </h2>
              </div>
              <div className="space-y-2">
                {section.items.map((item, idx) => (
                  <p
                    key={idx}
                    className="whitespace-pre-line text-sm leading-relaxed text-ink-secondary"
                  >
                    {item}
                  </p>
                ))}
                {section.title === "联系方式与技术支持" && contactEmail && (
                  <p className="text-sm leading-relaxed text-ink-secondary">
                    管理员邮箱：{" "}
                    <a className="text-brand underline" href={`mailto:${contactEmail}`}>
                      {contactEmail}
                    </a>
                  </p>
                )}
              </div>
            </section>
          ))}
        </div>

        {/* 底部返回按钮 */}
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
