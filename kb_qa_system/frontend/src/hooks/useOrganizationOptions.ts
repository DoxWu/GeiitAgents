import { useEffect, useState } from 'react';
import { listAdminOrganizations, listMyOrganizations, type OrganizationSummary } from '@/api/organizations';
import { useAuthStore } from '@/store/authStore';

export function useOrganizationOptions(): OrganizationSummary[] {
  const user = useAuthStore(state => state.user);
  const userId = user?.id;
  const isSuperuser = Boolean(user?.is_superuser);
  const [organizations, setOrganizations] = useState<OrganizationSummary[]>([]);

  useEffect(() => {
    let current = true;
    setOrganizations([]);
    if (userId === undefined) return () => { current = false; };
    const load = isSuperuser
      ? listAdminOrganizations().then(rows => rows.map(item => ({ ...item, role: 'org_admin' as const })))
      : listMyOrganizations().then(rows => rows.filter(row => row.status === 'active').map(row => ({ ...row.organization, role: row.role })));
    void load.then(rows => {
      if (current) setOrganizations(rows.filter(item => item.isActive));
    }).catch(() => {
      if (current) setOrganizations([]);
    });
    return () => { current = false; };
  }, [userId, isSuperuser]);

  return organizations;
}
