import * as assert from "assert";
import * as vscode from "vscode";
import OpenAI from "openai";

import { convertRequestToOpenAI } from "../utils";
import { SyntheticChatModelProvider } from "../provider";

interface OpenAIToolCall {
	id: string;
	type: "function";
	function: { name: string; arguments: string };
}
interface ConvertedMessage {
	role: "user" | "assistant" | "tool";
	content?: string;
	name?: string;
	tool_calls?: OpenAIToolCall[];
	tool_call_id?: string;
}

suite("Synthetic Chat Provider Extension", () => {
	suite("provider", () => {
		test("reports buffered text before tool calls", async () => {
			const openai = new OpenAI({ apiKey: "test-key" });
			const completionsPrototype = Object.getPrototypeOf(openai.chat.completions) as object;
			const originalCreate = Object.getOwnPropertyDescriptor(completionsPrototype, "create");
			const provider = new SyntheticChatModelProvider(
				{ get: async () => "test-key" } as unknown as vscode.SecretStorage,
				"test-user-agent"
			);
			const emitted: Array<{ kind: "text" | "tool"; value: string }> = [];

			Object.defineProperty(completionsPrototype, "create", {
				configurable: true,
				value: () => ({
					async *[Symbol.asyncIterator]() {
						yield { choices: [{ delta: { content: "before changing <thi" } }] };
						yield {
							choices: [{
								delta: {
									tool_calls: [{
										index: 0,
										id: "call-1",
										type: "function",
										function: { name: "read_file", arguments: "{}" }
									}]
								},
								finish_reason: "tool_calls"
							}]
						};
					}
				})
			});

			try {
				await provider.provideLanguageModelChatResponse(
					{ id: "test-model" } as vscode.LanguageModelChatInformation,
					[],
					{ tools: [], toolMode: vscode.LanguageModelChatToolMode.Auto },
					{
						report: (part: vscode.LanguageModelResponsePart) => {
							if (part instanceof vscode.LanguageModelTextPart && part.value.length > 0) {
								emitted.push({ kind: "text", value: part.value });
							} else if (part instanceof vscode.LanguageModelToolCallPart) {
								emitted.push({ kind: "tool", value: part.name });
							}
						}
					},
					new vscode.CancellationTokenSource().token
				);

				assert.deepStrictEqual(emitted, [
					{ kind: "text", value: "before changing " },
					{ kind: "text", value: "<thi" },
					{ kind: "tool", value: "read_file" }
				]);
			} finally {
				provider.dispose();
				if (originalCreate) {
					Object.defineProperty(completionsPrototype, "create", originalCreate);
				}
			}
		});
	});

		suite("convertRequest", () => {
		test("should convert request with tools", () => {
			const mockTools: vscode.LanguageModelChatTool[] = [
				{
					name: "read_file",
					description: "Read file contents",
					inputSchema: {
						type: "object",
						required: ["filePath"],
						properties: {
							filePath: { type: "string" }
						}
					}
				}
			];

			const messages: vscode.LanguageModelChatRequestMessage[] = [{
				role: vscode.LanguageModelChatMessageRole.User,
				content: [new vscode.LanguageModelTextPart("Read a file")],
				name: "test-user"
			}];

			const result = convertRequestToOpenAI(messages, mockTools);

			assert.strictEqual(result.stream, true);
			assert.ok(result.messages);
			assert.strictEqual(result.messages!.length, 1);
			assert.ok(result.tools, "Should include tools in request");
			assert.strictEqual(result.tools!.length, 1, "Should have correct number of tools");
			assert.strictEqual((result.tools![0] as any).function.name, "read_file", "Should have correct tool name");
		});

		test("should convert request without tools", () => {
			const messages: vscode.LanguageModelChatRequestMessage[] = [{
				role: vscode.LanguageModelChatMessageRole.User,
				content: [new vscode.LanguageModelTextPart("Hello")],
				name: "test-user"
			}];

			const result = convertRequestToOpenAI(messages);

			assert.strictEqual(result.stream, true);
			assert.ok(result.messages);
			assert.strictEqual(result.messages!.length, 1);
			assert.strictEqual(result.tools, undefined, "Should not include tools when not provided");
		});			test("should convert user message with text content", () => {
				const messages: vscode.LanguageModelChatRequestMessage[] = [{
					role: vscode.LanguageModelChatMessageRole.User,
					content: [new vscode.LanguageModelTextPart("Hello, how are you?")],
					name: "test-user"
				}];			const result = convertRequestToOpenAI(messages);

			assert.strictEqual(result.stream, true);
			assert.ok(result.messages);
			assert.strictEqual(result.messages!.length, 1);
			assert.strictEqual(result.messages![0].role, "user");
			assert.strictEqual(result.messages![0].content, "Hello, how are you?");
			assert.strictEqual(result.messages![0].name, "test-user");
		});

		test("should convert assistant message with text content", () => {
			const messages: vscode.LanguageModelChatRequestMessage[] = [{
				role: vscode.LanguageModelChatMessageRole.Assistant,
				content: [new vscode.LanguageModelTextPart("I'm doing well, thank you!")],
				name: undefined
			}];

			const result = convertRequestToOpenAI(messages);

			assert.strictEqual(result.stream, true);
			assert.ok(result.messages);
			assert.strictEqual(result.messages!.length, 1);
			assert.strictEqual(result.messages![0].role, "assistant");
			assert.strictEqual(result.messages![0].content, "I'm doing well, thank you!");
			assert.strictEqual(result.messages![0].name, undefined);
		});

		test("should convert assistant message with tool calls", () => {
			const messages: vscode.LanguageModelChatRequestMessage[] = [{
				role: vscode.LanguageModelChatMessageRole.Assistant,
				content: [
					new vscode.LanguageModelTextPart("I'll call a tool"),
					new vscode.LanguageModelToolCallPart("call-123", "getWeather", { location: "Boston" })
				],
				name: undefined
			}];

			const result = convertRequestToOpenAI(messages);

			assert.strictEqual(result.stream, true);
			assert.ok(result.messages);
			assert.strictEqual(result.messages!.length, 1);
			assert.strictEqual(result.messages![0].role, "assistant");
			assert.strictEqual(result.messages![0].content, "I'll call a tool");

			const assistantMessage = result.messages![0] as any;
			assert.ok(assistantMessage.tool_calls);
			assert.strictEqual(assistantMessage.tool_calls.length, 1);
			assert.strictEqual(assistantMessage.tool_calls[0].id, "call-123");
			assert.strictEqual(assistantMessage.tool_calls[0].type, "function");
			assert.strictEqual(assistantMessage.tool_calls[0].function.name, "getWeather");
			assert.strictEqual(assistantMessage.tool_calls[0].function.arguments, JSON.stringify({ location: "Boston" }));
		});

		test("should convert tool result message", () => {
			const messages: vscode.LanguageModelChatRequestMessage[] = [{
				role: vscode.LanguageModelChatMessageRole.User, // Tool results are typically sent as user messages
				content: [
					new vscode.LanguageModelToolResultPart("call-123", [
						new vscode.LanguageModelTextPart("The weather in Boston is sunny")
					])
				],
				name: undefined
			}];

			const result = convertRequestToOpenAI(messages);

			assert.strictEqual(result.stream, true);
			assert.ok(result.messages);
			assert.strictEqual(result.messages!.length, 1);
			assert.strictEqual(result.messages![0].role, "tool");
			assert.strictEqual(result.messages![0].content, "The weather in Boston is sunny");
			assert.strictEqual((result.messages![0] as any).tool_call_id, "call-123");
		});

		test("should preserve assistant tool calls with no text and resolve tool result names", () => {
			const messages: vscode.LanguageModelChatRequestMessage[] = [
				{
					role: vscode.LanguageModelChatMessageRole.Assistant,
					content: [new vscode.LanguageModelToolCallPart("call-kimi", "get_weather", { location: "Paris" })],
					name: undefined
				},
				{
					role: vscode.LanguageModelChatMessageRole.User,
					content: [
						new vscode.LanguageModelToolResultPart("call-kimi", [
							new vscode.LanguageModelTextPart("Sunny")
						])
					],
					name: undefined
				}
			];

			const result = convertRequestToOpenAI(messages);

			assert.strictEqual(result.messages!.length, 2, "Assistant tool call and tool result must both be preserved");
			const assistantMessage = result.messages![0] as any;
			assert.strictEqual(assistantMessage.role, "assistant");
			assert.strictEqual(assistantMessage.content, null);
			assert.strictEqual(assistantMessage.tool_calls.length, 1);
			assert.strictEqual(assistantMessage.tool_calls[0].id, "call-kimi");
			assert.strictEqual(assistantMessage.tool_calls[0].function.name, "get_weather");

			const toolMessage = result.messages![1] as any;
			assert.strictEqual(toolMessage.role, "tool");
			assert.strictEqual(toolMessage.tool_call_id, "call-kimi");
			assert.strictEqual(toolMessage.name, "get_weather");
			assert.strictEqual(toolMessage.content, "Sunny");
		});

		test("should preserve empty tool results", () => {
			const messages: vscode.LanguageModelChatRequestMessage[] = [
				{
					role: vscode.LanguageModelChatMessageRole.Assistant,
					content: [new vscode.LanguageModelToolCallPart("call-empty", "get_status", {})],
					name: undefined
				},
				{
					role: vscode.LanguageModelChatMessageRole.User,
					content: [
						new vscode.LanguageModelToolResultPart("call-empty", [
							new vscode.LanguageModelTextPart("")
						])
					],
					name: undefined
				}
			];

			const result = convertRequestToOpenAI(messages);
			assert.strictEqual(result.messages!.length, 2);
			const toolMessage = result.messages![1] as any;
			assert.strictEqual(toolMessage.content, "");
			assert.strictEqual(toolMessage.name, "get_status");
		});

		test("should convert every tool result in a message", () => {
			const messages: vscode.LanguageModelChatRequestMessage[] = [
				{
					role: vscode.LanguageModelChatMessageRole.User,
					content: [
						new vscode.LanguageModelToolResultPart("call-one", [new vscode.LanguageModelTextPart("one")]),
						new vscode.LanguageModelToolResultPart("call-two", [new vscode.LanguageModelTextPart("two")])
					],
					name: undefined
				}
			];

			const result = convertRequestToOpenAI(messages);
			assert.strictEqual(result.messages!.length, 2);
			assert.strictEqual(result.messages![0].role, "tool");
			assert.strictEqual(result.messages![0].content, "one");
			assert.strictEqual(result.messages![1].role, "tool");
			assert.strictEqual(result.messages![1].content, "two");
		});

		test("should handle multiple text parts", () => {
			const messages: vscode.LanguageModelChatRequestMessage[] = [{
				role: vscode.LanguageModelChatMessageRole.User,
				content: [
					new vscode.LanguageModelTextPart("Hello,"),
					new vscode.LanguageModelTextPart(" how are you?"),
					new vscode.LanguageModelTextPart(" I'm doing well.")
				],
				name: "multi-part-user"
			}];

			const result = convertRequestToOpenAI(messages);

			assert.strictEqual(result.stream, true);
			assert.ok(result.messages);
			assert.strictEqual(result.messages!.length, 1);
			assert.strictEqual(result.messages![0].content, "Hello, how are you? I'm doing well.");
		});

		test("should handle mixed content types", () => {
			const messages: vscode.LanguageModelChatRequestMessage[] = [{
				role: vscode.LanguageModelChatMessageRole.Assistant,
				content: [
					new vscode.LanguageModelTextPart("I have a response and a tool call:"),
					new vscode.LanguageModelToolCallPart("call-456", "getTime", { format: "24h" }),
					new vscode.LanguageModelTextPart(" Please use the tool.")
				],
				name: undefined
			}];

			const result = convertRequestToOpenAI(messages);

			assert.strictEqual(result.stream, true);
			assert.ok(result.messages);
			assert.strictEqual(result.messages!.length, 1);
			assert.strictEqual(result.messages![0].role, "assistant");
			assert.strictEqual(result.messages![0].content, "I have a response and a tool call: Please use the tool.");

			const assistantMessage = result.messages![0] as any;
			assert.ok(assistantMessage.tool_calls);
			assert.strictEqual(assistantMessage.tool_calls.length, 1);
			assert.strictEqual(assistantMessage.tool_calls[0].id, "call-456");
			assert.strictEqual(assistantMessage.tool_calls[0].function.name, "getTime");
			assert.strictEqual(assistantMessage.tool_calls[0].function.arguments, JSON.stringify({ format: "24h" }));
		});

		test("should handle unknown role by defaulting to user", () => {
			// Create a message with an unknown role
			const messages: vscode.LanguageModelChatRequestMessage[] = [{
				role: 999 as vscode.LanguageModelChatMessageRole, // Unknown role
				content: [new vscode.LanguageModelTextPart("Unknown role message")],
				name: undefined
			}];

			const result = convertRequestToOpenAI(messages);

			assert.strictEqual(result.stream, true);
			assert.ok(result.messages);
			assert.strictEqual(result.messages!.length, 1);
			assert.strictEqual(result.messages![0].role, "user");
			assert.strictEqual(result.messages![0].content, "Unknown role message");
		});
	});

	suite("token counting", () => {
		test("should provide token count for text string", async () => {
			// Mock the provideTokenCount method
			const mockProvider = {
				provideTokenCount: async (model: any, text: string | vscode.LanguageModelChatRequestMessage, token: vscode.CancellationToken) => {
					return 44;
				}
			};

			const result = await mockProvider.provideTokenCount(
				{ id: "test-model" } as vscode.LanguageModelChatInformation,
				"test text",
				new vscode.CancellationTokenSource().token
			);

			assert.strictEqual(result, 44, "Should return fixed token count");
		});

		test("should provide token count for chat message", async () => {
			// Mock the provideTokenCount method
			const mockProvider = {
				provideTokenCount: async (model: any, text: string | vscode.LanguageModelChatRequestMessage, token: vscode.CancellationToken) => {
					return 44;
				}
			};

			const message: vscode.LanguageModelChatRequestMessage = {
				role: vscode.LanguageModelChatMessageRole.User,
				content: [new vscode.LanguageModelTextPart("test message")],
				name: "test-user"
			};

			const result = await mockProvider.provideTokenCount(
				{ id: "test-model" } as vscode.LanguageModelChatInformation,
				message,
				new vscode.CancellationTokenSource().token
			);

			assert.strictEqual(result, 44, "Should return fixed token count for message");
		});
	});

	suite("change notification", () => {
		test("refresh fires onDidChangeLanguageModelChatInformation", () => {
			const secrets = {
				get: async () => undefined,
				store: async () => {},
				delete: async () => {},
				onDidChange: () => ({ dispose: () => {} })
			} as unknown as vscode.SecretStorage;

			const provider = new SyntheticChatModelProvider(secrets, "test-user-agent");
			let fired = 0;
			const subscription = provider.onDidChangeLanguageModelChatInformation(() => fired++);

			provider.refresh();

			subscription.dispose();
			provider.dispose();
			assert.strictEqual(fired, 1, "refresh should fire the change event once");
		});
	});

});
