export interface ModelProfile {
  id: string;
  name: string;
  mode: "relay" | "local";
  baseUrl: string;
  model: string;
  maxTokens?: number;
  textTestedAt?: string;
  toolTestedAt?: string;
  hasKey: boolean;
}

export interface WorkMessage {
  finishReason?: import('@/services/modelStream').FinishReason;
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
  type: 'document.generate-markdown' | 'chart.generate' | 'office.tools' | 'workflow.run';
  workflow?: { definition: import('@/workflows/definition').WorkflowDefinition; input: import('@/workflows/definition').WorkflowInput };
  officeInput?: import('@/officeTasks/toolRunner').OfficeToolInput;
  summary?: string;
  chartInput?: import('@/officeTasks/chart').ChartInput;
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
  workflowNodeId?: string;
  finishReason?: import('@/services/modelStream').FinishReason;
  id: string;
  taskId: string;
  tool: 'model.complete' | 'document.edit' | 'document.restore' | 'document.export-docx' | 'chart.check' | 'chart.render' | 'model.tools' | `office.${import('@/officeTasks/toolProtocol').OfficeToolName}`;
  callId?: string;
  arguments?: string;
  result?: string;
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
  finishReason?: import('@/services/modelStream').FinishReason;
  id: string;
  taskId: string;
  kind: 'markdown' | 'svg';
  version: number;
  parentArtifactId?: string;
  restoredFromArtifactId?: string;
  name: string;
  mimeType: 'text/markdown' | 'image/svg+xml';
  content: string;
  sha256: string;
  createdAt: string;
}

export interface VaultData {
  workflows?: import('@/workflows/definition').WorkflowDefinition[];
  fileEditDraft?: import('@/fileOrganizer/textEdit').FileEditDraft | null;
  fileEditVersions?: import('@/fileOrganizer/textEdit').FileEditVersion[];
  personalDrafts?: import('@/personal/itemDraft').PersonalDraft[];
  reminderDrafts?: import('@/personal/reminderDraft').ReminderDraft[];
  reminderTemplates?: import('@/personal/reminderDraft').ReminderTemplate[];
  organizerRuns?: import('@/fileOrganizer/history').OrganizerRun[];
  personalItems?: import('@/personal/items').PersonalItem[];
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
