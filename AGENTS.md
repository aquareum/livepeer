# AGENTS.md

How to install, configure and verify an instance unattended. Every command is non-interactive.

Walking a person through putting their own instance online, from a bare server or on Vercel? Follow
[docs/agent-runbook.md](docs/agent-runbook.md): the steps in order, which are yours and which are theirs, and
the check after each. This file is the reference for the commands it uses.

## Requirements

- Docker with the Compose plugin (`docker compose version` exits 0)
- Node 22 or later (`node --version`)
- A checkout of this repository; run commands from its root

## Install

```bash
./livepeer setup --preset full --json
```

Expected: exit code 0 and one JSON line on stdout:

```json
{"ok":true,"dir":"…","preset":"full","config":"written","env":["SESSION_SECRET","…"],"mode":"mock-only","url":"http://localhost:3000","started":true,"health":{"status":"ok","instance":"Livepeer","mode":"mock-only","surfaces":{"app":true,"console":true,"api":true,"mcp":true},"engine":"skipped"}}
```

The first run builds the image and takes a few minutes. Running it again is safe: existing values in `.env`
and an existing `instance.config.json` are kept (`"config":"kept"`, `"env":[]`).

| Flag | Effect |
|------|--------|
| `--preset full\|headless` | Preset to start from. `headless` serves the operator console, API and MCP, with no customer-facing app (as with a headless CMS). |
| `--config <file>` | Use this instance config instead of a preset. |
| `--mock-only` | Run without engine keys. This is also the default when `ENGINE_URL` is empty. |
| `--network` | Also start the engine, payment provider and signer (needs keys, see `deploy/README.md`). |
| `--no-start` | Write files only; don't start containers. |
| `--port <n>` | Host port for the app (default 3000). |
| `--dir <path>` | Instance directory holding `.env` and `instance.config.json` (default: repository root). |
| `--json` | One JSON line on stdout; errors as `{"ok":false,"error":"…","exitCode":n}`. |

## Verify

```bash
curl -fsS http://localhost:3000/api/health
./livepeer doctor --json
```

`/api/health` answers 200 with `{"status":"ok",…}`, or 503 with `"status":"degraded"` when the engine is
configured but unreachable, or when its `database` field is `"unreachable"` or `"behind"` (the schema lacks
this release's migrations; `./livepeer upgrade` applies them). `"embedded"` means no `DATABASE_URL` was
given and the app is running a Postgres of its own in `DATA_DIR`, as `pnpm dev` does. Its `alerts` field is `"overdue"` when the
console is offered on phones and nothing has run the checks behind alerts for five minutes; that doesn't
make the answer 503, and `doctor` reports it with a fix. `doctor` exits 0 when every check passes and 1 otherwise; each failed check
carries a `fix`.

## Configure

- Config file: `instance.config.json`. Schema: `packages/config/schema/instance.schema.json`.
  Presets: `packages/config/presets/full.json`, `headless.json`.
- Secrets and the engine URL: `.env` (never committed). Every variable is described in `.env.example`.
- Connect a real engine: set `ENGINE_URL`, `ENGINE_READER_TOKEN` (an auditor key) and `ENGINE_ADMIN_TOKEN`
  (an admin key) in `.env`, then run `./livepeer setup` again. `MOCK_ONLY` is cleared automatically.
- Restart after editing either file: `./livepeer setup`.
- The console's Settings and Capabilities pages never write the config file. What they save is kept by the
  instance (in its database) and laid over the file; `DELETE /api/v1/operator/capabilities`
  (`operator_reset_capabilities`) forgets every capability change. A field the console has saved wins over
  the same field in the file until it is reset there.

## The first operator

`./livepeer setup --json` includes `owner_invitation` (`url`, `expiresAt`) the first time it makes
`SESSION_SECRET`: whoever opens that link and signs in becomes the first owner of the operator console. For
another owner link later:

```bash
./livepeer invite-operator --json     # {"ok":true,"url":"…","expires_at":"…"}; add --url <public address> if the config has no domain
```

On an instance with real sign-in and no `ENGINE_ADMIN_TOKEN` yet, no link is needed: the first person to
sign in and open `/operator` is offered "Become the owner", once. `/api/health` reports `owner` as `none`
until someone is.

A link works once. Owners invite everyone else from Team in the console, with a role (owner, member,
viewer). See `docs/operator-invitations.md`.

## Upgrade

```bash
git pull && ./livepeer upgrade --json
```

The engine version is pinned per release in `release.config.json`, so the app and engine move together.

## Exit codes

| Code | Meaning | Fix |
|------|---------|-----|
| 0 | Success | — |
| 1 | `doctor` found problems | Apply each check's `fix`, run `doctor` again |
| 2 | Bad usage | Check flags with `./livepeer --help` |
| 3 | Invalid instance config | The error lists each field; compare with the schema |
| 4 | Docker unavailable | Install or start Docker, or pass `--no-start` |
| 5 | `docker compose up` failed | Read the last line of the error; commonly the port is in use: pass `--port` |
| 6 | Health check did not pass in 120s | `docker logs livepeer-app-1`, then `./livepeer doctor` |

## Common failures

- **Port already in use** (exit 5): `./livepeer setup --port 3210`.
- **`admin token … refused (HTTP 403)`** in `doctor`: `ENGINE_ADMIN_TOKEN` is an actor (builder) key, not an
  admin key. Issue an admin key on the engine.
- **`engine … not ready`**: the engine isn't reachable at `ENGINE_URL` from where the app runs. Inside the
  bundle the engine is `http://engine:8080`; from the host it is `http://127.0.0.1:8090`.
- **Sign-in ends on "Sign-in didn't complete"**: the app's log has a line starting `[auth] sign-in failed:`
  with the step and the identity provider's error code (`docker logs livepeer-app-1 2>&1 | grep '\[auth\]'`).
  `invalid_client` is a wrong `OIDC_CLIENT_SECRET`.
- **Visitors see "This instance has only its test sign-in"**: the instance is published but still uses the
  presets' test sign-in, which answers only from the server and private networks. Connect an identity
  provider (`deploy/README.md`, "Sign-in on a public address").
- **Health is 500 right after changing config**: the config is invalid. Run `./livepeer doctor`.

## Working on the code

```bash
corepack pnpm install
corepack pnpm typecheck && corepack pnpm test
MOCK_ONLY=1 corepack pnpm build
```

Standing rules for changes are in `CLAUDE.md`; plans and research are in `docs/`.

## Working on the native apps

Requirements: macOS with Xcode 27 or later for iOS, with Apple's Metal toolchain for Home's aurora shader
(`xcodebuild -downloadComponent MetalToolchain`, once per machine); for Android, a JDK 17 or later and the Android SDK
(platform 37, build-tools 36) with `apps/android/local.properties` holding `sdk.dir=<path to the SDK>`, or
`ANDROID_HOME` set. Every command is non-interactive.

```bash
# 1. An instance for the app to talk to (mock-only, port 3100: what Config/Instance.xcconfig points at)
MOCK_ONLY=1 INSTANCE_CONFIG=docs/mobile/dev.instance.config.json corepack pnpm dev &   # phones switched on

# 2. Regenerate tokens, the OpenAPI document and the Swift client after changing their sources
corepack pnpm mobile:generate

# 3. Build and test iOS
xcodebuild -project apps/ios/Livepeer.xcodeproj -scheme Livepeer \
  -destination 'platform=iOS Simulator,name=iPhone 17 Pro' build
xcodebuild -project apps/ios/Livepeer.xcodeproj -scheme Livepeer \
  -destination 'platform=iOS Simulator,name=iPhone 17 Pro' test
# UI tests of the main flows: need the instance from step 1
xcodebuild -project apps/ios/Livepeer.xcodeproj -scheme LivepeerUITests \
  -destination 'platform=iOS Simulator,name=iPhone 17 Pro' test
# Unit and UI tests in one pass, as CI runs them: also need the instance
xcodebuild -project apps/ios/Livepeer.xcodeproj -scheme LivepeerAllTests \
  -destination 'platform=iOS Simulator,name=iPhone 17 Pro' test

# 4. Run it and take a screenshot
xcrun simctl boot 'iPhone 17 Pro'
xcrun simctl install booted <DerivedData>/Build/Products/Debug-iphonesimulator/Livepeer.app
xcrun simctl launch booted org.livepeer.app.dev
xcrun simctl ui booted appearance dark        # or light
xcrun simctl io booted screenshot home.png
```

```bash
# 5. Build and test Android (from apps/android; the wrapper fetches Gradle on first use)
cd apps/android
./gradlew :app:assembleDebug
./gradlew :app:testDebugUnitTest
# UI tests of the main flows, on a running emulator: need the instance from step 1. They install the app
# fresh (so a granted local-network permission goes) and turn system animations off; turn them back on after.
./gradlew :app:connectedDebugAndroidTest

# 6. Run it on an emulator and take a screenshot (10.0.2.2 is the host, where the instance listens)
$ANDROID_HOME/emulator/emulator -avd <name> -no-snapshot-save &
adb wait-for-device && adb install -r app/build/outputs/apk/debug/app-debug.apk
adb shell pm grant org.livepeer.app.dev android.permission.ACCESS_LOCAL_NETWORK   # Android 17+, debug builds
adb shell am start -n org.livepeer.app.dev/org.livepeer.app.MainActivity
adb shell cmd uimode night yes                # or no
adb exec-out screencap -p > home.png
```

- The Compose version is pinned to the newest one the installed SDK platform can compile against; the note is
  in `apps/android/gradle/libs.versions.toml`.
- New files under `apps/ios/Livepeer` and `apps/ios/LivepeerTests` are picked up without editing the Xcode
  project (the folders are synchronised).
- Never edit `apps/ios/Livepeer/Generated/*` or `apps/android/**/generated/*`: change the source and run
  `corepack pnpm mobile:generate`.
- The apps sign in through the instance's own flow. On a mock-only instance every method signs in at once as
  the test user, after the system's "wants to use … to sign in" prompt on iOS.
- On a fresh emulator Chrome opens its first-run screen inside the sign-in tab. To skip it on a test emulator
  without accepting anything: `adb shell 'echo "_ --disable-fre --no-first-run" > /data/local/tmp/chrome-command-line'`
  then `adb shell am set-debug-app --persistent com.android.chrome`.
- Decoding tests read the captured responses in `docs/mobile/fixtures/`; refresh them with `curl` against a
  mock-only instance when a response shape changes.

## Using and administering an instance as an agent

Everything the interface can do is in the API, and the same operations are MCP tools.

- Index of operations, no key needed: `GET /api/v1`
- REST: `/api/v1/*` with `Authorization: Bearer <API key>` (create a key under Developers ▸ Keys)
- MCP (streamable HTTP): `POST /api/mcp` with the same bearer token
- Operator operations (`/api/v1/operator/*`, and the `operator_*` tools): set `OPERATOR_API_TOKEN` in `.env`
  and send it as the bearer token. With it an agent can list users and jobs, suspend or top up a user, assign
  plans, create grants and change capability settings without the console.

```bash
curl -fsS http://localhost:3000/api/v1/offerings -H "Authorization: Bearer $API_KEY"
curl -fsS http://localhost:3000/api/v1/operator/overview -H "Authorization: Bearer $OPERATOR_API_TOKEN"
```
