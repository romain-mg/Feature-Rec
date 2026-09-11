import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { Client } from "pg";

// Exercise the real harness failure/cleanup path without a Docker image or provider calls.
const adminUrl = new URL(process.env.TEST_DATABASE_URL ?? "postgres://postgres:postgres@localhost:5432/postgres");
assert.ok(["localhost", "127.0.0.1", "[::1]"].includes(adminUrl.hostname), "Image selftest requires a local PostgreSQL server");
const directory = await mkdtemp(join(tmpdir(), "feature-rec-image-failure-"));
const callsPath = join(directory, "calls.jsonl");
const secretsPath = join(directory, "secrets.json");
const db = new Client({ connectionString: adminUrl.toString() });
const execute = promisify(execFile);
try {
  await writeFile(join(directory, "docker"), `#!/usr/bin/env node
const { appendFileSync, readFileSync, writeFileSync } = require("node:fs");
const args = process.argv.slice(2);
const name = args[args.indexOf("--name") + 1];
appendFileSync(process.env.IMAGE_TEST_CALLS, JSON.stringify([args[0], args[0] === "run" ? name : args.at(-1)]) + "\\n");
switch (args[0]) {
  case "run":
    if (args.includes("--help")) {
      console.log("--slack-installation-id slack-installation-status cancel-slack-installation");
      break;
    }
    const env = Object.fromEntries(args.flatMap((value, index) => {
      if (value !== "--env") return [];
      const entry = args[index + 1];
      const separator = entry.indexOf("=");
      return [[entry.slice(0, separator), entry.slice(separator + 1)]];
    }));
    const url = new URL(env.DATABASE_URL);
    writeFileSync(process.env.IMAGE_TEST_SECRETS, JSON.stringify([
      "fixture-image-client-secret", env.FEATURE_REC_SLACK_TOKEN_ENCRYPTION_KEY,
      url.toString(), decodeURIComponent(url.password),
    ].filter(Boolean)));
    console.log(name);
    break;
  case "exec": process.exitCode = 1; break;
  case "inspect": console.log("false"); break;
  case "logs":
    console.log("startup diagnostic marker");
    console.error("stderr diagnostic marker " + JSON.parse(readFileSync(process.env.IMAGE_TEST_SECRETS, "utf8")).join(" "));
    if (process.env.IMAGE_TEST_LOGS_FAIL === "1") process.exitCode = 42;
    break;
  case "rm": break;
  default: throw new Error("Unexpected Docker command");
}
`, { mode: 0o755 });
  await db.connect();
  for (const logsFail of [false, true]) {
    await writeFile(callsPath, "");
    let output = "";
    await assert.rejects(execute(process.execPath, [
      "--import", "tsx", fileURLToPath(new URL("./service-image-selftest.mts", import.meta.url)), "fixture-image",
    ], {
      env: {
        ...process.env, PATH: `${directory}:${process.env.PATH ?? ""}`, TEST_DATABASE_URL: adminUrl.toString(),
        IMAGE_TEST_CALLS: callsPath, IMAGE_TEST_SECRETS: secretsPath, IMAGE_TEST_LOGS_FAIL: logsFail ? "1" : "0",
      },
      timeout: 30_000,
    }), (error: unknown) => {
      assert.ok(error instanceof Error && "stdout" in error && "stderr" in error);
      output = String(error.stdout) + String(error.stderr);
      return true;
    });
    const secrets = JSON.parse(await readFile(secretsPath, "utf8")) as string[];
    for (const secret of secrets) assert.ok(!output.includes(secret), "Failure diagnostics leaked a secret fixture");
    assert.match(output, /Service exited before health became available/);
    if (logsFail) {
      assert.match(output, /Service image failure logs unavailable/);
      assert.doesNotMatch(output, /startup diagnostic marker/);
    } else {
      assert.match(output, /startup diagnostic marker/);
      assert.match(output, /stderr diagnostic marker/);
      assert.match(output, /\[REDACTED\]/);
    }
    const calls = (await readFile(callsPath, "utf8")).trim().split("\n").map((line) => JSON.parse(line) as string[]);
    const logsIndex = calls.findIndex(([command]) => command === "logs");
    const removalIndex = calls.findIndex(([command]) => command === "rm");
    assert.ok(logsIndex !== -1 && removalIndex > logsIndex, "Read failure logs before removing the container");
    const containerName = calls[logsIndex][1];
    assert.equal(calls[removalIndex][1], containerName);
    const suffix = /^feature-rec-image-([a-f0-9]+)-1$/.exec(containerName)?.[1];
    assert.ok(suffix);
    assert.equal((await db.query("select 1 from pg_database where datname = $1", [`feature_rec_image_test_${suffix}`])).rowCount, 0);
  }
  console.log("Service image failure selftest passed: diagnostics precede cleanup, redact secrets and preserve the original error when logs fail.");
} finally {
  await db.end();
  await rm(directory, { recursive: true, force: true });
}
