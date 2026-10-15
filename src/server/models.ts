import type {
  Asset,
  Project,
  Job,
  ProviderPublic,
  ProviderConfig,
  Conversation,
  User,
  ToolInput,
  RadarAsset,
} from "../shared/types.js";
import { Store, type Row } from "./db.js";
import { AppError, parseJson } from "./core.js";
export function owned(
  store: Store,
  table:
    | "assets"
    | "projects"
    | "jobs"
    | "providers"
    | "drafts"
    | "conversations"
    | "radar_assets"
    | "analyses",
  id: string,
  userId: string,
): Row {
  const row = store.get(
    `SELECT * FROM ${table} WHERE id=? AND owner_id=?`,
    id,
    userId,
  );
  if (!row) throw new AppError(404, "NOT_FOUND", "内容不存在或你没有访问权限");
  return row;
}
export function userView(r: Row): User {
  return {
    id: String(r.id),
    email: String(r.email),
    name: String(r.name),
    profile: parseJson(r.profile, {}),
  };
}
export function assetView(r: Row): Asset {
  return {
    id: String(r.id),
    name: String(r.name),
    kind: r.kind as Asset["kind"],
    mime: String(r.mime),
    size: Number(r.size),
    duration: r.duration === null ? null : Number(r.duration),
    width: r.width === null ? null : Number(r.width),
    height: r.height === null ? null : Number(r.height),
    tags: parseJson(r.tags, []),
    source: String(r.source),
    metadata: parseJson(r.metadata, {}),
    createdAt: String(r.created_at),
    deletedAt: r.deleted_at as string | null,
    url: `/api/assets/${r.id}/file`,
    ...(r.thumbnail_key
      ? { thumbnailUrl: `/api/assets/${r.id}/thumbnail` }
      : {}),
  };
}
export function projectView(r: Row): Project {
  return {
    id: String(r.id),
    name: String(r.name),
    description: String(r.description),
    market: String(r.market),
    brand: String(r.brand),
    createdAt: String(r.created_at),
    updatedAt: String(r.updated_at),
    archivedAt: r.archived_at as string | null,
  };
}
export function jobView(store: Store, r: Row, events = false): Job {
  return {
    id: String(r.id),
    batchId: String(r.batch_id),
    toolId: String(r.tool_id),
    title: String(r.title),
    projectId: r.project_id as string | null,
    status: r.status as Job["status"],
    progress: Number(r.progress),
    input: parseJson<ToolInput>(r.input, {}),
    error: r.error as string | null,
    errorCode: r.error_code as string | null,
    result: parseJson(r.result, null),
    createdAt: String(r.created_at),
    updatedAt: String(r.updated_at),
    cancelRequested: !!r.cancel_requested,
    outputs: store
      .all(
        "SELECT a.* FROM assets a JOIN job_assets ja ON ja.asset_id=a.id WHERE ja.job_id=? AND ja.role='output'",
        r.id,
      )
      .map(assetView),
    ...(events
      ? {
          events: store
            .all("SELECT * FROM job_events WHERE job_id=? ORDER BY id", r.id)
            .map((e) => ({
              id: Number(e.id),
              message: String(e.message),
              createdAt: String(e.created_at),
            })),
        }
      : {}),
  };
}
export function providerView(r: Row): ProviderPublic {
  const c = parseJson<
    Omit<ProviderPublic, "id" | "configured" | "status" | "updatedAt">
  >(r.config, {
    name: String(r.name),
    kind: r.kind as ProviderPublic["kind"],
    baseUrl: "",
    model: "",
    models: {},
    capabilities: [],
    voices: [],
    avatars: [],
  });
  return {
    ...c,
    id: String(r.id),
    name: String(r.name),
    kind: r.kind as ProviderPublic["kind"],
    configured: !!r.secret,
    status: !r.secret
      ? "not_configured"
      : r.verified
        ? "verified"
        : "configured_unverified",
    updatedAt: String(r.updated_at),
  };
}
export function providerSecret(store: Store, r: Row): ProviderConfig {
  const c = providerView(r);
  return {
    id: c.id,
    name: c.name,
    kind: c.kind,
    baseUrl: c.baseUrl,
    model: c.model,
    models: c.models,
    capabilities: c.capabilities,
    voices: c.voices,
    avatars: c.avatars,
    apiKey: r.secret ? store.storage.decrypt(String(r.secret)) : "",
  };
}
export function conversationView(r: Row): Conversation {
  return {
    id: String(r.id),
    title: String(r.title),
    createdAt: String(r.created_at),
    updatedAt: String(r.updated_at),
  };
}
export function radarView(store: Store, r: Row, userId: string): RadarAsset {
  return {
    id: String(r.id),
    title: String(r.title),
    brand: String(r.brand),
    country: String(r.country),
    industry: String(r.industry),
    objective: String(r.objective),
    format: String(r.format),
    sourceUrl: String(r.source_url),
    assetId: r.asset_id as string | null,
    likes: r.likes === null ? null : Number(r.likes),
    shares: r.shares === null ? null : Number(r.shares),
    comments: r.comments === null ? null : Number(r.comments),
    ctr: r.ctr === null ? null : Number(r.ctr),
    budget: r.budget === null ? null : Number(r.budget),
    metrics: parseJson(r.metrics, []),
    favorite: !!store.get(
      "SELECT radar_id FROM favorites WHERE user_id=? AND radar_id=?",
      userId,
      r.id,
    ),
    createdAt: String(r.created_at),
    ...(r.asset_id
      ? { asset: assetView(owned(store, "assets", String(r.asset_id), userId)) }
      : {}),
  };
}
