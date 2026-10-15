import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { Store } from "../src/server/db.js";
import { now, uid } from "../src/server/core.js";
import { createJobs } from "../src/server/jobs.js";
import type { ToolInput } from "../src/shared/types.js";
import {
  getProviderLimits,
  validateProviderLimits,
  type LimitAsset,
  type LimitProvider,
} from "../src/shared/provider-limits.js";

const p = (
  kind: LimitProvider["kind"],
  model: string,
  capabilities: string[],
): LimitProvider => ({ kind, model, capabilities, models: {} });
const image: LimitAsset = {
  kind: "image",
  width: 640,
  height: 640,
  size: 1024,
  duration: null,
};
const audio: LimitAsset = {
  kind: "audio",
  width: null,
  height: null,
  size: 1024,
  duration: 3,
};
const video: LimitAsset = { ...image, kind: "video", duration: 5 };

describe("shared adapter profiles", () => {
  it("exposes Ark mode-dependent choices without claiming unknown model support", () => {
    const unknown = getProviderLimits(
      p("ark", "private-endpoint-2-5-alias", ["video.task"]),
      "video-studio",
      { mode: "reference" },
    );
    expect(unknown.fields.duration.max).toBe(15);
    expect(unknown.fields.sourceIds.max).toBe(9);
    expect(unknown.fields.audioIds.max).toBe(3);
    expect(unknown.fields.videoIds.visible).toBe(false);
    expect(unknown.warnings.join(" ")).toContain("没有推断");
    const known = getProviderLimits(
      p("ark", "doubao-seedance-2-5-pro", ["video.task"]),
      "image-video",
      {},
    );
    expect(known.fields.duration.max).toBe(30);
    expect(known.fields.ratio.choices).toEqual(["auto"]);
  });
  it("rejects incompatible Ark ratios, noninteger durations and local video references", () => {
    const config = p("ark", "doubao-seedance-2-0-260128", ["video.task"]);
    for (const input of [
      { ratio: "2:3" },
      { duration: 16 },
      { duration: 4.5 },
    ] as ToolInput[])
      expect(() =>
        validateProviderLimits(config, "text-video", input),
      ).toThrow();
    expect(() =>
      validateProviderLimits(config, "video-studio", { mode: "reference" }, [
        video,
      ]),
    ).toThrow(/本机参考视频/);
    expect(() =>
      validateProviderLimits(config, "text-video", {
        duration: 15,
        ratio: "9:16",
      }),
    ).not.toThrow();
  });
  it("checks Ark reference combinations and dimensions from probed assets", () => {
    const config = p("ark", "doubao-seedance-2-0-260128", ["video.task"]);
    for (const [mode, refs] of [
      ["text", [image]],
      ["first-last", []],
      ["first-last", [image, audio]],
      ["reference", [audio]],
      ["reference", Array(10).fill(image)],
      ["reference", [image, ...Array(4).fill(audio)]],
    ] as [string, LimitAsset[]][])
      expect(() =>
        validateProviderLimits(config, "video-studio", { mode }, refs),
      ).toThrow();
    expect(() =>
      validateProviderLimits(config, "video-studio", { mode: "reference" }, [
        { ...image, width: 200 },
      ]),
    ).toThrow(/300–6000/);
    expect(() =>
      validateProviderLimits(config, "video-studio", { mode: "reference" }, [
        image,
        audio,
      ]),
    ).not.toThrow();
    expect(() =>
      validateProviderLimits(config, "image-video", { ratio: "auto" }, [
        image,
        image,
      ]),
    ).not.toThrow();
  });
  it("applies the recognized Ark 2.5 first-last profile and model-specific override", () => {
    const config = {
      ...p("ark", "private-default", ["video.task"]),
      models: { "video.task": "dreamina-seedance-2-5-pro" },
    };
    expect(() =>
      validateProviderLimits(
        config,
        "image-video",
        { duration: 30, ratio: "auto" },
        [image],
      ),
    ).not.toThrow();
    expect(() =>
      validateProviderLimits(
        config,
        "image-video",
        { duration: 30, ratio: "9:16" },
        [image],
      ),
    ).toThrow(/首帧比例/);
  });
  it("shares HeyGen quality, aspect and motion-engine restrictions", () => {
    const config = p("heygen", "avatar_v", ["avatar.photo"]);
    expect(
      getProviderLimits(config, "custom-avatar", {}).fields.prompt.visible,
    ).toBe(false);
    expect(() =>
      validateProviderLimits(config, "custom-avatar", { prompt: "wave" }),
    ).toThrow(/Avatar IV/);
    expect(() =>
      validateProviderLimits(config, "custom-avatar", {
        quality: "professional",
      }),
    ).toThrow(/专业模式/);
    expect(() =>
      validateProviderLimits(config, "custom-avatar", { ratio: "21:9" }),
    ).toThrow(/画幅范围/);
    expect(() =>
      validateProviderLimits(
        { ...config, model: "avatar_iv" },
        "custom-avatar",
        { prompt: "wave", quality: "standard", ratio: "9:16" },
      ),
    ).not.toThrow();
    expect(() =>
      validateProviderLimits(
        { ...config, model: "unknown-engine" },
        "custom-avatar",
        {},
      ),
    ).toThrow(/有效的 HeyGen/);
  });
  it("does not accept replacement voices for the HeyGen translation profile", () => {
    const config = p("heygen", "", ["video.translate"]);
    expect(
      getProviderLimits(config, "video-translate", {}).fields.voice.visible,
    ).toBe(false);
    expect(() =>
      validateProviderLimits(config, "video-translate", { voice: "custom" }),
    ).toThrow(/保留原声/);
    expect(() =>
      validateProviderLimits(config, "video-translate", {}),
    ).not.toThrow();
  });
  it("restricts ElevenLabs speed using the selected capability model", () => {
    const config = p("elevenlabs", "eleven_multilingual_v2", [
      "speech",
      "voice.clone",
    ]);
    expect(() =>
      validateProviderLimits(config, "tts", { speed: 0.7 }),
    ).not.toThrow();
    expect(() =>
      validateProviderLimits(config, "tts", { speed: 1.3 }),
    ).toThrow();
    config.models.speech = "eleven_v3";
    expect(getProviderLimits(config, "tts", {}).fields.speed).toMatchObject({
      min: 1,
      max: 1,
      disabled: true,
    });
    expect(() =>
      validateProviderLimits(config, "tts", { speed: 0.9 }),
    ).toThrow();
    expect(() =>
      validateProviderLimits(config, "voice-clone", { speed: 0.9 }),
    ).not.toThrow();
  });
  it("requires a timestamp ASR model before recognition", () => {
    const config = p("openai", "gpt-4o-transcribe", ["transcription"]);
    expect(() => validateProviderLimits(config, "subtitles", {})).toThrow(
      /分段时间码/,
    );
    expect(() =>
      validateProviderLimits(
        { ...config, options: { timestampTranscription: true } },
        "subtitles",
        {},
      ),
    ).not.toThrow();
    expect(() =>
      validateProviderLimits(
        { ...config, model: "whisper-1" },
        "subtitles",
        {},
      ),
    ).not.toThrow();
  });
  it("requires chat capability and model before a paid cross-language ASR call", () => {
    const config = p("openai", "", ["transcription"]);
    config.models.transcription = "whisper-1";
    const input = { language: "英语", targetLanguage: "中文" };
    expect(
      getProviderLimits(config, "subtitles", input).fields.targetLanguage
        .disabled,
    ).toBe(true);
    expect(() => validateProviderLimits(config, "subtitles", input)).toThrow(
      /尚未调用识别服务/,
    );
    config.capabilities.push("chat");
    expect(() => validateProviderLimits(config, "subtitles", input)).toThrow(
      /chat/,
    );
    config.models.chat = "configured-chat-model";
    expect(() =>
      validateProviderLimits(config, "subtitles", input),
    ).not.toThrow();
    expect(
      getProviderLimits(config, "subtitles", input).fields.targetLanguage
        .disabled,
    ).toBe(false);
    expect(() =>
      validateProviderLimits(
        p("openai", "whisper-1", ["transcription", "chat"]),
        "subtitles",
        input,
      ),
    ).toThrow(/chat/);
  });
  it("allows original-language transcription without a chat provider", () => {
    const config = p("openai", "whisper-1", ["transcription"]);
    for (const targetLanguage of [undefined, "original", "英语"])
      expect(() =>
        validateProviderLimits(config, "subtitles", {
          language: "英语",
          ...(targetLanguage ? { targetLanguage } : {}),
        }),
      ).not.toThrow();
  });
  it("does not impose direct-provider restrictions on custom workflow parameters", () => {
    const config = p("workflow", "my-adapter", ["workflow:product-avatar"]);
    expect(getProviderLimits(config, "product-avatar", {}).fields).toEqual({});
    expect(() =>
      validateProviderLimits(config, "product-avatar", {
        ratio: "21:9",
        speed: 2,
      }),
    ).not.toThrow();
  });
});

describe("job creation preflight with persisted media metadata", () => {
  let directory: string;
  let store: Store;
  let owner: string;
  beforeEach(async () => {
    directory = await mkdtemp(join(tmpdir(), "crosscut-profile-"));
    store = new Store(directory);
    owner = uid();
    store.run(
      "INSERT INTO users VALUES(?,?,?,?,?,?)",
      owner,
      "fixture@example.test",
      "Fixture",
      "unused",
      "{}",
      now(),
    );
  });
  afterEach(async () => {
    store.close();
    await rm(directory, { recursive: true, force: true });
  });
  const addProvider = (config: LimitProvider) => {
    const id = uid();
    store.run(
      "INSERT INTO providers(id,owner_id,name,kind,config,secret,updated_at) VALUES(?,?,?,?,?,?,?)",
      id,
      owner,
      "Offline profile fixture",
      config.kind,
      JSON.stringify({
        ...config,
        baseUrl: "https://fixture.example.test",
        voices: [],
        avatars: [],
      }),
      store.storage.encrypt("synthetic-fixture-key"),
      now(),
    );
    return id;
  };
  const addVideo = (duration: number) => {
    const id = uid();
    // Job preflight consumes trusted probe metadata. No fake file is executed.
    store.run(
      "INSERT INTO assets(id,owner_id,name,kind,mime,size,duration,width,height,storage_key,sha256,created_at) VALUES(?,?,?,?,?,?,?,?,?,?,?,?)",
      id,
      owner,
      "Probed metadata fixture",
      "video",
      "video/mp4",
      1024,
      duration,
      640,
      640,
      `fixture-${id}.mp4`,
      "fixture-hash",
      now(),
    );
    return id;
  };
  it("persists the exact 15.5-second reference duration and rejects follow above 60 seconds", () => {
    const providerId = addProvider(
      p("workflow", "custom-workflow", ["workflow:replication"]),
    );
    const sourceId = addVideo(15.5);
    const result = createJobs(store, owner, {
      toolId: "replication",
      providerId,
      idempotencyKey: uid(),
      input: {
        sourceIds: [sourceId],
        productName: "Cup",
        sellingPoints: "Lightweight",
        durationMode: "follow",
        duration: 999,
      },
    });
    expect(result.items[0].input).toMatchObject({
      durationMode: "follow",
      duration: 15.5,
    });
    const persisted = JSON.parse(
      String(
        store.get("SELECT input FROM jobs WHERE id=?", result.items[0].id)
          ?.input,
      ),
    );
    expect(persisted.duration).toBe(15.5);
    expect(() =>
      createJobs(store, owner, {
        toolId: "replication",
        providerId,
        idempotencyKey: uid(),
        input: {
          sourceIds: [addVideo(60.1)],
          productName: "Cup",
          sellingPoints: "Lightweight",
          durationMode: "follow",
        },
      }),
    ).toThrow(/4–60 秒/);
    expect(store.get("SELECT count(*) n FROM jobs")?.n).toBe(1);
  });
  it("rejects subtitle translation without chat before enqueueing a paid recognition task", () => {
    const config = {
      ...p("openai", "", ["transcription"]),
      models: { transcription: "whisper-1" } as Record<string, string>,
    };
    const providerId = addProvider(config);
    const sourceId = addVideo(15.5);
    const request = {
      toolId: "subtitles",
      providerId,
      idempotencyKey: uid(),
      input: {
        sourceIds: [sourceId],
        language: "英语",
        targetLanguage: "中文",
      },
    };
    expect(() => createJobs(store, owner, request)).toThrow(/尚未调用识别服务/);
    expect(store.get("SELECT count(*) n FROM jobs")?.n).toBe(0);
    config.capabilities.push("chat");
    config.models.chat = "configured-chat-model";
    store.run(
      "UPDATE providers SET config=? WHERE id=?",
      JSON.stringify({
        ...config,
        baseUrl: "https://fixture.example.test",
        voices: [],
        avatars: [],
      }),
      providerId,
    );
    expect(
      createJobs(store, owner, request).items[0].input.targetLanguage,
    ).toBe("中文");
  });
  it("rejects unsupported Ark duration before creating any batch or job", () => {
    const providerId = addProvider(
      p("ark", "doubao-seedance-2-0-260128", ["video.task"]),
    );
    expect(() =>
      createJobs(store, owner, {
        toolId: "text-video",
        providerId,
        idempotencyKey: uid(),
        input: { prompt: "cup", duration: 16 },
      }),
    ).toThrow(/时长/);
    expect(store.get("SELECT count(*) n FROM jobs")?.n).toBe(0);
    expect(store.get("SELECT count(*) n FROM batches")?.n).toBe(0);
  });
});
