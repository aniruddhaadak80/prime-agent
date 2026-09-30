import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { getApiProvider } from "../src/api-registry.js";
import { registerBuiltInApiProviders, setBedrockProviderModule } from "../src/providers/register-builtins.js";
import type {
	Api,
	AssistantMessage,
	AssistantMessageEvent,
	AssistantMessageEventStream,
	Context,
	TextContent,
} from "../src/types.js";
import { getFixtureModel } from "./fixture-models.js";

const model = getFixtureModel("amazon-bedrock", "eu.anthropic.claude-sonnet-4-5-20250929-v1:0")!;
const context: Context = { messages: [{ role: "user", content: "hi", timestamp: 1 }] };

function baseMessage(): AssistantMessage {
	return {
		role: "assistant",
		content: [],
		api: "bedrock-converse-stream" as Api,
		provider: model.provider,
		model: model.id,
		usage: {
			input: 0,
			output: 0,
			cacheRead: 0,
			cacheWrite: 0,
			totalTokens: 0,
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
		},
		stopReason: "stop",
		timestamp: 1,
	};
}

/** A provider stream that streams some content and then throws instead of encoding the failure. */
function throwingStream(): AsyncIterable<AssistantMessageEvent> {
	const partial = baseMessage();
	return {
		async *[Symbol.asyncIterator]() {
			yield { type: "start", partial };
			// Mirror a real provider: blocks are appended to the partial as they stream.
			partial.content.push({ type: "text", text: "" } satisfies TextContent);
			yield { type: "text_start", contentIndex: 0, partial };
			partial.content[0] = { type: "text", text: "par" };
			yield { type: "text_delta", contentIndex: 0, delta: "par", partial };
			throw new Error("socket hang up");
		},
	};
}

/** A provider stream that terminates correctly. */
function cleanStream(): AsyncIterable<AssistantMessageEvent> {
	const partial = baseMessage();
	const done: AssistantMessage = { ...partial, stopReason: "stop" };
	return {
		async *[Symbol.asyncIterator]() {
			yield { type: "start", partial };
			partial.content.push({ type: "text", text: "" } satisfies TextContent);
			yield { type: "text_start", contentIndex: 0, partial };
			partial.content[0] = { type: "text", text: "partial" };
			yield { type: "text_delta", contentIndex: 0, delta: "partial", partial };
			done.content = partial.content;
			yield { type: "done", reason: "stop", message: done };
		},
	};
}

function collectUntilTerminal(stream: AsyncIterable<AssistantMessageEvent>): Promise<AssistantMessageEvent[]> {
	return (async () => {
		const events: AssistantMessageEvent[] = [];
		for await (const event of stream) {
			events.push(event);
			if (event.type === "done" || event.type === "error") break;
		}
		return events;
	})();
}

/** Let the microtask queue drain so any rejected detached promise is reported. */
async function flushMicrotasks(): Promise<void> {
	for (let round = 0; round < 3; round += 1) {
		await new Promise<void>((resolve) => {
			setImmediate(resolve);
		});
	}
}

function bedrockStream(): AssistantMessageEventStream {
	const provider = getApiProvider("bedrock-converse-stream");
	if (!provider) throw new Error("bedrock-converse-stream provider is not registered");
	return provider.stream(model, context, { apiKey: "test-key" });
}

describe("lazy provider stream forwarding", () => {
	let unhandled: unknown[] = [];
	let onUnhandled: (reason: unknown) => void;

	beforeEach(() => {
		registerBuiltInApiProviders();
		unhandled = [];
		onUnhandled = (reason: unknown) => unhandled.push(reason);
		process.on("unhandledRejection", onUnhandled);
	});

	afterEach(() => {
		process.off("unhandledRejection", onUnhandled);
	});

	it("encodes a mid-stream provider throw as a terminal error instead of crashing the process", async () => {
		setBedrockProviderModule({ streamBedrock: throwingStream, streamSimpleBedrock: throwingStream });

		const collected = collectUntilTerminal(bedrockStream());
		await flushMicrotasks();

		// A detached forwarding promise that rejects with no handler terminates the
		// process on Node >= 15. Nothing may escape before the stream reports it.
		expect(unhandled).toEqual([]);

		const events = await collected;
		const terminal = events.at(-1);
		expect(terminal?.type).toBe("error");
	});

	it("settles result() with the accumulated content when the source throws", async () => {
		setBedrockProviderModule({ streamBedrock: throwingStream, streamSimpleBedrock: throwingStream });

		const stream = bedrockStream();
		const collected = collectUntilTerminal(stream);
		await flushMicrotasks();
		expect(unhandled).toEqual([]);

		const result = await stream.result();
		await collected;

		expect(result.stopReason).toBe("error");
		expect(result.errorMessage).toBe("socket hang up");
		// Content streamed before the failure is preserved rather than discarded.
		expect(result.content).toEqual(expect.arrayContaining([expect.objectContaining({ type: "text" })]));
	});

	it("still forwards a well-behaved stream unchanged", async () => {
		setBedrockProviderModule({ streamBedrock: cleanStream, streamSimpleBedrock: cleanStream });

		const stream = bedrockStream();
		const events = await collectUntilTerminal(stream);
		const result = await stream.result();

		expect(unhandled).toEqual([]);
		expect(events.map((event) => event.type)).toEqual(["start", "text_start", "text_delta", "done"]);
		expect(result.stopReason).toBe("stop");
		expect(result.errorMessage).toBeUndefined();
	});
});
