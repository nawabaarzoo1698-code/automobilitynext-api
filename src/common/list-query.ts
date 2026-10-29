import { z } from "zod";

// Every list endpoint takes ?page=&limit=&search=&sort=field:asc|desc and
// answers { data, meta: { page, limit, total } }.

export const MAX_LIMIT = 200;

export const listQuerySchema = z.object({
  page: z.coerce.number().int().min(1).default(1),
  limit: z.coerce.number().int().min(1).max(MAX_LIMIT).default(50),
  search: z.string().trim().max(200).optional(),
  sort: z
    .string()
    .regex(/^[a-zA-Z]+(:(asc|desc))?$/, "sort must look like field or field:desc")
    .optional(),
});

export type ListQuery = z.infer<typeof listQuerySchema>;

export interface Page<T> {
  data: T[];
  meta: { page: number; limit: number; total: number };
}

export function paging(q: ListQuery) {
  return { skip: (q.page - 1) * q.limit, take: q.limit };
}

/** Turns ?sort=name:desc into a Prisma orderBy, allowing only known fields. */
export function orderBy(q: ListQuery, allowed: readonly string[], fallback: Record<string, "asc" | "desc">) {
  if (!q.sort) return fallback;
  const [field, dir = "asc"] = q.sort.split(":");
  if (!allowed.includes(field)) return fallback;
  return { [field]: dir as "asc" | "desc" };
}

/** Case-insensitive "contains" across several text columns. */
export function searchWhere(search: string | undefined, fields: readonly string[]) {
  if (!search) return {};
  return { OR: fields.map((f) => ({ [f]: { contains: search, mode: "insensitive" as const } })) };
}

export function page<T>(data: T[], total: number, q: ListQuery): Page<T> {
  return { data, meta: { page: q.page, limit: q.limit, total } };
}

/** Optional comma-separated or repeated numeric id filter, e.g. ?categoryId=3 */
export const optionalId = z.coerce.number().int().positive().optional();
export const optionalDate = z.coerce.date().optional();
