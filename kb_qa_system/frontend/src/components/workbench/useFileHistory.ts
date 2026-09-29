import { useMemo, useState } from 'react';
import type { HistoryFilter } from '@/fileOrganizer/historyView';

export const FILE_HISTORY_PAGE_SIZE = 10;
export function useFileHistory<T, Row>(records: T[], select: (records: T[], filter: HistoryFilter) => Row[]) {
  const [filter, setFilter] = useState<HistoryFilter>({ query: '', status: '' });
  const [requestedPage, setPage] = useState(1);
  const matches = useMemo(() => select(records, filter), [records, filter, select]);
  const pages = Math.max(1, Math.ceil(matches.length / FILE_HISTORY_PAGE_SIZE));
  const page = Math.min(Math.max(1, requestedPage), pages);
  // Persist the clamped page when deletion removes the last page, so later inserts
  // cannot unexpectedly return the user to that removed page.
  if (page !== requestedPage) setPage(page);
  return {
    ...filter, page, pages, total: matches.length,
    rows: matches.slice((page - 1) * FILE_HISTORY_PAGE_SIZE, page * FILE_HISTORY_PAGE_SIZE),
    setPage,
    changeFilter: (next: HistoryFilter) => { setFilter(next); setPage(1); },
  };
}
