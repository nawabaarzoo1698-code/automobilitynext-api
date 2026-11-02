import type { Prisma } from "../generated/prisma/client.js";
import type { LdArticle } from "./jsonld.js";

// What the JSON-LD builders need from the database, shared by the public API
// and the CMS preview.

export const ldTermSelect = { name: true, slug: true, description: true, sameAs: true } satisfies Prisma.CategorySelect;
export const ldTagSelect = { ...ldTermSelect, entityType: true } satisfies Prisma.TagSelect;
export const ldWriterSelect = { firstName: true, lastName: true, slug: true, biography: true, avatarUrl: true, social: true, sameAs: true } satisfies Prisma.WriterSelect;

export const ldArticleSelect = {
  title: true,
  slug: true,
  description: true,
  synopsis: true,
  leadImageUrl: true,
  storyType: true,
  publishedAt: true,
  updatedAt: true,
  reviewCriteria: true,
  primaryCategory: { select: ldTermSelect },
  agency: { select: { name: true } },
  tags: { select: { tag: { select: ldTagSelect } } },
  bylines: { orderBy: { position: "asc" }, select: { writer: { select: ldWriterSelect } } },
} satisfies Prisma.ArticleSelect;

export const toLdArticle = (a: Prisma.ArticleGetPayload<{ select: typeof ldArticleSelect }>): LdArticle => ({
  ...a,
  tags: a.tags.map((t) => t.tag),
  writers: a.bylines.map((b) => b.writer),
});
