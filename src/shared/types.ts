export type MediaKind = "image" | "video" | "audio" | "subtitle" | "document";
export type JobStatus =
  | "queued"
  | "running"
  | "succeeded"
  | "failed"
  | "cancelled"
  | "needs_review";
export type ToolInput = Record<string, string | number | boolean | string[]>;
export interface User {
  id: string;
  email: string;
  name: string;
  profile: Record<string, string>;
}
export interface Asset {
  id: string;
  name: string;
  kind: MediaKind;
  mime: string;
  size: number;
  duration: number | null;
  width: number | null;
  height: number | null;
  tags: string[];
  source: string;
  createdAt: string;
  deletedAt: string | null;
  url: string;
  thumbnailUrl?: string;
  metadata: Record<string, unknown>;
}
export interface Project {
  id: string;
  name: string;
  description: string;
  market: string;
  brand: string;
  createdAt: string;
  updatedAt: string;
  archivedAt: string | null;
}
export interface Field {
  key: string;
  label: string;
  type: "text" | "textarea" | "number" | "select" | "boolean" | "assets";
  required?: boolean;
  placeholder?: string;
  help?: string;
  default?: string | number | boolean | string[];
  options?: { value: string; label: string }[];
  min?: number;
  max?: number;
  maxLength?: number;
  accepts?: MediaKind[];
  maxBytes?: number;
  maxDuration?: number;
}
export interface Tool {
  id: string;
  title: string;
  description: string;
  category: string;
  icon: string;
  capability: string;
  output: MediaKind | "analysis";
  fields: Field[];
  availability?: "local" | "configured" | "not_configured";
  providerIds?: string[];
  note?: string;
}
export interface Job {
  id: string;
  batchId: string;
  toolId: string;
  title: string;
  projectId: string | null;
  status: JobStatus;
  progress: number;
  input: ToolInput;
  error: string | null;
  errorCode: string | null;
  result: unknown;
  createdAt: string;
  updatedAt: string;
  cancelRequested: boolean;
  outputs: Asset[];
  events?: { id: number; message: string; createdAt: string }[];
}
export interface ProviderPublic {
  id: string;
  name: string;
  kind: ProviderKind;
  baseUrl: string;
  model: string;
  models: Record<string, string>;
  capabilities: string[];
  verifiedCapabilities?: string[];
  configured: boolean;
  status: "configured_unverified" | "verified" | "not_configured";
  voices: { id: string; name: string; language?: string; gender?: string }[];
  avatars: {
    id: string;
    name: string;
    gender?: string;
    scene?: string;
    imageUrl?: string;
  }[];
  updatedAt: string;
}
export type ProviderKind =
  | "openai"
  | "ark"
  | "elevenlabs"
  | "heygen"
  | "workflow";
export interface ProviderConfig
  extends Omit<ProviderPublic, "configured" | "status" | "updatedAt"> {
  apiKey: string;
  options?: Record<string, unknown>;
}
export interface ExecutionAsset {
  id: string;
  name: string;
  path: string;
  kind: MediaKind;
  mime: string;
  size: number;
  duration: number | null;
  width: number | null;
  height: number | null;
  metadata?: Record<string, unknown>;
}
export interface GeneratedArtifact {
  path: string;
  kind: MediaKind;
  mime: string;
  name: string;
  metadata?: Record<string, unknown>;
}
export interface ExecutionResult {
  artifacts: GeneratedArtifact[];
  result?: unknown;
  usage?: Record<string, unknown>;
}
export interface ExecutionContext {
  jobId: string;
  toolId: string;
  input: ToolInput;
  assets: ExecutionAsset[];
  outputDir: string;
  signal: AbortSignal;
  provider?: ProviderConfig;
  remoteTaskId?: string;
  onProgress: (progress: number, message: string) => void | Promise<void>;
  onRemoteTask: (
    id: string,
    metadata?: Record<string, unknown>,
  ) => void | Promise<void>;
  isCancellationRequested: () => boolean;
}
export interface RadarAsset {
  id: string;
  title: string;
  brand: string;
  country: string;
  industry: string;
  objective: string;
  format: string;
  sourceUrl: string;
  assetId: string | null;
  likes: number | null;
  shares: number | null;
  comments: number | null;
  ctr: number | null;
  budget: number | null;
  metrics: {
    time: number;
    retention?: number;
    clicks?: number;
    ctr?: number;
    conversions?: number;
    cvr?: number;
  }[];
  favorite: boolean;
  createdAt: string;
  asset?: Asset;
}
export interface Draft {
  id: string;
  title: string;
  toolId: string;
  projectId: string | null;
  input: ToolInput;
  updatedAt: string;
}
export interface Conversation {
  id: string;
  title: string;
  createdAt: string;
  updatedAt: string;
  messages?: {
    id: string;
    role: "user" | "assistant";
    content: string;
    createdAt: string;
    jobId?: string | null;
  }[];
  jobs?: Job[];
}
