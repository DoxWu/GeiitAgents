export type ModelCapabilityState = 'unknown' | 'supported' | 'unsupported';

export interface ModelCapabilityEvidence {
  state: ModelCapabilityState;
  testedAt?: string;
  fingerprint?: string;
  value?: number;
}

export interface ModelCapabilities {
  text?: ModelCapabilityEvidence;
  toolCalls?: ModelCapabilityEvidence;
  vision?: ModelCapabilityEvidence;
  contextWindow?: ModelCapabilityEvidence;
  maxOutputTokens?: ModelCapabilityEvidence;
}

export interface ModelProfile {
  id: string;
  name: string;
  mode: "relay" | "local";
  baseUrl: string;
  model: string;
  maxTokens?: number;
  textTestedAt?: string;
  toolTestedAt?: string;
  capabilities?: ModelCapabilities;
  hasKey: boolean;
}

export interface WorkMessage {
  finishReason?: import('@/services/modelStream').FinishReason;
  id: string;
  role: "user" | "assistant";
  content: string;
  images?: WorkImage[];
  createdAt: string;
  model?: string;
}

export interface WorkImage {
  name: string;
  mimeType: 'image/png' | 'image/jpeg' | 'image/webp';
  dataUrl: string;
  bytes: number;
}

export interface ModelImagePart {
  type: 'text' | 'image_url';
  text?: string;
  image_url?: { url: string };
}

export type ModelMessageContent = string | ModelImagePart[];

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
  chartReview?: {
    profileId: string;
    model: string;
    answer: string;
    reviewedAt: string;
    imageSha256: string;
    artifactSha256: string;
  };
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
  resumedFromTaskId?: string;
  resumeFromNodeId?: string;
}

export interface ToolRun {
  workflowNodeId?: string;
  finishReason?: import('@/services/modelStream').FinishReason;
  id: string;
  taskId: string;
  tool: 'model.complete' | 'workflow.condition' | 'document.edit' | 'document.restore' | 'document.export-docx' | 'chart.check' | 'chart.render' | 'model.tools' | `office.${import('@/officeTasks/toolProtocol').OfficeToolName}`;
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
  workflowDraft?: import('@/workflows/definition').WorkflowDefinition | null;
  workflowSchedules?: import('@/workflows/schedule').WorkflowSchedule[];
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
