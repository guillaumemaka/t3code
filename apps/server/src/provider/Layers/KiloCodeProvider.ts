import {
  ProviderDriverKind,
  type ModelCapabilities,
  type KiloCodeSettings,
  type ServerProviderModel,
} from "@t3tools/contracts";
import * as Cause from "effect/Cause";
import * as Data from "effect/Data";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";

import { createModelCapabilities } from "@t3tools/shared/model";
import {
  buildServerProvider,
  nonEmptyTrimmed,
  parseGenericCliVersion,
  providerModelsFromSettings,
  type ServerProviderDraft,
} from "../providerSnapshot.ts";
import {
  KiloCodeRuntime,
  kiloCodeRuntimeErrorDetail,
  type KiloCodeInventory,
} from "../kilocodeRuntime.ts";
import type { Agent, ProviderListResponse } from "@kilocode/sdk/v2";

const PROVIDER = ProviderDriverKind.make("kilocode");
const KILOCODE_PRESENTATION = {
  displayName: "KiloCode",
  showInteractionModeToggle: false,
} as const;
class KiloCodeProbeError extends Data.TaggedError("KiloCodeProbeError")<{
  readonly cause: unknown;
  readonly detail: string;
}> {}

function normalizeProbeMessage(message: string): string | undefined {
  const trimmed = message.trim();
  if (trimmed.length === 0) {
    return undefined;
  }
  if (
    trimmed === "An error occurred in Effect.tryPromise" ||
    trimmed === "An error occurred in Effect.try"
  ) {
    return undefined;
  }
  return trimmed;
}

function normalizedErrorMessage(cause: unknown): string | undefined {
  if (cause instanceof KiloCodeProbeError) {
    return normalizeProbeMessage(cause.detail);
  }

  if (!(cause instanceof Error)) {
    return undefined;
  }

  return normalizeProbeMessage(cause.message);
}

function formatKiloCodeProbeError(input: {
  readonly cause: unknown;
  readonly isExternalServer: boolean;
  readonly serverUrl: string;
}): { readonly installed: boolean; readonly message: string } {
  const detail = normalizedErrorMessage(input.cause);
  const lower = detail?.toLowerCase() ?? "";

  if (input.isExternalServer) {
    if (
      lower.includes("401") ||
      lower.includes("403") ||
      lower.includes("unauthorized") ||
      lower.includes("forbidden")
    ) {
      return {
        installed: true,
        message: "KiloCode server rejected authentication. Check the server URL and password.",
      };
    }

    if (
      lower.includes("econnrefused") ||
      lower.includes("enotfound") ||
      lower.includes("fetch failed") ||
      lower.includes("networkerror") ||
      lower.includes("timed out") ||
      lower.includes("timeout") ||
      lower.includes("socket hang up")
    ) {
      return {
        installed: true,
        message: `Couldn't reach the configured KiloCode server at ${input.serverUrl}. Check that the server is running and the URL is correct.`,
      };
    }

    return {
      installed: true,
      message: detail ?? "Failed to connect to the configured KiloCode server.",
    };
  }

  if (lower.includes("enoent") || lower.includes("notfound")) {
    return {
      installed: false,
      message: "KiloCode CLI (`kilo`) is not installed or not on PATH.",
    };
  }

  if (lower.includes("quarantine")) {
    return {
      installed: true,
      message:
        "macOS is blocking the KiloCode binary (quarantine). Run `xattr -d com.apple.quarantine $(which kilo)` to fix this.",
    };
  }

  if (lower.includes("invalid code signature") || lower.includes("corrupted")) {
    return {
      installed: true,
      message:
        "macOS killed the KiloCode process due to an invalid code signature. The binary may be corrupted — try reinstalling KiloCode.",
    };
  }

  return {
    installed: true,
    message: detail
      ? `Failed to execute KiloCode CLI health check: ${detail}`
      : "Failed to execute KiloCode CLI health check.",
  };
}

function titleCaseSlug(value: string): string {
  return value
    .split(/[-_/]+/)
    .filter((segment) => segment.length > 0)
    .map((segment) => segment.charAt(0).toUpperCase() + segment.slice(1))
    .join(" ");
}

function inferDefaultVariant(
  providerID: string,
  variants: ReadonlyArray<string>,
): string | undefined {
  if (variants.length === 1) {
    return variants[0];
  }
  if (providerID === "anthropic" || providerID.startsWith("google")) {
    return variants.includes("high") ? "high" : undefined;
  }
  if (providerID === "openai" || providerID === "kilocode") {
    return variants.includes("medium") ? "medium" : variants.includes("high") ? "high" : undefined;
  }
  return undefined;
}

function inferDefaultAgent(agents: ReadonlyArray<Agent>): string | undefined {
  return (
    agents.find((agent) => agent.name === "code")?.name ??
    agents.find((agent) => agent.name === "build")?.name ??
    agents[0]?.name ??
    undefined
  );
}

const DEFAULT_KILOCODE_MODEL_CAPABILITIES: ModelCapabilities = createModelCapabilities({
  optionDescriptors: [],
});

function kiloCodeCapabilitiesForModel(input: {
  readonly providerID: string;
  readonly model: ProviderListResponse["all"][number]["models"][string];
  readonly agents: ReadonlyArray<Agent>;
}): ModelCapabilities {
  const variantValues = Object.keys(input.model.variants ?? {});
  const defaultVariant = inferDefaultVariant(input.providerID, variantValues);
  const variantOptions = variantValues.map((value) =>
    defaultVariant === value
      ? { id: value, label: titleCaseSlug(value), isDefault: true as const }
      : { id: value, label: titleCaseSlug(value) },
  );
  const primaryAgents = input.agents.filter(
    (agent) => !agent.hidden && (agent.mode === "primary" || agent.mode === "all"),
  );
  const defaultAgent = inferDefaultAgent(primaryAgents);
  const agentOptions = primaryAgents.map((agent) =>
    defaultAgent === agent.name
      ? { id: agent.name, label: titleCaseSlug(agent.name), isDefault: true as const }
      : { id: agent.name, label: titleCaseSlug(agent.name) },
  );
  return createModelCapabilities({
    optionDescriptors: [
      ...(variantOptions.length > 0
        ? [
            {
              id: "variant",
              label: "Variant",
              type: "select" as const,
              options: variantOptions,
              ...(defaultVariant ? { currentValue: defaultVariant } : {}),
            },
          ]
        : []),
      ...(agentOptions.length > 0
        ? [
            {
              id: "agent",
              label: "Agent",
              type: "select" as const,
              options: agentOptions,
              ...(defaultAgent ? { currentValue: defaultAgent } : {}),
            },
          ]
        : []),
    ],
  });
}

function flattenKiloCodeModels(input: KiloCodeInventory): ReadonlyArray<ServerProviderModel> {
  const connected = new Set(input.providerList.connected);
  const models: Array<ServerProviderModel> = [];

  for (const provider of input.providerList.all) {
    if (!connected.has(provider.id)) {
      continue;
    }

    for (const model of Object.values(provider.models)) {
      const name = nonEmptyTrimmed(model.name);
      if (!name) {
        continue;
      }

      const subProvider = nonEmptyTrimmed(provider.name);
      models.push({
        slug: `${provider.id}/${model.id}`,
        name,
        ...(subProvider ? { subProvider } : {}),
        isCustom: false,
        capabilities: kiloCodeCapabilitiesForModel({
          providerID: provider.id,
          model,
          agents: input.agents,
        }),
      });
    }
  }

  return models.toSorted((left, right) => left.name.localeCompare(right.name));
}

export const makePendingKiloCodeProvider = (
  kiloCodeSettings: KiloCodeSettings,
): Effect.Effect<ServerProviderDraft> =>
  Effect.gen(function* () {
    const checkedAt = yield* Effect.map(DateTime.now, DateTime.formatIso);
    const models = providerModelsFromSettings(
      [],
      PROVIDER,
      kiloCodeSettings.customModels,
      DEFAULT_KILOCODE_MODEL_CAPABILITIES,
    );

    if (!kiloCodeSettings.enabled) {
      return buildServerProvider({
        presentation: KILOCODE_PRESENTATION,
        enabled: false,
        checkedAt,
        models,
        probe: {
          installed: false,
          version: null,
          status: "warning",
          auth: { status: "unknown" },
          message:
            kiloCodeSettings.serverUrl.trim().length > 0
              ? "KiloCode is disabled in T3 Code settings. A server URL is configured."
              : "KiloCode is disabled in T3 Code settings.",
        },
      });
    }

    return buildServerProvider({
      presentation: KILOCODE_PRESENTATION,
      enabled: true,
      checkedAt,
      models,
      probe: {
        installed: false,
        version: null,
        status: "warning",
        auth: { status: "unknown" },
        message: "KiloCode provider status has not been checked in this session yet.",
      },
    });
  });

export const checkKiloCodeProviderStatus = Effect.fn("checkKiloCodeProviderStatus")(function* (
  kiloCodeSettings: KiloCodeSettings,
  cwd: string,
  environment: NodeJS.ProcessEnv = process.env,
): Effect.fn.Return<ServerProviderDraft, never, KiloCodeRuntime> {
  const kiloCodeRuntime = yield* KiloCodeRuntime;
  const checkedAt = DateTime.formatIso(yield* DateTime.now);
  const customModels = kiloCodeSettings.customModels;
  const isExternalServer = kiloCodeSettings.serverUrl.trim().length > 0;

  const fallback = (cause: unknown, version: string | null = null) => {
    const failure = formatKiloCodeProbeError({
      cause,
      isExternalServer,
      serverUrl: kiloCodeSettings.serverUrl,
    });
    return buildServerProvider({
      presentation: KILOCODE_PRESENTATION,
      enabled: kiloCodeSettings.enabled,
      checkedAt,
      models: providerModelsFromSettings(
        [],
        PROVIDER,
        customModels,
        DEFAULT_KILOCODE_MODEL_CAPABILITIES,
      ),
      probe: {
        installed: failure.installed,
        version,
        status: "error",
        auth: { status: "unknown" },
        message: failure.message,
      },
    });
  };

  if (!kiloCodeSettings.enabled) {
    return buildServerProvider({
      presentation: KILOCODE_PRESENTATION,
      enabled: false,
      checkedAt,
      models: providerModelsFromSettings(
        [],
        PROVIDER,
        customModels,
        DEFAULT_KILOCODE_MODEL_CAPABILITIES,
      ),
      probe: {
        installed: false,
        version: null,
        status: "warning",
        auth: { status: "unknown" },
        message: isExternalServer
          ? "KiloCode is disabled in T3 Code settings. A server URL is configured."
          : "KiloCode is disabled in T3 Code settings.",
      },
    });
  }

  let version: string | null = null;
  if (!isExternalServer) {
    const versionExit = yield* Effect.exit(
      kiloCodeRuntime
        .runKiloCodeCommand({
          binaryPath: kiloCodeSettings.binaryPath,
          args: ["--version"],
          environment,
        })
        .pipe(
          Effect.mapError(
            (cause) => new KiloCodeProbeError({ cause, detail: kiloCodeRuntimeErrorDetail(cause) }),
          ),
        ),
    );
    if (versionExit._tag === "Failure") {
      return fallback(Cause.squash(versionExit.cause));
    }
    version = parseGenericCliVersion(versionExit.value.stdout) ?? null;

    if (!version) {
      return fallback(
        new Error("Unable to determine KiloCode version from `kilo --version` output."),
        null,
      );
    }
  }

  const inventoryExit = yield* Effect.exit(
    Effect.scoped(
      Effect.gen(function* () {
        const server = yield* kiloCodeRuntime
          .connectToKiloCodeServer({
            binaryPath: kiloCodeSettings.binaryPath,
            serverUrl: kiloCodeSettings.serverUrl,
            environment,
          })
          .pipe(
            Effect.mapError(
              (cause) =>
                new KiloCodeProbeError({ cause, detail: kiloCodeRuntimeErrorDetail(cause) }),
            ),
          );
        return yield* kiloCodeRuntime
          .loadKiloCodeInventory(
            kiloCodeRuntime.createKiloCodeSdkClient({
              baseUrl: server.url,
              directory: cwd,
              ...(isExternalServer && kiloCodeSettings.serverPassword
                ? { serverPassword: kiloCodeSettings.serverPassword }
                : {}),
            }),
          )
          .pipe(
            Effect.mapError(
              (cause) =>
                new KiloCodeProbeError({ cause, detail: kiloCodeRuntimeErrorDetail(cause) }),
            ),
          );
      }),
    ),
  );
  if (inventoryExit._tag === "Failure") {
    return fallback(Cause.squash(inventoryExit.cause), version);
  }

  const models = providerModelsFromSettings(
    flattenKiloCodeModels(inventoryExit.value),
    PROVIDER,
    customModels,
    DEFAULT_KILOCODE_MODEL_CAPABILITIES,
  );
  const connectedCount = inventoryExit.value.providerList.connected.length;
  return buildServerProvider({
    presentation: KILOCODE_PRESENTATION,
    enabled: true,
    checkedAt,
    models,
    probe: {
      installed: true,
      version,
      status: connectedCount > 0 ? "ready" : "warning",
      auth: {
        status: connectedCount > 0 ? "authenticated" : "unknown",
        type: "kilocode",
      },
      message:
        connectedCount > 0
          ? `${connectedCount} upstream provider${connectedCount === 1 ? "" : "s"} connected through ${isExternalServer ? "the configured KiloCode server" : "KiloCode"}.`
          : isExternalServer
            ? "Connected to the configured KiloCode server, but it did not report any connected upstream providers."
            : "KiloCode is available, but it did not report any connected upstream providers.",
    },
  });
});
