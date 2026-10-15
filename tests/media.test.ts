import { execFile } from "node:child_process";
import {
  mkdtemp,
  mkdir,
  readFile,
  readdir,
  rm,
  writeFile,
  copyFile,
} from "node:fs/promises";
import { randomUUID } from "node:crypto";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import sharp from "sharp";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  extractAudio,
  extractFrames,
  probeMedia,
  runMediaTask,
} from "../src/server/media.js";
import type {
  ExecutionAsset,
  ExecutionContext,
  ToolInput,
} from "../src/shared/types.js";
import { SUBTITLE_STYLES } from "../src/shared/subtitle-styles.js";
import { findTool, validateInput } from "../src/shared/catalog.js";
import { Store } from "../src/server/db.js";
import { saveAsset } from "../src/server/assets.js";

const exec = promisify(execFile);
const ff = process.env.FFMPEG_PATH || "ffmpeg";
let root: string;
let videos: ExecutionAsset[] = [];
let sequence = 0;

async function asset(file: string, id: string): Promise<ExecutionAsset> {
  const info = await probeMedia(file);
  return {
    id,
    name: path.basename(file),
    path: file,
    kind: info.kind,
    mime: info.mime,
    size: (await readFile(file)).length,
    duration: info.duration,
    width: info.width,
    height: info.height,
  };
}
async function context(
  toolId: string,
  input: ToolInput,
  assets = videos,
  signal = new AbortController().signal,
): Promise<ExecutionContext> {
  const outputDir = path.join(root, `输出 ${sequence++}`);
  await mkdir(outputDir);
  return {
    jobId: "reproducible-job-17",
    toolId,
    input,
    assets,
    outputDir,
    signal,
    onProgress: () => {},
    onRemoteTask: () => {},
    isCancellationRequested: () => signal.aborted,
  };
}
async function frame(file: string, time: number): Promise<Buffer> {
  const out = path.join(root, `sample-${sequence++}.png`);
  await exec(ff, [
    "-hide_banner",
    "-loglevel",
    "error",
    "-nostdin",
    "-y",
    "-ss",
    String(time),
    "-i",
    file,
    "-frames:v",
    "1",
    "-update",
    "1",
    out,
  ]);
  return readFile(out);
}

beforeAll(async () => {
  root = await mkdtemp(path.join(os.tmpdir(), "crosscut 媒体 ' 测试-"));
  const colors = ["red", "blue", "green", "yellow", "purple", "orange"];
  for (let i = 0; i < colors.length; i++) {
    const file = path.join(root, `素材 ${i}.mp4`);
    const args = [
      "-hide_banner",
      "-loglevel",
      "error",
      "-nostdin",
      "-y",
      "-f",
      "lavfi",
      "-i",
      `color=c=${colors[i]}:s=320x180:r=30:d=0.9`,
    ];
    if (i % 2)
      args.push(
        "-f",
        "lavfi",
        "-i",
        `sine=frequency=${440 + i * 100}:sample_rate=48000:duration=0.9`,
      );
    args.push(
      "-c:v",
      "libx264",
      "-preset",
      "ultrafast",
      "-pix_fmt",
      "yuv420p",
      "-threads",
      "1",
    );
    if (i % 2) args.push("-c:a", "aac", "-shortest");
    else args.push("-an");
    args.push(file);
    await exec(ff, args);
    videos.push(await asset(file, `video-${i}`));
  }
}, 60_000);
afterAll(async () => {
  if (root) await rm(root, { recursive: true, force: true });
});

describe("real local media processing", () => {
  it("distinguishes actual MKV and WebM content, preserves MIME at ingestion and rejects a forged WebM DocType", async () => {
    const mkv = path.join(root, "matroska.part"),
      webm = path.join(root, "webm.part"),
      audio = path.join(root, "webm-audio.part");
    const input = [
      "-hide_banner",
      "-loglevel",
      "error",
      "-nostdin",
      "-y",
      "-i",
      videos[1]!.path,
    ];
    await exec(ff, [...input, "-c", "copy", "-f", "matroska", mkv]);
    await exec(ff, [
      ...input,
      "-c:v",
      "libvpx-vp9",
      "-deadline",
      "realtime",
      "-cpu-used",
      "8",
      "-threads",
      "1",
      "-c:a",
      "libopus",
      "-f",
      "webm",
      webm,
    ]);
    await exec(ff, [...input, "-vn", "-c:a", "libopus", "-f", "webm", audio]);
    expect(await probeMedia(mkv)).toMatchObject({
      kind: "video",
      mime: "video/x-matroska",
      format: "matroska",
      width: 320,
      height: 180,
      hasAudio: true,
    });
    expect(await probeMedia(webm)).toMatchObject({
      kind: "video",
      mime: "video/webm",
      format: "webm",
      width: 320,
      height: 180,
      hasAudio: true,
    });
    expect(await probeMedia(audio)).toMatchObject({
      kind: "audio",
      mime: "audio/webm",
      format: "webm",
    });
    const store = new Store(path.join(root, "container-storage"));
    try {
      const owner = randomUUID();
      store.run(
        "INSERT INTO users(id,email,name,password_hash,created_at) VALUES(?,?,?,?,?)",
        owner,
        "media@example.test",
        "Media test",
        "test-only",
        new Date().toISOString(),
      );
      for (const [source, mime, extension] of [
        [mkv, "video/x-matroska", ".mkv"],
        [webm, "video/webm", ".webm"],
        [audio, "audio/webm", ".webm"],
      ]) {
        const temporary = path.join(store.storage.temp, `${randomUUID()}.part`);
        await copyFile(source!, temporary);
        const saved = await saveAsset(store, owner, temporary, {
          name: "misleading-name.mp4",
        });
        expect(saved.mime).toBe(mime);
        expect(
          String(
            store.get("SELECT storage_key FROM assets WHERE id=?", saved.id)!
              .storage_key,
          ),
        ).toMatch(new RegExp(`${extension!.replace(".", "\\.")}\$`));
      }
    } finally {
      store.close();
    }
    const forged = Buffer.from(await readFile(mkv)),
      doc = forged.indexOf(Buffer.from("matroska"));
    expect(doc).toBeGreaterThan(0);
    Buffer.from("webm\0\0\0\0").copy(forged, doc);
    const fake = path.join(root, "forged-webm.part");
    await writeFile(fake, forged);
    await expect(probeMedia(fake)).rejects.toMatchObject({
      code: "INVALID_MEDIA",
    });
    Buffer.from("unknown!").copy(forged, doc);
    await writeFile(fake, forged);
    await expect(probeMedia(fake)).rejects.toBeDefined();
  }, 30_000);
  it("probes content, audio presence and rejects disguised data", async () => {
    expect(await probeMedia(videos[0]!.path)).toMatchObject({
      kind: "video",
      width: 320,
      height: 180,
      hasAudio: false,
    });
    expect((await probeMedia(videos[1]!.path)).hasAudio).toBe(true);
    const invalid = path.join(root, "fake.mp4");
    await writeFile(invalid, "not a video");
    await expect(probeMedia(invalid)).rejects.toMatchObject({
      code: "MEDIA_PROCESS_FAILED",
    });
    const png = path.join(root, "image.part");
    await sharp({
      create: { width: 40, height: 30, channels: 3, background: "red" },
    })
      .png()
      .toFile(png);
    expect(await probeMedia(png)).toMatchObject({
      kind: "image",
      mime: "image/png",
      width: 40,
      height: 30,
    });
  });

  it("mixes six actual clips into a precise 15-second video with consistent audio", async () => {
    const ctx = await context("remix", {
      sourceIds: videos.map((v) => v.id),
      duration: "15",
      ratio: "16:9",
      resolution: "480p",
      count: 100,
      subtitles: false,
    });
    const result = await runMediaTask(ctx);
    expect(result.artifacts).toHaveLength(1);
    const info = await probeMedia(result.artifacts[0]!.path);
    expect(info).toMatchObject({
      kind: "video",
      width: 854,
      height: 480,
      hasAudio: true,
    });
    expect(Math.abs(info.duration! - 15)).toBeLessThanOrEqual(1 / 30);
    expect(result.artifacts[0]!.metadata?.sourceOrder).toHaveLength(6);
    expect(
      (await readdir(ctx.outputDir)).some((x) => x.startsWith(".work")),
    ).toBe(false);
    const colors = await Promise.all(
      [0.4, 2.9, 5.4].map((t) =>
        frame(result.artifacts[0]!.path, t).then((b) =>
          sharp(b).resize(1, 1).raw().toBuffer(),
        ),
      ),
    );
    expect(new Set(colors.map((c) => c.toString("hex"))).size).toBe(3);
    expect(result.result).toMatchObject({
      productFieldsUsage: "metadata-only",
      captionScript: [],
    });
  }, 60_000);

  it("resolves the explicit recommended rule to a real 30-second mix and retains both durations", async () => {
    const durationField = findTool("remix").fields.find(
      (field) => field.key === "duration",
    )!;
    expect(durationField.default).toBe("recommended");
    expect(
      durationField.options?.find((option) => option.value === "recommended")
        ?.label,
    ).toBe("推荐时长（30 秒）");
    expect(durationField.help).toContain("固定为 30 秒");
    const validated = validateInput("remix", {
      sourceIds: videos.map(() => randomUUID()),
      productName: "Travel bag",
      description: "Compact storage",
      sellingPoints: "Lightweight",
      ratio: "16:9",
      resolution: "480p",
      subtitles: false,
    });
    expect(validated.duration).toBe("recommended");
    const input = { ...validated, sourceIds: videos.map((video) => video.id) };
    const ctx = await context("remix", input);
    const result = await runMediaTask(ctx);
    const info = await probeMedia(result.artifacts[0]!.path);
    expect(info).toMatchObject({
      kind: "video",
      width: 854,
      height: 480,
      hasAudio: true,
    });
    expect(Math.abs(info.duration! - 30)).toBeLessThanOrEqual(1 / 30);
    expect(result.result).toMatchObject({
      durationSelection: "recommended",
      resolvedDuration: 30,
      duration: 30,
      actualDuration: info.duration,
      durationRule: "本产品推荐时长固定为30秒，不代表自动判断最佳投放时长。",
    });
    expect(result.artifacts[0]!.metadata).toMatchObject({
      durationSelection: "recommended",
      resolvedDuration: 30,
      duration: info.duration,
    });
    expect(ctx.input.duration).toBe("recommended");
  }, 60_000);

  it("places the actual product title, description and selling points in a readable subtitle sequence", async () => {
    const input = {
      sourceIds: videos.map((v) => v.id),
      duration: "15",
      ratio: "16:9",
      resolution: "180p",
      subtitles: true,
      subtitleStyle: "bold",
      productName: "Travel bag",
      description: "Made for travel",
      sellingPoints: "Lightweight, Durable",
    };
    const result = await runMediaTask(await context("remix", input));
    const script = (
      result.result as {
        captionScript: {
          text: string;
          role: string;
          start: number;
          end: number;
        }[];
      }
    ).captionScript;
    expect(script.map((c) => [c.role, c.text])).toEqual([
      ["title", "Travel bag"],
      ["description", "Made for travel"],
      ["selling-point", "Lightweight"],
      ["selling-point", "Durable"],
    ]);
    expect(script[0]!.start).toBe(0);
    expect(script.at(-1)!.end).toBe(15);
    expect(result.result).toMatchObject({
      productFieldsUsage: "captioned",
      subtitleAnimation: "static",
    });
    for (const cue of script) {
      const decoded = await sharp(
        await frame(result.artifacts[0]!.path, (cue.start + cue.end) / 2),
      )
        .raw()
        .toBuffer({ resolveWithObject: true });
      let white = 0;
      for (
        let index = 0;
        index < decoded.data.length;
        index += decoded.info.channels
      )
        if (
          decoded.data[index]! > 210 &&
          decoded.data[index + 1]! > 210 &&
          decoded.data[index + 2]! > 210
        )
          white++;
      expect(white).toBeGreaterThan(10);
    }
    const tooLong = await context("remix", {
      ...input,
      description:
        "This description has far too many words to be readable. ".repeat(12),
    });
    await expect(runMediaTask(tooLong)).rejects.toMatchObject({
      code: "CAPTION_TOO_LONG",
    });
    expect(await readdir(tooLong.outputDir)).toEqual([]);
  }, 60_000);

  it("rejects count and duration violations before encoding", async () => {
    await expect(
      runMediaTask(
        await context("remix", { duration: "15" }, videos.slice(0, 5)),
      ),
    ).rejects.toMatchObject({ code: "INVALID_INPUT" });
    await expect(
      runMediaTask(await context("remix", { duration: "17" }, videos)),
    ).rejects.toMatchObject({ code: "INVALID_INPUT" });
  });

  it("trims real media at requested times, preserving auto aspect", async () => {
    const result = await runMediaTask(
      await context(
        "trim",
        { start: 0.1, end: 0.7, ratio: "auto", resolution: "180p" },
        [videos[1]!],
      ),
    );
    const info = await probeMedia(result.artifacts[0]!.path);
    expect(info).toMatchObject({ width: 320, height: 180, hasAudio: true });
    expect(Math.abs(info.duration! - 0.6)).toBeLessThan(0.04);
    await expect(
      runMediaTask(await context("trim", { start: 1, end: 2 }, [videos[0]!])),
    ).rejects.toMatchObject({ code: "INVALID_INPUT" });
  });

  it("preserves portrait rotation, emits MOV content type and actually adjusts audio volume", async () => {
    const rotated = path.join(root, "rotated.mov");
    await exec(ff, [
      "-hide_banner",
      "-loglevel",
      "error",
      "-nostdin",
      "-y",
      "-display_rotation:v:0",
      "90",
      "-i",
      videos[1]!.path,
      "-c",
      "copy",
      rotated,
    ]);
    expect(await probeMedia(rotated)).toMatchObject({
      width: 180,
      height: 320,
      mime: "video/quicktime",
    });
    const result = await runMediaTask(
      await context(
        "transcode",
        { ratio: "auto", resolution: "180p", format: "mov", volume: 0 },
        [await asset(rotated, "portrait")],
      ),
    );
    expect(await probeMedia(result.artifacts[0]!.path)).toMatchObject({
      width: 180,
      height: 320,
      mime: "video/quicktime",
    });
    const measured = await exec(ff, [
      "-hide_banner",
      "-nostdin",
      "-i",
      result.artifacts[0]!.path,
      "-vn",
      "-af",
      "volumedetect",
      "-f",
      "null",
      "-",
    ]);
    const maximum = /max_volume: ([-\d.]+) dB/.exec(measured.stderr);
    expect(Number(maximum?.[1])).toBeLessThan(-80);
  });

  it("burns timed Chinese SRT visibly, with blank intervals retained", async () => {
    const ctx = await context(
      "subtitle-burn",
      {
        subtitleText: "1\n00:00:00,200 --> 00:00:00,700\n跨境广告测试 你好\n",
        subtitleStyle: "contrast",
      },
      [videos[0]!],
    );
    const result = await runMediaTask(ctx);
    const output = result.artifacts[0]!.path;
    const raw = await sharp(await frame(output, 0.4))
      .raw()
      .toBuffer({ resolveWithObject: true });
    let yellow = 0;
    for (let i = 0; i < raw.data.length; i += raw.info.channels)
      if (
        raw.data[i]! > 170 &&
        raw.data[i + 1]! > 160 &&
        raw.data[i + 2]! < 160
      )
        yellow++;
    expect(yellow).toBeGreaterThan(50);
    const blank = await sharp(await frame(output, 0.05))
      .raw()
      .toBuffer({ resolveWithObject: true });
    let yellowBefore = 0;
    for (let i = 0; i < blank.data.length; i += blank.info.channels)
      if (
        blank.data[i]! > 170 &&
        blank.data[i + 1]! > 160 &&
        blank.data[i + 2]! < 160
      )
        yellowBefore++;
    expect(yellowBefore).toBeLessThan(10);
    await expect(
      runMediaTask(
        await context(
          "subtitle-burn",
          { subtitleText: "1\n00:00:01,000 --> 00:00:02,000\nToo late" },
          [videos[0]!],
        ),
      ),
    ).rejects.toMatchObject({ code: "INVALID_SUBTITLE" });
  }, 30_000);

  it("renders representative top, center, outlined and shadow presets with genuine pixel differences", async () => {
    expect(SUBTITLE_STYLES).toHaveLength(33);
    expect(new Set(SUBTITLE_STYLES.map((s) => s.id)).size).toBe(33);
    expect(
      new Set(SUBTITLE_STYLES.map((s) => JSON.stringify(s.render))).size,
    ).toBe(33);
    const summaries: Record<
      string,
      { centroid: number; hash: string; highlight: number }
    > = {};
    for (const style of [
      "headline-top",
      "center-lime",
      "outline-yellow",
      "shadow-coral",
    ]) {
      const result = await runMediaTask(
        await context(
          "subtitle-burn",
          { subtitleText: "新品 NEW", subtitleStyle: style },
          [videos[0]!],
        ),
      );
      const pixels = await sharp(await frame(result.artifacts[0]!.path, 0.4))
        .raw()
        .toBuffer({ resolveWithObject: true });
      let highlight = 0,
        ys = 0;
      for (let i = 0; i < pixels.data.length; i += pixels.info.channels)
        if (pixels.data[i + 1]! > 85 || pixels.data[i + 2]! > 85) {
          highlight++;
          ys += Math.floor(i / pixels.info.channels / pixels.info.width);
        }
      summaries[style] = {
        centroid: ys / highlight / pixels.info.height,
        hash: pixels.data.toString("base64"),
        highlight,
      };
      expect(highlight).toBeGreaterThan(40);
    }
    expect(summaries["headline-top"]!.centroid).toBeLessThan(0.35);
    expect(summaries["center-lime"]!.centroid).toBeGreaterThan(0.35);
    expect(summaries["center-lime"]!.centroid).toBeLessThan(0.65);
    expect(summaries["outline-yellow"]!.centroid).toBeGreaterThan(0.65);
    expect(new Set(Object.values(summaries).map((s) => s.hash)).size).toBe(4);
  }, 30_000);

  it("renders slideshow from real images and user caption text", async () => {
    const images: ExecutionAsset[] = [];
    for (const [i, color] of ["red", "blue"].entries()) {
      const file = path.join(root, `product-${i}.png`);
      await sharp({
        create: { width: 300, height: 300, channels: 3, background: color },
      })
        .png()
        .toFile(file);
      images.push(await asset(file, `image-${i}`));
    }
    const result = await runMediaTask(
      await context(
        "slideshow",
        {
          duration: 3,
          ratio: "1:1",
          resolution: "180p",
          subtitleText: "旅行收纳袋",
          subtitleStyle: "minimal",
        },
        images,
      ),
    );
    expect(await probeMedia(result.artifacts[0]!.path)).toMatchObject({
      width: 180,
      height: 180,
      duration: 3,
    });
  }, 30_000);

  it("removes selected band by explicit crop or visible cover, never labels inpainting local", async () => {
    const cropped = await runMediaTask(
      await context(
        "subtitle-remove",
        { mode: "crop", regionY: 80, regionHeight: 20 },
        [videos[0]!],
      ),
    );
    expect(await probeMedia(cropped.artifacts[0]!.path)).toMatchObject({
      width: 320,
      height: 144,
    });
    const adapted = await runMediaTask(
      await context(
        "subtitle-remove",
        { mode: "crop", regionY: 80, regionHeight: 20, resolution: "180p" },
        [videos[0]!],
      ),
    );
    expect(await probeMedia(adapted.artifacts[0]!.path)).toMatchObject({
      width: 400,
      height: 180,
    });
    const covered = await runMediaTask(
      await context(
        "subtitle-remove",
        { mode: "cover", regionY: 80, regionHeight: 20 },
        [videos[0]!],
      ),
    );
    const pixel = await sharp(await frame(covered.artifacts[0]!.path, 0.4))
      .extract({ left: 100, top: 160, width: 1, height: 1 })
      .raw()
      .toBuffer();
    expect(Math.max(...pixel)).toBeLessThan(15);
    await expect(
      runMediaTask(
        await context("subtitle-remove", { mode: "inpaint" }, [videos[0]!]),
      ),
    ).rejects.toMatchObject({ code: "UNSUPPORTED_CAPABILITY" });
    await expect(
      runMediaTask(
        await context(
          "subtitle-remove",
          { mode: "cover", regionY: 90, regionHeight: 20 },
          [videos[0]!],
        ),
      ),
    ).rejects.toMatchObject({ code: "INVALID_INPUT" });
  }, 30_000);

  it("extracts genuine frames and mono audio; silent input gives actionable error", async () => {
    const dir = path.join(root, "extractions");
    const frames = await extractFrames(videos[0]!, dir, 3);
    expect(frames).toHaveLength(3);
    expect(frames[0]!.time).toBeLessThan(frames[2]!.time);
    expect((await probeMedia(frames[0]!.path)).kind).toBe("image");
    const wav = await extractAudio(videos[1]!, dir);
    expect(await probeMedia(wav)).toMatchObject({
      kind: "audio",
      mime: "audio/wav",
      hasAudio: true,
    });
    await expect(extractAudio(videos[0]!, dir)).rejects.toMatchObject({
      code: "NO_AUDIO",
    });
  }, 30_000);

  it("detects real visual boundaries and returns technical frames and JSON", async () => {
    const file = path.join(root, "two-scenes.mp4");
    await exec(ff, [
      "-hide_banner",
      "-loglevel",
      "error",
      "-nostdin",
      "-y",
      "-f",
      "lavfi",
      "-i",
      "color=red:s=320x180:r=30:d=0.6",
      "-f",
      "lavfi",
      "-i",
      "color=blue:s=320x180:r=30:d=0.6",
      "-filter_complex",
      "[0:v][1:v]concat=n=2:v=1:a=0[v]",
      "-map",
      "[v]",
      "-c:v",
      "libx264",
      "-threads",
      "1",
      file,
    ]);
    const result = await runMediaTask(
      await context("scene-detect", {}, [await asset(file, "scenes")]),
    );
    expect(result.result).toMatchObject({ mode: "technical", sceneCount: 2 });
    expect(result.artifacts.filter((a) => a.kind === "image")).toHaveLength(2);
    expect(
      JSON.parse(
        await readFile(
          result.artifacts.find((a) => a.kind === "document")!.path,
          "utf8",
        ),
      ),
    ).toMatchObject({ mode: "technical" });
  }, 30_000);

  it("terminates in-flight processes and removes intermediate files on cancellation", async () => {
    const controller = new AbortController();
    const ctx = await context(
      "remix",
      { duration: "30", resolution: "720p" },
      videos,
      controller.signal,
    );
    const pending = runMediaTask(ctx);
    setTimeout(() => controller.abort(), 180);
    await expect(pending).rejects.toMatchObject({ code: "CANCELLED" });
    expect(await readdir(ctx.outputDir)).toEqual([]);
    await expect(
      extractFrames(videos[0]!, ctx.outputDir, 2, controller.signal),
    ).rejects.toMatchObject({ code: "CANCELLED" });
  }, 10_000);

  it("cancels a stalled probe subprocess without leaving the detached process running", async () => {
    const pidFile = path.join(root, "probe.pid"),
      fake = path.join(root, "slow-probe.cjs");
    await writeFile(
      fake,
      `#!${process.execPath}\nrequire('node:fs').writeFileSync(${JSON.stringify(pidFile)},String(process.pid));setInterval(()=>{},1000);\n`,
      { mode: 0o755 },
    );
    const previous = process.env.FFPROBE_PATH;
    process.env.FFPROBE_PATH = fake;
    const controller = new AbortController();
    try {
      const pending = probeMedia(videos[0]!.path, controller.signal);
      const outcome = pending.then(
        () => null,
        (error) => error as { code?: string },
      );
      const deadline = Date.now() + 3000;
      let pid: number | undefined;
      while (Date.now() < deadline && !pid) {
        try {
          pid = Number(await readFile(pidFile, "utf8"));
        } catch {
          await new Promise((resolve) => setTimeout(resolve, 20));
        }
      }
      const start = Date.now();
      controller.abort();
      expect(await outcome).toMatchObject({ code: "CANCELLED" });
      expect(pid).toBeGreaterThan(1);
      expect(Date.now() - start).toBeLessThan(2000);
      expect(() => process.kill(pid!, 0)).toThrow();
    } finally {
      if (previous === undefined) delete process.env.FFPROBE_PATH;
      else process.env.FFPROBE_PATH = previous;
    }
  }, 8000);
});
