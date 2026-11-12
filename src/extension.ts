import * as vscode from "vscode";
import { SyntheticChatModelProvider } from "./provider";
import { showTemperatureConfigUI } from "./config";

export async function activate(context: vscode.ExtensionContext) {
	// Build a descriptive User-Agent to help quantify API usage.
	// Keep UA minimal: only extension id/version and VS Code version.
	const extVersion = context.extension.packageJSON.version ?? "unknown";
	const ua = `${context.extension.id}/${extVersion} VSCode/${vscode.version}`;

	const provider = new SyntheticChatModelProvider(context.secrets, ua);
	context.subscriptions.push(provider);

	// Register the Synthetic provider under the vendor id used in package.json
	context.subscriptions.push(vscode.lm.registerLanguageModelChatProvider("synthetic", provider));

	// Prefetch models in the BACKGROUND (non-blocking), then notify VS Code.
	// VS Code caches the models it resolves for a provider, and the agent-host
	// BYOK bridge only reads that cache. Firing onDidChangeLanguageModelChatInformation
	// makes VS Code resolve us immediately, so the provider shows up in the model
	// picker and agent-host sessions without first opening Manage Models.
	provider
		.prefetchModels()
		.catch((err) => {
			console.warn("[Synthetic Model Provider] Model prefetch failed (will retry on demand):", err);
		})
		.finally(() => provider.refresh());

	// Keep multiple VS Code windows in sync when the key is changed elsewhere.
	context.subscriptions.push(
		context.secrets.onDidChange((event) => {
			if (event.key === "synthetic.apiKey") {
				provider.refresh();
			}
		})
	);

	// Management command to configure API key
	context.subscriptions.push(
		vscode.commands.registerCommand("synthetic.manage", async () => {
			const existing = await context.secrets.get("synthetic.apiKey");
			const apiKey = await vscode.window.showInputBox({
				title: "Synthetic API Key",
				prompt: existing ? "Update your Synthetic API key" : "Enter your Synthetic API key",
				ignoreFocusOut: true,
				password: true,
				value: existing ?? "",
			});
			if (apiKey === undefined) {
				return; // user canceled
			}
			if (!apiKey.trim()) {
				await context.secrets.delete("synthetic.apiKey");
				provider.refresh();
				vscode.window.showInformationMessage("Synthetic API key cleared.");
				return;
			}
			await context.secrets.store("synthetic.apiKey", apiKey.trim());
			provider.refresh();
			vscode.window.showInformationMessage("Synthetic API key saved.");
		})
	);

	// Command to configure model temperature
	context.subscriptions.push(
		vscode.commands.registerCommand("synthetic.configureTemperature", async () => {
			await showTemperatureConfigUI(context.secrets);
		})
	);
}

export function deactivate() {}
