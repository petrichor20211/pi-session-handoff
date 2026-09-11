import { mkdtemp, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import piSessionHandoff from "../src/index.ts";

const roots: string[] = [];
const originalConfigDir = process.env.PI_CODING_AGENT_DIR;

afterEach(async () => {
	if (originalConfigDir === undefined) delete process.env.PI_CODING_AGENT_DIR;
	else process.env.PI_CODING_AGENT_DIR = originalConfigDir;
	await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

async function setupExtension(toolCalls = [{ type: "toolCall", id: "handoff-call", name: "handoff", arguments: {} }]) {
	const root = await mkdtemp(join(tmpdir(), "pi-session-handoff-lifecycle-"));
	roots.push(root);
	process.env.PI_CODING_AGENT_DIR = root;

	const tools = new Map<string, any>();
	const commands = new Map<string, any>();
	const handlers = new Map<string, any>();
	const messageRenderers = new Map<string, any>();
	const queued: Array<{ content: string; options: unknown }> = [];
	const customMessages: Array<{ message: any; options: unknown }> = [];
	const pi = {
		registerTool: (tool: any) => tools.set(tool.name, tool),
		registerCommand: (name: string, command: any) => commands.set(name, command),
		registerMessageRenderer: (name: string, renderer: any) => messageRenderers.set(name, renderer),
		on: (name: string, handler: any) => handlers.set(name, handler),
		sendUserMessage: (content: string, options: unknown) => queued.push({ content, options }),
		sendMessage: (message: any, options: unknown) => customMessages.push({ message, options }),
	};
	await piSessionHandoff(pi as any);

	const branch: any[] = [
		{
			type: "message",
			id: "user-entry",
			parentId: null,
			timestamp: new Date().toISOString(),
			message: { role: "user", content: [{ type: "text", text: "Preserve this exact user request." }] },
		},
		{
			type: "message",
			id: "assistant-entry",
			parentId: "user-entry",
			timestamp: new Date().toISOString(),
			message: { role: "assistant", content: toolCalls },
		},
	];
	const sessionManager = {
		getSessionFile: () => "/sessions/source.jsonl",
		getSessionId: () => "source-session",
		getBranch: () => branch,
		getEntries: () => branch,
		getLeafId: () => branch.at(-1)?.id ?? null,
	};
	const ui = { notify: vi.fn() };
	const toolContext = { sessionManager, ui };

	return { root, tools, commands, handlers, messageRenderers, queued, customMessages, branch, sessionManager, toolContext, ui };
}

describe("replacement lifecycle", () => {
	it("asks the Agent through a provenance-marked custom message, not a synthetic user message", async () => {
		const state = await setupExtension();
		await state.commands.get("handoff").handler("preserve the API", {
			...state.toolContext,
			isIdle: () => true,
		});
		expect(state.queued).toEqual([]);
		expect(state.customMessages).toHaveLength(1);
		expect(state.customMessages[0]).toMatchObject({
			message: {
				customType: "pi-handoff-request",
				details: { version: 1, focus: "preserve the API" },
			},
			options: { triggerTurn: true },
		});
	});

	it("uses one terminating handoff call, then delivers the note through the fresh session context", async () => {
		const state = await setupExtension();
		const result = await state.tools.get("handoff").execute(
			"handoff-call",
			{ message: "Continue with the focused regression test." },
			undefined,
			undefined,
			state.toolContext,
		);
		expect(result.terminate).toBe(true);
		expect(state.queued).toHaveLength(1);
		expect(state.queued[0]?.options).toEqual({ deliverAs: "followUp", expandPromptTemplates: true });

		const match = state.queued[0]?.content.match(/^\/_pi-session-handoff-commit ([0-9a-f-]+)$/);
		expect(match).not.toBeNull();
		const ticketId = match![1]!;
		state.branch.push({
			type: "message",
			id: "result-entry",
			parentId: "assistant-entry",
			timestamp: new Date().toISOString(),
			message: { role: "toolResult", toolCallId: "handoff-call", toolName: "handoff" },
		});

		const originEntries: Array<{ type: string; data: unknown }> = [];
		const delivered: Array<{ message: any; options: unknown }> = [];
		const targetBranch = [
			{
				type: "message",
				id: "target-assistant",
				message: { role: "assistant", content: [{ type: "text", text: "Continuing." }], stopReason: "stop" },
			},
		];
		const commandContext = {
			...state.toolContext,
			waitForIdle: vi.fn(async () => undefined),
			hasPendingMessages: () => false,
			newSession: vi.fn(async (options: any) => {
				expect(options.parentSession).toBe("/sessions/source.jsonl");
				await options.setup({
					appendCustomEntry: (type: string, data: unknown) => originEntries.push({ type, data }),
					getSessionFile: () => "/sessions/target.jsonl",
				});
				await options.withSession({
					sendMessage: async (message: any, deliveryOptions: unknown) => {
						delivered.push({ message, options: deliveryOptions });
					},
					sessionManager: { getBranch: () => targetBranch },
					ui: state.ui,
				});
				return { cancelled: false };
			}),
		};
		await state.commands.get("_pi-session-handoff-commit").handler(ticketId, commandContext);

		expect(commandContext.newSession).toHaveBeenCalledTimes(1);
		expect(originEntries).toEqual([
			{
				type: "pi-handoff-origin",
				data: { version: 1, handoffId: ticketId, sourceSessionFile: "/sessions/source.jsonl" },
			},
		]);
		expect(delivered).toHaveLength(1);
		expect(delivered[0]?.message.customType).toBe("pi-handoff-note");
		expect(delivered[0]?.message.content).toContain("Continue with the focused regression test.");
		expect(delivered[0]?.message.content).toContain("Preserve this exact user request.");
		expect(delivered[0]?.message.details).toMatchObject({
			version: 2,
			authoredBy: "agent",
			taskState: "Continue with the focused regression test.",
		});
		expect(delivered[0]?.options).toEqual({ triggerTurn: true });
		expect(await readdir(join(state.root, "pi-session-handoff", "tickets"))).toEqual([]);
	});

	it("does not queue a switch for a mixed tool batch", async () => {
		const state = await setupExtension([
			{ type: "toolCall", id: "read-call", name: "read", arguments: { path: "README.md" } },
			{ type: "toolCall", id: "handoff-call", name: "handoff", arguments: {} },
		]);
		await expect(
			state.tools.get("handoff").execute(
				"handoff-call",
				{ message: "Continue later." },
				undefined,
				undefined,
				state.toolContext,
			),
		).rejects.toThrow("only tool call");
		expect(state.queued).toEqual([]);
	});
});
