import { useCallback, useEffect, useMemo, useState } from 'react';
import { Building2, Check, Clock3, Search, ShieldCheck, UserMinus, UserPlus, X } from 'lucide-react';
import { useAuthStore } from '@/store/authStore';
import {
  createOrganization, decideOrganizationRequest, listAdminOrganizations, listMyOrganizations,
  listOrganizationCatalog, listOrganizationMembers, listOrganizationRequests, searchOrganizationUsers,
  requestOrganizationJoin, requestOrganizationLeave, setOrganizationMembership, setOrganizationRole,
  updateOrganization, type OrganizationMember, type OrganizationMembershipSummary,
  type OrganizationRequest, type OrganizationSummary,
} from '@/api/organizations';

export default function OrganizationsPage() {
  const user = useAuthStore(state => state.user);
  const [catalog, setCatalog] = useState<OrganizationSummary[]>([]);
  const [memberships, setMemberships] = useState<OrganizationMembershipSummary[]>([]);
  const [adminOrganizations, setAdminOrganizations] = useState<OrganizationSummary[]>([]);
  const [selectedId, setSelectedId] = useState<number | null>(null);
  const [members, setMembers] = useState<OrganizationMember[]>([]);
  const [requests, setRequests] = useState<OrganizationRequest[]>([]);
  const [query, setQuery] = useState('');
  const [matches, setMatches] = useState<{ id: number; username: string; email: string }[]>([]);
  const [targetUserId, setTargetUserId] = useState<number | null>(null);
  const [role, setRole] = useState<'member' | 'org_admin'>('member');
  const [newName, setNewName] = useState('');
  const [newSlug, setNewSlug] = useState('');
  const [newDescription, setNewDescription] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');
  const selected = catalog.find(item => item.id === selectedId)
    ?? adminOrganizations.find(item => item.id === selectedId) ?? null;
  const selectedMembership = memberships.find(item => item.organization.id === selectedId);
  const canManage = Boolean(user?.is_superuser || (selectedMembership?.status === 'active' && selectedMembership.role === 'org_admin'));
  const membershipByOrg = useMemo(() => new Map(memberships.map(item => [item.organization.id, item])), [memberships]);

  const refresh = useCallback(async () => {
    const [orgs, mine] = await Promise.all([listOrganizationCatalog(), listMyOrganizations()]);
    setCatalog(orgs);
    setMemberships(mine);
    if (user?.is_superuser) {
      const adminOrgs = await listAdminOrganizations();
      setAdminOrganizations(adminOrgs);
    } else setAdminOrganizations([]);
    setSelectedId(current => current ?? mine.find(item => item.status === 'active')?.organization.id ?? orgs[0]?.id ?? null);
  }, [user?.is_superuser]);

  useEffect(() => {
    let active = true;
    void refresh().catch(reason => { if (active) setError(reason instanceof Error ? reason.message : '无法加载组织信息。'); });
    return () => { active = false; };
  }, [refresh]);

  useEffect(() => {
    let active = true;
    setMembers([]); setRequests([]);
    if (selectedId && canManage) {
      void Promise.all([listOrganizationMembers(selectedId), listOrganizationRequests(selectedId)])
        .then(([items, pending]) => { if (active) { setMembers(items); setRequests(pending); } })
        .catch(() => { if (active) { setMembers([]); setRequests([]); } });
    }
    return () => { active = false; };
  }, [selectedId, canManage]);

  async function act(label: string, operation: () => Promise<unknown>, reload = true) {
    setBusy(true); setError(''); setNotice('');
    try { await operation(); if (reload) await refresh(); setNotice(label); }
    catch (reason) { setError(reason instanceof Error ? reason.message : '操作失败。'); }
    finally { setBusy(false); }
  }

  async function handleSearch() {
    if (query.trim().length < 3) { setError('请输入至少 3 个字符。'); return; }
    setBusy(true); setError('');
    try { setMatches(await searchOrganizationUsers(query.trim())); }
    catch (reason) { setError(reason instanceof Error ? reason.message : '用户查找失败。'); }
    finally { setBusy(false); }
  }

  async function handleCreate() {
    const name = newName.trim(), slug = newSlug.trim().toLowerCase();
    if (!name || !/^[a-z0-9](?:[a-z0-9-]{0,78}[a-z0-9])?$/.test(slug)) { setError('请填写名称和有效的组织标识。'); return; }
    setBusy(true); setError('');
    try {
      const created = await createOrganization({ name, slug, description: newDescription.trim() });
      setNewName(''); setNewSlug(''); setNewDescription(''); setSelectedId(created.id);
      await refresh(); setNotice('组织已创建。');
    } catch (reason) { setError(reason instanceof Error ? reason.message : '创建失败。'); }
    finally { setBusy(false); }
  }

  async function handleDecision(item: OrganizationRequest, decision: 'approve' | 'reject') {
    if (!selectedId) return;
    await act(decision === 'approve' ? '申请已批准。' : '申请已拒绝。', async () => {
      await decideOrganizationRequest(selectedId, item.userId, decision);
      const [nextMembers, nextRequests] = await Promise.all([listOrganizationMembers(selectedId), listOrganizationRequests(selectedId)]);
      setMembers(nextMembers); setRequests(nextRequests);
    }, false);
  }

  async function handleDirectMembership(active: boolean) {
    if (!selectedId || targetUserId === null) return;
    await act(active ? '成员已加入组织。' : '成员已移出组织。', () => setOrganizationMembership(selectedId, targetUserId, active, role));
    setTargetUserId(null);
  }

  async function handleRole(member: OrganizationMember) {
    if (!selectedId) return;
    const next = member.role === 'org_admin' ? 'member' : 'org_admin';
    await act(next === 'org_admin' ? '已任命组织子管理员。' : '已撤销组织子管理员。', async () => {
      await setOrganizationRole(selectedId, member.userId, next);
      setMembers(await listOrganizationMembers(selectedId));
    }, false);
  }

  return <main className="mx-auto grid w-full max-w-6xl gap-6 px-4 py-6 sm:px-6" aria-label="组织管理">
    <header className="flex items-center gap-3 border-b border-line pb-4">
      <Building2 className="h-5 w-5 text-brand" />
      <div><h1 className="text-lg font-semibold text-ink">组织</h1><p className="mt-1 text-sm text-ink-secondary">成员资格控制组织知识库、智能体和工作流的访问范围。</p></div>
    </header>

    {error && <p role="alert" className="border-l-2 border-danger px-3 py-2 text-sm text-danger">{error}</p>}
    {notice && <p role="status" className="border-l-2 border-success px-3 py-2 text-sm text-success">{notice}</p>}

    <section className="grid gap-5 lg:grid-cols-[minmax(250px,0.8fr)_minmax(0,1.5fr)]">
      <div className="grid content-start gap-2">
        <h2 className="text-sm font-semibold text-ink">可加入的组织</h2>
        {!catalog.length && <p className="text-sm text-ink-secondary">当前没有可用组织。</p>}
        {catalog.map(org => {
          const membership = membershipByOrg.get(org.id);
          const active = membership?.status === 'active';
          const pending = membership?.status === 'pending';
          return <article key={org.id} className={`grid gap-2 border p-3 ${selectedId === org.id ? 'border-brand' : 'border-line'}`}>
            <button type="button" className="text-left" onClick={() => setSelectedId(org.id)} aria-pressed={selectedId === org.id}>
              <span className="block text-sm font-medium text-ink">{org.name}</span>
              {org.description && <span className="mt-1 block text-xs text-ink-secondary">{org.description}</span>}
            </button>
            <div className="flex flex-wrap items-center justify-between gap-2 border-t border-line pt-2">
              <span className="text-xs text-ink-secondary">{active ? (membership?.role === 'org_admin' ? '组织子管理员' : '已加入') : pending ? (membership?.pendingAction === 'leave' ? '退出待审批' : '加入待审批') : '未加入'}</span>
              {active && membership?.pendingAction !== 'leave' && <button className="work-command" disabled={busy || membership.role === 'org_admin' && members.filter(item => item.role === 'org_admin' && item.status === 'active').length <= 1} onClick={() => void act('退出申请已提交。', () => requestOrganizationLeave(org.id))}>申请退出</button>}
              {pending && membership?.pendingAction === 'join' && <span className="inline-flex items-center gap-1 text-xs text-ink-secondary"><Clock3 size={13} />等待审批</span>}
              {!active && !pending && <button className="work-command" disabled={busy} onClick={() => void act('加入申请已提交。', () => requestOrganizationJoin(org.id))}><UserPlus size={14} />申请加入</button>}
            </div>
          </article>;
        })}
      </div>

      <div className="grid content-start gap-5">
        {user?.is_superuser && <section className="grid gap-3 border-b border-line pb-5">
          <h2 className="text-sm font-semibold text-ink">新建组织</h2>
          <div className="grid gap-3 sm:grid-cols-2">
            <label className="work-label">组织名称<input className="work-input" maxLength={120} value={newName} onChange={event => setNewName(event.target.value)} /></label>
            <label className="work-label">组织标识<input className="work-input" maxLength={80} value={newSlug} onChange={event => setNewSlug(event.target.value)} placeholder="example-team" /></label>
            <label className="work-label sm:col-span-2">说明<input className="work-input" maxLength={500} value={newDescription} onChange={event => setNewDescription(event.target.value)} /></label>
          </div>
          <button type="button" className="work-command justify-self-start" disabled={busy} onClick={() => void handleCreate()}><Building2 size={14} />创建组织</button>
        </section>}

        {selected && <>
          <div className="flex flex-wrap items-center justify-between gap-2 border-b border-line pb-3">
            <div><h2 className="text-sm font-semibold text-ink">{selected.name}</h2><p className="text-xs text-ink-secondary">{selected.memberCount ?? members.filter(item => item.status === 'active').length} 位成员</p></div>
            {user?.is_superuser && <button type="button" className="work-command" disabled={busy} onClick={() => void act(selected.isActive ? '组织已停用。' : '组织已启用。', () => updateOrganization(selected.id, { isActive: !selected.isActive }))}>{selected.isActive ? '停用组织' : '启用组织'}</button>}
          </div>

          {canManage && <>
            <section className="grid gap-3">
              <h3 className="text-sm font-semibold text-ink">待审批</h3>
              {!requests.length && <p className="text-sm text-ink-secondary">没有待处理申请。</p>}
              {requests.map(item => <article key={`${item.userId}:${item.action}`} className="flex flex-wrap items-center justify-between gap-3 border border-line p-3">
                <div><p className="text-sm font-medium text-ink">{item.username} · {item.action === 'join' ? '申请加入' : '申请退出'}</p><p className="text-xs text-ink-secondary">{item.email}</p></div>
                <div className="flex gap-2"><button className="work-command" disabled={busy} onClick={() => void handleDecision(item, 'approve')}><Check size={14} />批准</button><button className="work-command" disabled={busy} onClick={() => void handleDecision(item, 'reject')}><X size={14} />拒绝</button></div>
              </article>)}
            </section>
            <section className="grid gap-3 border-t border-line pt-4">
              <h3 className="text-sm font-semibold text-ink">成员</h3>
              {members.filter(item => item.status === 'active').map(member => <div key={member.userId} className="flex flex-wrap items-center justify-between gap-2 border-b border-line py-2">
                <div><p className="text-sm text-ink">{member.username} <span className="text-xs text-ink-secondary">#{member.userId}</span></p><p className="text-xs text-ink-secondary">{member.email}</p></div>
                <div className="flex items-center gap-2"><span className="text-xs text-ink-secondary">{member.role === 'org_admin' ? '组织子管理员' : '成员'}</span>{user?.is_superuser && <button type="button" className="work-icon" title={member.role === 'org_admin' ? '撤销子管理员' : '任命子管理员'} aria-label={member.role === 'org_admin' ? '撤销子管理员' : '任命子管理员'} disabled={busy} onClick={() => void handleRole(member)}><ShieldCheck size={16} /></button>}</div>
              </div>)}
            </section>
            {user?.is_superuser && <section className="grid gap-3 border-t border-line pt-4">
              <h3 className="text-sm font-semibold text-ink">总管理员直接调整成员</h3>
              <div className="flex flex-wrap gap-2"><input className="work-input min-w-0 flex-1" minLength={3} maxLength={100} value={query} onChange={event => setQuery(event.target.value)} onKeyDown={event => { if (event.key === 'Enter') void handleSearch(); }} placeholder="搜索用户名或邮箱" /><button type="button" className="work-command" disabled={busy} onClick={() => void handleSearch()}><Search size={14} />搜索</button></div>
              {matches.map(item => <button type="button" key={item.id} className={`border px-3 py-2 text-left text-sm ${targetUserId === item.id ? 'border-brand bg-muted' : 'border-line'}`} onClick={() => setTargetUserId(item.id)}>{item.username} · {item.email} · #{item.id}</button>)}
              {targetUserId !== null && <div className="flex flex-wrap items-end gap-2"><label className="work-label">加入身份<select className="work-input" value={role} onChange={event => setRole(event.target.value as 'member' | 'org_admin')}><option value="member">成员</option><option value="org_admin">组织子管理员</option></select></label><button className="work-command" disabled={busy} onClick={() => void handleDirectMembership(true)}><UserPlus size={14} />直接加入</button><button className="work-command" disabled={busy} onClick={() => void handleDirectMembership(false)}><UserMinus size={14} />直接移出</button></div>}
            </section>}
          </>}
          {!canManage && <p className="text-sm text-ink-secondary">成员目录与审批仅对组织子管理员和总管理员开放。</p>}
        </>}
      </div>
    </section>
  </main>;
}
