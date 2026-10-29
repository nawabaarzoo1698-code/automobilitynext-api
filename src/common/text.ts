/** "Next-Gen Solid-State EV Batteries!" -> "next-gen-solid-state-ev-batteries" */
export function slugify(text: string): string {
  return text
    .normalize("NFKD")
    .replace(/[̀-ͯ]/g, "")
    .toLowerCase()
    .replace(/&/g, " and ")
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 120) || "item";
}

/**
 * Finds a free slug by appending -2, -3, ... when the base is taken.
 * `exists` checks the database for a slug used by another record.
 */
export async function uniqueSlug(base: string, exists: (slug: string) => Promise<boolean>): Promise<string> {
  const root = slugify(base);
  let candidate = root;
  for (let n = 2; await exists(candidate); n++) candidate = `${root}-${n}`;
  return candidate;
}
