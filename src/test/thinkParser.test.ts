import * as assert from "assert";

import { ThinkSegment, ThinkTagParser } from "../thinkParser";

suite("ThinkTagParser", () => {
	test("parses inline thinking blocks", () => {
		const parser = new ThinkTagParser();

		const segments: ThinkSegment[] = [];
		segments.push(...parser.push("Hello<think>Reason</think>World"));
		segments.push(...parser.flush());

		const merged = mergeSegments(segments);

		assert.deepStrictEqual(merged, [
			{ kind: "text", value: "Hello" },
			{ kind: "thinking", value: "Reason" },
			{ kind: "text", value: "World" }
		]);
	});

	test("supports streamed content across chunks", () => {
		const parser = new ThinkTagParser();

		const segments: ThinkSegment[] = [];
		segments.push(...parser.push("Before <think>partial"));
		segments.push(...parser.push(" reasoning"));
		segments.push(...parser.push("</think> after"));
		segments.push(...parser.flush());

		const merged = mergeSegments(segments);

		assert.deepStrictEqual(merged, [
			{ kind: "text", value: "Before " },
			{ kind: "thinking", value: "partial reasoning" },
			{ kind: "text", value: " after" }
		]);
	});

	test("handles multiple thinking sections", () => {
		const parser = new ThinkTagParser();

		const segments: ThinkSegment[] = [];
		segments.push(...parser.push("<think>First</think> middle <think>Second</think>"));
		segments.push(...parser.flush());

		const merged = mergeSegments(segments);

		assert.deepStrictEqual(merged, [
			{ kind: "thinking", value: "First" },
			{ kind: "text", value: " middle " },
			{ kind: "thinking", value: "Second" }
		]);
	});

	test("reports text as it arrives instead of withholding a fixed lookahead", () => {
		const parser = new ThinkTagParser();

		const segments = parser.push("before changing anything.");

		assert.deepStrictEqual(segments, [{ kind: "text", value: "before changing anything." }]);
	});

	test("leaves nothing buffered that could be reported after a tool call", () => {
		const parser = new ThinkTagParser();

		// Shape of a real streamed completion: narration split at arbitrary points,
		// followed by a finish_reason chunk that carries the tool calls.
		const chunks = [
			"Let me verify the arithmetic and ",
			"look at the callers and tests before ",
			"changing anything.\n\n"
		];

		for (const chunk of chunks) {
			const emitted = parser.push(chunk).map((segment) => segment.value).join("");
			assert.strictEqual(emitted, chunk, "text must be reported as it arrives");
		}

		assert.deepStrictEqual(parser.flush(), [], "nothing may be left to report after the tool-call parts");
	});

	test("withholds only a suffix that could start a tag", () => {
		const parser = new ThinkTagParser();

		// Ordinary prose is emitted immediately; only the partial tag is held.
		assert.deepStrictEqual(parser.push("Hello <thi"), [{ kind: "text", value: "Hello " }]);
		assert.deepStrictEqual(parser.push("nk>hidden"), [{ kind: "thinking", value: "hidden" }]);

		const textParser = new ThinkTagParser();
		assert.deepStrictEqual(textParser.push("ordinary text "), [
			{ kind: "text", value: "ordinary text " }
		]);
	});

	test("flushes a genuinely incomplete tag", () => {
		const parser = new ThinkTagParser();

		assert.deepStrictEqual(parser.push("text <thi"), [{ kind: "text", value: "text " }]);
		assert.deepStrictEqual(parser.flush(), [{ kind: "text", value: "<thi" }]);
	});

	test("streams thinking content without lookahead lag", () => {
		const parser = new ThinkTagParser();

		assert.deepStrictEqual(parser.push("<think>deep thoughts"), [
			{ kind: "thinking", value: "deep thoughts" }
		]);
	});
});

function mergeSegments(segments: ThinkSegment[]): ThinkSegment[] {
	if (segments.length === 0) {
		return [];
	}

	const result: ThinkSegment[] = [];
	let current = { ...segments[0] };

	for (let i = 1; i < segments.length; i++) {
		const segment = segments[i];
		if (segment.kind === current.kind) {
			current.value += segment.value;
			continue;
		}

		if (current.value.length > 0) {
			result.push({ ...current });
		}
		current = { ...segment };
	}

	if (current.value.length > 0) {
		result.push({ ...current });
	}

	return result;
}
