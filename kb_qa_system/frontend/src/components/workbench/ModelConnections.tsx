import { useState } from "react";
import { Plus, Save, PlugZap, Trash2, Pencil, X } from "lucide-react";
import { useWorkbenchStore } from "@/store/workbenchStore";
import type { ModelProfile } from "@/types/workbench";

const empty = (): Omit<ModelProfile, "hasKey"> => ({ id: crypto.randomUUID(), name: "", mode: "relay", baseUrl: "", model: "" });

export function ModelConnections() {
  const profiles = useWorkbenchStore((s) => s.profiles);
  const [draft, setDraft] = useState(empty);
  const [apiKey, setApiKey] = useState("");
  const [clearKey, setClearKey] = useState(false);
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState("");
  const existing = profiles.find((p) => p.id === draft.id);
  const dirty = Boolean(apiKey || clearKey || !existing || ["name", "baseUrl", "model", "mode", "maxTokens"].some((key) => draft[key] !== existing[key]));
  function reset() { setDraft(empty()); setApiKey(""); setClearKey(false); setMessage(""); }
  async function action(callback: () => Promise<void>, success: string) {
    setBusy(true); setMessage("");
    try { await callback(); setMessage(success); }
    catch (error) { setMessage(error instanceof Error ? error.message : "操作失败。"); }
    finally { setBusy(false); }
  }
  return <div className="mx-auto w-full max-w-3xl overflow-auto p-5 sm:p-8">
    <div className="mb-5 flex items-center justify-between"><h2 className="text-lg font-semibold">模型连接</h2><button className="work-icon" title="新建连接" aria-label="新建连接" onClick={reset} disabled={busy}><Plus size={18} /></button></div>
    <div className="mb-6 divide-y divide-line border-y border-line">
      {profiles.map((profile) => <div key={profile.id} className="flex items-center gap-3 py-3">
        <div className="min-w-0 flex-1"><p className="truncate text-sm font-medium">{profile.name}</p><p className="truncate text-xs text-ink-secondary">{profile.model} · {profile.mode === "local" ? "本机直连" : "云端临时转发"}</p></div>
        <button className="work-icon" title="编辑连接" aria-label={`编辑 ${profile.name}`} disabled={busy} onClick={() => { const { hasKey: _, ...config } = profile; setDraft(config); setApiKey(""); setClearKey(false); setMessage(""); }}><Pencil size={16} /></button>
        <button className="work-icon" title="删除连接" aria-label={`删除 ${profile.name}`} disabled={busy} onClick={() => { if (window.confirm(`删除模型连接“${profile.name}”？`)) void action(async () => { await useWorkbenchStore.getState().removeProfile(profile.id); reset(); }, "连接已删除。"); }}><Trash2 size={16} /></button>
      </div>)}
      {!profiles.length && <p className="py-4 text-sm text-ink-tertiary">暂无模型连接</p>}
    </div>
    <form className="grid gap-4" onSubmit={(event) => { event.preventDefault(); void action(async () => { await useWorkbenchStore.getState().saveProfile(draft, apiKey, clearKey); setApiKey(""); setClearKey(false); }, "连接已加密保存到本机。"); }}>
      <fieldset disabled={busy} className="grid gap-4">
        <label className="work-label">连接名称<input className="work-input" required maxLength={100} value={draft.name} onChange={(e) => setDraft({ ...draft, name: e.target.value })} /></label>
        <label className="work-label">调用方式<select aria-label="调用方式" className="work-input" value={draft.mode} onChange={(e) => setDraft({ ...draft, mode: e.target.value as ModelProfile["mode"], baseUrl: e.target.value === "local" ? "http://127.0.0.1:11434/v1" : "", model: "" })}>
          <option value="relay">云端临时转发</option><option value="local">本机直连（Ollama / LM Studio）</option>
        </select></label>
        <label className="work-label">API Base URL<input className="work-input" type="url" required maxLength={2048} placeholder={draft.mode === "local" ? "http://127.0.0.1:11434/v1" : "https://api.example.com/v1"} value={draft.baseUrl} onChange={(e) => setDraft({ ...draft, baseUrl: e.target.value })} /></label>
        <label className="work-label">模型名称<input className="work-input" required maxLength={200} placeholder="模型服务中的完整模型名称" value={draft.model} onChange={(e) => setDraft({ ...draft, model: e.target.value })} /></label>
        <label className="work-label">API Key<input className="work-input" type="password" autoComplete="new-password" maxLength={4096} placeholder={existing?.hasKey ? "已保存；留空保持原密钥" : draft.mode === "local" ? "可选" : "必填"} value={apiKey} onChange={(e) => setApiKey(e.target.value)} /></label>
        {existing?.hasKey && <label className="flex items-center gap-2 text-sm"><input type="checkbox" checked={clearKey} onChange={(e) => setClearKey(e.target.checked)} />清除已保存密钥</label>}
        <label className="work-label">最大输出 Token（可选）<input className="work-input" type="number" min={1} max={2147483647} placeholder="模型默认" value={draft.maxTokens ?? ""} onChange={(e) => setDraft({ ...draft, maxTokens: e.target.value === "" ? undefined : Number(e.target.value) })} /></label>
      </fieldset>
      <div className="flex flex-wrap gap-2"><button className="work-command bg-brand text-white" type="submit" disabled={busy}><Save size={16} />{busy ? "处理中..." : "保存连接"}</button>
        <button className="work-command" type="button" disabled={busy || dirty} onClick={() => void action(() => useWorkbenchStore.getState().testProfile(draft.id), "模型调用成功。")}><PlugZap size={16} />测试连接</button>
        <button className="work-icon" type="button" aria-label="清空表单" title="清空表单" disabled={busy} onClick={reset}><X size={16} /></button></div>
      {message && <p role="status" className="text-sm break-words">{message}</p>}
    </form>
  </div>;
}
