import { mkdtemp, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import piSessionHandoff from "../src/index.ts";
import * as handoffStore from "../src/store.ts";

const roots: string[] = [];
const originalConfigDir = process.env.PI_CODING_AGENT_DIR;

afterEach(async () => {
	vi.restoreAllMocks();
	if (originalConfigDir === undefined) delete process.env.PI_CODING_AGENT_DIR;
	else process.env.PI_CODING_AGENT_DIR = originalConfigDir;
	await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

async function setupExtension(toolCalls = [{ type: "toolCall", id: "handoff-call", name: "handoff", arguments: {} }]) {
	const root = await mkdtemp(join(tmpdir(), "pi-session-handoff-lifecycle-"));
	roots.push(root);
	process.env.PI_CODING_AGENT_DIR = root;
	const store = handoffStore.createStore();
	vi.spyOn(handoffStore, "createStore").mockReturnValue(store);

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

	return { root, store, tools, commands, handlers, messageRenderers, queued, customMessages, branch, sessionManager, toolContext, ui };
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

function deferred<T = void>() {
	let resolve!: (value: T | PromiseLike<T>) => void;
	const promise = new Promise<T>((done) => { resolve = done; });
	return { promise, resolve };
}

type State = Awaited<ReturnType<typeof setupExtension>>;

async function callHandoff(state: State, id: string, message = "Original accepted note.") {
	state.branch.push({
		type: "message", id: `assistant-${id}`, parentId: state.branch.at(-1)?.id,
		message: { role: "assistant", content: [{ type: "toolCall", id, name: "handoff", arguments: { message } }] },
	});
	const result = await state.tools.get("handoff").execute(id, { message }, undefined, undefined, state.toolContext);
	state.branch.push({
		type: "message", id: `result-${id}`, parentId: state.branch.at(-1)?.id,
		message: { role: "toolResult", toolCallId: id, toolName: "handoff", content: result.content },
	});
	return result;
}

function commandContext(state: State) {
	return {
		...state.toolContext,
		hasUI: true,
		isIdle: () => true,
		waitForIdle: vi.fn(async () => {}),
		hasPendingMessages: () => false,
		newSession: vi.fn(async (_options: any) => ({ cancelled: true })),
		ui: { ...state.ui, editor: vi.fn(async () => "User-written note.") },
	};
}

function commit(state: State, id: string, ctx: ReturnType<typeof commandContext>) {
	return state.commands.get("_pi-session-handoff-commit").handler(id, ctx);
}

describe("one pending handoff per extension instance", () => {
	it("reserves the session before ticket persistence yields", async () => {
		const state = await setupExtension();
		const saving = deferred();
		const create = state.store.createTicket.bind(state.store);
		const save = vi.spyOn(state.store, "createTicket").mockImplementation(async ticket => {
			await saving.promise;
			await create(ticket);
		});
		const first = callHandoff(state, "first");
		const duplicate = await callHandoff(state, "second", "Do not replace the first note.");
		expect(duplicate.terminate).toBe(true);
		expect(duplicate.content[0].text).toContain("already pending");
		expect(save).toHaveBeenCalledTimes(1);
		expect(state.queued).toHaveLength(0);
		saving.resolve();
		await first;
		expect(state.queued).toHaveLength(1);
		expect(await state.store.listTickets()).toMatchObject([{ message: "Original accepted note." }]);
	});

	it("deduplicates a monitor-triggered handoff and repeated commits while waiting for idle", async () => {
		const state = await setupExtension();
		const first = await callHandoff(state, "first");
		const idle = deferred();
		const ctx = commandContext(state);
		ctx.waitForIdle.mockImplementation(() => idle.promise);
		const delivered: string[] = [];
		ctx.newSession.mockImplementation(async options => {
			await options.setup({
				appendCustomEntry: () => {}, getSessionFile: () => "/sessions/target.jsonl",
			});
			await options.withSession({
				sendMessage: async (message: any) => { delivered.push(message.content); },
				sessionManager: { getBranch: () => [{ type: "message", message: { role: "assistant", stopReason: "stop" } }] },
				ui: state.ui,
			});
			return { cancelled: false };
		});
		const running = commit(state, first.details.handoffId, ctx);
		state.branch.push({ type: "custom_message", id: "monitor", customType: "pi-task-monitor", content: "Check task." });
		const second = await callHandoff(state, "second", "Later note that must not replace the accepted one.");
		expect(second.details.handoffId).toBe(first.details.handoffId);
		expect(second.terminate).toBe(true);
		await commit(state, first.details.handoffId, ctx);
		await commit(state, "00000000-0000-4000-8000-000000000002", ctx);
		expect(ctx.waitForIdle).toHaveBeenCalledTimes(1);
		expect(ctx.newSession).not.toHaveBeenCalled();
		expect(state.queued).toHaveLength(1);
		expect(await state.store.listTickets()).toHaveLength(1);
		idle.resolve();
		await running;
		expect(ctx.newSession).toHaveBeenCalledTimes(1);
		expect(delivered).toHaveLength(1);
		expect(delivered[0]).toContain("Original accepted note.");
		expect(delivered[0]).not.toContain("Later note");
		expect(await state.store.listTickets()).toHaveLength(0);
		await commit(state, first.details.handoffId, ctx);
		expect(ctx.newSession).toHaveBeenCalledTimes(1);
	});

	it("blocks another request throughout an in-progress replacement", async () => {
		const state = await setupExtension();
		const first = await callHandoff(state, "first");
		const entered = deferred();
		const finish = deferred();
		const ctx = commandContext(state);
		ctx.newSession.mockImplementation(async () => { entered.resolve(); await finish.promise; return { cancelled: true }; });
		const running = commit(state, first.details.handoffId, ctx);
		await entered.promise;
		await callHandoff(state, "second");
		await commit(state, first.details.handoffId, ctx);
		expect(state.queued).toHaveLength(1);
		expect(ctx.newSession).toHaveBeenCalledTimes(1);
		finish.resolve();
		await running;
	});

	it("does not open the editor or request another Agent note while a tool handoff is pending", async () => {
		const state = await setupExtension();
		await callHandoff(state, "first");
		const ctx = commandContext(state);
		await state.commands.get("handoff").handler("--write", ctx);
		await state.commands.get("handoff").handler("another focus", ctx);
		expect(ctx.ui.editor).not.toHaveBeenCalled();
		expect(state.customMessages).toHaveLength(0);
		expect(await state.store.listTickets()).toHaveLength(1);
	});

	it("reserves a direct-write request before waiting for idle and shares ownership with the tool", async () => {
		const state = await setupExtension();
		const idle = deferred();
		const ctx = commandContext(state);
		ctx.waitForIdle.mockImplementationOnce(() => idle.promise);
		const writing = state.commands.get("handoff").handler("--write", ctx);
		const duplicate = await callHandoff(state, "tool-during-write");
		expect(duplicate.terminate).toBe(true);
		expect(state.queued).toHaveLength(0);
		await state.commands.get("handoff").handler("--write", ctx);
		idle.resolve();
		await writing;
		expect(ctx.ui.editor).toHaveBeenCalledTimes(1);
		expect(ctx.newSession).toHaveBeenCalledTimes(1);
		expect(await state.store.listTickets()).toMatchObject([{ author: "user", message: "User-written note.", status: "cancelled" }]);
	});

	it("allows a new request after the direct-write editor is cancelled", async () => {
		const state = await setupExtension();
		const ctx = commandContext(state);
		ctx.ui.editor.mockResolvedValueOnce(undefined as any);
		await state.commands.get("handoff").handler("--write", ctx);
		await callHandoff(state, "after-cancel");
		expect(state.queued).toHaveLength(1);
		expect(ctx.newSession).not.toHaveBeenCalled();
	});

	it("allows retry after ticket persistence fails", async () => {
		const state = await setupExtension();
		vi.spyOn(state.store, "createTicket").mockRejectedValueOnce(new Error("disk full"));
		await expect(callHandoff(state, "failed")).rejects.toThrow("disk full");
		expect(state.queued).toHaveLength(0);
		await callHandoff(state, "retry");
		expect(state.queued).toHaveLength(1);
		expect(await state.store.listTickets()).toHaveLength(1);
	});

	it.each(["cancelled", "invalidated", "creation failed"])("releases ownership after commit is %s without allowing an old commit to steal the next request", async outcome => {
		const state = await setupExtension();
		const first = await callHandoff(state, "first");
		const ctx = commandContext(state);
		if (outcome === "invalidated") ctx.hasPendingMessages = () => true;
		if (outcome === "creation failed") {
			ctx.newSession.mockRejectedValueOnce(new Error("creation failed"));
			vi.spyOn(console, "error").mockImplementation(() => {});
		}
		await commit(state, first.details.handoffId, ctx);
		const second = await callHandoff(state, "retry");
		expect(second.details.handoffId).not.toBe(first.details.handoffId);
		ctx.hasPendingMessages = () => false;
		ctx.newSession.mockClear();
		await commit(state, first.details.handoffId, ctx);
		expect(ctx.newSession).not.toHaveBeenCalled();
		await commit(state, second.details.handoffId, ctx);
		expect(ctx.newSession).toHaveBeenCalledTimes(1);
	});

	it("keeps pending state local while the previous instance's replacement callback is still running", async () => {
		const source = await setupExtension();
		const first = await callHandoff(source, "first");
		const entered = deferred();
		const finish = deferred();
		const ctx = commandContext(source);
		ctx.newSession.mockImplementation(async () => { entered.resolve(); await finish.promise; return { cancelled: false }; });
		const running = commit(source, first.details.handoffId, ctx);
		await entered.promise;
		// Pi initializes a new extension factory for the replacement session.
		vi.restoreAllMocks();
		const target = await setupExtension();
		await callHandoff(target, "target-call");
		expect(target.queued).toHaveLength(1);
		finish.resolve();
		await running;
	});
});
