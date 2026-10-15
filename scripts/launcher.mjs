import { spawn, execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, openSync, closeSync, writeSync } from "node:fs";
import {
  mkdir,
  readFile,
  readdir,
  rename,
  rm,
  stat,
  writeFile,
} from "node:fs/promises";
import net from "node:net";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";

const exec = promisify(execFile);
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const dataDir = path.resolve(root, process.env.CROSSCUT_DATA_DIR || "data");
const port = Number(process.env.CROSSCUT_PORT || 4318);
const runDir = path.join(dataDir, "run");
const logsDir = path.join(dataDir, "logs");
const stateFile = path.join(runDir, `server-${port}.json`);
const lockDir = path.join(runDir, `launcher-${port}.lock`);
const mainFile = path.join(root, "src/server/main.ts");
const appUrl = `http://127.0.0.1:${port}`;
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const command = process.argv[2] || "start";
process.env.PATH = `${path.dirname(process.execPath)}:${process.env.PATH || ""}`;
process.umask(0o077);

function checkNode() {
  const [major, minor] = process.versions.node.split(".").map(Number);
  if (major < 22 || (major === 22 && minor < 22))
    throw new Error(
      `当前 Node.js ${process.versions.node} 不满足要求。请安装 Node.js 22.22 或更高版本，然后重新双击启动。`,
    );
  if (!Number.isInteger(port) || port < 1024 || port > 65535)
    throw new Error("CROSSCUT_PORT 必须是 1024–65535 之间的整数。");
}

async function json(file, fallback = null) {
  try {
    return JSON.parse(await readFile(file, "utf8"));
  } catch {
    return fallback;
  }
}

async function identity(pid) {
  if (!Number.isSafeInteger(pid) || pid <= 1) return null;
  try {
    const [started, argv, user] = await Promise.all([
      exec("/bin/ps", ["-p", String(pid), "-o", "lstart="]),
      exec("/bin/ps", ["-p", String(pid), "-o", "command="]),
      exec("/bin/ps", ["-p", String(pid), "-o", "uid="]),
    ]);
    if (!started.stdout.trim()) return null;
    return {
      started: started.stdout.trim(),
      argv: argv.stdout.trim(),
      uid: Number(user.stdout.trim()),
    };
  } catch {
    return null;
  }
}

async function belongs(state) {
  if (
    !state ||
    state.projectRoot !== root ||
    state.dataDir !== dataDir ||
    state.port !== port ||
    state.mainFile !== mainFile
  )
    return false;
  const actual = await identity(state.pid);
  return (
    !!actual &&
    actual.started === state.started &&
    actual.uid === (process.getuid?.() ?? actual.uid) &&
    actual.argv === state.argv &&
    actual.argv.includes(mainFile)
  );
}

async function health() {
  try {
    const response = await fetch(`${appUrl}/api/health`, {
      signal: AbortSignal.timeout(1500),
    });
    if (!response.ok) return null;
    const value = await response.json();
    return value.app === "crosscut" && value.ok === true ? value : null;
  } catch {
    return null;
  }
}

async function assertPortAvailable() {
  await new Promise((resolve, reject) => {
    const server = net.createServer();
    server.once("error", () =>
      reject(
        new Error(
          `端口 ${port} 已被其他进程占用。为避免影响其他服务，本脚本不会终止或接管该进程。可设置 CROSSCUT_PORT 使用另一个端口。`,
        ),
      ),
    );
    server.listen(port, "127.0.0.1", () =>
      server.close((error) => (error ? reject(error) : resolve())),
    );
  });
}

async function lock() {
  await mkdir(runDir, { recursive: true, mode: 0o700 });
  const deadline = Date.now() + 5 * 60_000;
  let announced = false;
  while (true) {
    try {
      await mkdir(lockDir);
      const actual = await identity(process.pid);
      await writeFile(
        path.join(lockDir, "owner.json"),
        JSON.stringify({ pid: process.pid, started: actual?.started }),
        { mode: 0o600 },
      );
      return;
    } catch (error) {
      if (error.code !== "EEXIST") throw error;
      const owner = await json(path.join(lockDir, "owner.json"));
      const live = owner ? await identity(owner.pid) : null;
      const age = Date.now() - (await stat(lockDir)).mtimeMs;
      if (
        (owner && (!live || live.started !== owner.started)) ||
        (!owner && age > 30_000)
      ) {
        await rm(lockDir, { recursive: true, force: true });
        continue;
      }
      if (!announced) {
        console.log("另一启动/停止操作正在执行，等待它完成…");
        announced = true;
      }
      if (Date.now() > deadline)
        throw new Error(
          "等待启动锁超时。请查看另一个终端中的构建结果，勿同时运行多个安装。",
        );
      await sleep(500);
    }
  }
}

async function checkedRun(executable, args, label, logName) {
  console.log(label);
  const fd = openSync(path.join(logsDir, logName), "a", 0o600);
  try {
    await new Promise((resolve, reject) => {
      const child = spawn(executable, args, {
        cwd: root,
        env: process.env,
        stdio: ["ignore", "pipe", "pipe"],
      });
      for (const stream of [child.stdout, child.stderr])
        stream.on("data", (chunk) => {
          process.stdout.write(chunk);
          writeSync(fd, chunk);
        });
      child.once("error", reject);
      child.once("exit", (code) =>
        code === 0
          ? resolve()
          : reject(
              new Error(
                `${label}失败（退出码 ${code}）。详情：${path.join(logsDir, logName)}`,
              ),
            ),
      );
    });
  } finally {
    closeSync(fd);
  }
}

async function checkMedia() {
  const ffmpeg = process.env.FFMPEG_PATH || "ffmpeg";
  const ffprobe = process.env.FFPROBE_PATH || "ffprobe";
  for (const executable of [ffmpeg, ffprobe]) {
    let result;
    try {
      result = await exec(executable, ["-version"], { maxBuffer: 1024 * 1024 });
    } catch {
      throw new Error(
        `找不到可用的 ${path.basename(executable)}。请先安装 FFmpeg 8+（已有 Homebrew 可运行 brew install ffmpeg），或配置 FFMPEG_PATH / FFPROBE_PATH。`,
      );
    }
    const match = /version\s+(\d+)/.exec(result.stdout);
    if (!match || Number(match[1]) < 8)
      throw new Error(
        `${path.basename(executable)} 需要 8+；当前：${result.stdout.split("\n")[0]}`,
      );
  }
  const [encoders, filters] = await Promise.all([
    exec(ffmpeg, ["-hide_banner", "-encoders"]),
    exec(ffmpeg, ["-hide_banner", "-filters"]),
  ]);
  const missing = ["libx264", "aac", "mjpeg", "pcm_s16le"].filter(
    (name) => !new RegExp(`\\b${name}\\b`).test(encoders.stdout),
  );
  missing.push(
    ...["scale", "overlay", "select", "showinfo", "crop", "drawbox"].filter(
      (name) => !new RegExp(`\\b${name}\\b`).test(filters.stdout),
    ),
  );
  if (missing.length)
    throw new Error(
      `FFmpeg 构建缺少必要能力：${missing.join(", ")}。请换用含这些编码器/滤镜的 FFmpeg 构建。`,
    );
  const font =
    process.env.CROSSCUT_FONT_PATH ||
    "/System/Library/Fonts/Supplemental/Arial Unicode.ttf";
  if (!existsSync(font))
    console.log(
      "提示：未找到默认中文字体。中文字幕需要设置 CROSSCUT_FONT_PATH 为有效的中文字体文件。",
    );
}

async function dependencyHash() {
  return createHash("sha256")
    .update(await readFile(path.join(root, "package-lock.json")))
    .update(process.versions.modules)
    .digest("hex");
}

async function dependenciesReady() {
  try {
    const pkg = await json(path.join(root, "package.json"));
    const lock = await json(path.join(root, "package-lock.json"));
    for (const name of Object.keys({
      ...pkg.dependencies,
      ...pkg.devDependencies,
    })) {
      const installed = await json(
        path.join(root, "node_modules", name, "package.json"),
      );
      if (
        !installed ||
        installed.version !== lock.packages[`node_modules/${name}`]?.version
      )
        return false;
    }
    await exec(
      process.execPath,
      [
        "--input-type=module",
        "-e",
        "import Database from 'better-sqlite3'; const d=new Database(':memory:');d.prepare('select 1').get();d.close();import sharp from 'sharp';await sharp({create:{width:1,height:1,channels:3,background:'white'}}).png().toBuffer();",
      ],
      { cwd: root },
    );
    return true;
  } catch {
    return false;
  }
}

async function sourceHash() {
  const hash = createHash("sha256");
  async function add(relative) {
    const location = path.join(root, relative);
    const info = await stat(location);
    if (info.isDirectory())
      for (const name of (await readdir(location)).sort())
        await add(path.join(relative, name));
    else hash.update(relative).update(await readFile(location));
  }
  for (const name of [
    "src",
    "package.json",
    "package-lock.json",
    "tsconfig.json",
    "vite.config.ts",
    "index.html",
  ])
    await add(name);
  return hash.update(process.versions.modules).digest("hex");
}

async function prepare() {
  await mkdir(logsDir, { recursive: true, mode: 0o700 });
  await checkMedia();
  const fingerprint = await dependencyHash();
  const dependencyStamp = await json(path.join(runDir, "dependencies.json"));
  if (
    !(await dependenciesReady()) ||
    (dependencyStamp && dependencyStamp.hash !== fingerprint)
  ) {
    await checkedRun(
      "npm",
      ["ci", "--no-audit", "--no-fund"],
      "正在按锁文件安装项目依赖…",
      "install.log",
    );
  }
  await writeFile(
    path.join(runDir, "dependencies.json"),
    JSON.stringify({ hash: fingerprint }),
    { mode: 0o600 },
  );
  const source = await sourceHash();
  const buildStamp = await json(path.join(runDir, "build.json"));
  if (
    !existsSync(path.join(root, "dist/web/index.html")) ||
    buildStamp?.hash !== source
  ) {
    await checkedRun(
      "npm",
      ["run", "build"],
      "正在检查 TypeScript 并构建界面…",
      "build.log",
    );
    const after = await sourceHash();
    if (after !== source)
      throw new Error(
        "构建期间源文件发生变化，请等待当前代码编辑完成后重新启动。",
      );
    await writeFile(
      path.join(runDir, "build.json"),
      JSON.stringify({ hash: source, builtAt: new Date().toISOString() }),
      { mode: 0o600 },
    );
  }
}

async function openBrowser() {
  if (process.env.CROSSCUT_NO_OPEN === "1") return;
  if (process.platform === "darwin")
    await exec("/usr/bin/open", [appUrl]).catch(() =>
      console.log(`请在浏览器打开 ${appUrl}`),
    );
  else console.log(`请在浏览器打开 ${appUrl}`);
}

async function start() {
  const existing = await json(stateFile);
  if (await belongs(existing)) {
    const status = await health();
    if (
      !status ||
      (process.env.CROSSCUT_WORKER !== "0" && !status.worker?.online)
    )
      throw new Error(
        `本项目进程仍存在，但 API 或媒体 Worker 健康检查失败。请先使用“停止.command”停止，再查看 ${logsDir}。`,
      );
    console.log(`Crosscut 已在运行，复用现有进程：${appUrl}`);
    await openBrowser();
    return;
  }
  await assertPortAvailable();
  await prepare();
  await assertPortAvailable();
  const logfile = path.join(logsDir, `server-${port}.log`),
    fd = openSync(logfile, "a", 0o600);
  const child = spawn(process.execPath, ["--import", "tsx", mainFile], {
    cwd: root,
    detached: true,
    stdio: ["ignore", fd, fd],
    env: {
      ...process.env,
      CROSSCUT_DATA_DIR: dataDir,
      CROSSCUT_PORT: String(port),
    },
  });
  closeSync(fd);
  await new Promise((resolve, reject) => {
    child.once("spawn", resolve);
    child.once("error", reject);
  });
  child.unref();
  let actual;
  for (let i = 0; i < 15 && !actual; i++) {
    actual = await identity(child.pid);
    if (!actual) await sleep(100);
  }
  if (!actual) throw new Error(`服务启动后立即退出。请查看 ${logfile}`);
  const state = {
    pid: child.pid,
    started: actual.started,
    argv: actual.argv,
    projectRoot: root,
    dataDir,
    port,
    mainFile,
    logfile,
    writtenAt: new Date().toISOString(),
  };
  const staged = `${stateFile}.tmp`;
  await writeFile(staged, JSON.stringify(state, null, 2), { mode: 0o600 });
  await rename(staged, stateFile);
  for (let i = 0; i < 80; i++) {
    const result = await health();
    if (
      result &&
      (process.env.CROSSCUT_WORKER === "0" || result.worker?.online) &&
      (await belongs(state))
    ) {
      console.log(
        `\nCrosscut 启动成功：${appUrl}\n数据：${dataDir}\n日志：${logfile}\n关闭此终端不会停止服务；停止请双击“停止.command”。`,
      );
      await openBrowser();
      return;
    }
    if (!(await belongs(state))) break;
    await sleep(250);
  }
  if (await belongs(state)) process.kill(state.pid, "SIGTERM");
  throw new Error(`启动未通过健康检查。请查看 ${logfile}，修复后再启动。`);
}

async function stop() {
  const state = await json(stateFile);
  if (!(await belongs(state))) {
    console.log(
      "未找到身份匹配的本项目运行进程；未向任何其他进程发送终止信号。",
    );
    if (state) await rm(stateFile, { force: true });
    return;
  }
  console.log(`正在停止 Crosscut（端口 ${port}）…`);
  process.kill(state.pid, "SIGTERM");
  for (let i = 0; i < 100; i++) {
    if (!(await belongs(state))) {
      await rm(stateFile, { force: true });
      console.log("Crosscut 已停止，SQLite 与素材保留。");
      return;
    }
    await sleep(100);
  }
  if (await belongs(state)) {
    console.log("正常退出超时，正在终止已核验的本项目 API 进程。");
    process.kill(state.pid, "SIGKILL");
  }
  await sleep(250);
  if (await belongs(state)) throw new Error("进程仍未退出，请保留日志并检查。");
  await rm(stateFile, { force: true });
  console.log("Crosscut 已停止。");
}

async function logs() {
  const logfile = path.join(logsDir, `server-${port}.log`);
  console.log(`日志文件：${logfile}\n`);
  try {
    console.log(
      (await readFile(logfile, "utf8")).split("\n").slice(-100).join("\n"),
    );
  } catch {
    console.log("尚无运行日志，请先启动项目。");
  }
}

async function main() {
  checkNode();
  if (command === "logs") return logs();
  if (command === "status") {
    const state = await json(stateFile);
    const running = await belongs(state);
    console.log(
      JSON.stringify(
        {
          running,
          url: appUrl,
          dataDir,
          health: running ? await health() : null,
        },
        null,
        2,
      ),
    );
    return;
  }
  if (!["start", "stop", "backup"].includes(command))
    throw new Error(
      "用法：node scripts/launcher.mjs start|stop|status|logs|backup",
    );
  await lock();
  try {
    if (command === "start") await start();
    else if (command === "stop") await stop();
    else {
      await mkdir(logsDir, { recursive: true, mode: 0o700 });
      if (!(await dependenciesReady()))
        throw new Error(
          "备份需要项目依赖，请先完成一次“启动.command”的依赖准备。",
        );
      await checkedRun(
        process.execPath,
        [
          "--import",
          "tsx",
          path.join(root, "scripts/backup.ts"),
          "create",
          ...process.argv.slice(3),
        ],
        "正在建立一致性备份…",
        "backup.log",
      );
    }
  } finally {
    await rm(lockDir, { recursive: true, force: true });
  }
}
main().catch((error) => {
  console.error(`\n操作未完成：${error.message}\n日志目录：${logsDir}`);
  process.exitCode = 1;
});
