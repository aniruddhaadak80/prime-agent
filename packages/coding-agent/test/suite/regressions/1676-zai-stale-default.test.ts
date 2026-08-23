import { getModels, type KnownProvider } from "@earendil-works/pi-ai";
import { describe, expect, test } from "vitest";
import { defaultModelPerProvider } from "../../../src/core/model-resolver.js";

// Issue 1676: glm-5.1 was removed from the upstream zai catalog while
// defaultModelPerProvider still referenced it. buildFallbackModel then
// silently degraded to providerModels[0] (glm-4.7). This test fails if any
// provider default drifts out of the generated catalog again.
describe("defaultModelPerProvider", () => {
	test("every default model id exists under its provider in the generated catalog", () => {
		const mismatches: string[] = [];
		for (const [provider, defaultId] of Object.entries(defaultModelPerProvider)) {
			const available = getModels(provider as KnownProvider);
			if (!available.some((model) => model.id === defaultId)) {
				mismatches.push(`${provider} -> "${defaultId}"`);
			}
		}
		expect(mismatches, `stale defaults: ${mismatches.join(", ")}`).toEqual([]);
	});

	test("zai default resolves to the current GLM generation", () => {
		const available = getModels("zai").map((model) => model.id);
		expect(available).toContain(defaultModelPerProvider.zai);
		expect(defaultModelPerProvider.zai === "glm-5.2" || defaultModelPerProvider.zai === "glm-5.3").toBe(true);
	});
});
