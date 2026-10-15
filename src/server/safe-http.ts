import { lookup } from "node:dns/promises";
import { BlockList, isIP } from "node:net";
import { Agent, request } from "undici";

export class SafeHttpError extends Error {
  constructor(
    public readonly code: string,
    message: string,
  ) {
    super(message);
    this.name = "SafeHttpError";
  }
}
export interface SafeFetchOptions {
  method?: "GET" | "POST" | "PUT" | "PATCH" | "DELETE" | "HEAD";
  headers?: Record<string, string>;
  body?: string | Buffer | Uint8Array | FormData;
  signal?: AbortSignal;
  timeoutMs?: number;
  maxBytes?: number;
  maxRedirects?: number;
}
export interface SafeFetchResponse {
  status: number;
  ok: boolean;
  headers: Headers;
  body: Buffer;
  url: string;
}
const excluded = new BlockList();
for (const [address, prefix] of [
  ["0.0.0.0", 8],
  ["10.0.0.0", 8],
  ["100.64.0.0", 10],
  ["127.0.0.0", 8],
  ["169.254.0.0", 16],
  ["172.16.0.0", 12],
  ["192.0.0.0", 24],
  ["192.0.2.0", 24],
  ["192.168.0.0", 16],
  ["198.18.0.0", 15],
  ["198.51.100.0", 24],
  ["203.0.113.0", 24],
  ["224.0.0.0", 4],
  ["240.0.0.0", 4],
] as const)
  excluded.addSubnet(address, prefix, "ipv4");
const excludedV6 = new BlockList();
for (const [address, prefix] of [
  ["::", 128],
  ["::1", 128],
  ["::ffff:0:0", 96],
  ["64:ff9b::", 96],
  ["100::", 64],
  ["2001::", 23],
  ["2001:db8::", 32],
  ["2002::", 16],
  ["3fff::", 20],
  ["fc00::", 7],
  ["fe80::", 10],
  ["ff00::", 8],
] as const)
  excludedV6.addSubnet(address, prefix, "ipv6");
const globalV6 = new BlockList();
globalV6.addSubnet("2000::", 3, "ipv6");
export function isPublicAddress(address: string): boolean {
  const family = isIP(address);
  if (family === 4) return !excluded.check(address, "ipv4");
  return (
    family === 6 &&
    globalV6.check(address, "ipv6") &&
    !excludedV6.check(address, "ipv6")
  );
}
async function resolveTarget(url: URL, signal: AbortSignal) {
  if (
    !["https:", "http:"].includes(url.protocol) ||
    url.username ||
    url.password
  )
    throw new SafeHttpError(
      "UNSAFE_URL",
      "仅允许不含登录信息的 HTTP(S) 地址。",
    );
  const hostname = url.hostname.replace(/^\[|\]$/g, "");
  const fixture =
    process.env.CROSSCUT_ALLOW_LOCAL_PROVIDERS === "1" &&
    ["localhost", "127.0.0.1", "::1"].includes(hostname);
  let addresses: { address: string; family: number }[];
  try {
    addresses = isIP(hostname)
      ? [{ address: hostname, family: isIP(hostname) }]
      : await new Promise<{ address: string; family: number }[]>(
          (resolve, reject) => {
            const aborted = () =>
              reject(
                new SafeHttpError("UPSTREAM_TIMEOUT", "服务地址解析超时。"),
              );
            signal.addEventListener("abort", aborted, { once: true });
            lookup(hostname, { all: true, verbatim: true })
              .then(resolve, reject)
              .finally(() => signal.removeEventListener("abort", aborted));
            if (signal.aborted) aborted();
          },
        );
  } catch (error) {
    if (error instanceof SafeHttpError) throw error;
    throw new SafeHttpError("DNS_FAILED", "服务地址无法解析。");
  }
  if (
    !addresses.length ||
    addresses.some(
      (a) =>
        !isPublicAddress(a.address) &&
        !(fixture && ["127.0.0.1", "::1"].includes(a.address)),
    )
  )
    throw new SafeHttpError("UNSAFE_URL", "禁止访问本机、内网或保留网络地址。");
  return addresses.find((address) => address.family === 4) ?? addresses[0]!;
}

/** Resolve, validate and pin DNS for every hop; credentials never cross origins. */
export async function safeFetch(
  input: string | URL,
  options: SafeFetchOptions = {},
): Promise<SafeFetchResponse> {
  let url: URL;
  try {
    url = new URL(input);
  } catch {
    throw new SafeHttpError("UNSAFE_URL", "服务地址格式无效。");
  }
  const method = options.method ?? "GET";
  const maxBytes = options.maxBytes ?? 8 * 1024 * 1024;
  const timeoutMs = options.timeoutMs ?? 30_000;
  if (
    !Number.isFinite(maxBytes) ||
    maxBytes < 1 ||
    !Number.isFinite(timeoutMs) ||
    timeoutMs < 1
  )
    throw new SafeHttpError("INVALID_HTTP_LIMIT", "无效的网络请求限额。");
  const signal = options.signal
    ? AbortSignal.any([options.signal, AbortSignal.timeout(timeoutMs)])
    : AbortSignal.timeout(timeoutMs);
  let headers = new Headers(options.headers);
  let body: Buffer | string | Uint8Array | undefined;
  if (options.body instanceof FormData) {
    const encoded = new Request("https://multipart.invalid", {
      method: "POST",
      body: options.body,
    });
    headers.set("content-type", encoded.headers.get("content-type")!);
    body = Buffer.from(await encoded.arrayBuffer());
  } else body = options.body;
  for (let hop = 0; hop <= (options.maxRedirects ?? 3); hop++) {
    if (signal.aborted)
      throw new SafeHttpError(
        options.signal?.aborted ? "CANCELLED" : "UPSTREAM_TIMEOUT",
        options.signal?.aborted ? "任务已停止等待。" : "服务响应超时。",
      );
    const target = await resolveTarget(url, signal);
    const dispatcher = new Agent({
      connect: {
        autoSelectFamily: false,
        lookup: (_hostname, _options, callback) =>
          callback(null, target.address, target.family),
      },
    });
    try {
      const response = await request(url, {
        method,
        headers: Object.fromEntries(headers.entries()),
        body,
        dispatcher,
        signal,
        headersTimeout: timeoutMs,
        bodyTimeout: timeoutMs,
      });
      // Destroying an unread undici body emits an error; observe it before any early exit.
      response.body.on("error", () => {});
      const responseHeaders = new Headers();
      for (const [key, value] of Object.entries(response.headers)) {
        if (Array.isArray(value))
          value.forEach((v) => responseHeaders.append(key, v));
        else if (value !== undefined) responseHeaders.set(key, value);
      }
      if ([301, 302, 303, 307, 308].includes(response.statusCode)) {
        response.body.destroy();
        if (!["GET", "HEAD"].includes(method))
          throw new SafeHttpError(
            "UNSAFE_REDIRECT",
            "服务提交接口不能自动重定向。",
          );
        const location = responseHeaders.get("location");
        if (!location || hop === (options.maxRedirects ?? 3))
          throw new SafeHttpError(
            "REDIRECT_LIMIT",
            "远程地址重定向过多或无效。",
          );
        const next = new URL(location, url);
        if (next.origin !== url.origin)
          headers = new Headers(
            [...headers.entries()].filter(
              ([key]) =>
                ![
                  "authorization",
                  "cookie",
                  "x-api-key",
                  "xi-api-key",
                ].includes(key),
            ),
          );
        url = next;
        continue;
      }
      const declared = Number(responseHeaders.get("content-length"));
      if (Number.isFinite(declared) && declared > maxBytes) {
        response.body.destroy();
        throw new SafeHttpError("RESPONSE_TOO_LARGE", "远程响应超过允许大小。");
      }
      const chunks: Buffer[] = [];
      let length = 0;
      for await (const chunk of response.body) {
        const bytes = Buffer.from(chunk);
        length += bytes.length;
        if (length > maxBytes) {
          response.body.destroy();
          throw new SafeHttpError(
            "RESPONSE_TOO_LARGE",
            "远程响应超过允许大小。",
          );
        }
        chunks.push(bytes);
      }
      return {
        status: response.statusCode,
        ok: response.statusCode >= 200 && response.statusCode < 300,
        headers: responseHeaders,
        body: Buffer.concat(chunks),
        url: url.href,
      };
    } catch (error) {
      if (error instanceof SafeHttpError) throw error;
      if (signal.aborted)
        throw new SafeHttpError(
          options.signal?.aborted ? "CANCELLED" : "UPSTREAM_TIMEOUT",
          options.signal?.aborted ? "任务已停止等待。" : "服务响应超时。",
        );
      throw new SafeHttpError("NETWORK_ERROR", "服务连接失败。");
    } finally {
      await dispatcher.destroy();
    }
  }
  throw new SafeHttpError("REDIRECT_LIMIT", "远程地址重定向过多。");
}
