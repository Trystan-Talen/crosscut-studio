import "./runtime-env.js";
import { spawn } from "node:child_process";
import { resolve } from "node:path";
import { createApp } from "./app.js";
const port = Number(process.env.CROSSCUT_PORT ?? 4318);
const { app } = await createApp();
await app.listen({ host: "127.0.0.1", port });
console.log(`Crosscut 已启动：http://127.0.0.1:${port}`);
const worker =
  process.env.CROSSCUT_WORKER === "0"
    ? null
    : spawn(
        process.execPath,
        ["--import", "tsx", resolve("src/server/worker.ts")],
        { cwd: process.cwd(), env: process.env, stdio: "inherit" },
      );
let stopping = false;
async function shutdown() {
  if (stopping) return;
  stopping = true;
  worker?.kill("SIGTERM");
  const force = setTimeout(() => worker?.kill("SIGKILL"), 5000);
  force.unref();
  await app.close();
  process.exitCode = 0;
}
process.on("SIGINT", () => void shutdown());
process.on("SIGTERM", () => void shutdown());
worker?.on("exit", (code, signal) => {
  if (!stopping) {
    console.error(
      `媒体worker退出(${code ?? signal})，请重启应用；任务已持久化。`,
    );
  }
});
