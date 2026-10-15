import { afterEach, describe, expect, it } from "vitest";
import { execFile, spawn, type ChildProcess } from "node:child_process";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";

const exec = promisify(execFile);
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const directories: string[] = [];
const children: ChildProcess[] = [];
afterEach(async () => {
  for (const child of children.splice(0))
    if (child.exitCode === null) child.kill("SIGTERM");
  for (const dir of directories.splice(0))
    await rm(dir, { recursive: true, force: true });
});

describe("Mac launcher process ownership", () => {
  it("never stops or takes over an unrelated live process with a misleading PID file", async () => {
    const data = await mkdtemp(
      path.join(tmpdir(), "crosscut launcher 中文 ' "),
    );
    directories.push(data);
    const child = spawn(
      process.execPath,
      [
        "--input-type=module",
        "-e",
        "import http from 'node:http';const s=http.createServer((q,r)=>r.end('unrelated-service'));s.listen(0,'127.0.0.1',()=>console.log(s.address().port));",
      ],
      { stdio: ["ignore", "pipe", "pipe"] },
    );
    children.push(child);
    const port = await new Promise<number>((resolve, reject) => {
      child.stdout!.once("data", (data) =>
        resolve(Number(String(data).trim())),
      );
      child.once("error", reject);
    });
    const ps = async (field: string) =>
      (
        await exec("/bin/ps", ["-p", String(child.pid), "-o", `${field}=`])
      ).stdout.trim();
    await mkdir(path.join(data, "run"));
    await writeFile(
      path.join(data, "run", `server-${port}.json`),
      JSON.stringify({
        pid: child.pid,
        started: await ps("lstart"),
        argv: await ps("command"),
        projectRoot: root,
        dataDir: data,
        port,
        mainFile: path.join(root, "src/server/main.ts"),
      }),
    );
    const options = {
      cwd: root,
      env: {
        ...process.env,
        CROSSCUT_DATA_DIR: data,
        CROSSCUT_PORT: String(port),
        CROSSCUT_NO_OPEN: "1",
      },
    };
    const stopped = await exec(
      process.execPath,
      ["scripts/launcher.mjs", "stop"],
      options,
    );
    expect(stopped.stdout).toContain("未向任何其他进程发送终止信号");
    expect(await (await fetch(`http://127.0.0.1:${port}`)).text()).toBe(
      "unrelated-service",
    );
    await expect(
      exec(process.execPath, ["scripts/launcher.mjs", "start"], options),
    ).rejects.toMatchObject({
      code: 1,
      stderr: expect.stringContaining("已被其他进程占用"),
    });
    expect(await (await fetch(`http://127.0.0.1:${port}`)).text()).toBe(
      "unrelated-service",
    );
  });

  it("rejects invalid ports before touching a service", async () => {
    await expect(
      exec(process.execPath, ["scripts/launcher.mjs", "start"], {
        cwd: root,
        env: { ...process.env, CROSSCUT_PORT: "0" },
      }),
    ).rejects.toMatchObject({
      code: 1,
      stderr: expect.stringContaining("1024–65535"),
    });
  });
});
