import { apiClient } from '@/api/client';
import { workflowHasLocalMcp } from '@/agents/capabilities';

export interface OrganizationSummary {
  id: number;
  name: string;
  slug: string;
  description: string;
  isActive: boolean;
  memberCount?: number;
  role?: 'member' | 'org_admin';
}

export interface OrganizationMembershipSummary {
  organization: OrganizationSummary;
  role: 'member' | 'org_admin';
  status: 'active' | 'pending';
  pendingAction: 'join' | 'leave' | null;
  requestedAt: string;
}

export interface OrganizationMember {
  userId: number;
  username: string;
  email: string;
  role: 'member' | 'org_admin';
  status: 'active' | 'pending';
  pendingAction: 'join' | 'leave' | null;
}

export interface OrganizationRequest {
  userId: number;
  username: string;
  email: string;
  action: 'join' | 'leave';
  requestedAt: string;
}

export interface OrganizationWorkflowTemplate {
  id: string;
  organizationId: number;
  name: string;
  definition: unknown;
  ownerId: number;
  updatedAt: string;
}

const requestOptions = { cache: 'no-store' as RequestCache, redirect: 'error' as RequestRedirect };

export function listOrganizationCatalog(): Promise<OrganizationSummary[]> {
  return apiClient.get('/organizations/catalog', requestOptions);
}

export function listMyOrganizations(): Promise<OrganizationMembershipSummary[]> {
  return apiClient.get('/organizations/mine', requestOptions);
}

export function listAdminOrganizations(): Promise<OrganizationSummary[]> {
  return apiClient.get('/organizations/admin', requestOptions);
}

export function createOrganization(body: Pick<OrganizationSummary, 'name' | 'slug' | 'description'>): Promise<OrganizationSummary> {
  return apiClient.post('/organizations', body, requestOptions);
}

export function updateOrganization(id: number, body: Partial<Pick<OrganizationSummary, 'name' | 'description' | 'isActive'>>): Promise<OrganizationSummary> {
  return apiClient.request(`/organizations/${id}`, { ...requestOptions, method: 'PATCH', body: JSON.stringify(body), headers: { 'Content-Type': 'application/json' } });
}

export function requestOrganizationJoin(id: number): Promise<unknown> {
  return apiClient.post(`/organizations/${id}/join`, {}, requestOptions);
}

export function requestOrganizationLeave(id: number): Promise<unknown> {
  return apiClient.post(`/organizations/${id}/leave`, {}, requestOptions);
}

export function listOrganizationMembers(id: number): Promise<OrganizationMember[]> {
  return apiClient.get(`/organizations/${id}/members`, requestOptions);
}

export function listOrganizationRequests(id: number): Promise<OrganizationRequest[]> {
  return apiClient.get(`/organizations/${id}/requests`, requestOptions);
}

export function decideOrganizationRequest(id: number, userId: number, decision: 'approve' | 'reject'): Promise<unknown> {
  return apiClient.post(`/organizations/${id}/requests/${userId}`, { decision }, requestOptions);
}

export function searchOrganizationUsers(query: string): Promise<{ id: number; username: string; email: string }[]> {
  return apiClient.get(`/organizations/search-users?q=${encodeURIComponent(query)}`, requestOptions);
}

export function setOrganizationMembership(id: number, userId: number, active: boolean, role: 'member' | 'org_admin' = 'member'): Promise<unknown> {
  return apiClient.request(`/organizations/${id}/members/${userId}`, { ...requestOptions, method: 'PUT', body: JSON.stringify({ active, role }), headers: { 'Content-Type': 'application/json' } });
}

export function setOrganizationRole(id: number, userId: number, role: 'member' | 'org_admin'): Promise<unknown> {
  return apiClient.request(`/organizations/${id}/members/${userId}/role`, { ...requestOptions, method: 'PUT', body: JSON.stringify({ role }), headers: { 'Content-Type': 'application/json' } });
}

export function listOrganizationWorkflows(id: number): Promise<OrganizationWorkflowTemplate[]> {
  return apiClient.get(`/organizations/${id}/workflows`, requestOptions);
}

export function publishOrganizationWorkflow(id: number, name: string, definition: unknown): Promise<OrganizationWorkflowTemplate> {
  if (workflowHasLocalMcp(definition as Parameters<typeof workflowHasLocalMcp>[0])) throw new Error('含本机 MCP 的工作流只能保存在个人私有仓库。');
  return apiClient.post(`/organizations/${id}/workflows`, { name, definition }, requestOptions);
}

export function updateOrganizationWorkflow(id: number, workflowId: string, name: string, definition: unknown): Promise<OrganizationWorkflowTemplate> {
  if (workflowHasLocalMcp(definition as Parameters<typeof workflowHasLocalMcp>[0])) throw new Error('含本机 MCP 的工作流只能保存在个人私有仓库。');
  return apiClient.request(`/organizations/${id}/workflows/${workflowId}`, { ...requestOptions, method: 'PUT', body: JSON.stringify({ name, definition }), headers: { 'Content-Type': 'application/json' } });
}

export function deleteOrganizationWorkflow(id: number, workflowId: string): Promise<void> {
  return apiClient.request(`/organizations/${id}/workflows/${workflowId}`, { ...requestOptions, method: 'DELETE' });
}
