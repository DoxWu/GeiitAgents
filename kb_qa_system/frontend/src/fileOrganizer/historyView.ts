import type { OrganizerRun } from './history';
import type { FileEditVersion } from './textEdit';

export interface HistoryFilter { query: string; status: string }
export interface TextHistoryBatch { id: string; createdAt: string; rows: FileEditVersion[] }

function normalize(value: string) { return value.normalize('NFC').toLowerCase(); }
function includes(query: string, values: (string | undefined)[]) {
  return !query || values.some(value => value !== undefined && normalize(value).includes(query));
}
function newest<T extends { id: string; createdAt: string }>(records: T[]): T[] {
  return records.sort((a, b) => Date.parse(b.createdAt) - Date.parse(a.createdAt) || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
}
function textMatches(record: FileEditVersion, query: string, status: string) {
  return (!status || record.status === status) && includes(query, [record.name, record.directoryName, record.id, record.batch?.id, record.restoredFrom]);
}

export function selectOrganizerHistory(records: OrganizerRun[], filter: HistoryFilter): OrganizerRun[] {
  const query = normalize(filter.query.trim());
  return newest(records.filter(record => (!filter.status || record.status === filter.status) && (
    includes(query, [record.id, record.directoryName, record.destinationName, record.undoOf]) ||
    record.changes.some(change => includes(query, [change.source, change.target, change.stage]))
  )));
}
export function selectTextHistory(records: FileEditVersion[], filter: HistoryFilter): FileEditVersion[] {
  const query = normalize(filter.query.trim());
  return newest(records.filter(record => textMatches(record, query, filter.status)));
}
export function selectTextBatches(records: FileEditVersion[], filter: HistoryFilter): TextHistoryBatch[] {
  const groups = new Map<string, TextHistoryBatch>(), query = normalize(filter.query.trim());
  for (const record of records) {
    if (!record.batch) continue;
    const group = groups.get(record.batch.id) ?? { id: record.batch.id, createdAt: record.createdAt, rows: [] };
    group.rows.push(record);
    if (Date.parse(record.createdAt) > Date.parse(group.createdAt)) group.createdAt = record.createdAt;
    groups.set(group.id, group);
  }
  // Match query and status on the same file, but retain the complete batch for actions.
  return newest([...groups.values()].filter(group => group.rows.some(record => textMatches(record, query, filter.status))))
    .map(group => ({ ...group, rows: group.rows.sort((a, b) => a.batch!.index - b.batch!.index) }));
}
