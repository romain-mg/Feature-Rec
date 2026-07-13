# First Hosted Version on Railway

Status: repository implementation complete; Railway provisioning pending  
Target: `packages/service`  
Hosting target: Railway service plus Railway PostgreSQL  
Portability target: the same OCI image must run on any container platform with only environment and networking changes

## Goal

Ship the Feature-Rec Fastify backend as its first hosted production service. Railway will build the service image from this repository, run it as a long-lived web service, expose it over HTTPS, and provide a separate PostgreSQL service.

Railway is the first infrastructure provider, not an application dependency. The runtime contract remains:

1. A Linux container capable of running a Node.js 24 OCI image.
2. A PostgreSQL connection supplied through `DATABASE_URL`.
3. Runtime configuration and secrets supplied through environment variables.
4. An HTTP ingress that forwards to the injected `PORT`.

The backend must not call Railway APIs, read Railway-specific variables in application code, write durable state to its container filesystem, or require a Railway-specific buildpack.

## Architecture

```text
GitHub repository
       |
       | Railway builds root Dockerfile
       v
Railway backend service  <---- HTTPS ---- GitHub Action / Slack
       |
       | private DATABASE_URL
       v
Railway PostgreSQL service
```

The application image contains only the Feature-Rec service. PostgreSQL runs as a separate Railway service and is not installed in, started by, or persisted through the application container.

For local development, the existing Makefile-managed PostgreSQL container remains sufficient. A production-style Compose stack is not required for the first hosted version.

## Decisions

### Repository root is the build context

Keep `Dockerfile` at the repository root and keep Railway's service root directory at `/`. `packages/service` imports the workspace package `@feature-rec/core`, and its build also needs the root workspace definition and lockfile. Setting Railway's root directory to `/packages/service` would remove required monorepo context.

### Standardize on Node.js 24 LTS

Use Node.js 24 for development constraints, type definitions, CI, build output, and production. Node.js 24 is the newer LTS baseline for this first deployment and has a longer remaining support window than Node.js 22.

Align the repository in one change:

- change the root `engines.node` constraint from `^22.13.0 || >=24` to `^24.0.0`;
- update every workspace `@types/node` development dependency from major 22 to major 24;
- update the GitHub Actions `setup-node` version from 22 to 24;
- target Node.js 24 in the service production bundle;
- use `node:24-bookworm-slim` in every Dockerfile stage;
- regenerate `pnpm-lock.yaml` and run the complete repository gate under Node.js 24.

The standalone `apps/web` project is outside the pnpm workspace and remains outside this deployment change unless its own manifest explicitly needs alignment later.

### Build TypeScript before runtime

The current `dev` command runs `src/index.ts` with `tsx`. The production image will instead run generated JavaScript with Node.js directly.

Add a production build to `@feature-rec/service` that:

- emits an ESM entry point under `dist/`;
- targets Node.js 24;
- includes `@feature-rec/core` in the compiled output so its TypeScript source is not required by Node at runtime;
- leaves ordinary third-party packages as external runtime dependencies;
- emits source maps for useful production stack traces;
- fails on build errors and never falls back to `tsx` in production.

Use a small bundler such as `tsup` as an explicit service development dependency. Add `build` and `start` scripts, update `pnpm-lock.yaml`, and keep `dev` unchanged for local development.

### Use a multi-stage, provider-neutral Dockerfile

The root `Dockerfile` will:

1. Start from `node:24-bookworm-slim`, matching the updated repository engine requirement. Debian's `glibc` base avoids Alpine/musl compatibility surprises, while the slim variant omits tools the built runtime does not need.
2. Enable Corepack and use the repository-pinned `pnpm@11.9.0`.
3. Install from `pnpm-lock.yaml` with `--frozen-lockfile`.
4. Copy only the workspace files needed to build the service and `@feature-rec/core`.
5. Build `@feature-rec/service` in a builder stage.
6. Use `pnpm --filter @feature-rec/service deploy --legacy --prod /app` to produce a self-contained production package tree. The legacy deploy implementation avoids enabling injected workspace dependencies for every package in this existing monorepo.
7. Copy that deployed tree into a fresh runtime stage.
8. Set `NODE_ENV=production` and document port `3000` with `EXPOSE` without hard-coding the runtime port.
9. Run as the base image's unprivileged `node` user.
10. Start with an exec-form command equivalent to `node dist/index.js`, allowing `SIGTERM` to reach Node directly.
11. Include a local Docker health check that calls `GET /health` using Node's built-in `fetch`, avoiding an extra `curl` package.

Do not accept secrets as Docker build arguments and do not copy `.env` into any stage.

### Keep the image configuration portable

Application code will continue to consume standard variables only:


| Variable                   | Requirement                  | Purpose                                             |
| -------------------------- | ---------------------------- | --------------------------------------------------- |
| `PORT`                     | Platform supplied            | HTTP listener; defaults to `3000` locally           |
| `DATABASE_URL`             | Required                     | PostgreSQL connection string                        |
| `FEATURE_REC_BASE_URL`     | Required when hosted         | Stable external URL used by integrations            |
| `FEATURE_REC_RUNNER_TOKEN` | Required                     | Shared bearer token for runner endpoints            |
| `GITHUB_APP_ID`            | Required for GitHub App mode | GitHub App identifier                               |
| `GITHUB_PRIVATE_KEY`       | Required for GitHub App mode | GitHub App signing key                              |
| `FEATURE_REC_GITHUB_TOKEN` | Optional fallback            | Local/demo alternative to GitHub App authentication |
| `SLACK_BOT_TOKEN`          | Required for Slack flow      | Slack Web API authentication                        |
| `SLACK_SIGNING_SECRET`     | Required for Slack flow      | Slack request signature verification                |


The service will not read `RAILWAY_PUBLIC_DOMAIN`, `RAILWAY_SERVICE_ID`, or any other `RAILWAY_*` variable. Railway may be used to construct the value of `FEATURE_REC_BASE_URL` in its variable configuration, but the application sees only the provider-neutral variable.

A custom domain controlled by the project is preferred before integrations are considered stable. If the first version uses a generated `*.up.railway.app` domain, record that changing providers will also require updating the Slack interactivity URL and the demo repository's `FEATURE_REC_API_URL`.

## Repository changes

### Root and workspace package manifests and `pnpm-lock.yaml`

- Set the root Node engine to `^24.0.0`.
- Update `@types/node` to major 24 in `packages/core`, `packages/service`, `packages/action`, and `packages/cli`.
- Regenerate the lockfile through pnpm rather than editing it manually.

### `packages/service/package.json`

- Add the production bundler as a development dependency.
- Add `build` for the Node 24 ESM bundle.
- Add `start` for `node dist/index.js`.
- Publish only `dist/` into the deployed package tree, keep `@feature-rec/core` as a build-time dependency because it is bundled, and retain `yaml` as an explicit production dependency because it remains external.
- Preserve `dev`, `typecheck`, and `selftest`.

### `Dockerfile`

Add the provider-neutral multi-stage build described above. The image must build from the repository root with:

```bash
docker build -t feature-rec-service:local .
```

### `.dockerignore`

Exclude at least:

- `.git` and local editor metadata;
- all `node_modules`, `.pnpm-store`, caches, logs, and existing build outputs;
- `.env` and `.env.*`, while allowing `.env.example` only if documentation needs it;
- `out`, `.next`, `.remotion`, rendered media, and the local testbed;
- `packages/action`, because the GitHub Action runs in GitHub Actions and calls the hosted backend over HTTP rather than running inside the backend container;
- `packages/cli` and `packages/video`, which are not runtime dependencies of the backend;
- `apps/web`, which is a standalone application outside the pnpm workspace;
- `fixtures`, `examples`, and `docs`, which are not required to compile or run the backend;
- `.github`, whose workflows and repository automation are not runtime inputs.

The application-code boundary for this image is exactly `packages/service` plus its shared library dependency `packages/core`. Do not exclude the root package manifest, lockfile, workspace definition, TypeScript base configuration, or either of those two package directories.

### `railway.json`

Keep the small amount of provider-specific configuration isolated in a root deployment file. It should declare:

- Dockerfile builder and root `Dockerfile` path;
- `/health` as the deployment health-check path;
- a bounded health-check timeout;
- an `ALWAYS` restart policy for the long-lived service;
- zero deployment overlap, retaining Railway's default immediate traffic switch once the new deployment is healthy;
- a 60-second draining window so the old container can finish active uploads and external API requests and the existing `SIGTERM` handler can close Fastify and the PostgreSQL pool before Railway resorts to `SIGKILL`;
- watch patterns covering the Dockerfile, Railway configuration, root build manifests, `packages/service`, and `packages/core` so unrelated web/video changes do not redeploy the backend.

Express the teardown values in the Railway configuration as:

```json
{
  "deploy": {
    "overlapSeconds": 0,
    "drainingSeconds": 60
  }
}
```

These values are JSON numbers, matching Railway's current configuration schema.

Only draining differs from Railway's default. A separate overlap period is unnecessary because the `/health` gate already keeps the previous deployment serving until the replacement is ready. Draining protects requests that were already in flight when traffic switches.

Do not override the image's start command in Railway unless a platform issue makes it necessary. The Docker image must remain independently runnable.

### CI workflow

Keep `.github/workflows/ci.yaml` as a pre-merge pull-request gate:

```yaml
on:
  pull_request:
```

Extend the workflow after the existing typecheck, lint, and selftest steps:

1. Change `actions/setup-node` to Node.js 24 so all existing repository checks run on the production major version.
2. Build `feature-rec-service:ci` from the root Dockerfile.
3. Start it against the existing CI PostgreSQL service. On the Linux runner, host networking may be used so the container can reach the job service published on `localhost:5432`.
4. Poll `http://localhost:3000/health` until it returns HTTP 200 or a short deadline expires.
5. Print application logs on failure.
6. Stop the container in an `always()` cleanup step.

The smoke test needs only `DATABASE_URL` and a test `FEATURE_REC_RUNNER_TOKEN`; it must not receive production GitHub or Slack secrets.

Configure GitHub branch protection so the pull-request `CI` check must succeed and the branch must be up to date with `main` before merge. This ensures the candidate merge content passes typechecking, linting, selftests, the Docker build, and the image smoke test before it can reach the production branch.

Enable GitHub Autodeploys on the backend Railway service for the protected `main` branch, but do **not** enable Railway's **Wait for CI**. Once GitHub accepts the merge and pushes the protected `main` commit, Railway can immediately build the Dockerfile and deploy it; no second post-merge test run is planned.

### Documentation

Update `README.md` and `docs/feature-rec.md` with:

- production build and local image commands;
- the environment-variable contract;
- the Railway service and database setup;
- the hosted `/health` endpoint;
- the production Slack interactivity URL;
- the demo repository's hosted `FEATURE_REC_API_URL`;
- backup, rollback, and provider-migration notes.

## Railway provisioning

### 1. Create the project and environment

Create one Railway project with a production environment. Connect the GitHub repository and create a backend service from it. Keep the service root at the repository root so Railway detects `Dockerfile` and retains access to the shared pnpm workspace.

Select a region close to the expected Slack/GitHub users and place both the backend and PostgreSQL in the same Railway project and region.

In the backend service settings:

- select `main` as the GitHub trigger branch;
- enable GitHub Autodeploys;
- leave **Wait for CI** disabled because all required tests run before merge and there is intentionally no push-triggered CI workflow;
- confirm a project member has connected a GitHub account with contributor access and that the Railway GitHub App can access the repository;
- keep the configured watch patterns so commits unrelated to the backend can be skipped.

### 2. Add PostgreSQL

Provision Railway PostgreSQL as a separate service. Prefer the same PostgreSQL major version used locally and in CI (`postgres:18`) when Railway exposes that choice.

On the backend service, define a reference variable:

```text
DATABASE_URL=${{Postgres.DATABASE_URL}}
```

Use the private project connection. Do not expose PostgreSQL publicly for normal application traffic and do not attach a persistent volume to the backend service.

Railway hosts the database service, but database operations remain our responsibility. Before storing important review state:

- confirm the PostgreSQL version;
- configure or verify backups appropriate to the Railway plan;
- document how to obtain a `pg_dump`;
- retain credentials needed for an emergency restore;
- verify that the service has no dependency on provider-specific PostgreSQL extensions.

### 3. Configure backend variables

Set the full runtime variable set in the backend service. Seal secret values where Railway permits it.

Use one strong, randomly generated value for `FEATURE_REC_RUNNER_TOKEN` and set the same value in the calling GitHub repository. Store `GITHUB_PRIVATE_KEY` as a multiline value or with escaped newlines; the current loader supports escaped `\n` values.

Do not set `PORT` manually. Railway injects it, and the existing service already listens on that value at `0.0.0.0`.

Set `FEATURE_REC_BASE_URL` to the final HTTPS origin without a trailing route. Prefer:

```text
https://feature-rec.example.com
```

For a generated first URL, a Railway reference may be used in platform configuration:

```text
https://${{RAILWAY_PUBLIC_DOMAIN}}
```

No application code should be changed to understand that reference.

### 4. Configure public ingress and integrations

Generate a Railway domain or attach the custom domain. After the deployment is healthy:

- set Slack's Interactivity Request URL to `https://<host>/api/slack/interactivity`;
- set the demo repository's `FEATURE_REC_API_URL` to `https://<host>`;
- set the demo repository's `FEATURE_REC_RUNNER_TOKEN` to the matching secret;
- confirm that the GitHub App is installed with the documented Checks, pull request, issue, contents, and metadata permissions;
- invite the Slack bot to the configured validation channel.

The backend does not require a GitHub webhook endpoint.

## Startup, health, and migrations

The current startup order is suitable for the first hosted version:

1. Read and validate the environment.
2. Connect to PostgreSQL.
3. Run all Kysely migrations through `PostgresCycleStore.init()`.
4. Construct Fastify.
5. Listen on `0.0.0.0:$PORT`.

Because the HTTP listener starts only after migrations complete, Railway cannot receive a successful `/health` response if initial database connection or migration fails. This makes `/health` sufficient as a deployment-readiness check for the first version.

The current endpoint is not a continuous database-health check: a database outage after startup can still leave `/health` returning 200. Keep that behavior for the first version and add a database-aware readiness endpoint plus continuous external monitoring when operational requirements justify it. Railway's deployment health check itself is not continuous monitoring.

During replacement, Railway will switch traffic to the healthy new deployment, send `SIGTERM` to the previous container, and allow up to 60 seconds for the service's shutdown handler to finish active work and close its database pool. The overlap remains zero; this teardown grace period is not a second replica and does not provide crash redundancy.

Run one backend replica initially. If replicas are added later, verify concurrent migration behavior and use backward-compatible expand/contract migrations so old and new application versions can overlap safely.

## Verification

### Local application gate

Run the existing checks before container validation:

```bash
pnpm install --frozen-lockfile
pnpm typecheck
pnpm lint
pnpm selftest
```

Confirm `node --version` reports Node.js 24 before running this gate so local results match CI and production.

### Local image smoke test

1. Start PostgreSQL with `make db`.
2. Build the image from a clean repository context.
3. Run it with runtime-only environment variables and a connection URL that is reachable from the container.
4. Wait for `GET /health` to return `{ "ok": true }`.
5. Confirm the initial migration tables exist.
6. Stop the container and confirm it exits cleanly after `SIGTERM`.
7. Start it again against the same database and confirm migrations are idempotent.
8. Inspect the running UID and confirm it is not root.
9. Inspect the final filesystem and dependency tree to confirm that `.env`, repository history, development tools, and unrelated packages are absent.

### Railway deployment smoke test

Verify in this order:

1. The build log says Railway detected the root Dockerfile.
2. The service connects through the referenced private `DATABASE_URL`.
3. Migrations finish before the server begins listening.
4. Railway marks `/health` healthy and routes the public domain.
5. A public `GET /health` returns HTTP 200.
6. An unauthorized runner request returns HTTP 401.
7. A real demo PR creates or updates its Feature-Rec Check Run.
8. A frontend-visible change uploads a video and Slack buttons.
9. Slack accept and request-changes actions update GitHub correctly.
10. A service restart preserves review state in PostgreSQL.
11. A replacement deployment shows the old container receiving `SIGTERM` and exiting cleanly within the 60-second drain window rather than being force-killed.
12. Runtime logs contain useful request and shutdown information without printing tokens or private keys.

## Release and rollback

GitHub will allow a change onto the protected production branch only after the pull-request CI gate succeeds. Railway will then receive the resulting `main` push through GitHub Autodeploys and build and deploy the Dockerfile without rerunning the test suite. For the first release:

1. Provision and back up PostgreSQL before enabling real workflow traffic.
2. Deploy the backend with integrations configured but without making its Check Run required.
3. Complete the end-to-end smoke test on a disposable pull request.
4. Make the Feature-Rec Check Run required only after the hosted path succeeds.

For an application rollback, redeploy the previous known-good Railway deployment or commit. Database migrations must be backward compatible with the previous image; do not rely on automatic down migrations. If a data rollback is required, stop writes, restore a verified database backup into a new PostgreSQL service, update `DATABASE_URL`, and redeploy.

## Provider migration path

A future move to another provider should require no application code changes:

1. Build or reuse the same Docker image.
2. Provision standard PostgreSQL on the destination.
3. Export Railway PostgreSQL with `pg_dump` and restore it with `pg_restore`.
4. Set the same provider-neutral environment variables.
5. Deploy the image and wait for migrations and `/health`.
6. Exercise runner, GitHub, and Slack flows against a staging hostname.
7. Switch the custom domain or integration callback URLs.
8. Keep Railway available during a defined rollback window.
9. Take a final backup and retire the Railway services.

The portability check is simple: the image must continue to pass its smoke test when run locally with Docker and a non-Railway PostgreSQL instance.

## Out of scope for the first hosted version

- Embedding PostgreSQL in the application image.
- Publishing to Docker Hub or another registry; Railway can build the Dockerfile from GitHub.
- Kubernetes manifests or configuration for a second cloud provider.
- Multiple backend replicas or multi-region deployment.
- Preview environments for every pull request.
- A separate migration job or automatic down migrations.
- A database-aware continuous health monitor.
- A full observability stack beyond Fastify logs, Railway deployment health, and database backups.
- Deploying `apps/web`, the Remotion renderer, or other workspace packages as hosted services.

## Definition of done

- `@feature-rec/service` has a repeatable production build and starts from compiled JavaScript.
- The root engine constraint, Node type definitions, CI runner, build target, and runtime image all use Node.js 24.
- A root multi-stage Dockerfile builds a backend-only image from a clean checkout.
- The final image runs as non-root, contains no secrets, and needs no development dependencies.
- The image starts locally against ordinary PostgreSQL, migrates successfully, passes `/health`, restarts safely, and handles `SIGTERM` cleanly.
- CI builds and smoke-tests the exact Dockerfile used by Railway.
- Railway builds from the repository root and runs one healthy backend service.
- Railway PostgreSQL is a separate service reached through a referenced private `DATABASE_URL`.
- The public health endpoint, runner authentication, GitHub Check Run flow, Slack interaction flow, and persistence across restart are verified.
- Database backup and rollback procedures are documented and tested at least once before the service becomes critical.
- No application source imports a Railway SDK or reads a `RAILWAY_*` environment variable.
- The documented provider-migration procedure can reuse the same image and schema migrations.

## References

- [Railway Dockerfiles](https://docs.railway.com/builds/dockerfiles)
- [Railway monorepo deployments](https://docs.railway.com/deployments/monorepo)
- [Railway PostgreSQL](https://docs.railway.com/databases/postgresql)
- [Railway health checks](https://docs.railway.com/deployments/healthchecks)
- [Railway variables](https://docs.railway.com/variables)
- [Railway configuration as code](https://docs.railway.com/config-as-code)
- [Railway GitHub Autodeploys](https://docs.railway.com/deployments/github-autodeploys)
- [Railway Deployment Teardown](https://docs.railway.com/deployments/deployment-teardown)
- [Node.js release schedule](https://nodejs.org/en/about/previous-releases)
- [Official Node.js Docker image variants](https://github.com/nodejs/docker-node)

