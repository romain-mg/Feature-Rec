import { parseArgs as parseNodeArgs } from "node:util";
import type { ReadStream, WriteStream } from "node:tty";

const STRING_FLAGS = ["environment", "expect-current", "tenant-id", "selected-channel-id", "installation-id", "repository"];
const BOOLEAN_FLAGS = ["help", "confirm", "require-future-cycle-keys", "traffic-paused", "service-stopped", "replace-pairing"];
const COMMAND_FLAGS: Record<string, string[]> = {
  "migration-status": [],
  "migrate-to": ["confirm", "expect-current", "traffic-paused", "service-stopped"],
  "validate-contract-readiness": ["require-future-cycle-keys"],
  "provision-tenant": ["confirm", "installation-id", "repository", "tenant-id", "selected-channel-id", "replace-pairing"],
  help: [],
};

export type ParsedArgs = {
  command: string | undefined;
  positionals: string[];
  flags: Map<string, string | true>;
};

export function parseArgs(argv: string[]): ParsedArgs {
  const [command, ...rest] = argv;
  const parsed = parseNodeArgs({
    args: rest, strict: true, allowPositionals: true, tokens: true,
    options: Object.fromEntries([
      ...STRING_FLAGS.map((name) => [name, { type: "string" as const }]),
      ...BOOLEAN_FLAGS.map((name) => [name, { type: "boolean" as const }]),
    ]),
  });
  const flags = new Map<string, string | true>();
  const allowed = new Set(["environment", "help", ...(COMMAND_FLAGS[command ?? ""] ?? [])]);
  for (const token of parsed.tokens) {
    if (token.kind !== "option") continue;
    if (!allowed.has(token.name)) throw new Error(`--${token.name} is not supported for this command`);
    if (flags.has(token.name)) throw new Error(`--${token.name} may only be supplied once`);
    if (token.value !== undefined && !token.value.trim()) throw new Error(`--${token.name} requires a non-empty value`);
    flags.set(token.name, token.value ?? true);
  }
  if (command !== "migrate-to" && parsed.positionals.length > 0) throw new Error("Unexpected positional argument");
  return { command, positionals: parsed.positionals, flags };
}

function validSecret(value: string): string {
  if (!/^[!-~]+$/.test(value) || value.length > 16_384) {
    throw new Error("Input must contain exactly one non-empty ASCII Slack bot token without whitespace or control characters");
  }
  return value;
}

export async function readSecret(tty: ReadStream = process.stdin, output: Pick<WriteStream, "write"> = process.stderr): Promise<string> {
  if (!tty.isTTY) {
    const chunks: Buffer[] = [];
    let size = 0;
    for await (const chunk of tty) {
      const bytes = Buffer.isBuffer(chunk) ? chunk : Buffer.from(String(chunk));
      size += bytes.length;
      if (size > 16_386) throw new Error("Slack bot token input is too long");
      chunks.push(bytes);
    }
    return validSecret(Buffer.concat(chunks).toString("utf8").replace(/\r?\n$/, ""));
  }
  if (!tty.setRawMode) throw new Error("Cannot disable terminal echo; pipe the Slack bot token on stdin");
  const wasRaw = tty.isRaw;
  output.write("Slack bot token: ");
  tty.setRawMode(true);
  return new Promise<string>((resolve, reject) => {
    let value = "";
    let finished = false;
    const finish = (error?: Error) => {
      if (finished) return;
      finished = true;
      tty.pause();
      tty.removeListener("data", onData);
      tty.removeListener("end", onEnd);
      tty.removeListener("close", onEnd);
      tty.removeListener("error", onError);
      try {
        tty.setRawMode(wasRaw);
        output.write("\n");
        if (error) throw error;
        resolve(validSecret(value));
      } catch (failure) {
        reject(failure);
      }
    };
    const onEnd = () => finish(new Error("Slack bot token input ended before submission"));
    const onError = () => finish(new Error("Cannot read Slack bot token input"));
    const onData = (chunk: Buffer | string) => {
      for (const character of chunk.toString()) {
        if (character === "\u0003") return finish(new Error("Cancelled"));
        if (character === "\r" || character === "\n" || character === "\u0004") return finish();
        if (character === "\u007f" || character === "\b") value = value.slice(0, -1);
        else if (!/^[!-~]$/.test(character)) return finish(new Error("Unsupported character in token input; paste only the Slack bot token"));
        else value += character;
        if (value.length > 16_384) return finish(new Error("Slack bot token input is too long"));
      }
    };
    tty.on("data", onData);
    tty.once("end", onEnd);
    tty.once("close", onEnd);
    tty.once("error", onError);
    tty.resume();
  });
}
