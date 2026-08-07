import dotenv from "dotenv";
import { assertDeploymentConfiguration } from "../src/lib/config/runtime.js";

// Railway injects service variables. Local production builds may use .env.local.
dotenv.config({ path: ".env.local", quiet: true });

try {
  const config = assertDeploymentConfiguration(process.env);
  console.log(JSON.stringify({ event: "runtime_configuration_valid", core: config.core }));
} catch (error) {
  // The thrown message contains variable names only; never print values.
  console.error(error instanceof Error ? error.message : "Invalid deployment configuration");
  process.exitCode = 1;
}
