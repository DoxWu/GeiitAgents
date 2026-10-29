import { apiClient } from '@/api/client';
import type { AgentDefinition, PublicAgent } from '@/agents/definition';

export async function listPublicAgents(): Promise<PublicAgent[]> {
  return apiClient.get('/agents/public?limit=100', { cache: 'no-store', redirect: 'error' });
}

export async function listMyPublicAgents(): Promise<PublicAgent[]> {
  return apiClient.get('/agents/mine', { cache: 'no-store', redirect: 'error' });
}

export async function savePublicAgent(agent: AgentDefinition, organizationId: number | null = null): Promise<PublicAgent> {
  const { id: _id, sharedId, ...spec } = agent;
  const body = JSON.stringify({ agent: spec, organizationId });
  return sharedId
    ? apiClient.request(`/agents/public/${sharedId}`, { method: 'PUT', body, headers: { 'Content-Type': 'application/json' }, cache: 'no-store', redirect: 'error' })
    : apiClient.request('/agents/public', { method: 'POST', body, headers: { 'Content-Type': 'application/json' }, cache: 'no-store', redirect: 'error' });
}

export async function deletePublicAgent(sharedId: string): Promise<void> {
  await apiClient.request(`/agents/public/${sharedId}`, { method: 'DELETE', cache: 'no-store', redirect: 'error' });
}

export function copyPublicAgent(item: PublicAgent): AgentDefinition {
  const agent = { ...structuredClone(item.agent), id: crypto.randomUUID() };
  for (const resource of agent.capabilities ?? []) if (resource.fn) resource.fn.reviewed = false;
  return agent;
}
