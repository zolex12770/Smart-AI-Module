#!/usr/bin/env node
/**
 * `npm run setup` — get this machine from a fresh clone to a running platform.
 *
 * It does the three things that are the same on every machine (install, build the shared
 * packages, create the directories the app writes to) and then hands over to `npm run doctor`,
 * which reports what is actually available here.
 *
 * It deliberately does NOT install Ollama, ffmpeg, a diffusion model or clamd. Those are large,
 * platform-specific, and a setup script that downloads gigabytes without being asked is a worse
 * thing than a setup script that tells you the two commands to run. Every one of them is
 * optional: the platform runs without all of them and says so in its own API rather than
 * pretending the capability is there.
 */
import { execFileSync } from "node:child_process";
import { mkdirSync, existsSync, copyFileSync } from "node:fs";
import { join, dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const REPO = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const step = (n, what) => console.log(`\n[${n}/4] ${what}`);

const major = Number(process.versions.node.split(".")[0]);
const minor = Number(process.versions.node.split(".")[1]);
if (major < 20 || (major === 20 && minor < 6)) {
  console.error(`Node ${process.versions.node} is too old. This project needs 20.6 or newer:`);
  console.error("  - process.loadEnvFile, which is how .env files are read with no dependency (ADR-043)");
  process.exit(1);
}

const sh = (cmd, args) => {
  try {
    execFileSync(cmd, args, { cwd: REPO, stdio: "inherit", shell: process.platform === "win32" });
    return true;
  } catch {
    return false;
  }
};

step(1, "Installing dependencies for every workspace (npm install)");
if (!sh("npm", ["install", "--no-audit", "--no-fund"])) {
  console.error("\nnpm install failed. Nothing below would work, so setup stops here.");
  process.exit(1);
}

step(2, "Building the shared packages the two applications import");
if (!sh("npm", ["run", "build:packages"])) {
  console.error("\nThe shared build failed. Fix that before starting either application.");
  process.exit(1);
}

step(3, "Creating the directories the backend writes to");
for (const dir of ["data/pgdata", "data/assets", "data/sandbox"]) {
  const path = join(REPO, dir);
  if (!existsSync(path)) {
    mkdirSync(path, { recursive: true });
    console.log(`  created ${dir}`);
  } else {
    console.log(`  ${dir} already there`);
  }
}
for (const [example, target] of [
  ["backend/.env.example", "backend/.env"],
  ["frontend/.env.example", "frontend/.env.local"],
]) {
  const to = join(REPO, target);
  if (existsSync(to)) {
    console.log(`  ${target} already there — left alone`);
  } else {
    copyFileSync(join(REPO, example), to);
    console.log(`  created ${target} from ${example} (every value is commented out; it is gitignored)`);
  }
}

step(4, "Checking what this machine can actually run");
sh("node", [join(REPO, "scripts", "doctor.mjs")]);

console.log(`
Start the two applications, in two terminals:

    cd backend   && npm run dev     # http://localhost:8787  (GET /api/health)
    cd frontend  && npm run dev     # http://localhost:3000

Then sign up at http://localhost:3000/signup. With no AI runtime installed the platform still
runs end to end on its mock provider, and every response says which provider answered, so a
mock can never be mistaken for a real model.

To run the real thing instead, the doctor rows above name the exact command for each capability.
`);
