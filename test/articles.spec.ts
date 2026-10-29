import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { ArticlesService } from "../src/articles/articles.service.js";
import { newsroomBasics, setup, type TestContext } from "./helpers.js";

let t: TestContext;
let editor: string;
let writer: string;
let basics: Awaited<ReturnType<typeof newsroomBasics>>;

beforeAll(async () => {
  t = await setup();
  basics = await newsroomBasics(t.prisma);
  editor = await t.token("editor@test.local");
  writer = await t.token("writer@test.local");
});
afterAll(() => t.app.close());

const draft = () => ({
  title: "Next-Gen Solid-State EV Batteries Set to Revolutionize Urban Mobility",
  synopsis: "Solid-state cells promise twice the range.",
  primaryCategoryId: basics.category.id,
  regionIds: [basics.india.id],
  writerIds: [basics.writer.id],
  tagNames: ["Electric Vehicle", "Batteries"],
  body: [{ kind: "text", html: '<p onclick="steal()">Hello <script>alert(1)</script><a href="javascript:x()">x</a></p>' }],
});

describe("articles", () => {
  it("creates a draft with a slug, editions, bylines and new tags, and cleans the HTML", async () => {
    const res = await t.http().post("/v1/cms/articles").set("Authorization", writer).send(draft()).expect(201);
    expect(res.body).toMatchObject({
      status: "DRAFT",
      slug: "next-gen-solid-state-ev-batteries-set-to-revolutionize-urban-mobility",
      regions: [{ code: "IN" }],
      bylines: [{ name: "Automobility Next Team" }],
    });
    expect(res.body.tags.map((tg: { name: string }) => tg.name).sort()).toEqual(["Batteries", "Electric Vehicle"]);
    const html = res.body.body[0].html as string;
    expect(html).not.toMatch(/script|onclick|javascript:/);
    expect(html).toContain("Hello");
  });

  it("gives a second article with the same title a different slug, and reuses existing tags", async () => {
    const res = await t.http().post("/v1/cms/articles").set("Authorization", writer).send(draft()).expect(201);
    expect(res.body.slug).toBe("next-gen-solid-state-ev-batteries-set-to-revolutionize-urban-mobility-2");
    expect(await t.prisma.tag.count()).toBe(2);
  });

  it("validates required fields with readable errors", async () => {
    const res = await t.http().post("/v1/cms/articles").set("Authorization", writer).send({ title: "", writerIds: [] }).expect(400);
    const paths = res.body.fields.map((f: { path: string }) => f.path);
    expect(paths).toEqual(expect.arrayContaining(["title", "primaryCategoryId", "writerIds"]));
  });

  it("lets a writer edit but not publish", async () => {
    const { body: a } = await t.http().post("/v1/cms/articles").set("Authorization", writer).send(draft()).expect(201);
    await t.http().patch(`/v1/cms/articles/${a.id}`).set("Authorization", writer).send({ synopsis: "Updated" }).expect(200);
    const denied = await t.http().post(`/v1/cms/articles/${a.id}/publish`).set("Authorization", writer).send({}).expect(403);
    expect(denied.body.message).toContain("articles:publish");
    // Status can't be smuggled through a normal edit either.
    const edited = await t.http().patch(`/v1/cms/articles/${a.id}`).set("Authorization", writer).send({ status: "PUBLISHED" }).expect(200);
    expect(edited.body.status).toBe("DRAFT");
  });

  it("keeps fields the client leaves out of an edit", async () => {
    const { body: a } = await t.http().post("/v1/cms/articles").set("Authorization", editor).send({ ...draft(), storyType: "REVIEW" }).expect(201);
    const res = await t.http().patch(`/v1/cms/articles/${a.id}`).set("Authorization", editor).send({ title: "New title" }).expect(200);
    expect(res.body).toMatchObject({ title: "New title", storyType: "REVIEW", regions: [{ code: "IN" }] });
    expect(res.body.tags).toHaveLength(2);
  });

  it("saves a revision on every edit", async () => {
    const { body: a } = await t.http().post("/v1/cms/articles").set("Authorization", editor).send(draft()).expect(201);
    await t.http().patch(`/v1/cms/articles/${a.id}`).set("Authorization", editor).send({ title: "Second" }).expect(200);
    await t.http().patch(`/v1/cms/articles/${a.id}`).set("Authorization", editor).send({ title: "Third" }).expect(200);
    const res = await t.http().get(`/v1/cms/articles/${a.id}/revisions`).set("Authorization", editor).expect(200);
    expect(res.body.map((r: { data: { title: string } }) => r.data.title)).toEqual(["Second", draft().title]);
  });

  it("locks an article while someone edits it", async () => {
    const { body: a } = await t.http().post("/v1/cms/articles").set("Authorization", editor).send(draft()).expect(201);
    const lock = await t.http().post(`/v1/cms/articles/${a.id}/lock`).set("Authorization", editor).expect(200);
    expect(lock.body.user.name).toBe("Eddie Editor");

    const blocked = await t.http().patch(`/v1/cms/articles/${a.id}`).set("Authorization", writer).send({ title: "Mine now" }).expect(423);
    expect(blocked.body.message).toBe("Eddie Editor is editing this article");
    await t.http().post(`/v1/cms/articles/${a.id}/lock`).set("Authorization", writer).expect(423);
    await t.http().delete(`/v1/cms/articles/${a.id}/lock`).set("Authorization", writer).expect(423);

    const listed = await t.http().get(`/v1/cms/articles/${a.id}`).set("Authorization", writer).expect(200);
    expect(listed.body.lock.user.name).toBe("Eddie Editor");

    await t.http().delete(`/v1/cms/articles/${a.id}/lock`).set("Authorization", editor).expect(204);
    await t.http().patch(`/v1/cms/articles/${a.id}`).set("Authorization", writer).send({ title: "Mine now" }).expect(200);
  });

  it("treats a lock older than 15 minutes as abandoned", async () => {
    const { body: a } = await t.http().post("/v1/cms/articles").set("Authorization", editor).send(draft()).expect(201);
    const eddie = await t.prisma.staffUser.findUniqueOrThrow({ where: { email: "editor@test.local" } });
    await t.prisma.article.update({ where: { id: a.id }, data: { lockedById: eddie.id, lockedAt: new Date(Date.now() - 16 * 60_000) } });
    await t.http().patch(`/v1/cms/articles/${a.id}`).set("Authorization", writer).send({ title: "Taken over" }).expect(200);
  });

  it("publishes now, schedules for later, and publishes scheduled articles when due", async () => {
    const { body: now } = await t.http().post("/v1/cms/articles").set("Authorization", editor).send(draft()).expect(201);
    const published = await t.http().post(`/v1/cms/articles/${now.id}/publish`).set("Authorization", editor).send({}).expect(200);
    expect(published.body.status).toBe("PUBLISHED");
    expect(published.body.publishedAt).toBeTruthy();

    const { body: later } = await t.http().post("/v1/cms/articles").set("Authorization", editor).send(draft()).expect(201);
    const at = new Date(Date.now() + 3_600_000);
    const scheduled = await t.http().post(`/v1/cms/articles/${later.id}/publish`).set("Authorization", editor).send({ at }).expect(200);
    expect(scheduled.body).toMatchObject({ status: "SCHEDULED", publishedAt: null });

    const service = t.app.get(ArticlesService);
    expect(await service.publishDue(new Date())).toBe(0);
    expect(await service.publishDue(new Date(at.getTime() + 1000))).toBe(1);
    const after = await t.prisma.article.findUniqueOrThrow({ where: { id: later.id } });
    expect(after.status).toBe("PUBLISHED");
  });

  it("filters the list by status, category, edition and search", async () => {
    await t.http().post("/v1/cms/articles").set("Authorization", editor).send({ ...draft(), title: "MoRTH Proposes Mandatory Emergency Braking", primaryCategoryId: basics.other.id, regionIds: [basics.me.id] }).expect(201);
    const byCategory = await t.http().get(`/v1/cms/articles?categoryId=${basics.other.id}`).set("Authorization", editor).expect(200);
    expect(byCategory.body.data.map((a: { title: string }) => a.title)).toEqual(["MoRTH Proposes Mandatory Emergency Braking"]);
    expect(byCategory.body.data[0].body).toBeUndefined();
    const byRegion = await t.http().get(`/v1/cms/articles?regionId=${basics.me.id}&search=braking`).set("Authorization", editor).expect(200);
    expect(byRegion.body.meta.total).toBe(1);
    const published = await t.http().get("/v1/cms/articles?status=PUBLISHED&limit=1").set("Authorization", editor).expect(200);
    expect(published.body.meta).toMatchObject({ limit: 1, total: 2 });
  });

  it("soft-deletes, and the audit log records who did what", async () => {
    const { body: a } = await t.http().post("/v1/cms/articles").set("Authorization", editor).send(draft()).expect(201);
    await t.http().delete(`/v1/cms/articles/${a.id}`).set("Authorization", editor).expect(204);
    await t.http().get(`/v1/cms/articles/${a.id}`).set("Authorization", editor).expect(404);
    expect(await t.prisma.article.findUnique({ where: { id: a.id } })).not.toBeNull();
    const admin = await t.token("admin@test.local");
    const log = await t.http().get(`/v1/cms/logs/audit?entity=article&entityId=${a.id}`).set("Authorization", admin).expect(200);
    expect(log.body.data.map((l: { action: string }) => l.action)).toEqual(["delete", "create"]);
  });
});
