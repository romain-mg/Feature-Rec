import assert from "node:assert/strict";
import { PassThrough } from "node:stream";
import type { ReadStream } from "node:tty";
import { parseArgs, readSecret } from "../src/admin-input";

for (const [command, option] of [["migrate-to", "expect-current"], ["provision-tenant", "tenant-id"], ["provision-tenant", "selected-channel-id"], ["provision-tenant", "slack-installation-id"], ["slack-installation-status", "slack-installation-id"], ["cancel-slack-installation", "slack-installation-id"]]) {
  assert.throws(() => parseArgs([command, `--${option}`]), /argument missing|requires a value/);
  assert.throws(() => parseArgs([command, `--${option}= `]), /non-empty value/);
  assert.throws(() => parseArgs([command, `--${option}`, "--confirm"]), /argument is ambiguous/);
  assert.throws(() => parseArgs([command, `--${option}=first`, `--${option}=second`]), /only be supplied once/);
}
assert.throws(() => parseArgs(["provision-tenant", "--confrim"]), /Unknown option/);
assert.throws(() => parseArgs(["migration-status", "--apply"]), /not supported/);
assert.throws(() => parseArgs(["provision-tenant", "--confirm=false"]), /does not take an argument/);
assert.throws(() => parseArgs(["provision-tenant", "--confirm", "unexpected"]), /Unexpected positional/);
const parsed = parseArgs(["migrate-to", "--confirm", "0007_mention_modes", "--expect-current=0008_multitenant_expand"]);
assert.deepEqual(parsed.positionals, ["0007_mention_modes"]);
assert.equal(parsed.flags.get("confirm"), true);
assert.equal(parsed.flags.get("expect-current"), "0008_multitenant_expand");

assert.equal(parseArgs(["provision-tenant", "--slack-installation-id", "pending-id"]).flags.get("slack-installation-id"), "pending-id");
assert.equal(parseArgs(["cancel-slack-installation", "--slack-installation-id", "pending-id", "--confirm"]).flags.get("confirm"), true);
assert.throws(() => parseArgs(["slack-installation-status", "--confirm"]), /not supported/);
assert.throws(() => parseArgs(["cancel-slack-installation", "--replace-pairing"]), /not supported/);

class FakeTty extends PassThrough {
  isTTY = true;
  isRaw = false;
  setRawMode(raw: boolean) { this.isRaw = raw; return this; }
}

async function prompt(input: string, expected: string | RegExp, wasRaw = false): Promise<void> {
  const tty = new FakeTty();
  tty.isRaw = wasRaw;
  let output = "";
  const pending = readSecret(tty as unknown as ReadStream, { write: ((value: string) => { output += value; return true; }) as never });
  const result = typeof expected === "string" ? pending.then((value) => assert.equal(value, expected)) : assert.rejects(pending, expected);
  tty.write(input);
  await result;
  assert.equal(tty.isRaw, wasRaw);
  assert.equal(output, "Slack bot token: \n");
  for (const event of ["data", "end", "close", "error"]) assert.equal(tty.listenerCount(event), 0);
}

await prompt("xoxb-test\r", "xoxb-test");
await prompt("xoxb-test\u0004", "xoxb-test", true);
await prompt("xoxb-tesX\u007ft\n", "xoxb-test");
await prompt("\u0004", /non-empty/);
await prompt("secret\u0003", /Cancelled/);
for (const control of ["\u001b[A", "\t", "\u0000", "é", " "]) await prompt(`secret${control}`, /Unsupported character/);
for (const event of ["end", "close", "error"]) {
  const tty = new FakeTty();
  const pending = assert.rejects(readSecret(tty as unknown as ReadStream, { write: (() => true) as never }), /input ended|Cannot read/);
  tty.emit(event, new Error("never reveal this input"));
  await pending;
  assert.equal(tty.isRaw, false);
  assert.equal(tty.listenerCount("data"), 0);
}
for (const value of ["xoxb-test", "xoxb-test\n", "xoxb-test\r\n"]) {
  const pipe = new PassThrough();
  const pending = readSecret(pipe as unknown as ReadStream);
  pipe.end(value);
  assert.equal(await pending, "xoxb-test");
}
for (const value of ["", "a\nb", "secret\u0004", "secret\t", "secret\n\n"]) {
  const pipe = new PassThrough();
  const pending = assert.rejects(readSecret(pipe as unknown as ReadStream), /ASCII Slack bot token/);
  pipe.end(value);
  await pending;
}
console.log("admin-input selftest passed");
