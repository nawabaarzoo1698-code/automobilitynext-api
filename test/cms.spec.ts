import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { patchSchema } from "../src/common/validation.js";
import { decryptField, encryptField, mask } from "../src/common/crypto.js";
import { slugify } from "../src/common/text.js";
import { z } from "zod";
import { setup, type TestContext } from "./helpers.js";

let t: TestContext;
let admin: string;
let editor: string;
let writer: string;

beforeAll(async () => {
  t = await setup();
  admin = await t.token("admin@test.local");
  editor = await t.token("editor@test.local");
  writer = await t.token("writer@test.local");
});
afterAll(() => t.app.close());

describe("CMS tables", () => {
  it("creates nested categories with slugs and counts", async () => {
    const parent = await t.http().post("/v1/cms/categories").set("Authorization", editor).send({ name: "Electric Vehicles" }).expect(201);
    const child = await t.http().post("/v1/cms/categories").set("Authorization", editor).send({ name: "Commercial Vehicles", parentId: parent.body.id }).expect(201);
    expect(child.body).toMatchObject({ slug: "commercial-vehicles", parent: { name: "Electric Vehicles" }, newsItems: 0 });
    const dup = await t.http().post("/v1/cms/categories").set("Authorization", editor).send({ name: "Electric Vehicles" }).expect(201);
    expect(dup.body.slug).toBe("electric-vehicles-2");
    await t.http().patch(`/v1/cms/categories/${parent.body.id}`).set("Authorization", editor).send({ parentId: parent.body.id }).expect(400);
  });

  it("leaves fields out of a PATCH unchanged instead of resetting them to defaults", async () => {
    const c = await t.http().post("/v1/cms/categories").set("Authorization", editor).send({ name: "Industry", active: false, sortOrder: 4 }).expect(201);
    const res = await t.http().patch(`/v1/cms/categories/${c.body.id}`).set("Authorization", editor).send({ name: "Industry News" }).expect(200);
    expect(res.body).toMatchObject({ name: "Industry News", active: false, sortOrder: 4, slug: "industry" });
  });

  it("searches, sorts and pages lists", async () => {
    const res = await t.http().get("/v1/cms/categories?search=vehicles&sort=name:desc&limit=1").set("Authorization", editor).expect(200);
    expect(res.body.meta).toEqual({ page: 1, limit: 1, total: 3 });
    expect(res.body.data[0].name).toBe("Electric Vehicles");
    await t.http().get("/v1/cms/categories?limit=1000").set("Authorization", editor).expect(400);
  });

  it("answers 409 for a duplicate unique value and 404 for a missing record", async () => {
    await t.http().post("/v1/cms/regions").set("Authorization", admin).send({ name: "India", code: "in" }).expect(201);
    const dup = await t.http().post("/v1/cms/regions").set("Authorization", admin).send({ name: "India 2", code: "IN" }).expect(409);
    expect(dup.body.error).toBe("already_exists");
    await t.http().patch("/v1/cms/regions/999").set("Authorization", admin).send({ name: "x" }).expect(404);
  });

  it("encrypts writers' PAN and bank account and only returns them masked", async () => {
    const res = await t.http().post("/v1/cms/writers").set("Authorization", editor).send({ firstName: "Asha", lastName: "Rao", pan: "abcde1234f", bankAccountNumber: "123456789012", ifsc: "hdfc0001234" }).expect(201);
    expect(res.body).toMatchObject({ pan: "******234F", bankAccountNumber: "********9012", ifsc: "HDFC0001234", slug: "asha-rao" });
    const row = await t.prisma.writer.findUniqueOrThrow({ where: { id: res.body.id } });
    expect(row.panEnc).not.toContain("ABCDE");
    expect(decryptField(row.panEnc)).toBe("ABCDE1234F");
    await t.http().post("/v1/cms/writers").set("Authorization", editor).send({ firstName: "Bad", pan: "123" }).expect(400);
  });

  it("validates page blocks and keeps one homepage per region", async () => {
    const region = await t.prisma.region.findUniqueOrThrow({ where: { code: "IN" } });
    const a = await t.http().post("/v1/cms/pages").set("Authorization", editor).send({ name: "EV Page", regionId: region.id, isHomepage: true, blocks: [{ id: "top", source: { kind: "latest" } }] }).expect(201);
    expect(a.body.blocks[0]).toMatchObject({ contentCount: 6, template: "grid" });
    await t.http().post("/v1/cms/pages").set("Authorization", editor).send({ name: "Bad", blocks: [{ id: "x", source: { kind: "nope" } }] }).expect(400);
    await t.http().post("/v1/cms/pages").set("Authorization", editor).send({ name: "EV Page v2", regionId: region.id, isHomepage: true }).expect(201);
    const homes = await t.prisma.page.findMany({ where: { regionId: region.id, isHomepage: true } });
    expect(homes.map((p) => p.name)).toEqual(["EV Page v2"]);
  });

  it("keeps the block builder's layout choices on page blocks", async () => {
    const res = await t.http().post("/v1/cms/pages").set("Authorization", editor).send({ name: "Layout", blocks: [{ id: "a", block: "Hero Grid", desktopWidth: "Half", displayLogic: "Latest", autoStories: true, source: { kind: "latest" } }] }).expect(201);
    expect(res.body.blocks[0]).toMatchObject({ block: "Hero Grid", desktopWidth: "Half", displayLogic: "Latest", autoStories: true });
  });

  it("lets staff add a subscriber and change their status", async () => {
    const res = await t.http().post("/v1/cms/subscribers").set("Authorization", admin).send({ email: "Fan@Example.com", name: "Fan" }).expect(201);
    expect(res.body).toMatchObject({ email: "fan@example.com", status: "ACTIVE" });
    expect(res.body.confirmToken).toBeUndefined();
    const off = await t.http().patch(`/v1/cms/subscribers/${res.body.id}`).set("Authorization", admin).send({ status: "UNSUBSCRIBED" }).expect(200);
    expect(off.body).toMatchObject({ status: "UNSUBSCRIBED", name: "Fan" });
    await t.http().post("/v1/cms/subscribers").set("Authorization", admin).send({ email: "fan@example.com" }).expect(409);
  });

  it("checks permissions on every table", async () => {
    await t.http().get("/v1/cms/categories").set("Authorization", writer).expect(403);
    await t.http().post("/v1/cms/menus").set("Authorization", writer).send({ name: "Main", position: "HEADER" }).expect(403);
    await t.http().delete("/v1/cms/categories/1").set("Authorization", editor).expect(403);
    await t.http().get("/v1/cms/grievances").set("Authorization", editor).expect(403);
    await t.http().get("/v1/cms/grievances").set("Authorization", admin).expect(200);
    // Writers pick editions in the article editor, so they may read regions but not change them.
    await t.http().get("/v1/cms/regions").set("Authorization", writer).expect(200);
    await t.http().post("/v1/cms/regions").set("Authorization", writer).send({ name: "Europe", code: "EU" }).expect(403);
  });
});

describe("users and roles", () => {
  it("lists users without password hashes and with login status", async () => {
    const res = await t.http().get("/v1/cms/users").set("Authorization", admin).expect(200);
    expect(res.body.meta.total).toBe(3);
    for (const u of res.body.data) expect(u.passwordHash).toBeUndefined();
    expect(res.body.data.find((u: { email: string }) => u.email === "admin@test.local").loginStatus).toBe("Active");
  });

  it("does not let a non-administrator create or promote an administrator", async () => {
    const superAdmin = await t.prisma.role.findUniqueOrThrow({ where: { name: "Super Admin" } });
    const eddie = await t.prisma.staffUser.findUniqueOrThrow({ where: { email: "editor@test.local" } });
    await t.http().post("/v1/cms/users").set("Authorization", editor).send({ name: "Sneaky", email: "sneaky@test.local", roleId: superAdmin.id, password: "long-enough-pass" }).expect(403);
    await t.http().patch(`/v1/cms/users/${eddie.id}`).set("Authorization", editor).send({ roleId: superAdmin.id }).expect(403);
    const adminUser = await t.prisma.staffUser.findUniqueOrThrow({ where: { email: "admin@test.local" } });
    await t.http().patch(`/v1/cms/users/${adminUser.id}`).set("Authorization", editor).send({ password: "taken-over-123" }).expect(403);
  });

  it("creates a user who can then sign in, with a hashed password", async () => {
    const writerRole = await t.prisma.role.findUniqueOrThrow({ where: { name: "Writer" } });
    await t.http().post("/v1/cms/users").set("Authorization", editor).send({ name: "New Writer", email: "New@Test.local", roleId: writerRole.id, password: "short" }).expect(400);
    const res = await t.http().post("/v1/cms/users").set("Authorization", editor).send({ name: "New Writer", email: "New@Test.local", roleId: writerRole.id, password: "a-long-password" }).expect(201);
    expect(res.body.email).toBe("new@test.local");
    await t.http().post("/v1/auth/login").send({ email: "new@test.local", password: "a-long-password" }).expect(200);
  });

  it("validates role permissions against the catalog", async () => {
    const catalog = await t.http().get("/v1/cms/permissions").set("Authorization", admin).expect(200);
    expect(catalog.body.modules.find((m: { key: string }) => m.key === "articles").permissions).toContain("articles:publish");
    await t.http().post("/v1/cms/roles").set("Authorization", admin).send({ name: "Odd", permissions: ["articles:fly"] }).expect(400);
    const role = await t.http().post("/v1/cms/roles").set("Authorization", admin).send({ name: "SEO", permissions: ["seo:view", "seo:edit"] }).expect(201);
    await t.http().delete(`/v1/cms/roles/${role.body.id}`).set("Authorization", admin).expect(204);
    const writerRole = await t.prisma.role.findUniqueOrThrow({ where: { name: "Writer" } });
    await t.http().delete(`/v1/cms/roles/${writerRole.id}`).set("Authorization", admin).expect(400);
  });

  it("stores global settings", async () => {
    await t.http().put("/v1/cms/settings/app-language").set("Authorization", admin).send({ value: "en-US" }).expect(200);
    await t.http().put("/v1/cms/settings/Bad Key").set("Authorization", admin).send({ value: "x" }).expect(400);
    const res = await t.http().get("/v1/cms/settings").set("Authorization", admin).expect(200);
    expect(res.body.data).toEqual([expect.objectContaining({ key: "app-language", value: "en-US" })]);
  });
});

describe("helpers", () => {
  it("slugifies headlines", () => {
    expect(slugify("Tyres & Lubricants")).toBe("tyres-and-lubricants");
    expect(slugify("JK Tyre Plans Further 4-5% Price Hike in Q3!")).toBe("jk-tyre-plans-further-4-5-price-hike-in-q3");
    expect(slugify("Électrique")).toBe("electrique");
  });

  it("round-trips encrypted fields and masks", () => {
    const enc = encryptField("123456789012")!;
    expect(encryptField("123456789012")).not.toBe(enc);
    expect(decryptField(enc)).toBe("123456789012");
    expect(mask("123456789012")).toBe("********9012");
    expect(encryptField("")).toBeNull();
  });

  it("builds PATCH schemas without defaults", () => {
    const s = patchSchema(z.object({ a: z.boolean().default(true), b: z.string() }));
    expect(s.parse({})).toEqual({});
    expect(s.parse({ a: false })).toEqual({ a: false });
  });
});
