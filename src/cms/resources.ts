import { BadRequestException } from "@nestjs/common";
import { z } from "zod";
import { decryptField, encryptField, mask } from "../common/crypto.js";
import { optionalId } from "../common/list-query.js";
import { uniqueSlug } from "../common/text.js";
import type { PrismaService } from "../prisma/prisma.service.js";
import type { ResourceDef, WriteContext } from "./crud.js";

// The simple CMS screens: each is a table with search, add, edit and delete.
// Articles, media, users and roles have their own controllers.

const text = (max = 200) => z.string().trim().min(1).max(max);
const optionalText = (max = 2000) => z.string().trim().max(max).nullish();
const url = z.string().trim().url().max(2000).nullish();
const boolFilter = z.enum(["true", "false"]).transform((v) => v === "true").optional();

type SlugTable = "category" | "tag" | "writer" | "topic" | "page" | "staticContent";

/** Fills `slug` from `from` on create, or tidies a slug the editor typed. */
async function withSlug(table: SlugTable, input: Record<string, unknown>, from: string | undefined, ctx: WriteContext) {
  const delegate = ctx.prisma[table] as unknown as { findFirst(a: object): Promise<unknown> };
  const taken = async (slug: string) => !!(await delegate.findFirst({ where: { slug, NOT: ctx.id ? { id: ctx.id } : undefined } }));
  if (typeof input.slug === "string" && input.slug) return { ...input, slug: await uniqueSlug(input.slug, taken) };
  if (!ctx.id && from) return { ...input, slug: await uniqueSlug(from, taken) };
  return input;
}

const withCount = (row: Record<string, unknown>, key: string, as: string) => {
  const { _count, ...rest } = row as { _count?: Record<string, number> };
  return { ...rest, [as]: _count?.[key] ?? 0 };
};

// --- Regions ---------------------------------------------------------------

export const regions: ResourceDef = {
  path: "regions",
  module: "webmaster",
  model: "region",
  create: z.object({
    name: text(),
    code: z.string().trim().toUpperCase().regex(/^[A-Z]{2,5}$/, "2–5 letters, e.g. IN or ME"),
    description: optionalText(),
    active: z.boolean().default(true),
  }),
  searchFields: ["name", "code"],
  sortFields: ["name", "code", "updatedAt"],
  defaultSort: { name: "asc" },
  include: { _count: { select: { articles: true } } },
  toResponse: (r) => withCount(r, "articles", "articleCount"),
};

// --- Categories ------------------------------------------------------------

export const categories: ResourceDef = {
  path: "categories",
  module: "categories",
  model: "category",
  create: z.object({
    name: text(),
    slug: z.string().trim().max(120).optional(),
    parentId: z.number().int().positive().nullish(),
    description: optionalText(),
    imageUrl: url,
    sortOrder: z.number().int().default(0),
    active: z.boolean().default(true),
  }),
  filters: { schema: z.object({ parentId: optionalId, active: boolFilter }), where: (q) => ({ parentId: q.parentId, active: q.active }) },
  searchFields: ["name", "slug"],
  sortFields: ["name", "sortOrder", "updatedAt"],
  defaultSort: { updatedAt: "desc" },
  include: { parent: { select: { id: true, name: true } }, _count: { select: { primaryArticles: true } } },
  toData: async (input, ctx) => {
    if (ctx.id && input.parentId === ctx.id) throw new BadRequestException({ error: "invalid_parent", message: "A category cannot be its own parent" });
    return withSlug("category", input, input.name as string, ctx);
  },
  toResponse: (r) => withCount(r, "primaryArticles", "newsItems"),
};

// --- Tags ------------------------------------------------------------------

export const tags: ResourceDef = {
  path: "tags",
  module: "tags",
  model: "tag",
  create: z.object({ name: text(100), slug: z.string().trim().max(120).optional(), active: z.boolean().default(true) }),
  filters: {
    schema: z.object({ from: z.coerce.date().optional(), to: z.coerce.date().optional() }),
    where: (q) => (q.from || q.to ? { createdAt: { gte: q.from, lte: q.to } } : {}),
  },
  searchFields: ["name", "slug"],
  sortFields: ["name", "createdAt"],
  defaultSort: { id: "asc" },
  include: { _count: { select: { articles: true } } },
  toData: (input, ctx) => withSlug("tag", input, input.name as string, ctx),
  toResponse: (r) => withCount(r, "articles", "count"),
};

// --- Writers ---------------------------------------------------------------

const writerSchema = z.object({
  firstName: text(100),
  lastName: z.string().trim().max(100).default(""),
  slug: z.string().trim().max(120).optional(),
  email: z.email().nullish(),
  mobile: z.string().trim().max(20).nullish(),
  biography: optionalText(5000),
  avatarUrl: url,
  social: z
    .object({ twitter: url, linkedin: url, instagram: url, facebook: url })
    .partial()
    .default({}),
  pan: z.string().trim().toUpperCase().regex(/^[A-Z]{5}[0-9]{4}[A-Z]$/, "PAN looks like ABCDE1234F").nullish(),
  gst: z.string().trim().max(20).nullish(),
  ratePerStory: z.number().nonnegative().nullish(),
  bankAccountName: optionalText(200),
  bankAccountNumber: z.string().trim().regex(/^[0-9]{6,20}$/, "Digits only").nullish(),
  ifsc: z.string().trim().toUpperCase().regex(/^[A-Z]{4}0[A-Z0-9]{6}$/, "IFSC looks like HDFC0001234").nullish(),
  bankName: optionalText(200),
  active: z.boolean().default(true),
});

export const writers: ResourceDef = {
  path: "writers",
  module: "writers",
  model: "writer",
  create: writerSchema,
  searchFields: ["firstName", "lastName", "email"],
  sortFields: ["firstName", "updatedAt"],
  defaultSort: { firstName: "asc" },
  include: { _count: { select: { bylines: true } } },
  toData: async (input, ctx) => {
    const { pan, bankAccountNumber, ...rest } = input;
    const data: Record<string, unknown> = { ...rest };
    if (pan !== undefined) data.panEnc = encryptField(pan as string | null);
    if (bankAccountNumber !== undefined) data.bankAccountNumEnc = encryptField(bankAccountNumber as string | null);
    const name = `${input.firstName ?? ""} ${input.lastName ?? ""}`.trim();
    return withSlug("writer", data, name || undefined, ctx);
  },
  // Lists and forms only ever see masked numbers.
  toResponse: (r) => {
    const { panEnc, bankAccountNumEnc, ...rest } = withCount(r, "bylines", "newsItems") as Record<string, unknown>;
    return {
      ...rest,
      pan: mask(decryptField(panEnc as string | null)),
      bankAccountNumber: mask(decryptField(bankAccountNumEnc as string | null)),
    };
  },
};

// --- Agencies --------------------------------------------------------------

export const agencies: ResourceDef = {
  path: "agencies",
  module: "writers",
  model: "agency",
  create: z.object({ name: text(), active: z.boolean().default(true) }),
  searchFields: ["name"],
  sortFields: ["name"],
  defaultSort: { name: "asc" },
};

// --- Topic types and topics -----------------------------------------------

export const topicTypes: ResourceDef = {
  path: "topic-types",
  module: "topics",
  model: "topicType",
  create: z.object({ name: text(), parentId: z.number().int().positive().nullish(), active: z.boolean().default(true) }),
  searchFields: ["name"],
  sortFields: ["name", "updatedAt"],
  defaultSort: { id: "asc" },
  include: { parent: { select: { id: true, name: true } } },
};

export const topics: ResourceDef = {
  path: "topics",
  module: "topics",
  model: "topic",
  create: z.object({
    title: text(),
    subtitle: optionalText(300),
    slug: z.string().trim().max(120).optional(),
    description: optionalText(5000),
    imageUrl: url,
    topicTypeId: z.number().int().positive(),
    tagId: z.number().int().positive().nullish(),
    active: z.boolean().default(true),
  }),
  filters: { schema: z.object({ topicTypeId: optionalId }), where: (q) => ({ topicTypeId: q.topicTypeId }) },
  searchFields: ["title", "subtitle"],
  sortFields: ["title", "updatedAt"],
  defaultSort: { title: "asc" },
  include: { topicType: { select: { id: true, name: true } }, tag: { select: { id: true, name: true } } },
  toData: (input, ctx) => withSlug("topic", input, input.title as string, ctx),
};

// --- Menus and pages -------------------------------------------------------

type MenuItem = { type: "Category" | "Page" | "Custom"; ref: string; label: string; target: "Same Window" | "New Window"; showSubcategories?: boolean; children?: MenuItem[] };
const menuItem: z.ZodType<MenuItem> = z.lazy(() =>
  z.object({
    type: z.enum(["Category", "Page", "Custom"]),
    ref: z.string().max(500),
    label: text(100),
    target: z.enum(["Same Window", "New Window"]).default("Same Window"),
    showSubcategories: z.boolean().optional(),
    children: z.array(menuItem).max(50).optional(),
  }),
);

export const menus: ResourceDef = {
  path: "menus",
  module: "webmaster",
  model: "menu",
  create: z.object({
    name: text(100),
    position: z.enum(["HEADER", "FOOTER", "SUB", "SIDEBAR"]),
    items: z.array(menuItem).max(100).default([]),
    active: z.boolean().default(true),
  }),
  searchFields: ["name"],
  sortFields: ["name", "updatedAt"],
  defaultSort: { id: "asc" },
};

export const pageBlockSchema = z.object({
  id: z.string().max(50),
  title: z.string().max(200).default(""),
  showTitle: z.boolean().default(true),
  template: z.string().max(50).default("grid"),
  contentCount: z.number().int().min(1).max(50).default(6),
  source: z.discriminatedUnion("kind", [
    z.object({ kind: z.literal("latest") }),
    z.object({ kind: z.literal("category"), categoryId: z.number().int().positive() }),
    z.object({ kind: z.literal("tag"), tagId: z.number().int().positive() }),
    z.object({ kind: z.literal("manual"), articleIds: z.array(z.number().int().positive()).max(50) }),
  ]),
});

export const pages: ResourceDef = {
  path: "pages",
  module: "webmaster",
  model: "page",
  create: z.object({
    name: text(),
    slug: z.string().trim().max(120).optional(),
    description: optionalText(),
    regionId: z.number().int().positive().nullish(),
    visible: z.boolean().default(true),
    redirectUrl: url,
    isHomepage: z.boolean().default(false),
    blocks: z.array(pageBlockSchema).max(40).default([]),
    active: z.boolean().default(true),
  }),
  filters: { schema: z.object({ regionId: optionalId }), where: (q) => ({ regionId: q.regionId }) },
  searchFields: ["name", "slug"],
  sortFields: ["name", "updatedAt"],
  defaultSort: { id: "asc" },
  include: { region: { select: { id: true, name: true, code: true } } },
  toData: async (input, ctx) => {
    // Only one homepage per region.
    if (input.isHomepage === true) await clearOtherHomepages(ctx.prisma, input.regionId as number | null | undefined, ctx.id);
    return withSlug("page", input, input.name as string, ctx);
  },
};

async function clearOtherHomepages(prisma: PrismaService, regionId: number | null | undefined, keepId?: number) {
  let region = regionId;
  if (region === undefined && keepId) region = (await prisma.page.findUnique({ where: { id: keepId } }))?.regionId;
  await prisma.page.updateMany({ where: { regionId: region ?? null, isHomepage: true, NOT: keepId ? { id: keepId } : undefined }, data: { isHomepage: false } });
}

export const staticContent: ResourceDef = {
  path: "static-content",
  module: "webmaster",
  model: "staticContent",
  create: z.object({
    kind: z.enum(["PAGE", "BOARD_OF_DIRECTORS", "EDITORIAL_BOARD"]).default("PAGE"),
    title: text(),
    slug: z.string().trim().max(120).optional(),
    subtitle: optionalText(200),
    imageUrl: url,
    html: z.string().max(200_000).default(""),
    sortOrder: z.number().int().default(0),
    active: z.boolean().default(true),
  }),
  filters: {
    schema: z.object({ kind: z.enum(["PAGE", "BOARD_OF_DIRECTORS", "EDITORIAL_BOARD"]).optional() }),
    where: (q) => ({ kind: q.kind }),
  },
  searchFields: ["title"],
  sortFields: ["title", "sortOrder", "updatedAt"],
  defaultSort: { sortOrder: "asc" },
  toData: (input, ctx) => withSlug("staticContent", input, input.title as string, ctx),
};

// --- SEO -------------------------------------------------------------------

export const seoMeta: ResourceDef = {
  path: "seo-meta",
  module: "seo",
  model: "seoMeta",
  entity: "seoMeta",
  ops: ["list", "get", "create", "update"],
  create: z.object({
    entityType: z.enum(["article", "category", "page", "static"]),
    entityId: z.number().int().positive(),
    metaTitle: optionalText(70),
    metaDescription: optionalText(170),
    canonicalUrl: url,
    ogImageUrl: url,
    noIndex: z.boolean().default(false),
  }),
  filters: {
    schema: z.object({ entityType: z.enum(["article", "category", "page", "static"]).optional(), entityId: optionalId }),
    where: (q) => ({ entityType: q.entityType, entityId: q.entityId }),
  },
  searchFields: ["metaTitle"],
  sortFields: ["updatedAt"],
  defaultSort: { updatedAt: "desc" },
};

export const redirects: ResourceDef = {
  path: "redirects",
  module: "seo",
  model: "redirect",
  ops: ["list", "get", "create", "update"],
  create: z.object({
    fromPath: z.string().trim().regex(/^\/\S*$/, "Must start with /").max(500),
    toPath: z.string().trim().min(1).max(2000),
    statusCode: z.union([z.literal(301), z.literal(302), z.literal(308)]).default(301),
    active: z.boolean().default(true),
  }),
  searchFields: ["fromPath", "toPath"],
  sortFields: ["fromPath", "updatedAt"],
  defaultSort: { updatedAt: "desc" },
};

// --- Audience --------------------------------------------------------------

export const grievances: ResourceDef = {
  path: "grievances",
  module: "grievances",
  model: "grievance",
  ops: ["list", "get", "update"],
  create: z.object({}),
  update: z.object({ status: z.enum(["OPEN", "IN_PROGRESS", "CLOSED"]) }),
  filters: { schema: z.object({ status: z.enum(["OPEN", "IN_PROGRESS", "CLOSED"]).optional() }), where: (q) => ({ status: q.status }) },
  searchFields: ["name", "email", "state", "message"],
  sortFields: ["createdAt", "status"],
  defaultSort: { createdAt: "desc" },
};

export const subscribers: ResourceDef = {
  path: "subscribers",
  module: "subscribers",
  model: "newsletterSubscriber",
  entity: "subscriber",
  ops: ["list", "get", "delete"],
  create: z.object({}),
  filters: {
    schema: z.object({ status: z.enum(["PENDING", "ACTIVE", "UNSUBSCRIBED"]).optional() }),
    where: (q) => ({ status: q.status }),
  },
  searchFields: ["email", "name"],
  sortFields: ["createdAt", "email"],
  defaultSort: { createdAt: "desc" },
  toResponse: ({ confirmToken: _hidden, ...rest }) => rest,
};

export const RESOURCES = [
  regions,
  categories,
  tags,
  writers,
  agencies,
  topicTypes,
  topics,
  menus,
  pages,
  staticContent,
  seoMeta,
  redirects,
  grievances,
  subscribers,
];

