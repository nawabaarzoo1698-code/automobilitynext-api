import { z } from "zod";

// All configuration comes from environment variables, validated once at start.
// See .env.example for what each one is for.
const schema = z.object({
  NODE_ENV: z.enum(["development", "test", "production"]).default("development"),
  PORT: z.coerce.number().int().default(4000),
  DATABASE_URL: z.string().min(1),

  JWT_SECRET: z.string().min(32, "JWT_SECRET must be at least 32 characters"),
  ACCESS_TOKEN_TTL_SECONDS: z.coerce.number().int().positive().default(900),
  REFRESH_TOKEN_TTL_DAYS: z.coerce.number().int().positive().default(30),
  /// 32-byte key (base64) used to encrypt writers' PAN and bank account numbers.
  FIELD_ENCRYPTION_KEY: z
    .string()
    .refine((v) => Buffer.from(v, "base64").length === 32, "FIELD_ENCRYPTION_KEY must be 32 bytes, base64-encoded"),

  /// Comma-separated origins allowed to call the API from a browser.
  CORS_ORIGINS: z.string().default("http://localhost:3000"),
  /// Public news site base URL, used in sitemaps and canonical links.
  SITE_URL: z.string().url().default("http://localhost:3001"),
  COOKIE_DOMAIN: z.string().optional(),

  /// S3-compatible storage (AWS S3 or DigitalOcean Spaces). Media upload is
  /// disabled until these are set.
  S3_ENDPOINT: z.string().url().optional(),
  S3_REGION: z.string().default("blr1"),
  S3_BUCKET: z.string().optional(),
  S3_ACCESS_KEY_ID: z.string().optional(),
  S3_SECRET_ACCESS_KEY: z.string().optional(),
  MEDIA_PUBLIC_BASE_URL: z.string().url().optional(),
  /// For running on one computer without S3: keep uploads in this folder and
  /// serve them from the API under /media. Ignored when S3 is set.
  MEDIA_LOCAL_DIR: z.string().optional(),
  /// The API's own address as the browser reaches it, for local media links.
  API_PUBLIC_URL: z.string().url().default("http://localhost:4000"),

  /// Publishes scheduled articles every minute. Off in tests.
  SCHEDULER_ENABLED: z
    .enum(["true", "false"])
    .default("true")
    .transform((v) => v === "true"),
});

export type Env = z.infer<typeof schema>;

let cached: Env | undefined;

export function env(): Env {
  if (!cached) {
    const parsed = schema.safeParse(process.env);
    if (!parsed.success) {
      throw new Error(`Invalid environment:\n${z.prettifyError(parsed.error)}`);
    }
    cached = parsed.data;
  }
  return cached;
}

/** Test helper: forget the cached values after changing process.env. */
export function resetEnvCache() {
  cached = undefined;
}
