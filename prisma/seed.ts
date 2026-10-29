// Starting data: roles, regions, the categories seen in the vendor CMS, region
// homepages, and the first administrator. Safe to run more than once.
//
//   ADMIN_EMAIL=you@automobilitynext.com ADMIN_PASSWORD='...' npm run db:seed
import "dotenv/config";
import { PrismaPg } from "@prisma/adapter-pg";
import argon2 from "argon2";
import { PrismaClient } from "../src/generated/prisma/client.js";

const prisma = new PrismaClient({ adapter: new PrismaPg({ connectionString: process.env.DATABASE_URL! }) });

const ROLES: { name: string; description: string; permissions: string[] }[] = [
  { name: "Super Admin", description: "Everything, including users and roles", permissions: ["*"] },
  {
    name: "Editor",
    description: "Writes, edits and publishes; manages taxonomy, pages and media",
    permissions: [
      "dashboard:view", "reports:view",
      "articles:view", "articles:create", "articles:edit", "articles:publish", "articles:delete",
      "categories:view", "categories:create", "categories:edit",
      "tags:view", "tags:create", "tags:edit", "tags:delete",
      "writers:view", "writers:create", "writers:edit",
      "topics:view", "topics:create", "topics:edit",
      "webmaster:view", "webmaster:create", "webmaster:edit",
      "media:view", "media:create", "media:edit", "media:delete",
      "seo:view", "seo:edit",
    ],
  },
  {
    name: "Writer",
    description: "Writes and edits drafts; cannot publish",
    permissions: ["articles:view", "articles:create", "articles:edit", "categories:view", "tags:view", "tags:create", "writers:view", "topics:view", "media:view", "media:create"],
  },
  { name: "SEO Editor", description: "Meta tags, redirects and reports", permissions: ["dashboard:view", "reports:view", "articles:view", "categories:view", "seo:view", "seo:edit"] },
];

const REGIONS = [
  { name: "India", code: "IN" },
  { name: "Middle East", code: "ME" },
];

// Category names as they appear in the vendor CMS (Editorial → Categories).
const CATEGORIES: { name: string; slug: string; parent?: string }[] = [
  { name: "Electric Vehicles", slug: "electric-vehicles" },
  { name: "Commercial Vehicles", slug: "commercial-vehicles", parent: "electric-vehicles" },
  { name: "Automotive", slug: "automotive", parent: "electric-vehicles" },
  { name: "Passenger Vehicles", slug: "passenger-vehicles" },
  { name: "Two Wheelers", slug: "two-wheelers" },
  { name: "Three Wheelers", slug: "three-wheelers" },
  { name: "Industry", slug: "industry" },
  { name: "EV & Future Mobility", slug: "ev-and-future-mobility" },
  { name: "Auto Components", slug: "auto-components" },
  { name: "Tyres & Lubricants", slug: "tyres-and-lubricants" },
];

async function main() {
  for (const r of ROLES) {
    await prisma.role.upsert({ where: { name: r.name }, update: { description: r.description, permissions: r.permissions }, create: r });
  }
  const regions: Record<string, number> = {};
  for (const r of REGIONS) {
    regions[r.code] = (await prisma.region.upsert({ where: { code: r.code }, update: {}, create: r })).id;
  }
  for (const c of CATEGORIES.filter((c) => !c.parent)) {
    await prisma.category.upsert({ where: { slug: c.slug }, update: {}, create: { name: c.name, slug: c.slug } });
  }
  for (const c of CATEGORIES.filter((c) => c.parent)) {
    const parent = await prisma.category.findUniqueOrThrow({ where: { slug: c.parent! } });
    await prisma.category.upsert({ where: { slug: c.slug }, update: {}, create: { name: c.name, slug: c.slug, parentId: parent.id } });
  }

  // The two region homepages from the vendor CMS, each starting with a "Latest" block.
  const latest = [{ id: "latest", title: "Latest News", showTitle: true, template: "grid", contentCount: 12, source: { kind: "latest" } }];
  await prisma.page.upsert({ where: { slug: "ev-page" }, update: {}, create: { name: "EV Page", slug: "ev-page", regionId: regions.IN, isHomepage: true, blocks: latest } });
  await prisma.page.upsert({ where: { slug: "auto-mobility-page" }, update: {}, create: { name: "Auto Mobility Page", slug: "auto-mobility-page", regionId: regions.ME, isHomepage: true, blocks: latest } });

  await prisma.setting.upsert({ where: { key: "app-language" }, update: {}, create: { key: "app-language", value: "en-US" } });

  const email = process.env.ADMIN_EMAIL?.toLowerCase();
  const password = process.env.ADMIN_PASSWORD;
  if (email && password) {
    if (password.length < 12) throw new Error("ADMIN_PASSWORD must be at least 12 characters");
    const role = await prisma.role.findUniqueOrThrow({ where: { name: "Super Admin" } });
    const existing = await prisma.staffUser.findUnique({ where: { email } });
    if (!existing) {
      await prisma.staffUser.create({ data: { name: "Administrator", email, roleId: role.id, passwordHash: await argon2.hash(password, { type: argon2.argon2id }) } });
      console.log(`Created administrator ${email}`);
    }
  } else {
    console.log("ADMIN_EMAIL / ADMIN_PASSWORD not set: no administrator created.");
  }
  console.log("Seed complete.");
}

await main().finally(() => prisma.$disconnect());
