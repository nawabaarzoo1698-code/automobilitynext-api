// One-time setup for running the API on this computer: `npm run setup`.
// 1. Creates .env from .env.example with fresh secrets and local media storage.
// 2. Creates the database tables.
// 3. Adds the starting data and asks for your administrator sign-in.
// Safe to run again: it keeps an existing .env and never changes existing users.
import { execSync } from "node:child_process";
import { randomBytes } from "node:crypto";
import { copyFileSync, existsSync, readFileSync, writeFileSync } from "node:fs";
import { createInterface } from "node:readline";

const run = (cmd, env = {}) => execSync(cmd, { stdio: "inherit", env: { ...process.env, ...env } });

if (existsSync(".env")) {
  console.log("Keeping your existing .env");
} else {
  copyFileSync(".env.example", ".env");
  const text = readFileSync(".env", "utf8")
    .replace(/^JWT_SECRET=.*$/m, `JWT_SECRET=${randomBytes(48).toString("base64")}`)
    .replace(/^FIELD_ENCRYPTION_KEY=.*$/m, `FIELD_ENCRYPTION_KEY=${randomBytes(32).toString("base64")}`)
    .replace(/^# MEDIA_LOCAL_DIR=.*$/m, "MEDIA_LOCAL_DIR=./media-uploads");
  writeFileSync(".env", text);
  console.log("Created .env with new secrets. Keep it private.");
}

try {
  run("npx prisma migrate deploy");
} catch {
  console.error("\nCould not reach the database. Start it first with: docker compose up -d");
  process.exit(1);
}

/** Asks a question; with `hidden`, typed characters are not shown. */
function ask(question, hidden = false) {
  const rl = createInterface({ input: process.stdin, output: process.stdout, terminal: true });
  if (hidden) rl._writeToOutput = (s) => rl.output.write(s.startsWith(question) ? question : "");
  return new Promise((resolve) =>
    rl.question(question, (answer) => {
      rl.close();
      if (hidden) process.stdout.write("\n");
      resolve(answer.trim());
    }),
  );
}

let email = process.env.ADMIN_EMAIL ?? "";
let password = process.env.ADMIN_PASSWORD ?? "";
if (!email) {
  console.log("\nYour administrator sign-in for the CMS (leave the email empty if you already have one).");
  email = await ask("Admin email: ");
  while (email && password.length < 12) {
    password = await ask("Admin password (at least 12 characters): ", true);
    if (password.length < 12) console.log("That password is too short.");
  }
}
run("npx prisma db seed", email ? { ADMIN_EMAIL: email, ADMIN_PASSWORD: password } : {});
console.log("\nSetup complete. Start the API with: npm run start:dev");
