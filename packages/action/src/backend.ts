import fs from "node:fs";
import { getIDToken } from "@actions/core";
import type { ClassifierResult, RunStartRequest } from "@feature-rec/core";
import { normalizeOidcAudience, RunStartRequestSchema, RunStartResponseSchema } from "@feature-rec/core";

// The backend already committed the failed cycle and attempted provider
// cleanup. The runner must not report it again; a rerun can take over the
// failed cycle even if its GitHub check update was unavailable.
export class SettledBackendError extends Error {}

async function throwBackendError(context: string, response: Response): Promise<never> {
  const text = await response.text();
  try {
    const parsed = JSON.parse(text) as { settled?: boolean; message?: string; error?: string };
    if (parsed.settled === true) {
      throw new SettledBackendError(parsed.message ?? parsed.error ?? text);
    }
  } catch (err) {
    if (err instanceof SettledBackendError) throw err;
    // Non-JSON body: fall through to the generic error.
  }
  const hint = response.status === 401
    ? " Verify the action api-url matches FEATURE_REC_BASE_URL and the workflow grants id-token: write."
    : response.status === 403
      ? " Verify the tenant is enabled and its GitHub App installation grants access to this repository."
      : "";
  throw new Error(`${context} failed: ${response.status} ${text}${hint}`);
}

function backendUrl(apiUrl: string): string {
  return normalizeOidcAudience(apiUrl, {
    allowLoopbackHttp: process.env.NODE_ENV === "development" || process.env.NODE_ENV === "test",
  });
}

async function postJson<T>(apiUrl: string, path: string, body: unknown): Promise<T> {
  const audience = backendUrl(apiUrl);
  const token = await runnerToken(audience);
  const response = await fetch(`${audience}${path}`, {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}` },
    redirect: "error",
    body: JSON.stringify(body),
  });
  if (!response.ok) {
    await throwBackendError(`Feature-Rec backend ${path}`, response);
  }
  return (await response.json()) as T;
}

export async function startCycle(apiUrl: string, input: RunStartRequest) {
  return RunStartResponseSchema.parse(await postJson(apiUrl, "/api/runs/start", RunStartRequestSchema.parse(input)));
}

async function runnerToken(audience: string): Promise<string> {
  try {
    return await getIDToken(audience);
  } catch (cause) {
    throw new Error("Could not obtain GitHub Actions OIDC token. Grant the workflow permissions: id-token: write and verify the api-url input.", { cause });
  }
}

export async function acceptCycle(
  apiUrl: string,
  cycleId: string,
  classifier: ClassifierResult,
  attemptId: string,
): Promise<void> {
  await postJson(apiUrl, `/api/runs/${cycleId}/accepted`, { ...classifier, attemptId });
}

export async function failCycle(
  apiUrl: string,
  cycleId: string,
  message: string,
  attemptId: string,
): Promise<void> {
  await postJson(apiUrl, `/api/runs/${cycleId}/failed`, { message, attemptId });
}

export async function uploadVideo(
  apiUrl: string,
  cycleId: string,
  file: string,
  attemptId: string,
): Promise<void> {
  const audience = backendUrl(apiUrl);
  const body = new Blob([new Uint8Array(fs.readFileSync(file))]);
  const token = await runnerToken(audience);
  const headers: Record<string, string> = {
    "Content-Type": "application/octet-stream",
    Authorization: `Bearer ${token}`,
    // Octet-stream body carries no JSON, so the attempt token rides on a header.
    "x-feature-rec-attempt": attemptId,
  };
  const response = await fetch(`${audience}/api/runs/${cycleId}/video`, {
    method: "POST",
    headers,
    body,
    redirect: "error",
  });
  if (!response.ok) {
    await throwBackendError("Feature-Rec backend video upload", response);
  }
}
