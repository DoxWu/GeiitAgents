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
  id: string;
  title: string;
  profileId: string;
  messages: WorkMessage[];
  updatedAt: string;
}

export interface VaultData {
  profiles: (Omit<ModelProfile, "hasKey"> & { apiKey: string })[];
  conversations: WorkConversation[];
}

export interface LocalDocument {
  name: string;
  content: string;
}
