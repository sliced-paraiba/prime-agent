import { appendFileSync, existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
	buildSessionContext,
	loadEntriesFromFile,
	SessionManager,
	type SessionStateEntry,
} from "../../src/core/session-manager.js";
import { inactiveLifecycleForSession } from "../../src/modes/daemon/daemon-session-list.js";
import { assistantMsg, userMsg } from "../utilities.js";

describe("SessionManager session state", () => {
	it("persists lifecycle state and exposes it through list", async () => {
		const tempDir = mkdtempSync(join(tmpdir(), "session-state-"));
		try {
			const cwd = join(tempDir, "project");
			const sessionDir = join(tempDir, "sessions");
			const session = SessionManager.create(cwd, sessionDir);

			session.appendMessage(userMsg("hello"));
			session.appendMessage(assistantMsg("hi"));
			session.appendSessionState({ status: "crash" });

			const sessionFile = session.getSessionFile();
			expect(sessionFile).toBeDefined();
			expect(existsSync(sessionFile!)).toBe(true);

			const stateEntries = loadEntriesFromFile(sessionFile!).filter(
				(entry): entry is SessionStateEntry => entry.type === "session_state",
			);
			expect(stateEntries).toHaveLength(1);
			expect(stateEntries[0]!.state).toEqual({ status: "crash" });
			expect(session.getSessionState()).toEqual({ status: "crash" });

			const sessions = await SessionManager.list(cwd, sessionDir);
			expect(sessions).toHaveLength(1);
			expect(sessions[0]).toMatchObject({
				id: session.getSessionId(),
				state: { status: "crash" },
			});
		} finally {
			rmSync(tempDir, { recursive: true, force: true });
		}
	});

	it("flushes lifecycle state for sessions without assistant messages", async () => {
		const tempDir = mkdtempSync(join(tmpdir(), "session-state-empty-"));
		try {
			const cwd = join(tempDir, "project");
			const sessionDir = join(tempDir, "sessions");
			const session = SessionManager.create(cwd, sessionDir);

			session.appendSessionInfo("empty");
			session.appendSessionState({ status: "archived" });

			const sessionFile = session.getSessionFile();
			expect(sessionFile).toBeDefined();
			expect(existsSync(sessionFile!)).toBe(true);

			const sessions = await SessionManager.list(cwd, sessionDir);
			expect(sessions).toHaveLength(1);
			expect(sessions[0]).toMatchObject({
				id: session.getSessionId(),
				name: "empty",
				messageCount: 0,
				state: { status: "archived" },
			});
		} finally {
			rmSync(tempDir, { recursive: true, force: true });
		}
	});

	it("persists renamed sessions without assistant messages", async () => {
		const tempDir = mkdtempSync(join(tmpdir(), "session-state-rename-empty-"));
		try {
			const cwd = join(tempDir, "project");
			const sessionDir = join(tempDir, "sessions");
			const session = SessionManager.create(cwd, sessionDir);
			// Fork: the rename itself (session_info) creates the draft's file;
			// session_state bookkeeping no longer does.
			session.appendSessionInfo("Renamed draft");
			const sessionFile = session.getSessionFile();
			expect(sessionFile).toBeDefined();
			expect(existsSync(sessionFile!)).toBe(true);

			await expect(SessionManager.list(cwd, sessionDir)).resolves.toEqual([
				expect.objectContaining({ id: session.getSessionId(), name: "Renamed draft" }),
			]);
		} finally {
			rmSync(tempDir, { recursive: true, force: true });
		}
	});

	it("archives a deactivated session that has no prior state entry", async () => {
		const tempDir = mkdtempSync(join(tmpdir(), "session-state-deactivate-"));
		try {
			const cwd = join(tempDir, "project");
			const sessionDir = join(tempDir, "sessions");
			const session = SessionManager.create(cwd, sessionDir);
			session.appendMessage(userMsg("hello"));
			session.appendMessage(assistantMsg("hi"));
			const sessionFile = session.getSessionFile()!;

			const reopened = SessionManager.open(sessionFile, sessionDir);
			expect(reopened.getSessionState()).toBeUndefined();
			if (reopened.getSessionState()?.status !== "archived") {
				reopened.appendSessionState({ status: "archived" });
			}

			const sessions = await SessionManager.list(cwd, sessionDir);
			expect(sessions).toHaveLength(1);
			expect(sessions[0]!.state).toEqual({ status: "archived" });
			expect(inactiveLifecycleForSession(sessions[0]!)).toBe("archived");
		} finally {
			rmSync(tempDir, { recursive: true, force: true });
		}
	});

	// Guards the agents-view deactivate path: opening a deleted file and appending
	// would recreate a stub session at the old path, so the caller must skip it.
	// Fork: with lazy drafts the open+append of session_state no longer recreates
	// a stub at all, which makes the caller-side guard doubly safe.
	it("does not recreate a stub when archiving a deleted file (fork: lazy drafts)", async () => {
		const tempDir = mkdtempSync(join(tmpdir(), "session-state-deleted-"));
		try {
			const cwd = join(tempDir, "project");
			const sessionDir = join(tempDir, "sessions");
			const session = SessionManager.create(cwd, sessionDir);
			session.appendMessage(userMsg("hello"));
			session.appendMessage(assistantMsg("hi")); // forces a flush to disk
			const sessionFile = session.getSessionFile()!;
			rmSync(sessionFile);
			expect(existsSync(sessionFile)).toBe(false);

			// Fork: session_state bookkeeping never creates a missing file.
			SessionManager.open(sessionFile, sessionDir).appendSessionState({ status: "archived" });
			expect(existsSync(sessionFile)).toBe(false);

			// The guard the caller uses skips a missing file, leaving nothing behind.
			rmSync(sessionFile, { force: true });
			if (existsSync(sessionFile)) {
				SessionManager.open(sessionFile, sessionDir).appendSessionState({ status: "archived" });
			}
			expect(existsSync(sessionFile)).toBe(false);
		} finally {
			rmSync(tempDir, { recursive: true, force: true });
		}
	});

	it("coerces legacy sleep and hidden lifecycle state to archived on read", async () => {
		const tempDir = mkdtempSync(join(tmpdir(), "session-state-hidden-"));
		try {
			const cwd = join(tempDir, "project");
			const sessionDir = join(tempDir, "sessions");
			const session = SessionManager.create(cwd, sessionDir);

			session.appendMessage(userMsg("hide me"));
			session.appendMessage(assistantMsg("ok")); // forces a flush to disk
			// Append a state entry, then the legacy raw "sleep"/"hidden"
			// entries older daemons wrote; both must normalize to "archived" on read.
			session.appendSessionState({ status: "active" });
			const sessionFile = session.getSessionFile();
			expect(sessionFile).toBeDefined();
			appendFileSync(sessionFile!, `${JSON.stringify({ type: "session_state", state: { status: "sleep" } })}\n`);
			appendFileSync(sessionFile!, `${JSON.stringify({ type: "session_state", state: { status: "hidden" } })}\n`);

			expect(SessionManager.open(sessionFile!, sessionDir).getSessionState()).toEqual({ status: "archived" });

			const sessions = await SessionManager.list(cwd, sessionDir);
			expect(sessions).toHaveLength(1);
			expect(sessions[0]).toMatchObject({
				id: session.getSessionId(),
				state: { status: "archived" },
			});
		} finally {
			rmSync(tempDir, { recursive: true, force: true });
		}
	});

	it("falls back to the last valid status when the newest entry is unrecognized", async () => {
		const tempDir = mkdtempSync(join(tmpdir(), "session-state-bad-"));
		try {
			const cwd = join(tempDir, "project");
			const sessionDir = join(tempDir, "sessions");
			const session = SessionManager.create(cwd, sessionDir);

			session.appendMessage(userMsg("hi"));
			session.appendMessage(assistantMsg("hello")); // forces a flush to disk
			session.appendSessionState({ status: "active" });
			const sessionFile = session.getSessionFile();
			expect(sessionFile).toBeDefined();
			appendFileSync(sessionFile!, `${JSON.stringify({ type: "session_state", state: { status: "bogus" } })}\n`);

			expect(SessionManager.open(sessionFile!, sessionDir).getSessionState()).toEqual({ status: "active" });

			const sessions = await SessionManager.list(cwd, sessionDir);
			expect(sessions[0]).toMatchObject({ id: session.getSessionId(), state: { status: "active" } });
		} finally {
			rmSync(tempDir, { recursive: true, force: true });
		}
	});

	it("does not duplicate entries when lifecycle state is followed by a normal turn", async () => {
		const tempDir = mkdtempSync(join(tmpdir(), "session-state-turn-"));
		try {
			const cwd = join(tempDir, "project");
			const sessionDir = join(tempDir, "sessions");
			const session = SessionManager.create(cwd, sessionDir);

			session.appendSessionState({ status: "archived" });
			session.appendMessage(userMsg("hello"));
			session.appendMessage(assistantMsg("hi"));

			const sessionFile = session.getSessionFile();
			expect(sessionFile).toBeDefined();

			const entries = loadEntriesFromFile(sessionFile!);
			expect(entries.filter((entry) => entry.type === "session_state")).toHaveLength(1);
			expect(entries.filter((entry) => entry.type === "message")).toHaveLength(2);
		} finally {
			rmSync(tempDir, { recursive: true, force: true });
		}
	});

	it("does not create the session file for lifecycle state alone (fork: lazy drafts)", () => {
		// Fork behavior: session_state is daemon bookkeeping and must not create
		// the session file before the first assistant response, so launching the
		// TUI never leaves an empty draft file on disk.
		const tempDir = mkdtempSync(join(tmpdir(), "session-state-missing-dir-"));
		try {
			const cwd = join(tempDir, "project");
			const sessionDir = join(tempDir, "sessions");
			const session = SessionManager.create(cwd, sessionDir);
			const sessionFile = session.getSessionFile();
			expect(sessionFile).toBeDefined();

			session.appendSessionState({ status: "active" });
			expect(existsSync(sessionFile!)).toBe(false);

			// The skipped entry is still in memory and lands on disk with the
			// first real turn, recreating the directory if it went missing.
			rmSync(sessionDir, { recursive: true, force: true });
			session.appendMessage(userMsg("hello"));
			session.appendMessage(assistantMsg("hi"));

			expect(existsSync(sessionFile!)).toBe(true);
			const entries = loadEntriesFromFile(sessionFile!);
			expect(entries[0]).toMatchObject({ type: "session", id: session.getSessionId() });
			expect(entries.filter((entry) => entry.type === "session_state")).toHaveLength(1);
			expect(entries.filter((entry) => entry.type === "message")).toHaveLength(2);
		} finally {
			rmSync(tempDir, { recursive: true, force: true });
		}
	});

	it("rewrites the full session if the session file disappears after flushing", () => {
		const tempDir = mkdtempSync(join(tmpdir(), "session-state-missing-file-"));
		try {
			const cwd = join(tempDir, "project");
			const sessionDir = join(tempDir, "sessions");
			const session = SessionManager.create(cwd, sessionDir);

			session.appendMessage(userMsg("hello"));
			session.appendMessage(assistantMsg("hi"));
			const sessionFile = session.getSessionFile();
			expect(sessionFile).toBeDefined();
			expect(existsSync(sessionFile!)).toBe(true);

			rmSync(sessionFile!, { force: true });
			session.appendSessionState({ status: "archived" });

			const entries = loadEntriesFromFile(sessionFile!);
			expect(entries[0]).toMatchObject({ type: "session", id: session.getSessionId() });
			expect(entries.filter((entry) => entry.type === "message")).toHaveLength(2);
			expect(entries.filter((entry) => entry.type === "session_state")).toHaveLength(1);
		} finally {
			rmSync(tempDir, { recursive: true, force: true });
		}
	});
});
describe("SessionManager agent status", () => {
	it("persists the latest agent status append-only, per branch, and keeps it out of model context", () => {
		const tempDir = mkdtempSync(join(tmpdir(), "agent-status-"));
		try {
			const session = SessionManager.create(join(tempDir, "project"), join(tempDir, "sessions"));

			const m1 = session.appendMessage(userMsg("add a login endpoint"));
			const m2 = session.appendMessage(assistantMsg("done"));
			session.appendAgentStatus({ summary: "Working", taskState: undefined, basedOnMessageCount: 2 });
			session.appendAgentStatus({ summary: "Added login endpoint", taskState: "completed", basedOnMessageCount: 2 });

			// Latest entry wins.
			expect(session.getLatestAgentStatus()).toEqual({
				summary: "Added login endpoint",
				taskState: "completed",
				basedOnMessageCount: 2,
			});

			// Append-only: re-reading the raw file recovers both status entries and
			// the two conversation messages untouched.
			const entries = loadEntriesFromFile(session.getSessionFile()!);
			expect(entries.filter((entry) => entry.type === "agent_status")).toHaveLength(2);
			expect(entries.filter((entry) => entry.type === "message")).toHaveLength(2);

			// Status never reaches the model.
			const context = buildSessionContext(session.getEntries(), session.getLeafId());
			expect(context.messages).toHaveLength(2);
			expect(context.messages.every((message) => message.role === "user" || message.role === "assistant")).toBe(
				true,
			);

			// Branch A off m1, then branch B off m2 with a later status in the file.
			session.branch(m1);
			const branchAStatus = session.appendAgentStatus({ summary: "branch A", basedOnMessageCount: 1 });
			session.branch(m2);
			session.appendAgentStatus({ summary: "branch B", basedOnMessageCount: 1 });

			// Re-activating branch A reads its own status, not the later sibling entry.
			session.branch(branchAStatus);
			expect(session.getLatestAgentStatus()?.summary).toBe("branch A");
		} finally {
			rmSync(tempDir, { recursive: true, force: true });
		}
	});
});

describe("SessionManager.hasUserContent", () => {
	// createAgentSession writes the model/thinking/tier defaults for every new
	// session, so only edits made after creation count as real user content.
	const defaults = (s: SessionManager): void => {
		s.appendModelChange("anthropic", "claude-opus-4-8");
		s.appendThinkingLevelChange("off");
	};
	const cases: Array<{ name: string; setup: (session: SessionManager) => void; expected: boolean }> = [
		{
			name: "creation defaults only",
			setup: (s) => {
				defaults(s);
				s.appendServiceTierChange("default");
			},
			expected: false,
		},
		{ name: "no model available at creation", setup: (s) => s.appendThinkingLevelChange("off"), expected: false },
		{
			name: "model changed after creation",
			setup: (s) => {
				defaults(s);
				s.appendModelChange("openai", "gpt-5");
			},
			expected: true,
		},
		{
			name: "thinking level changed after creation",
			setup: (s) => {
				defaults(s);
				s.appendThinkingLevelChange("high");
			},
			expected: true,
		},
		{
			name: "thinking level changed on a no-model session",
			setup: (s) => {
				s.appendThinkingLevelChange("off");
				s.appendThinkingLevelChange("high");
			},
			expected: true,
		},
		{
			name: "Fast mode enabled after creation",
			setup: (s) => {
				defaults(s);
				s.appendServiceTierChange("default");
				s.appendServiceTierChange("priority");
			},
			expected: true,
		},
		{ name: "a message was sent", setup: (s) => s.appendMessage(userMsg("hello")), expected: true },
		{
			name: "the session was named",
			setup: (s) => {
				defaults(s);
				s.appendSessionInfo("my draft");
			},
			expected: true,
		},
	];

	it.each(cases)("is $expected for: $name", ({ setup, expected }) => {
		const tempDir = mkdtempSync(join(tmpdir(), "has-user-content-"));
		try {
			const session = SessionManager.create(join(tempDir, "project"), join(tempDir, "sessions"));
			setup(session);
			expect(session.hasUserContent()).toBe(expected);
		} finally {
			rmSync(tempDir, { recursive: true, force: true });
		}
	});
});
