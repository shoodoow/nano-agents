import { config } from "../config.js";
import { migrateDb } from "./client.js";

await migrateDb(config.databaseUrl());
