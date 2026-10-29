import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { PASSWORD, setup, type TestContext } from "./helpers.js";

let t: TestContext;
beforeAll(async () => {
  t = await setup();
});
afterAll(() => t.app.close());

function refreshCookie(res: { headers: Record<string, unknown> }) {
  const cookies = res.headers["set-cookie"] as string[];
  return cookies.find((c) => c.startsWith("an_refresh="))!.split(";")[0];
}

describe("staff sign-in", () => {
  it("signs in, sets an HttpOnly refresh cookie, and keeps the refresh token out of the body", async () => {
    const res = await t.http().post("/v1/auth/login").send({ email: "ADMIN@test.local", password: PASSWORD }).expect(200);
    expect(res.body.accessToken).toBeTypeOf("string");
    expect(res.body.refreshToken).toBeUndefined();
    expect(res.body.user).toMatchObject({ email: "admin@test.local", role: { name: "Super Admin" } });
    expect(res.body.user.passwordHash).toBeUndefined();
    const cookie = (res.headers["set-cookie"] as unknown as string[]).find((c) => c.startsWith("an_refresh="))!;
    expect(cookie).toMatch(/HttpOnly/);
    expect(cookie).toMatch(/Path=\/v1\/auth/);
  });

  it("gives app clients the refresh token in the body", async () => {
    const res = await t.http().post("/v1/auth/login").set("X-Client-Type", "app").send({ email: "admin@test.local", password: PASSWORD }).expect(200);
    expect(res.body.refreshToken).toBeTypeOf("string");
    const again = await t.http().post("/v1/auth/refresh").set("X-Client-Type", "app").send({ refreshToken: res.body.refreshToken }).expect(200);
    expect(again.body.refreshToken).not.toBe(res.body.refreshToken);
  });

  it("rejects a wrong password with the same message as an unknown email, and logs both", async () => {
    const wrong = await t.http().post("/v1/auth/login").send({ email: "admin@test.local", password: "nope" }).expect(401);
    const unknown = await t.http().post("/v1/auth/login").send({ email: "nobody@test.local", password: "nope" }).expect(401);
    expect(wrong.body.message).toBe(unknown.body.message);
    const failures = await t.prisma.accessLog.count({ where: { action: "LOGIN_FAILED" } });
    expect(failures).toBeGreaterThanOrEqual(2);
  });

  it("requires a token on CMS routes and ignores a user id in the URL", async () => {
    await t.http().get("/v1/cms/articles").expect(401);
    await t.http().get("/v1/cms/articles?userId=1").expect(401);
    await t.http().get("/v1/cms/articles").set("Authorization", "Bearer not-a-token").expect(401);
  });

  it("rotates refresh tokens and signs out everywhere when an old one is reused", async () => {
    const login = await t.http().post("/v1/auth/login").send({ email: "editor@test.local", password: PASSWORD }).expect(200);
    const first = refreshCookie(login);
    const refreshed = await t.http().post("/v1/auth/refresh").set("Cookie", first).expect(200);
    const second = refreshCookie(refreshed);
    expect(second).not.toBe(first);

    // Replaying the first token looks like theft: every session ends.
    await t.http().post("/v1/auth/refresh").set("Cookie", first).expect(401);
    await t.http().post("/v1/auth/refresh").set("Cookie", second).expect(401);
  });

  it("logs out and records it", async () => {
    const login = await t.http().post("/v1/auth/login").send({ email: "writer@test.local", password: PASSWORD }).expect(200);
    const cookie = refreshCookie(login);
    await t.http().post("/v1/auth/logout").set("Cookie", cookie).expect(204);
    await t.http().post("/v1/auth/refresh").set("Cookie", cookie).expect(401);
    const user = await t.prisma.staffUser.findUniqueOrThrow({ where: { email: "writer@test.local" } });
    expect(await t.prisma.accessLog.count({ where: { userId: user.id, action: "LOGOUT" } })).toBe(1);
  });

  it("returns the signed-in profile", async () => {
    const res = await t.http().get("/v1/auth/me").set("Authorization", await t.token("writer@test.local")).expect(200);
    expect(res.body).toMatchObject({ email: "writer@test.local", permissions: ["articles:view", "articles:create", "articles:edit"] });
  });

  it("blocks disabled accounts and ends their sessions", async () => {
    const admin = await t.token("admin@test.local");
    const login = await t.http().post("/v1/auth/login").send({ email: "writer@test.local", password: PASSWORD }).expect(200);
    const writer = await t.prisma.staffUser.findUniqueOrThrow({ where: { email: "writer@test.local" } });
    await t.http().patch(`/v1/cms/users/${writer.id}`).set("Authorization", admin).send({ active: false }).expect(200);
    await t.http().post("/v1/auth/refresh").set("Cookie", refreshCookie(login)).expect(401);
    await t.http().post("/v1/auth/login").send({ email: "writer@test.local", password: PASSWORD }).expect(401);
    await t.http().patch(`/v1/cms/users/${writer.id}`).set("Authorization", admin).send({ active: true }).expect(200);
  });
});
