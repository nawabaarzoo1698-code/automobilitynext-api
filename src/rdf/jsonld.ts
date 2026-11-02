// RDF metadata as JSON-LD with the schema.org vocabulary, for the news site and
// the CMS preview. The @id scheme matches the portal (automobilitynext-web
// src/lib/jsonld.ts), so graphs from the API and from the portal's own pages
// join into one knowledge graph:
//
//   {SITE}/#organization          the publisher
//   {SITE}/#website               the site, with its search action
//   {SITE}/{category}#section     a category, a DefinedTerm in the topic vocabulary
//   {SITE}/tag/{tag}#term         a tag, a DefinedTerm with sameAs links
//   {SITE}/authors/{slug}#person  a writer
//   {SITE}/ns/segments            the topic vocabulary (DefinedTermSet)
//   {SITE}/{category}/{slug}#article
import { env } from "../config/env.js";

type Json = Record<string, unknown>;

export interface LdCategory {
  name: string;
  slug: string;
  description?: string | null;
  sameAs?: string[];
}
export interface LdTag extends LdCategory {
  entityType?: string;
}
export interface LdWriter {
  firstName: string;
  lastName: string;
  slug: string;
  biography?: string | null;
  avatarUrl?: string | null;
  social?: unknown;
  sameAs?: string[];
}
export interface LdArticle {
  title: string;
  slug: string;
  description?: string | null;
  synopsis?: string | null;
  leadImageUrl?: string | null;
  storyType: string;
  publishedAt?: Date | null;
  updatedAt: Date;
  reviewCriteria?: unknown;
  primaryCategory: LdCategory;
  agency?: { name: string } | null;
  tags: LdTag[];
  writers: LdWriter[];
}

const site = () => env().SITE_URL.replace(/\/$/, "");

export const ids = {
  org: () => `${site()}/#organization`,
  website: () => `${site()}/#website`,
  vocab: () => `${site()}/ns/segments`,
  section: (slug: string) => `${site()}/${slug}#section`,
  term: (slug: string) => `${site()}/tag/${slug}#term`,
  person: (slug: string) => `${site()}/authors/${slug}#person`,
  article: (category: string, slug: string) => `${site()}/${category}/${slug}#article`,
  page: (path: string) => `${site()}${path}#webpage`,
};

const ENTITY_TYPES: Record<string, string> = {
  ORGANIZATION: "Organization",
  BRAND: "Brand",
  PERSON: "Person",
  PLACE: "Place",
  PRODUCT: "Product",
  EVENT: "Event",
};

const STORY_TYPES: Record<string, string | string[]> = {
  OPINION: ["NewsArticle", "OpinionNewsArticle"],
  REVIEW: ["NewsArticle", "ReviewNewsArticle"],
};

const iso = (d?: Date | null) => d?.toISOString();
const list = <T>(xs: T[]) => (xs.length ? xs : undefined);
/** Drops undefined values so the JSON stays tidy. */
const clean = (o: Json): Json => Object.fromEntries(Object.entries(o).filter(([, v]) => v !== undefined && v !== null && v !== ""));

export const organization = () => ({
  "@type": "NewsMediaOrganization",
  "@id": ids.org(),
  name: "Automobility Next",
  url: `${site()}/`,
  logo: { "@type": "ImageObject", url: `${site()}/logo.png` },
  sameAs: ["https://x.com/automobilitynext", "https://www.linkedin.com/company/automobilitynext"],
  publishingPrinciples: `${site()}/editorial-standards`,
});

export const website = () => ({
  "@type": "WebSite",
  "@id": ids.website(),
  name: "Automobility Next",
  url: `${site()}/`,
  inLanguage: "en-IN",
  publisher: { "@id": ids.org() },
  potentialAction: {
    "@type": "SearchAction",
    target: { "@type": "EntryPoint", urlTemplate: `${site()}/search?q={search_term_string}` },
    "query-input": "required name=search_term_string",
  },
});

const graph = (...nodes: Json[]) => ({ "@context": "https://schema.org", "@graph": [organization(), website(), ...nodes] });

export const sectionTerm = (c: LdCategory) =>
  clean({
    "@type": "DefinedTerm",
    "@id": ids.section(c.slug),
    name: c.name,
    description: c.description,
    termCode: c.slug,
    url: `${site()}/${c.slug}`,
    inDefinedTermSet: { "@id": ids.vocab() },
    sameAs: list(c.sameAs ?? []),
  });

export const tagTerm = (t: LdTag) =>
  clean({
    "@type": "DefinedTerm",
    "@id": ids.term(t.slug),
    name: t.name,
    description: t.description,
    termCode: t.slug,
    url: `${site()}/tag/${t.slug}`,
    inDefinedTermSet: { "@id": ids.vocab() },
    additionalType: t.entityType && ENTITY_TYPES[t.entityType] ? `https://schema.org/${ENTITY_TYPES[t.entityType]}` : undefined,
    sameAs: list(t.sameAs ?? []),
  });

export function person(w: LdWriter) {
  const social = Object.values((w.social ?? {}) as Record<string, string | null>).filter((v): v is string => !!v);
  return clean({
    "@type": "Person",
    "@id": ids.person(w.slug),
    name: `${w.firstName} ${w.lastName}`.trim(),
    url: `${site()}/authors/${w.slug}`,
    image: w.avatarUrl,
    description: w.biography,
    worksFor: { "@id": ids.org() },
    sameAs: list([...new Set([...social, ...(w.sameAs ?? [])])]),
  });
}

const breadcrumbs = (items: { name: string; path?: string }[]) => ({
  "@type": "BreadcrumbList",
  itemListElement: items.map((c, i) => clean({ "@type": "ListItem", position: i + 1, name: c.name, item: c.path ? `${site()}${c.path}` : undefined })),
});

/** The graph for an article page: the article, its page, section, tags and authors. */
export function articleGraph(a: LdArticle) {
  const path = `/${a.primaryCategory.slug}/${a.slug}`;
  const authors = a.writers.length ? a.writers.map((w) => ({ "@id": ids.person(w.slug) })) : [a.agency ? { "@type": "Organization", name: a.agency.name } : { "@id": ids.org() }];
  const criteria = Array.isArray(a.reviewCriteria) ? (a.reviewCriteria as { type?: string; value?: string }[]) : [];
  const article = clean({
    "@type": STORY_TYPES[a.storyType] ?? "NewsArticle",
    "@id": ids.article(a.primaryCategory.slug, a.slug),
    mainEntityOfPage: { "@id": ids.page(path) },
    headline: a.title,
    description: a.description ?? a.synopsis,
    image: a.leadImageUrl ? [a.leadImageUrl] : undefined,
    datePublished: iso(a.publishedAt),
    dateModified: iso(a.updatedAt),
    author: authors,
    publisher: { "@id": ids.org() },
    articleSection: a.primaryCategory.name,
    genre: a.storyType === "INTERVIEW" ? "Interview" : undefined,
    keywords: list(a.tags.map((t) => t.name)),
    about: [{ "@id": ids.section(a.primaryCategory.slug) }, ...a.tags.map((t) => ({ "@id": ids.term(t.slug) }))],
    inLanguage: "en-IN",
    isAccessibleForFree: true,
    speakable: { "@type": "SpeakableSpecification", cssSelector: ["h1", "[data-dek]"] },
    review:
      a.storyType === "REVIEW" && criteria.length
        ? { "@type": "Review", author: authors, positiveNotes: { "@type": "ItemList", itemListElement: criteria.map((c, i) => ({ "@type": "ListItem", position: i + 1, name: `${c.type}: ${c.value}` })) } }
        : undefined,
  });
  return graph(
    {
      "@type": "WebPage",
      "@id": ids.page(path),
      url: `${site()}${path}`,
      name: a.title,
      isPartOf: { "@id": ids.website() },
      breadcrumb: breadcrumbs([{ name: "Home", path: "/" }, { name: a.primaryCategory.name, path: `/${a.primaryCategory.slug}` }, { name: a.title }]),
    },
    article,
    sectionTerm(a.primaryCategory),
    ...a.tags.map(tagTerm),
    ...a.writers.map(person),
  );
}

/** The graph for a category or tag archive page. */
export function collectionGraph(kind: "section" | "tag", term: LdTag, articles: { title: string; slug: string; categorySlug: string }[]) {
  const path = kind === "section" ? `/${term.slug}` : `/tag/${term.slug}`;
  return graph(
    {
      "@type": "CollectionPage",
      "@id": ids.page(path),
      url: `${site()}${path}`,
      name: term.name,
      isPartOf: { "@id": ids.website() },
      about: { "@id": kind === "section" ? ids.section(term.slug) : ids.term(term.slug) },
      mainEntity: {
        "@type": "ItemList",
        itemListElement: articles.map((x, i) => ({ "@type": "ListItem", position: i + 1, url: `${site()}/${x.categorySlug}/${x.slug}`, name: x.title })),
      },
    },
    kind === "section" ? sectionTerm(term) : tagTerm(term),
  );
}

/** The graph for an author page. */
export const writerGraph = (w: LdWriter) =>
  graph({ "@type": "ProfilePage", "@id": ids.page(`/authors/${w.slug}`), url: `${site()}/authors/${w.slug}`, mainEntity: { "@id": ids.person(w.slug) }, isPartOf: { "@id": ids.website() } }, person(w));

/** The site's topic vocabulary: every active category and tag as a DefinedTerm. */
export const vocabulary = (categories: LdCategory[], tags: LdTag[]) => ({
  "@context": "https://schema.org",
  "@type": "DefinedTermSet",
  "@id": ids.vocab(),
  name: "Automobility Next topics",
  description: "Sections and tags used to classify Automobility Next stories.",
  publisher: { "@id": ids.org() },
  hasDefinedTerm: [...categories.map(sectionTerm), ...tags.map(tagTerm)],
});
