import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { setup, type TestContext } from "./helpers.js";

// Media kept on this computer (MEDIA_LOCAL_DIR), as for running without S3.
let t: TestContext;
let admin: string;
let dir: string;

const PNG = Buffer.from("89504e470d0a1a0a0000000d49484452", "hex");

beforeAll(async () => {
  dir = await mkdtemp(path.join(tmpdir(), "an-media-"));
  process.env.MEDIA_LOCAL_DIR = dir;
  process.env.API_PUBLIC_URL = "http://localhost:4000";
  t = await setup();
  admin = await t.token("admin@test.local");
});
afterAll(async () => {
  await t.app.close();
  await rm(dir, { recursive: true, force: true });
});

const ticket = async (sizeBytes = PNG.length) =>
  (await t.http().post("/v1/cms/media/upload-url").set("Authorization", admin).send({ kind: "IMAGE", fileName: "car.png", mimeType: "image/png", sizeBytes }).expect(200)).body;

/** The upload URL's path and query, for supertest. */
const local = (url: string) => url.replace("http://localhost:4000", "");

describe("local media storage", () => {
  it("uploads, registers, serves and deletes a file", async () => {
    const tk = await ticket();
    expect(tk.uploadUrl).toMatch(/^http:\/\/localhost:4000\/v1\/cms\/media\/local-upload\?/);
    expect(tk.headers).toEqual({ "Content-Type": "image/png" });
    await t.http().put(local(tk.uploadUrl)).set("Content-Type", "image/png").send(PNG).expect(200);
    expect(await readFile(path.join(dir, tk.storageKey))).toEqual(PNG);

    const row = await t.http().post("/v1/cms/media").set("Authorization", admin).send({ kind: "IMAGE", storageKey: tk.storageKey, title: "Car", mimeType: "image/png", sizeBytes: PNG.length }).expect(201);
    expect(row.body.url).toBe(`http://localhost:4000/media/${tk.storageKey}`);

    const served = await t.http().get(`/media/${tk.storageKey}`).expect(200);
    expect(served.headers["cross-origin-resource-policy"]).toBe("cross-origin");
    expect(served.headers["content-type"]).toBe("image/png");

    await t.http().delete(`/v1/cms/media/${row.body.id}`).set("Authorization", admin).expect(204);
    await t.http().get(`/media/${tk.storageKey}`).expect(404);
  });

  it("rejects tampered links, wrong types and oversize bodies", async () => {
    const tk = await ticket();
    await t.http().put(local(tk.uploadUrl).replace("size=", "size=9")).set("Content-Type", "image/png").send(PNG).expect(403);
    await t.http().put(local(tk.uploadUrl)).set("Content-Type", "image/jpeg").send(PNG).expect(400);
    await t.http().put(local(tk.uploadUrl)).set("Content-Type", "image/png").send(Buffer.concat([PNG, PNG])).expect(400);
    const short = await ticket(PNG.length + 5);
    await t.http().put(local(short.uploadUrl)).set("Content-Type", "image/png").send(PNG).expect(400);
    await expect(readFile(path.join(dir, short.storageKey))).rejects.toThrow();
  });
});
