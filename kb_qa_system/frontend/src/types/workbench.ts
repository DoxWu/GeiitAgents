export interface ModelProfile {
  id: string;
  name: string;
  mode: "relay" | "local";
  baseUrl: string;
  model: string;
  maxTokens?: number;
  hasKey: boolean;
}

export interface WorkMessage {
  id: string;
  role: "user" | "assistant";
  content: string;
  createdAt: string;
  model?: string;
}

export interface WorkConversation {
  kind?: 'knowledge-answer';
  id: string;
  title: string;
  profileId: string;
  messages: WorkMessage[];
  updatedAt: string;
}

export type TaskStatus = 'running' | 'succeeded' | 'failed' | 'cancelled' | 'interrupted';

export interface TaskRun {
  id: string;
  type: 'document.generate-markdown';
  title: string;
  profileId: string;
  instruction: string;
  sourceName?: string;
  sourceContent?: string;
  status: TaskStatus;
  createdAt: string;
  updatedAt: string;
  error?: string;
  toolRunIds: string[];
  artifactIds: string[];
}

export interface ToolRun {
  id: string;
  taskId: string;
  tool: 'model.complete' | 'document.edit' | 'document.restore' | 'document.export-docx';
  sourceArtifactId?: string;
  previousArtifactId?: string;
  outputArtifactId?: string;
  outputSha256?: string;
  outputName?: string;
  converterVersion?: string;
  warnings?: string[];
  status: TaskStatus;
  model?: string;
  startedAt: string;
  finishedAt?: string;
  error?: string;
}

export interface WorkArtifact {
  id: string;
  taskId: string;
  kind: 'markdown';
  version: number;
  parentArtifactId?: string;
  restoredFromArtifactId?: string;
  name: string;
  mimeType: 'text/markdown';
  content: string;
  sha256: string;
  createdAt: string;
}

export interface VaultData {
  profiles: (Omit<ModelProfile, "hasKey"> & { apiKey: string })[];
  conversations: WorkConversation[];
  taskRuns?: TaskRun[];
  toolRuns?: ToolRun[];
  artifacts?: WorkArtifact[];
}

export interface LocalDocument {
  name: string;
  content: string;
}
