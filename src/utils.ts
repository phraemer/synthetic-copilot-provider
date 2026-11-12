import OpenAI from "openai";
import { get_encoding, type Tiktoken } from "tiktoken";
import {
	CancellationToken,
	LanguageModelChatInformation,
	LanguageModelChatRequestMessage,
	LanguageModelChatTool,
	LanguageModelToolCallPart,
	LanguageModelTextPart,
	LanguageModelChatMessageRole,
	LanguageModelToolResultPart,
} from "vscode";

// Lazily-initialized, cached encoder. get_encoding() loads BPE data synchronously
// and blocks the event loop, so we initialize it once and reuse it.
let cachedEncoder: Tiktoken | null = null;
function getOrCreateEncoder(): Tiktoken {
	if (!cachedEncoder) {
		cachedEncoder = get_encoding("cl100k_base");
	}
	return cachedEncoder!;
}

/**
 * Convert an array of VS Code LanguageModelChatRequestMessage to a single OpenAI ChatCompletionCreateParamsStreaming
 * @param messages Array of VS Code chat messages to convert
 * @param tools Optional array of tool definitions to include in the request
 * @returns OpenAI ChatCompletionCreateParamsStreaming object with all messages collapsed into one conversation
 */
export function convertRequestToOpenAI(
	messages: LanguageModelChatRequestMessage[],
	tools?: LanguageModelChatTool[]
): OpenAI.ChatCompletionCreateParamsStreaming {
	const openaiMessages: OpenAI.ChatCompletionMessageParam[] = [];
	const toolCallNames = new Map<string, string>();

	for (const message of messages) {
		// Convert role
		let openaiRole: "system" | "user" | "assistant" | "tool";
		switch (message.role) {
			case LanguageModelChatMessageRole.User:
				openaiRole = "user";
				break;
			case LanguageModelChatMessageRole.Assistant:
				openaiRole = "assistant";
				break;
			default:
				openaiRole = "user"; // Default to user for unknown roles
		}

		// Convert content
		const contentParts: string[] = [];
		const toolCalls: OpenAI.ChatCompletionMessageToolCall[] = [];
		const toolResults: Array<{ callId: string; content: string }> = [];

		for (const part of message.content) {
			if (part instanceof LanguageModelTextPart) {
				contentParts.push(part.value);
			} else if (part instanceof LanguageModelToolCallPart) {
				// Convert tool call parts and remember their names for the matching
				// tool results later in the conversation.
				toolCallNames.set(part.callId, part.name);
				toolCalls.push({
					id: part.callId,
					type: "function",
					function: {
						name: part.name,
						arguments: JSON.stringify(part.input),
					},
				});
			} else if (part instanceof LanguageModelToolResultPart) {
				// Tool result parts become tool messages
				const toolResultContent: string[] = [];
				for (const resultPart of part.content) {
					if (resultPart instanceof LanguageModelTextPart) {
						toolResultContent.push(resultPart.value);
					}
				}
				toolResults.push({ callId: part.callId, content: toolResultContent.join("") });
			}
		}

		// An assistant message with tool calls must be preserved even when it has
		// no text content. Dropping it leaves an orphan tool result, which Kimi
		// rejects because it cannot resolve the tool name from a preceding call.
		if (openaiRole === "assistant" && toolCalls.length > 0) {
			openaiMessages.push({
				role: "assistant",
				content: contentParts.length > 0 ? contentParts.join("") : null,
				name: message.name || undefined,
				tool_calls: toolCalls,
			} as OpenAI.ChatCompletionAssistantMessageParam);
		} else if (contentParts.length > 0) {
			// Standard message (user, assistant, or system)
			openaiMessages.push({
				role: openaiRole,
				content: contentParts.join(""),
				name: message.name || undefined,
			});
		}

		for (const toolResult of toolResults) {
			const toolMessage: OpenAI.ChatCompletionToolMessageParam & { name?: string } = {
				role: "tool",
				content: toolResult.content,
				tool_call_id: toolResult.callId,
			};
			const toolName = toolCallNames.get(toolResult.callId);
			if (toolName) {
				// Kimi accepts either this explicit name or a matching preceding
				// assistant tool_call. Supplying both is the most robust form.
				toolMessage.name = toolName;
			}
			openaiMessages.push(toolMessage);
		}
	}

	// eslint-disable-next-line @typescript-eslint/no-explicit-any
	const result: any = {
		stream: true,
		messages: openaiMessages,
	};

	// Include tool definitions if provided
	if (tools && tools.length > 0) {
		const toolDefs = convertTools(tools);
		if (toolDefs.tools) {
			result.tools = toolDefs.tools;
		}
		if (toolDefs.tool_choice) {
			result.tool_choice = toolDefs.tool_choice;
		}
	}

	return result;
}

/**
 * Convert VS Code tool definitions to OpenAI function tool definitions.
 * @param tools Array of VS Code LanguageModelChatTool objects
 */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export function convertTools(tools: LanguageModelChatTool[]): { tools?: any[]; tool_choice?: any } {
	if (!tools || tools.length === 0) {
		return {};
	}

	const toolDefs = tools
		.filter((t) => t && typeof t === "object")
		.map((t) => {
			const name = t.name;
			const description = typeof t.description === "string" ? t.description : "";
			const params = t.inputSchema ?? {
				type: "object",
				properties: {},
			};

			// Special case: if there are no properties, don't include additionalProperties
			// eslint-disable-next-line @typescript-eslint/no-explicit-any
			const paramsWithSchema = params as any;
			if (
				Object.keys(paramsWithSchema.properties || {}).length === 0 &&
				paramsWithSchema.additionalProperties === undefined
			) {
				delete paramsWithSchema.additionalProperties;
			}

			return {
				type: "function" as const,
				function: {
					name,
					description,
					parameters: params,
				},
			};
		});

	const tool_choice: "auto" | { type: "function"; function: { name: string } } = "auto";

	return { tools: toolDefs, tool_choice };
}

export function provideTokenCount(
	model: LanguageModelChatInformation,
	text: string | LanguageModelChatRequestMessage,
	token: CancellationToken
): Promise<number> {
	return new Promise((resolve, reject) => {
		// Defer to the next tick so the event loop isn't blocked by tiktoken's
		// synchronous BPE encoding. VS Code calls this frequently for token
		// estimation and blocking would freeze the extension host.
		setImmediate(() => {
			try {
				// Check for cancellation
				if (token.isCancellationRequested) {
					reject(new Error("Token count operation was cancelled"));
					return;
				}

				// Get text content from message or use string directly
				let textContent: string;
				if (typeof text === "string") {
					textContent = text;
				} else {
					// Extract text content from LanguageModelChatRequestMessage
					const contentParts: string[] = [];
					for (const part of text.content) {
						if (part instanceof LanguageModelTextPart) {
							contentParts.push(part.value);
						}
					}
					textContent = contentParts.join("");
				}

				// Use cached encoder - don't create/free every call
				const enc = getOrCreateEncoder();

				// Encode the text into tokens and get the count
				const tokens = enc.encode(textContent);
				resolve(tokens.length);
			} catch (error) {
				reject(error);
			}
		});
	});
}
