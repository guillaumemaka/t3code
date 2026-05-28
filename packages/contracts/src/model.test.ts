import { describe, expect, it } from "vitest";

import {
  DEFAULT_GIT_TEXT_GENERATION_MODEL_BY_PROVIDER,
  DEFAULT_MODEL_BY_PROVIDER,
  MODEL_SLUG_ALIASES_BY_PROVIDER,
  PROVIDER_DISPLAY_NAMES,
} from "./model.ts";
import { ProviderDriverKind } from "./providerInstance.ts";

describe("model provider metadata", () => {
  it("defines KiloCode defaults and presentation", () => {
    const kilocode = ProviderDriverKind.make("kilocode");

    expect(DEFAULT_MODEL_BY_PROVIDER[kilocode]).toBe("openai/gpt-5");
    expect(DEFAULT_GIT_TEXT_GENERATION_MODEL_BY_PROVIDER[kilocode]).toBe("openai/gpt-5");
    expect(MODEL_SLUG_ALIASES_BY_PROVIDER[kilocode]).toEqual({});
    expect(PROVIDER_DISPLAY_NAMES[kilocode]).toBe("KiloCode");
  });
});
