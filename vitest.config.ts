import swc from "unplugin-swc";
import { defineConfig } from "vitest/config";

const TEST_DATABASE_URL = process.env.TEST_DATABASE_URL ?? "postgresql://an:an@localhost:5432/automobilitynext_test";

// SWC emits decorator metadata, which Nest needs for dependency injection.
// Tests run against a real PostgreSQL database (see test/global-setup.ts).
export default defineConfig({
  plugins: [swc.vite({ module: { type: "es6" } })],
  test: {
    include: ["test/**/*.spec.ts"],
    globalSetup: ["test/global-setup.ts"],
    fileParallelism: false,
    testTimeout: 20_000,
    hookTimeout: 60_000,
    env: {
      NODE_ENV: "test",
      DATABASE_URL: TEST_DATABASE_URL,
      JWT_SECRET: "test-secret-test-secret-test-secret-123456",
      FIELD_ENCRYPTION_KEY: Buffer.alloc(32, 7).toString("base64"),
      SCHEDULER_ENABLED: "false",
      SITE_URL: "https://www.automobilitynext.com",
    },
  },
});
