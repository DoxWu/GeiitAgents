import type { EmbeddingProfile, LocalDocument, LocalIndex } from './core';
export type Request =
  | { id: number; type: 'init'; profile: EmbeddingProfile }
  | { id: number; type: 'build'; documents: LocalDocument[]; base: LocalIndex | null }
  | { id: number; type: 'query'; text: string };
export type Reply = { id: number; type: 'progress'; message: string }
  | { id: number; type: 'result'; result: LocalIndex | number[] | null }
  | { id: number; type: 'error'; message: string };
