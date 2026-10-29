import { BadRequestException, type PipeTransform } from "@nestjs/common";
import { ZodDefault, z } from "zod";

/** Validates a request body or query against a zod schema. */
export class ZodPipe<T extends z.ZodType> implements PipeTransform {
  constructor(private readonly schema: T) {}

  transform(value: unknown): z.infer<T> {
    const result = this.schema.safeParse(value);
    if (!result.success) {
      throw new BadRequestException({
        error: "validation_failed",
        message: "Some fields are missing or invalid",
        fields: result.error.issues.map((i) => ({ path: i.path.join("."), message: i.message })),
      });
    }
    return result.data;
  }
}

export function parse<T extends z.ZodType>(schema: T, value: unknown): z.infer<T> {
  return new ZodPipe(schema).transform(value);
}

/**
 * The PATCH version of a create schema: every field optional and no defaults,
 * so fields the client leaves out are left unchanged rather than reset.
 */
export function patchSchema<T extends z.ZodRawShape>(schema: z.ZodObject<T>) {
  const shape = Object.fromEntries(
    Object.entries(schema.shape).map(([key, field]) => {
      const inner = field instanceof ZodDefault ? field.unwrap() : field;
      return [key, (inner as z.ZodType).optional()];
    }),
  );
  return z.object(shape);
}
