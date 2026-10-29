import "dotenv/config";
import "reflect-metadata";
import { createApp } from "./bootstrap.js";
import { env } from "./config/env.js";

const app = await createApp();
await app.listen(env().PORT, "0.0.0.0");
console.log(`API listening on :${env().PORT} (docs at /docs)`);
