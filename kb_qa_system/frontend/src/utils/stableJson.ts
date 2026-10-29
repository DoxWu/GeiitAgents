/** Compare JSON snapshots independently of object property insertion order. */
export function stableJson(value: unknown): string {
  const order = (item: unknown): unknown => Array.isArray(item) ? item.map(order)
    : item && typeof item === 'object' ? Object.fromEntries(Object.entries(item)
      .filter(([, child]) => child !== undefined).sort(([a], [b]) => a.localeCompare(b)).map(([key, child]) => [key, order(child)])) : item;
  return JSON.stringify(order(value));
}
