import "reflect-metadata";
import type { INestApplication } from "@nestjs/common";
import argon2 from "argon2";
import request from "supertest";
import { createApp } from "../src/bootstrap.js";
import { PrismaService } from "../src/prisma/prisma.service.js";

export const PASSWORD = "correct-horse-battery";

export interface TestContext {
  app: INestApplication;
  prisma: PrismaService;
  http: () => ReturnType<typeof request>;
  /** Signs in and returns an Authorization header value. */
  token: (email: string) => Promise<string>;
}

/** Starts the app on an empty database with three roles and one user per role. */
export async function setup(): Promise<TestContext> {
  const app = await createApp();
  // Listen once so concurrent supertest requests share one server.
  await app.listen(0, "127.0.0.1");
  const prisma = app.get(PrismaService);
  await resetDatabase(prisma);

  const hash = await argon2.hash(PASSWORD);
  const roles = {
    admin: await prisma.role.create({ data: { name: "Super Admin", permissions: ["*"] } }),
    editor: await prisma.role.create({
      data: { name: "Editor", permissions: ["articles:view", "articles:create", "articles:edit", "articles:publish", "articles:delete", "categories:view", "categories:create", "categories:edit", "tags:view", "tags:create", "writers:view", "writers:create", "webmaster:view", "webmaster:create", "webmaster:edit", "users:view", "users:edit", "users:create", "reports:view", "dashboard:view"] },
    }),
    writer: await prisma.role.create({ data: { name: "Writer", permissions: ["articles:view", "articles:create", "articles:edit"] } }),
  };
  await prisma.staffUser.createMany({
    data: [
      { name: "Admin", email: "admin@test.local", passwordHash: hash, roleId: roles.admin.id },
      { name: "Eddie Editor", email: "editor@test.local", passwordHash: hash, roleId: roles.editor.id },
      { name: "Wendy Writer", email: "writer@test.local", passwordHash: hash, roleId: roles.writer.id },
    ],
  });

  const http = () => request(app.getHttpServer());
  const token = async (email: string) => {
    const res = await http().post("/v1/auth/login").send({ email, password: PASSWORD }).expect(200);
    return `Bearer ${res.body.accessToken}`;
  };
  return { app, prisma, http, token };
}

export async function resetDatabase(prisma: PrismaService) {
  const tables = await prisma.$queryRaw<{ tablename: string }[]>`
    SELECT tablename FROM pg_tables WHERE schemaname = 'public' AND tablename <> '_prisma_migrations'`;
  await prisma.$executeRawUnsafe(`TRUNCATE ${tables.map((t) => `"${t.tablename}"`).join(", ")} RESTART IDENTITY CASCADE`);
}

/** A category, region and writer, enough to create articles. */
export async function newsroomBasics(prisma: PrismaService) {
  const category = await prisma.category.create({ data: { name: "Electric Vehicles", slug: "electric-vehicles" } });
  const other = await prisma.category.create({ data: { name: "Two Wheelers", slug: "two-wheelers" } });
  const india = await prisma.region.create({ data: { name: "India", code: "IN" } });
  const me = await prisma.region.create({ data: { name: "Middle East", code: "ME" } });
  const writer = await prisma.writer.create({ data: { firstName: "Automobility Next", lastName: "Team", slug: "automobility-next-team" } });
  return { category, other, india, me, writer };
}
