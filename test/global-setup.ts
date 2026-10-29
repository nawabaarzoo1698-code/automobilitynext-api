import { execSync } from "node:child_process";

// Brings the test database up to the latest migration before any test runs.
export default function setup() {
  const url = process.env.TEST_DATABASE_URL ?? "postgresql://an:an@localhost:5432/automobilitynext_test";
  execSync("npx prisma migrate deploy", { stdio: "inherit", env: { ...process.env, DATABASE_URL: url } });
}
