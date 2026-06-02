import { describe, expect, it } from "vitest";

import { parseKiloCodeModelSlug, parseKiloCodeServerUrlFromOutput } from "./kilocodeRuntime.ts";

describe("kilocodeRuntime", () => {
  it("parses the KiloCode server listening banner", () => {
    expect(
      parseKiloCodeServerUrlFromOutput(
        "booting\nkilo server listening on http://127.0.0.1:49321\n",
      ),
    ).toBe("http://127.0.0.1:49321");
  });

  it("parses provider/model slugs", () => {
    expect(parseKiloCodeModelSlug("openai/gpt-5")).toEqual({
      providerID: "openai",
      modelID: "gpt-5",
    });
    expect(parseKiloCodeModelSlug("gpt-5")).toBeNull();
  });
});
