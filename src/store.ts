import { randomUUID } from "node:crypto";
import { mkdir, readFile, readdir, rename, rm, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { DEFAULT_TARGET, type HandoffTarget } from "./context.ts";

export type HandoffTicketStatus = "accepted" | "target-created" | "invalidated" | "cancelled";

export interface HandoffTicket {
	version: 1;
	id: string;
	createdAt: string;
	updatedAt: string;
	status: HandoffTicketStatus;
	author: "agent" | "user";
	sourceSessionId: string;
	sourceSessionFile: string;
	sourceBoundaryEntryId: string;
	toolCallId?: string;
	message: string;
	userMessages: string[];
	targetSessionFile?: string;
	reason?: string;
}

interface StoredConfig {
	version: 1;
	target: HandoffTarget;
}

export interface HandoffStore {
	loadConfig(): Promise<StoredConfig>;
	saveTarget(target: HandoffTarget): Promise<void>;
	createTicket(ticket: HandoffTicket): Promise<void>;
	readTicket(id: string): Promise<HandoffTicket | undefined>;
	updateTicket(id: string, patch: Partial<Omit<HandoffTicket, "version" | "id">>): Promise<HandoffTicket>;
	removeTicket(id: string): Promise<void>;
	listTickets(): Promise<HandoffTicket[]>;
}

export function createStore(root = defaultStoreRoot()): HandoffStore {
	const configPath = join(root, "config.json");
	const ticketsDir = join(root, "tickets");

	return {
		async loadConfig() {
			try {
				const parsed = JSON.parse(await readFile(configPath, "utf8")) as Partial<StoredConfig>;
				if (parsed.version === 1 && isTarget(parsed.target)) return parsed as StoredConfig;
			} catch (error) {
				if (!isMissing(error)) throw error;
			}
			return { version: 1, target: DEFAULT_TARGET };
		},

		async saveTarget(target) {
			await atomicWriteJson(configPath, { version: 1, target } satisfies StoredConfig);
		},

		async createTicket(ticket) {
			try {
				await atomicWriteJson(ticketPath(ticketsDir, ticket.id), ticket);
			} catch (error) {
				throw new Error(`Could not persist handoff ticket ${ticket.id}: ${errorMessage(error)}`);
			}
		},

		async readTicket(id) {
			validateTicketId(id);
			try {
				return parseTicket(await readFile(ticketPath(ticketsDir, id), "utf8"));
			} catch (error) {
				if (isMissing(error)) return undefined;
				throw error;
			}
		},

		async updateTicket(id, patch) {
			const current = await this.readTicket(id);
			if (!current) throw new Error(`Handoff ticket not found: ${id}`);
			const updated: HandoffTicket = {
				...current,
				...patch,
				version: 1,
				id,
				updatedAt: new Date().toISOString(),
			};
			await atomicWriteJson(ticketPath(ticketsDir, id), updated);
			return updated;
		},

		async removeTicket(id) {
			validateTicketId(id);
			await rm(ticketPath(ticketsDir, id), { force: true });
		},

		async listTickets() {
			let names: string[];
			try {
				names = await readdir(ticketsDir);
			} catch (error) {
				if (isMissing(error)) return [];
				throw error;
			}

			const tickets: HandoffTicket[] = [];
			for (const name of names.filter((entry) => entry.endsWith(".json")).sort()) {
				try {
					tickets.push(parseTicket(await readFile(join(ticketsDir, name), "utf8")));
				} catch {
					// A malformed or partial external file is ignored; atomic writes never create one.
				}
			}
			return tickets.sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
		},
	};
}

export function newTicketId(): string {
	return randomUUID();
}

export function defaultStoreRoot(): string {
	const configRoot = process.env.PI_CODING_AGENT_DIR || join(homedir(), ".pi", "agent");
	return join(configRoot, "pi-session-handoff");
}

async function atomicWriteJson(path: string, value: unknown): Promise<void> {
	await mkdir(dirname(path), { recursive: true });
	const temporary = await writeTemporaryJson(path, value);
	try {
		await rename(temporary, path);
	} catch (error) {
		await rm(temporary, { force: true });
		throw error;
	}
}

async function writeTemporaryJson(path: string, value: unknown): Promise<string> {
	const temporary = `${path}.${process.pid}.${randomUUID()}.tmp`;
	await writeFile(temporary, `${JSON.stringify(value, null, 2)}\n`, { encoding: "utf8", flag: "wx", mode: 0o600 });
	return temporary;
}

function ticketPath(ticketsDir: string, id: string): string {
	validateTicketId(id);
	return join(ticketsDir, `${id}.json`);
}

function validateTicketId(id: string): void {
	if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(id)) {
		throw new Error("Invalid handoff ticket id.");
	}
}

function parseTicket(text: string): HandoffTicket {
	const value = JSON.parse(text) as Partial<HandoffTicket>;
	if (
		value.version !== 1 ||
		typeof value.id !== "string" ||
		typeof value.createdAt !== "string" ||
		typeof value.updatedAt !== "string" ||
		!isTicketStatus(value.status) ||
		(value.author !== "agent" && value.author !== "user") ||
		typeof value.sourceSessionId !== "string" ||
		typeof value.sourceSessionFile !== "string" ||
		typeof value.sourceBoundaryEntryId !== "string" ||
		(value.toolCallId !== undefined && typeof value.toolCallId !== "string") ||
		(value.author === "agent" && typeof value.toolCallId !== "string") ||
		typeof value.message !== "string" ||
		!Array.isArray(value.userMessages) ||
		!value.userMessages.every((message) => typeof message === "string") ||
		(value.targetSessionFile !== undefined && typeof value.targetSessionFile !== "string") ||
		(value.reason !== undefined && typeof value.reason !== "string")
	) {
		throw new Error("Invalid handoff ticket file.");
	}
	validateTicketId(value.id);
	return value as HandoffTicket;
}

function isTicketStatus(value: unknown): value is HandoffTicketStatus {
	return value === "accepted" || value === "target-created" || value === "invalidated" || value === "cancelled";
}

function isTarget(value: unknown): value is HandoffTarget {
	if (!value || typeof value !== "object") return false;
	const candidate = value as Partial<HandoffTarget>;
	return (
		(candidate.kind === "percent" && typeof candidate.value === "number" && candidate.value > 0 && candidate.value <= 100) ||
		(candidate.kind === "tokens" && typeof candidate.value === "number" && candidate.value >= 1_000)
	);
}

function isMissing(error: unknown): boolean {
	return !!error && typeof error === "object" && "code" in error && error.code === "ENOENT";
}

function errorMessage(error: unknown): string {
	return error instanceof Error ? error.message : String(error);
}
