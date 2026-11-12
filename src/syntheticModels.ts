import * as vscode from "vscode";
import type { SyntheticModelDetails, SyntheticModelDevDetails } from "./types";
import { SyntheticModelsResponseSchema, SyntheticModelsDevApiResponseSchema } from "./types";
import { CancellationToken, LanguageModelChatInformation } from "vscode";
import { tryit } from "radash";

export const BASE_URL = "https://api.synthetic.new/openai/v1";
export const DEFAULT_CONTEXT_LENGTH = 128000;
export const DEFAULT_MAX_OUTPUT_TOKENS = 16000;
export const MAX_TOOLS = 128;

type BaseCapabilities = import("vscode").LanguageModelChatInformation["capabilities"];
type ExtendedCapabilities = BaseCapabilities & { supportsThinking?: boolean };

const DEFAULT_CAPABILITIES: ExtendedCapabilities = {
	toolCalling: false,
	imageInput: false,
	supportsThinking: false,
};

export const DEFAULT_MODEL_DETAILS = {
	tooltip: "Synthetic",
	family: "synthetic",
	detail: "Synthetic.new",
	version: "1.0.0",
	maxInputTokens: DEFAULT_CONTEXT_LENGTH,
	maxOutputTokens: DEFAULT_MAX_OUTPUT_TOKENS,
	capabilities: DEFAULT_CAPABILITIES,
} satisfies Partial<import("vscode").LanguageModelChatInformation>;

/**
 * Service for handling model fetching and hydration from Synthetic API
 */
export class SyntheticModelsService {
	private _modelDetailsCache: Record<string, SyntheticModelDevDetails> | null = null;
	// Lock to prevent parallel fetches from models.dev
	private _fetchingModelDetails: Promise<void> | null = null;
	// Coalesce parallel model-list fetches (e.g. the startup prefetch racing a
	// VS Code model resolution).
	private _fetchingModels: Promise<{ models: SyntheticModelDetails[] }> | null = null;
	// Cache for the list of models to avoid fetching on every request
	private _modelsCache: { models: SyntheticModelDetails[]; fetchedAt: number } | null = null;
	// Cache TTL (e.g., 5 minutes)
	private static readonly MODELS_CACHE_TTL_MS = 5 * 60 * 1000;

	constructor(private readonly userAgent: string) {}

	/**
	 * Ensure an API key exists in SecretStorage, optionally prompting the user when not silent.
	 * @param secrets VS Code secret storage.
	 * @param silent If true, do not prompt the user.
	 */
	async ensureApiKey(secrets: vscode.SecretStorage, silent: boolean): Promise<string | undefined> {
		let apiKey = await secrets.get("synthetic.apiKey");
		// Always fallback to environment variable (not a user prompt)
		if (!apiKey && process.env.SYNTHETIC_API_KEY) {
			apiKey = process.env.SYNTHETIC_API_KEY;
		}
		if (!apiKey && !silent) {
			const entered = await vscode.window.showInputBox({
				title: "Synthetic API Key",
				prompt: "Enter your Synthetic API key",
				ignoreFocusOut: true,
				password: true,
			});
			if (entered && entered.trim()) {
				apiKey = entered.trim();
				await secrets.store("synthetic.apiKey", apiKey);
			}
		}
		return apiKey;
	}

	/**
	 * Fetch the list of models and supplementary metadata from Synthetic.
	 * The models endpoint is public, so the API key is optional and only sent
	 * when one is available.
	 * @param apiKey The Synthetic API key used to authenticate, if available.
	 */
	async fetchModels(apiKey?: string): Promise<{ models: SyntheticModelDetails[] }> {
		if (this._fetchingModels) {
			return this._fetchingModels;
		}

		const promise = this._fetchModels(apiKey);
		this._fetchingModels = promise;
		try {
			return await promise;
		} finally {
			if (this._fetchingModels === promise) {
				this._fetchingModels = null;
			}
		}
	}

	private async _fetchModels(apiKey?: string): Promise<{ models: SyntheticModelDetails[] }> {
		// Use cached models if still fresh (skip caching in test environment)
		if (process.env.NODE_ENV !== "test") {
			const now = Date.now();
			if (this._modelsCache && now - this._modelsCache.fetchedAt < SyntheticModelsService.MODELS_CACHE_TTL_MS) {
				return { models: this._modelsCache.models };
			}
		}
		try {
			// Fetch with timeout
			const controller = new AbortController();
			const timeoutId = setTimeout(() => controller.abort(), 10000); // 10 second timeout
			let response;
			try {
				response = await fetch(`${BASE_URL}/models`, {
					headers: {
						...(apiKey ? { Authorization: `Bearer ${apiKey}` } : {}),
						"User-Agent": this.userAgent,
					},
					signal: controller.signal,
				});
			} finally {
				clearTimeout(timeoutId);
			}
			if (!response.ok) {
				const errorText = await response.text();
				console.error("[Synthetic Model Provider] Failed to fetch Synthetic models", {
					status: response.status,
					statusText: response.statusText,
					detail: errorText,
				});

				// Emit user-friendly error message
				vscode.window.showInformationMessage(
					`Failed to fetch models from Synthetic (${response.status}): ${response.statusText || "Network error"}. Please check your API key and internet connection.`
				);

				throw new Error(
					`Failed to fetch Synthetic models: ${response.status}${response.statusText ? ` ${response.statusText}` : ""}${errorText ? `\n${errorText}` : ""}`
				);
			}

			// Fetch and PARSE the data using the schema
			const rawData = await response.json();
			const [err, data] = tryit(() => SyntheticModelsResponseSchema.parse(rawData))();
			if (err) {
				console.error("[Synthetic Model Provider] Model data validation failed:", err);

				// Emit user-friendly error message
				vscode.window.showInformationMessage(
					`Failed to parse model data from Synthetic API. The API response format may have changed. Please try again later.`
				);

				throw new Error(
					`Invalid API response format from Synthetic: ${err instanceof Error ? err.message : "Unknown validation error"}`
				);
			}

			const models = data?.data;
			if (!models || models.length === 0) {
				throw new Error("No models data found in validated API response");
			}
			// Update cache
			this._modelsCache = { models, fetchedAt: Date.now() };
			return { models };
		} catch (error) {
			if (error instanceof Error) {
				throw error;
			}
			throw error;
		}
	}

	/**
	 * Fetch model details from models.dev API with retries. Only one fetch runs at a time.
	 */
	private async _fetchModelDetailsFromApi(): Promise<void> {
		let response: Response | null = null;
		const maxRetries = 3;
		let attempt = 0;

		while (attempt < maxRetries) {
			try {
				const controller = new AbortController();
				const timeoutId = setTimeout(() => controller.abort(), 5000);

				response = await fetch("https://models.dev/api.json", {
					signal: controller.signal,
				});

				clearTimeout(timeoutId);

				if (!response.ok) {
					throw new Error(`HTTP error! status: ${response.status}`);
				}

				break;
			} catch (err) {
				attempt++;
				if (attempt >= maxRetries) {
					console.error("[Synthetic Model Provider] Failed to fetch model details after retries:", err);
					// Note: We don't emit user messages here since this is a fallback operation
					// and will be handled gracefully by returning null
					throw err;
				}
				// Optionally add a delay before retrying
				await new Promise((res) => setTimeout(res, 500 * attempt));
			}
		}

		const rawData = await response!.json();
		const [err, data] = tryit(() => SyntheticModelsDevApiResponseSchema.parse(rawData))();
		if (err) {
			console.error("[Synthetic Model Provider] Model details validation failed:", err);
			// Note: We don't emit user messages here since this is a fallback operation
			// and the main error handling in prepareLanguageModelChatInformation will handle user notification
			throw new Error(
				`Invalid model details API response format: ${err instanceof Error ? err.message : "Unknown validation error"}`
			);
		}

		this._modelDetailsCache = data.synthetic.models;
	}

	/**
	 * Build hydrated info from cached model details. Returns null if model not found or tool_call is false.
	 */
	private _buildHydratedInfo(modelId: string): Partial<import("vscode").LanguageModelChatInformation> | null {
		if (!this._modelDetailsCache) {
			return null;
		}

		const modelDetails = this._modelDetailsCache[modelId];

		if (!modelDetails) {
			return null;
		}

		// Filter out models where tool_call is false
		if (!modelDetails.tool_call) {
			return null;
		}

		// Map model details to LanguageModelChatInformation properties
		const capabilities: ExtendedCapabilities = {
			toolCalling: modelDetails.tool_call || false,
			imageInput: modelDetails.modalities?.input?.includes("image") || false,
			supportsThinking: modelDetails.reasoning || false,
		};

		const hydratedInfo: Partial<import("vscode").LanguageModelChatInformation> = {
			name: modelDetails.name,
			tooltip: modelDetails.name,
			family: "synthetic",
			version: "1.0.0",
			maxInputTokens: modelDetails.limit?.context || DEFAULT_CONTEXT_LENGTH,
			maxOutputTokens: modelDetails.limit?.output || DEFAULT_MAX_OUTPUT_TOKENS,
			capabilities,
		};

		return hydratedInfo;
	}

	/**
	 * Hydrate model information using the model details from https://models.dev/api.json
	 * @param modelId The model ID to hydrate
	 * @param huggingFaceId Optional Hugging Face model ID used as a fallback lookup.
	 *   Synthetic's friendly aliases (for example `syn:large:text`) are not listed
	 *   in models.dev, but their underlying Hugging Face model is.
	 * @returns The hydrated model information or null if not found or tool_call is false
	 */
	async hydrateModelId(
		modelId: string,
		huggingFaceId?: string
	): Promise<Partial<import("vscode").LanguageModelChatInformation> | null> {
		try {
			// If cache is already populated, just build info directly
			if (this._modelDetailsCache) {
				return this._buildHydratedInfoWithFallback(modelId, huggingFaceId);
			}

			// Use a lock promise so parallel calls don't all race to fetch
			if (!this._fetchingModelDetails) {
				// First call — start the fetch
				this._fetchingModelDetails = this._fetchModelDetailsFromApi();
			}

			// Wait for the fetch (first caller or subsequent callers)
			await this._fetchingModelDetails;
			this._fetchingModelDetails = null;

			return this._buildHydratedInfoWithFallback(modelId, huggingFaceId);
		} catch (error) {
			this._fetchingModelDetails = null;
			console.error("[Synthetic Model Provider] Failed to hydrate model ID:", modelId, error);
			return null;
		}
	}

	private _buildHydratedInfoWithFallback(
		modelId: string,
		huggingFaceId?: string
	): Partial<import("vscode").LanguageModelChatInformation> | null {
		const direct = this._buildHydratedInfo(modelId);
		if (direct) {
			return direct;
		}

		if (!huggingFaceId) {
			return null;
		}

		const fallbackId = huggingFaceId.startsWith("hf:") ? huggingFaceId : `hf:${huggingFaceId}`;
		return fallbackId === modelId ? null : this._buildHydratedInfo(fallbackId);
	}

	/**
	 * Get the list of available language models contributed by this provider
	 * @param secrets VS Code secret storage
	 * @param options Options which specify the calling context of this function
	 * @param token A cancellation token which signals if the user cancelled the request or not
	 * @returns A promise that resolves to the list of available language models
	 */
	async prepareLanguageModelChatInformation(
		secrets: vscode.SecretStorage,
		options: { silent: boolean },
		_token: CancellationToken
	): Promise<LanguageModelChatInformation[]> {
		// Model discovery does not require a key: Synthetic's /models endpoint is
		// public. Keeping discovery key-independent is important because VS Code
		// only exposes a provider to the model picker (and to the agent-host BYOK
		// bridge) once it has resolved at least one model for that vendor.
		const apiKey = await this.ensureApiKey(secrets, true);

		let models;
		try {
			const result = await this.fetchModels(apiKey);
			models = result.models;
		} catch (error) {
			console.error("[Synthetic Model Provider] Failed to prepare model information:", error);

			if (!options.silent) {
				const errorMessage = error instanceof Error ? error.message : "Unknown error occurred";
				vscode.window.showInformationMessage(
					`Unable to load Synthetic models: ${errorMessage}. Please check your API key and try again.`
				);
			}

			return [];
		}

		const infos: LanguageModelChatInformation[] = [];

		// Hydrate models in parallel for speed
		const hydrationPromises = models.map(async (m) => {
			try {
				// Try to hydrate model information. Friendly aliases (syn:*, infinite:*)
				// are not listed in models.dev, so fall back to their Hugging Face ID.
				const hydratedInfo = await this.hydrateModelId(m.id, m.hugging_face_id);

				// Use hydrated information if available, otherwise fall back to defaults
				const modelInfo = { ...DEFAULT_MODEL_DETAILS, ...hydratedInfo };

				const contextLen = m.context_length ?? modelInfo.maxInputTokens ?? DEFAULT_CONTEXT_LENGTH;
				const maxOutput = m.max_output_length ?? modelInfo.maxOutputTokens ?? DEFAULT_MAX_OUTPUT_TOKENS;

				// The Synthetic API is authoritative for capabilities. models.dev is a
				// fallback for metadata that the Synthetic API does not expose, and may
				// not know about newly added models at all.
				const supportsTools = m.supported_features?.includes("tools") ?? Boolean(modelInfo.capabilities?.toolCalling);
				const supportsImages = m.input_modalities?.includes("image") ?? Boolean(modelInfo.capabilities?.imageInput);
				const supportsThinking =
					m.supported_features?.includes("reasoning") === true ||
					m.reasoning_parameters !== undefined ||
					Boolean((modelInfo.capabilities as ExtendedCapabilities | undefined)?.supportsThinking);

				const capabilitiesFinal: ExtendedCapabilities = {
					toolCalling: supportsTools,
					imageInput: supportsImages,
					supportsThinking,
				};

				// Prefer the API's display name, then models.dev, then the raw id.
				const apiDisplayName = m.display_name && m.display_name !== m.id ? m.display_name : undefined;
				const hydratedName = modelInfo.name && modelInfo.name !== m.id ? modelInfo.name : undefined;
				const friendlyName = apiDisplayName ?? hydratedName ?? m.display_name ?? m.name ?? m.id;

				// Synthetic exposes both category aliases (syn:*, infinite:*) and the
				// concrete hf:* models they route to. Both are useful, but they often
				// share the same friendly name, which makes the picker look like it has
				// duplicates. Keep aliases labelled by their unique id and explain the
				// routing in the detail/tooltip; include the id in every detail so rows
				// with the same display name can still be told apart.
				const isCategoryAlias = m.id.startsWith("syn:") || m.id.startsWith("infinite:");
				const displayName = isCategoryAlias ? m.id : friendlyName;
				const tooltip = isCategoryAlias
					? `${m.id} — Synthetic category alias for ${friendlyName}`
					: friendlyName;
				const detail = isCategoryAlias ? `Synthetic · routes to ${friendlyName}` : `Synthetic · ${m.id}`;

				const modelInfo_final = {
					id: m.id,
					name: displayName,
					tooltip,
					detail,
					family: modelInfo.family || "synthetic",
					version: modelInfo.version || "1.0.0",
					maxInputTokens: contextLen || DEFAULT_CONTEXT_LENGTH,
					maxOutputTokens: maxOutput || DEFAULT_MAX_OUTPUT_TOKENS,
					capabilities: capabilitiesFinal,
				} satisfies LanguageModelChatInformation;

				infos.push(modelInfo_final);
			} catch (error) {
				console.error(`[Synthetic Model Provider] Failed to process model ${m.id}:`, error);
				// Skip models that can't be processed - don't add them to the list
			}
		});

		// Wait for all hydration to complete in parallel
		await Promise.allSettled(hydrationPromises);

		return infos;
	}
}
