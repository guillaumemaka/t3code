# Add KiloCode Agent Driver

## Summary

Add a first-class `KiloCode` provider driver to t3code, modeled on the existing OpenCode provider but using KiloCode’s own SDK and CLI:

- New driver kind: `kilocode`
- Default instance id: `kilocode`
- Default binary path: `kilo`
- CLI package/update target: `@kilocode/cli`
- SDK dependency: `@kilocode/sdk`
- Runtime modes: spawn local server when `serverUrl` is empty, or connect to an external Kilo server when configured
- Scope: OpenCode parity first; defer Kilo workspace/indexing/suggestion/background-process extras

## Current Mapping: t3code OpenCode vs KiloCode

OpenCode provider in t3code currently assumes:

- npm SDK: `@opencode-ai/sdk/v2`
- spawn command: `opencode serve --hostname=... --port=...`
- startup banner: `opencode server listening on http://...`
- env config override: `OPENCODE_CONFIG_CONTENT`
- client factory: `createOpencodeClient`
- server password support through Basic auth
- provider status probes through `provider.list` and `app.agents`
- events: `message.updated`, `message.part.delta`, `message.part.updated`, `permission.asked`, `question.asked`, `session.status`, `session.error`
- turn sending through `session.promptAsync`
- synchronous text generation through `session.prompt`

KiloCode clone shows these differences:

- npm CLI package is `@kilocode/cli`, with bin names `kilo` and `kilocode`.
- npm SDK package is `@kilocode/sdk`, with v2 exports under `@kilocode/sdk/v2`.
- Kilo SDK client factory is `createKiloClient`.
- Kilo spawned server command is `kilo serve --hostname=... --port=...`.
- startup banner is `kilo server listening on http://...`.
- env config override is `KILO_CONFIG_CONTENT`.
- Kilo SDK has directory and optional workspace request plumbing via `x-kilo-directory` and `x-kilo-workspace`.
- Kilo v2 event union includes OpenCode-compatible events plus additional Kilo events:
  `workspace.*`, `worktree.*`, `indexing.status`, `suggestion.*`, `session.next.*`, `kilo.sessions.remote.status.changed`, etc.
- The OpenCode parity event subset still exists and should be mapped first:
  `message.updated`, `message.removed`, `message.part.delta`, `message.part.updated`, `permission.asked`, `permission.replied`, `question.asked`, `question.replied`, `question.rejected`, `session.status`, `session.error`, `session.idle`.
- Kilo adds `session.idle` as an explicit event; map it as an additional turn completion signal alongside OpenCode’s `session.status: idle`.

## Public Interfaces / Types

Add `KiloCodeSettings` to [packages/contracts/src/settings.ts](/Users/guillaumemaka/.t3/worktrees/t3code/t3code-1dff4347/packages/contracts/src/settings.ts):

```ts
export const KiloCodeSettings = makeProviderSettingsSchema(
  {
    enabled: Schema.Boolean.pipe(...default true...hidden...),
    binaryPath: makeBinaryPathSetting("kilo").pipe(...),
    serverUrl: TrimmedString.pipe(...),
    serverPassword: TrimmedString.pipe(...password control...),
    customModels: Schema.Array(Schema.String).pipe(...hidden...),
  },
  { order: ["binaryPath", "serverUrl", "serverPassword"] },
);
```

Add `kilocode` to:

- `ServerSettings.providers`
- `DEFAULT_MODEL_BY_PROVIDER`: `kilocode -> "openai/gpt-5"`
- `DEFAULT_GIT_TEXT_GENERATION_MODEL_BY_PROVIDER`: `kilocode -> "openai/gpt-5"`
- `MODEL_SLUG_ALIASES_BY_PROVIDER`: empty object
- `PROVIDER_DISPLAY_NAMES`: `KiloCode`

No new schema shape is needed for `ProviderRuntimeEvent`; use the existing canonical provider runtime events.

## Server Dependencies

Update [apps/server/package.json](/Users/guillaumemaka/.t3/worktrees/t3code/t3code-1dff4347/apps/server/package.json):

```json
"@kilocode/sdk": "^7.3.12"
```

Use KiloCode’s published package version aligned with the inspected repo version. Keep `@kilocode/cli` as the external CLI package users install globally; do not add it as a server runtime dependency unless package policy later allows bundling provider CLIs.

## Runtime Layer

Create [apps/server/src/provider/kilocodeRuntime.ts](/Users/guillaumemaka/.t3/worktrees/t3code/t3code-1dff4347/apps/server/src/provider/kilocodeRuntime.ts), derived from `opencodeRuntime.ts` but Kilo-specific.

Key differences:

- Import from `@kilocode/sdk/v2`.
- Runtime service tag: `KiloCodeRuntime`.
- Start server command:

```ts
ChildProcess.make(input.binaryPath, ["serve", `--hostname=${hostname}`, `--port=${port}`], {
  detached: process.platform !== "win32",
  shell: process.platform === "win32",
  env: {
    ...(input.environment ?? process.env),
    KILO_CONFIG_CONTENT: "{}",
  },
})
```

- Ready prefix: `kilo server listening`.
- Default hostname: `127.0.0.1`.
- Default timeout: `5000ms`.
- `connectToKiloCodeServer` mirrors OpenCode: external URL returns `{ external: true, exitCode: null }`, otherwise spawns local server.
- `createKiloCodeSdkClient` wraps `createKiloClient({ baseUrl, directory })`.
- Keep optional `serverPassword` support only if Kilo’s SDK/server accepts the same Basic auth pattern. Otherwise leave the setting present but unused for spawn mode and document external auth errors via provider probe messages.
- `loadKiloCodeInventory` calls `client.provider.list()` and `client.app.agents()`.

Shared helpers to port/rename:

- `runKiloCodeSdk`
- `parseKiloCodeModelSlug`
- `toKiloCodeFileParts`
- `buildKiloCodePermissionRules`
- `toKiloCodePermissionReply`
- `toKiloCodeQuestionAnswers`
- `kiloCodeQuestionId`

## Adapter

Create [apps/server/src/provider/Services/KiloCodeAdapter.ts](/Users/guillaumemaka/.t3/worktrees/t3code/t3code-1dff4347/apps/server/src/provider/Services/KiloCodeAdapter.ts):

```ts
export interface KiloCodeAdapterShape extends ProviderAdapterShape<ProviderAdapterError> {}
```

Create [apps/server/src/provider/Layers/KiloCodeAdapter.ts](/Users/guillaumemaka/.t3/worktrees/t3code/t3code-1dff4347/apps/server/src/provider/Layers/KiloCodeAdapter.ts), based on `OpenCodeAdapter.ts`.

Required behavior:

- Provider constant: `ProviderDriverKind.make("kilocode")`.
- Session context mirrors OpenCode:
  `client`, `server`, `directory`, `kiloCodeSessionId`, pending permissions/questions, part caches, turn snapshots, active turn/model/agent/variant, stopped ref, session scope.
- `startSession`:
  - stop existing context for the same t3code thread
  - connect/spawn Kilo server
  - create Kilo client
  - call `client.session.create({ title, permission })`
  - store context
  - start `client.event.subscribe(...)`
  - emit `session.started` and `thread.started`
- `sendTurn`:
  - require model slug in `provider/model` format
  - read model option descriptors `agent` and `variant`
  - default plan-mode `interactionMode === "plan"` to agent `"plan"` only if no explicit agent selection exists
  - emit `turn.started`
  - call `client.session.promptAsync({ sessionID, model, agent, variant, parts })`
- `interruptTurn` and `stopSession`:
  - use `client.session.abort({ sessionID })`
  - emit `turn.aborted` / `session.exited`
- approvals:
  - `permission.asked` -> `request.opened`
  - `respondToRequest` -> `client.permission.reply`
- user input:
  - `question.asked` -> `user-input.requested`
  - `respondToUserInput` -> `client.question.reply`
- thread read/rollback:
  - `session.messages`
  - `session.revert`

Event mapping should copy OpenCode’s parity mapping and add these Kilo-specific parity fixes:

- Treat `session.idle` as `turn.completed` when an active turn exists.
- Treat `session.turn.close` as terminal when present:
  - `completed` -> `turn.completed`
  - `interrupted` -> `turn.aborted`
  - `error` -> `turn.completed` with `state: "failed"`
- Ignore Kilo-only events in first pass, but log debug for unhandled events with event type and thread id.

Set capabilities:

```ts
capabilities: { sessionModelSwitch: "in-session" }
```

## Provider Snapshot / Status

Create [apps/server/src/provider/Layers/KiloCodeProvider.ts](/Users/guillaumemaka/.t3/worktrees/t3code/t3code-1dff4347/apps/server/src/provider/Layers/KiloCodeProvider.ts), based on `OpenCodeProvider.ts`.

Presentation:

```ts
displayName: "KiloCode"
showInteractionModeToggle: false
```

Minimum version:

- Use no hard minimum initially unless Kilo docs specify one.
- Probe local version with `kilo --version`.
- If parsing fails, surface a warning/error like OpenCode does.

Model discovery:

- `provider.list` returns provider/model inventory.
- `app.agents` returns agents.
- Flatten model slugs as `${provider.id}/${model.id}`.
- Capabilities:
  - `variant` select from model variants
  - `agent` select from primary/all non-hidden agents
  - default agent: prefer `code` if present, then `build`, then first primary/all agent
  - default variant: reuse OpenCode heuristic unless Kilo-specific data suggests otherwise

Probe behavior:

- Local mode: validate CLI installed and version readable, then start scoped server and load inventory.
- External mode: skip CLI version, connect to `serverUrl`, load inventory, report auth/network errors clearly.
- Disabled mode: same shape as OpenCode, with KiloCode-specific copy.

## Driver

Create [apps/server/src/provider/Drivers/KiloCodeDriver.ts](/Users/guillaumemaka/.t3/worktrees/t3code/t3code-1dff4347/apps/server/src/provider/Drivers/KiloCodeDriver.ts), based on `OpenCodeDriver.ts`.

Driver details:

```ts
const DRIVER_KIND = ProviderDriverKind.make("kilocode");

export const KiloCodeDriver: ProviderDriver<KiloCodeSettings, KiloCodeDriverEnv> = {
  driverKind: DRIVER_KIND,
  metadata: {
    displayName: "KiloCode",
    supportsMultipleInstances: true,
  },
  configSchema: KiloCodeSettings,
  defaultConfig: () => decodeKiloCodeSettings({}),
  create: ...
}
```

Maintenance resolver:

```ts
makePackageManagedProviderMaintenanceResolver({
  provider: DRIVER_KIND,
  npmPackageName: "@kilocode/cli",
  homebrewFormula: null,
  nativeUpdate: null
})
```

If Kilo exposes `kilo upgrade` later, add native update in a follow-up.

Driver `create` returns a `ProviderInstance` with:

- snapshot from `makeManagedServerProvider`
- adapter from `makeKiloCodeAdapter`
- text generation from `makeKiloCodeTextGeneration`
- default continuation identity

Register `KiloCodeDriver` in [apps/server/src/provider/builtInDrivers.ts](/Users/guillaumemaka/.t3/worktrees/t3code/t3code-1dff4347/apps/server/src/provider/builtInDrivers.ts).

## Text Generation

Create [apps/server/src/textGeneration/KiloCodeTextGeneration.ts](/Users/guillaumemaka/.t3/worktrees/t3code/t3code-1dff4347/apps/server/src/textGeneration/KiloCodeTextGeneration.ts), based on `OpenCodeTextGeneration.ts`.

Behavior:

- Shared idle server TTL: `30 seconds`.
- Use `KiloCodeRuntime`.
- Start shared server with `kilo serve`.
- Use `createKiloCodeSdkClient`.
- Create a session with deny-all permission for safe text generation.
- Call `client.session.prompt(...)`.
- Extract text parts and decode structured JSON as existing OpenCode code does.
- Error messages should say `KiloCode`, not `OpenCode`.

Update [apps/server/src/textGeneration/TextGeneration.ts](/Users/guillaumemaka/.t3/worktrees/t3code/t3code-1dff4347/apps/server/src/textGeneration/TextGeneration.ts):

```ts
export type TextGenerationProvider =
  | "codex"
  | "claudeAgent"
  | "cursor"
  | "opencode"
  | "kilocode";
```

Ensure the provider instance registry’s bundled `textGeneration` routes naturally through `ProviderInstance`.

## UI Integration

Update [apps/web/src/components/settings/providerDriverMeta.ts](/Users/guillaumemaka/.t3/worktrees/t3code/t3code-1dff4347/apps/web/src/components/settings/providerDriverMeta.ts):

- import `KiloCodeSettings`
- add `KiloCode` client definition
- add `KiloCodeIcon` in `apps/web/src/components/Icons.tsx`
- use the square `kilo.ai` favicon SVG shape for `KiloCodeIcon`; the upstream repo `logo.png` is a wide pixel wordmark and becomes unreadable at the app's 16-20px provider icon sizes

Update [apps/web/src/components/chat/providerIconUtils.ts](/Users/guillaumemaka/.t3/worktrees/t3code/t3code-1dff4347/apps/web/src/components/chat/providerIconUtils.ts):

```ts
[ProviderDriverKind.make("kilocode")]: KiloCodeIcon
```

Update any model/provider display constants to include `KiloCode`.

Do not add Kilo-specific workspace/indexing UI in this first pass.

## Tests

Add/extend focused tests.

Contracts:

- `settings.test.ts`
  - decodes default `KiloCodeSettings`
  - preserves `binaryPath`, `serverUrl`, `serverPassword`, `customModels`
  - decodes `ServerSettings.providers.kilocode`
- `model.test.ts`
  - default model for `kilocode`
  - display name for `kilocode`

Runtime:

- `kilocodeRuntime.test.ts`
  - parses `kilo server listening on http://...`
  - spawns `kilo serve --hostname=... --port=...`
  - injects `KILO_CONFIG_CONTENT`
  - external `serverUrl` does not spawn
  - process cleanup closes process group/scope
  - `parseKiloCodeModelSlug("openai/gpt-5")`

Provider status:

- `KiloCodeProvider.test.ts`
  - disabled snapshot
  - missing CLI message
  - external server network/auth message
  - inventory flattening into `provider/model`
  - agent/variant option descriptors

Adapter:

- `KiloCodeAdapter.test.ts`
  - `startSession` creates SDK session and emits `session.started`/`thread.started`
  - `sendTurn` validates model slug and calls `session.promptAsync`
  - text/file attachments become Kilo file parts
  - `message.part.delta` maps to `content.delta`
  - `message.part.updated` tool maps to item lifecycle events
  - `permission.asked` / reply round trip
  - `question.asked` / reply round trip
  - `session.idle` completes the active turn
  - `session.turn.close` maps completed/interrupted/error correctly
  - `stopSession` aborts and emits graceful `session.exited`
  - server exit emits `runtime.error` and non-recoverable `session.exited`

Driver/registry:

- `ProviderInstanceRegistryLive` or `ProviderRegistry` test with a `kilocode` instance
- `ProviderService` routing test starts a `kilocode` session and sends a turn through the adapter

Text generation:

- `KiloCodeTextGeneration.test.ts`
  - creates local shared server when no `serverUrl`
  - uses external server when `serverUrl` is configured
  - forwards model, agent, variant
  - rejects invalid model slug
  - decodes JSON output
  - reports empty output/invalid JSON as `TextGenerationError`

UI:

- provider settings browser/unit test:
  - KiloCode appears in provider settings
  - fields render as Binary path, Server URL, Server password
- model picker/icon test:
  - `kilocode` provider has display name and icon

Required repo checks before completion:

```bash
bun fmt
bun lint
bun typecheck
bun run test
```

Do not run `bun test`.

## Explicit Defaults / Assumptions

- Use a distinct driver kind `kilocode`, not an alias of `opencode`.
- Use `@kilocode/sdk/v2`, not `@opencode-ai/sdk/v2`, because KiloCode has already changed client factory, env names, server banner, response interceptors, workspace plumbing, and event variants.
- Default binary path is `kilo`, not `kilocode`, because Kilo’s own SDK server helper spawns `kilo`.
- Keep `serverPassword` in settings for parity with OpenCode and external-server compatibility, but verify during implementation whether Kilo server honors the same Basic auth mechanism.
- First version intentionally ignores Kilo-specific workspace/indexing/suggestion/background-process events unless they affect core session/turn correctness.
- Workspace support is deferred; do not expose `experimental_workspaceID` in settings in this pass.
- Use the `kilo.ai` favicon-derived square icon for the first-pass `KiloCodeIcon`; do not use the GitHub repo wordmark directly because it is not legible in compact provider icon slots.
- KiloCode text generation is included so provider instances can be used anywhere OpenCode instances can be selected for git/thread title generation.
