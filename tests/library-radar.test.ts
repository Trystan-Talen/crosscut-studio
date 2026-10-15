import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { resolve } from "node:path";
import { createApp } from "../src/server/app.js";
import { now, uid } from "../src/server/core.js";

let fixture: Awaited<ReturnType<typeof createApp>>;
let directory: string;
let cookie: string;
let owner: string;
beforeEach(async () => {
  await mkdir(resolve("data/test-runs"), { recursive: true });
  directory = await mkdtemp(resolve("data/test-runs/library-radar-"));
  fixture = await createApp({ dataDir: directory, serveStatic: false });
  const response = await fixture.app.inject({
    method: "POST",
    url: "/api/auth/setup",
    payload: {
      email: "collections@example.test",
      name: "资料检索验收",
      password: "Synthetic-collections-42",
    },
  });
  expect(response.statusCode, response.body).toBe(200);
  cookie = response.cookies
    .map((value) => `${value.name}=${value.value}`)
    .join("; ");
  owner = response.json().user.id;
});
afterEach(async () => {
  await fixture.app.close();
  await rm(directory, { recursive: true, force: true });
});
function call(
  method: "GET" | "POST" | "PATCH",
  path: string,
  payload?: Record<string, unknown>,
) {
  return fixture.app.inject({
    method,
    url: `/api${path}`,
    headers: { cookie, origin: "http://127.0.0.1:4318" },
    ...(payload ? { payload } : {}),
  });
}
function query(path: string, values: Record<string, string>) {
  return call("GET", `${path}?${new URLSearchParams(values)}`);
}
function otherUser() {
  const id = uid();
  fixture.store.run(
    "INSERT INTO users(id,email,name,password_hash,created_at) VALUES(?,?,?,?,?)",
    id,
    `${id}@example.test`,
    "隔离账号",
    "unused-synthetic-password-hash",
    now(),
  );
  return id;
}
// Metadata-only records exercise SQL filtering, never pretend to verify decoding.
function asset(
  name: string,
  created: string,
  tags: string[] = [],
  user = owner,
  kind = "video",
) {
  const id = uid();
  fixture.store.run(
    "INSERT INTO assets(id,owner_id,name,kind,mime,size,duration,width,height,storage_key,tags,source,sha256,created_at) VALUES(?,?,?,?,?,1,1,640,640,?,?,'fixture','synthetic',?)",
    id,
    user,
    name,
    kind,
    kind === "video" ? "video/mp4" : "image/png",
    `${id}.fixture`,
    JSON.stringify(tags),
    created,
  );
  return id;
}
async function radar(
  title: string,
  industry: string,
  fields: Record<string, unknown> = {},
) {
  const result = await call("POST", "/radar", { title, industry, ...fields });
  expect(result.statusCode, result.body).toBe(200);
  return result.json();
}

describe("素材与雷达真实资料检索", () => {
  it("素材按名称或标签字面搜索，组合类型/标签筛选且不泄露其他用户标签", async () => {
    const a = asset("ad_one", "2026-10-14T07:00:00.000Z", [
      "100%棉",
      "launch,US",
    ]);
    const b = asset("adXone", "2026-10-14T08:00:00.000Z", ["100棉", "室内"]);
    asset("静态图", "2026-10-14T09:00:00.000Z", ["100%棉"], owner, "image");
    asset("ad_one", "2026-10-14T10:00:00.000Z", ["他人私有标签"], otherUser());
    const name = await query("/assets", { search: "ad_one" });
    expect(name.statusCode, name.body).toBe(200);
    expect(name.json().items.map((item: { id: string }) => item.id)).toEqual([
      a,
    ]);
    const combined = await query("/assets", {
      search: "%",
      kind: "video",
      tags: JSON.stringify(["launch,US"]),
    });
    expect(
      combined.json().items.map((item: { id: string }) => item.id),
    ).toEqual([a]);
    expect(combined.json().tags).toEqual([
      "100%棉",
      "100棉",
      "launch,US",
      "室内",
    ]);
    expect(
      (await query("/assets", { search: "室内" })).json().items[0].id,
    ).toBe(b);
    expect(
      (await query("/assets", { search: "%' OR 1=1 --" })).json().total,
    ).toBe(0);
  });

  it("以当地日期换算的明确边界筛选，覆盖夏令时23小时日与排序", async () => {
    const first = asset("第一条", "2026-03-08T08:00:00.000Z");
    const last = asset("最后一条", "2026-03-09T06:59:59.999Z");
    asset("前一天", "2026-03-08T07:59:59.999Z");
    asset("后一天", "2026-03-09T07:00:00.000Z");
    const dates = {
      from: "2026-03-08T00:00:00-08:00",
      before: "2026-03-09T00:00:00-07:00",
    };
    const response = await query("/assets", { ...dates, sort: "oldest" });
    expect(response.statusCode, response.body).toBe(200);
    expect(
      response.json().items.map((item: { id: string }) => item.id),
    ).toEqual([first, last]);
    expect(
      (await query("/assets", { ...dates, sort: "newest" })).json().items[0].id,
    ).toBe(last);
    for (const path of ["/assets", "/radar"]) {
      expect(
        (await query(path, { from: "2026-02-30T00:00:00Z" })).statusCode,
      ).toBe(400);
      const reversed = await query(path, {
        from: dates.before,
        before: dates.from,
      });
      expect(reversed.statusCode).toBe(400);
      expect(reversed.json().error.code).toBe("INVALID_DATE_RANGE");
    }
  });

  it("回收站、项目和标签选项继续按用户隔离，拒绝畸形多选", async () => {
    const kept = asset("保留", "2026-10-14T00:00:00.000Z", ["在用"]);
    const removed = asset("回收", "2026-10-13T00:00:00.000Z", ["回收标签"]);
    expect(
      (await call("PATCH", `/assets/${removed}`, { deleted: true })).statusCode,
    ).toBe(200);
    const active = (await call("GET", "/assets")).json();
    expect(active.items.map((item: { id: string }) => item.id)).toEqual([kept]);
    expect(active.tags).toEqual(["在用"]);
    const trash = (
      await query("/assets", { trash: "1", tags: JSON.stringify(["回收标签"]) })
    ).json();
    expect(trash.total).toBe(1);
    expect(trash.tags).toEqual(["回收标签"]);
    const stranger = otherUser(),
      project = uid();
    fixture.store.run(
      "INSERT INTO projects(id,owner_id,name,created_at,updated_at) VALUES(?,?,?,?,?)",
      project,
      stranger,
      "他人项目",
      now(),
      now(),
    );
    expect((await query("/assets", { projectId: project })).statusCode).toBe(
      404,
    );
    for (const tags of [
      "not-json",
      JSON.stringify("标签"),
      JSON.stringify(Array(51).fill("标签")),
    ])
      expect((await query("/assets", { tags })).statusCode).toBe(400);
  });

  it("雷达行业父级包含真实子类，兼容单层行业且严格区分路径边界", async () => {
    const imported = await call("POST", "/radar/import", {
      items: [
        { title: "父级", industry: "游戏" },
        { title: "休闲", industry: " 游戏/ 休闲 " },
        { title: "益智", industry: "游戏 / 休闲 / 益智" },
        { title: "相似但不同", industry: "游戏化 / 教育" },
        { title: "平级旧格式", industry: "美妆" },
        { title: "带百分号", industry: "100%_类 / 子类" },
        { title: "非百分号", industry: "100xx类 / 子类" },
        { title: "带逗号", industry: "品牌,创意 / 设计" },
        { title: "英文大写分类", industry: "Game / Casual" },
        { title: "英文小写分类", industry: "game / Casual" },
        { title: "旧100字符单层分类", industry: "x".repeat(100) },
      ],
    });
    expect(imported.statusCode, imported.body).toBe(200);
    expect(imported.json().items[1].industry).toBe("游戏 / 休闲");
    const parent = (
      await query("/radar", { industryPaths: JSON.stringify(["游戏"]) })
    ).json();
    expect(parent.total).toBe(3);
    expect(
      new Set(parent.items.map((item: { title: string }) => item.title)),
    ).toEqual(new Set(["父级", "休闲", "益智"]));
    expect(
      (await query("/radar", { industry: "游戏 / 休闲" })).json().total,
    ).toBe(2);
    expect((await query("/radar", { industry: "美妆" })).json().total).toBe(1);
    expect(
      (
        await query("/radar", {
          industryPaths: JSON.stringify(["游戏", "游戏 / 休闲", "美妆"]),
        })
      ).json().total,
    ).toBe(4);
    const literal = (
      await query("/radar", { industryPaths: JSON.stringify(["100%_类"]) })
    ).json();
    expect(literal.total).toBe(1);
    expect(literal.items[0].title).toBe("带百分号");
    expect(
      (
        await query("/radar", { industryPaths: JSON.stringify(["品牌,创意"]) })
      ).json().total,
    ).toBe(1);
    const caseSensitive = (
      await query("/radar", { industryPaths: JSON.stringify(["Game"]) })
    ).json();
    expect(caseSensitive.total).toBe(1);
    expect(caseSensitive.items[0].title).toBe("英文大写分类");
    expect(
      (await query("/radar", { industry: "x".repeat(100) })).json().total,
    ).toBe(1);
    for (const industry of ["游戏 // 休闲", "a/b/c/d/e/f", "x".repeat(101)])
      expect(
        (await call("POST", "/radar", { title: "无效路径", industry }))
          .statusCode,
      ).toBe(400);
    expect((await query("/radar", { industryPaths: "{}" })).statusCode).toBe(
      400,
    );
  });

  it("雷达结合行业、国家、目标、真实关联标签与添加日期并保持外部指标未知", async () => {
    const linked = asset("授权视频", "2026-10-14T08:00:00.000Z", [
      "新品",
      "campaign,one",
    ]);
    const matching = await radar("详情_100%", "美妆 / 护肤", {
      country: "美国",
      objective: "转化",
      format: "vertical",
      assetId: linked,
      sourceUrl: "https://example.test/products/serum",
    });
    await radar("排除国家", "美妆 / 护肤", {
      country: "法国",
      objective: "转化",
      assetId: linked,
    });
    await radar("排除标签", "美妆 / 护肤", {
      country: "美国",
      objective: "转化",
    });
    fixture.store.run(
      "UPDATE radar_assets SET created_at=? WHERE id=?",
      "2026-10-14T08:00:00.000Z",
      matching.id,
    );
    const q = {
      industryPaths: JSON.stringify(["美妆"]),
      country: "美国,日本",
      objective: "转化",
      format: "vertical",
      tags: JSON.stringify(["campaign,one"]),
      from: "2026-10-14T00:00:00-07:00",
      before: "2026-10-15T00:00:00-07:00",
    };
    const result = (await query("/radar", q)).json();
    expect(result.total).toBe(1);
    expect(result.items[0]).toMatchObject({
      id: matching.id,
      likes: null,
      ctr: null,
      budget: null,
      metrics: [],
      asset: { tags: ["新品", "campaign,one"] },
    });
    expect((await query("/radar", { search: "%" })).json().total).toBe(1);
    expect(
      (await query("/radar", { search: "products/serum" })).json().total,
    ).toBe(1);
    expect((await query("/radar", { search: matching.id })).json().total).toBe(
      1,
    );
    expect(
      (await query("/radar", { ...q, before: "2026-10-14T08:00:00Z" })).json()
        .total,
    ).toBe(0);
  });

  it("收藏按真实收藏时间而非添加时间排序，重复收藏不改时间，其他账号不可见", async () => {
    const early = await radar("先添加后收藏", "游戏"),
      late = await radar("后添加先收藏", "游戏 / 休闲");
    for (const [item, created, favorited] of [
      [early, "2026-10-10T00:00:00.000Z", "2026-10-14T12:00:00.000Z"],
      [late, "2026-10-13T00:00:00.000Z", "2026-10-14T11:00:00.000Z"],
    ] as const) {
      fixture.store.run(
        "UPDATE radar_assets SET created_at=? WHERE id=?",
        created,
        item.id,
      );
      expect(
        (await call("POST", `/radar/${item.id}/favorite`, { favorite: true }))
          .statusCode,
      ).toBe(200);
      fixture.store.run(
        "UPDATE favorites SET created_at=? WHERE radar_id=? AND user_id=?",
        favorited,
        item.id,
        owner,
      );
    }
    await call("POST", `/radar/${early.id}/favorite`, { favorite: true });
    expect(
      fixture.store.get(
        "SELECT created_at FROM favorites WHERE radar_id=? AND user_id=?",
        early.id,
        owner,
      )?.created_at,
    ).toBe("2026-10-14T12:00:00.000Z");
    const recent = (
      await query("/radar", {
        favorite: "1",
        sort: "favorite_at",
        order: "desc",
      })
    ).json();
    expect(recent.items.map((item: { id: string }) => item.id)).toEqual([
      early.id,
      late.id,
    ]);
    expect(
      (
        await query("/radar", {
          favorite: "1",
          sort: "favorite_at",
          order: "asc",
        })
      ).json().items[0].id,
    ).toBe(late.id);
    expect(
      (
        await query("/radar", {
          favorite: "1",
          sort: "created_at",
          order: "desc",
        })
      ).json().items[0].id,
    ).toBe(late.id);
    const stranger = otherUser();
    fixture.store.run(
      "UPDATE radar_assets SET owner_id=? WHERE id=?",
      stranger,
      late.id,
    );
    expect(
      (await query("/radar", { favorite: "1", sort: "favorite_at" })).json()
        .total,
    ).toBe(1);
    expect(
      (await call("POST", `/radar/${late.id}/favorite`, { favorite: false }))
        .statusCode,
    ).toBe(404);
    const foreignAsset = asset("私有视频", now(), ["私有"], stranger);
    const before = (await call("GET", "/radar")).json().total;
    expect(
      (
        await call("POST", "/radar/import", {
          items: [
            { title: "须回滚" },
            { title: "非法关联", assetId: foreignAsset },
          ],
        })
      ).statusCode,
    ).toBe(404);
    expect((await call("GET", "/radar")).json().total).toBe(before);
  });
});
