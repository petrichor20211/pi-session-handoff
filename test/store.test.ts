import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { createStore, newTicketId, type HandoffTicket } from "../src/store.ts";

const roots: string[] = [];

afterEach(async () => {
	await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

async function temporaryStore() {
	const root = await mkdtemp(join(tmpdir(), "pi-session-handoff-"));
	roots.push(root);
	return { root, store: createStore(root) };
}

function ticket(): HandoffTicket {
	const now = new Date().toISOString();
	return {
		version: 1,
		id: newTicketId(),
		createdAt: now,
		updatedAt: now,
		status: "accepted",
		author: "agent",
		sourceSessionId: "source-id",
		sourceSessionFile: "/sessions/source.jsonl",
		sourceBoundaryEntryId: "entry-id",
		toolCallId: "tool-call-id",
		message: "Continue safely.",
		userMessages: ["First user message.", "Second user message."],
	};
}

describe("handoff store", () => {
	it("defaults to a 35% advisory target and persists changes", async () => {
		const { root, store } = await temporaryStore();
		expect((await store.loadConfig()).target).toEqual({ kind: "percent", value: 35 });
		await store.saveTarget({ kind: "tokens", value: 80_000 });
		expect((await store.loadConfig()).target).toEqual({ kind: "tokens", value: 80_000 });
		expect(JSON.parse(await readFile(join(root, "config.json"), "utf8"))).toMatchObject({ version: 1 });
	});

	it("creates, updates, lists, and removes a small durable ticket", async () => {
		const { store } = await temporaryStore();
		const value = ticket();
		await store.createTicket(value);
		expect(await store.readTicket(value.id)).toEqual(value);

		const updated = await store.updateTicket(value.id, {
			status: "target-created",
			targetSessionFile: "/sessions/target.jsonl",
		});
		expect(updated.status).toBe("target-created");
		expect(await store.listTickets()).toHaveLength(1);

		await store.removeTicket(value.id);
		expect(await store.readTicket(value.id)).toBeUndefined();
	});
});
