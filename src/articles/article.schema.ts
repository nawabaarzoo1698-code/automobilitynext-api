import sanitizeHtml from "sanitize-html";
import { z } from "zod";
import { patchSchema } from "../common/validation.js";

// Field limits match the counters in the CMS editor (title 0/200, SEO title
// 0/60, description 0/160, synopsis 0/300).

/** Rich text from the editor, cleaned so it cannot carry scripts onto the public site. */
export function cleanHtml(html: string) {
  return sanitizeHtml(html, {
    allowedTags: [
      ...sanitizeHtml.defaults.allowedTags,
      "img",
      "figure",
      "figcaption",
      "iframe",
      "span",
      "u",
      "s",
    ],
    allowedAttributes: {
      ...sanitizeHtml.defaults.allowedAttributes,
      "*": ["class", "style", "data-type"],
      img: ["src", "alt", "title", "width", "height", "loading"],
      iframe: ["src", "width", "height", "allow", "allowfullscreen", "frameborder", "title"],
      a: ["href", "name", "target", "rel"],
    },
    allowedStyles: { "*": { "text-align": [/^(left|right|center|justify)$/], color: [/^#[0-9a-f]{3,8}$/i], "background-color": [/^#[0-9a-f]{3,8}$/i] } },
    // Only video and social embeds may be framed.
    allowedIframeHostnames: ["www.youtube.com", "www.youtube-nocookie.com", "player.vimeo.com", "platform.twitter.com", "www.instagram.com", "www.facebook.com"],
    allowedSchemes: ["http", "https", "mailto"],
  });
}

const httpUrl = z.string().trim().url().max(2000).refine((u) => /^https?:\/\//.test(u), "Must be an http(s) link");

export const bodyBlock = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("text"), html: z.string().max(200_000).transform(cleanHtml) }),
  z.object({
    kind: z.literal("image"),
    images: z.array(z.object({ src: httpUrl, caption: z.string().max(500).default(""), alt: z.string().max(300).default("") })).min(1).max(50),
  }),
  z.object({ kind: z.literal("video"), url: httpUrl, title: z.string().max(300).optional() }),
  /// A YouTube, X, Instagram or other link the site renders as an embed.
  z.object({ kind: z.literal("embed"), url: httpUrl }),
]);

const nullableText = (max: number) => z.string().trim().max(max).nullish();
const ids = z.array(z.number().int().positive()).max(50);

export const articleCreateSchema = z.object({
  title: z.string().trim().min(1).max(200),
  seoTitle: nullableText(60),
  slug: z.string().trim().max(150).optional(),
  description: nullableText(160),
  synopsis: nullableText(300),
  leadImageUrl: httpUrl.nullish(),
  imageCaption: nullableText(500),
  imageAlt: nullableText(300),
  storyType: z.enum(["REGULAR", "REVIEW", "TICKER", "OPINION", "INTERVIEW"]).default("REGULAR"),
  primaryCategoryId: z.number().int().positive(),
  secondaryCategoryId: z.number().int().positive().nullish(),
  agencyId: z.number().int().positive().nullish(),
  /// Editions (India, Middle East).
  regionIds: ids.default([]),
  writerIds: ids.min(1, "Add at least one byline"),
  tagIds: ids.default([]),
  /// New tags typed in the editor; created if they don't exist.
  tagNames: z.array(z.string().trim().min(2).max(100)).max(30).default([]),
  body: z.array(bodyBlock).max(500).default([]),
  reviewCriteria: z.array(z.object({ type: z.string().max(100), value: z.string().max(100) })).max(30).default([]),
});

// On update every field is optional and has no default; omitted fields are left as they are.
export const articleUpdateSchema = patchSchema(articleCreateSchema);

export const publishSchema = z.object({
  /// Leave empty to publish now; a future time schedules it.
  at: z.coerce.date().optional(),
});

export type ArticleCreate = z.infer<typeof articleCreateSchema>;
export type ArticleUpdate = Partial<ArticleCreate>;
