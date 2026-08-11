/**
 * Where Navigator conversations are shown, and where they deliberately are not.
 *
 * The rule is presentation-only: a Navigator thread is an ordinary durable
 * thread and stays synchronized, routable and intact. It just must not turn up
 * in a coding list, a coding search, or the fallback that decides which thread
 * to open — landing in a planning-only conversation because it happened to be
 * the newest thread would be an accident, not a feature.
 */
import { describe, expect, it } from "vite-plus/test";

import {
  codingThreadsOnly,
  groupNavigatorThreadsByProject,
  isNavigatorThread,
  navigatorThreadsOnly,
  threadPurposeOf,
} from "./navigatorThreads";

const thread = (input: {
  readonly id: string;
  readonly projectId?: string;
  readonly environmentId?: string;
  readonly purpose?: "coding" | "navigator";
  readonly updatedAt?: string;
  readonly archivedAt?: string | null;
}) => ({
  id: input.id,
  projectId: input.projectId ?? "project-1",
  environmentId: input.environmentId ?? "env-1",
  updatedAt: input.updatedAt ?? "2026-01-01T00:00:00.000Z",
  archivedAt: input.archivedAt ?? null,
  ...(input.purpose === undefined ? {} : { purpose: input.purpose }),
});

const project = (id: string, environmentId = "env-1") => ({
  id,
  environmentId,
  title: `Project ${id}`,
});

describe("thread purpose", () => {
  it("treats a shell with no purpose as a coding thread", () => {
    // An older server sends no purpose at all. Reading that as "not coding"
    // would make every existing thread disappear from the sidebar at once.
    const legacy = thread({ id: "thread-legacy" });
    expect(threadPurposeOf(legacy)).toBe("coding");
    expect(isNavigatorThread(legacy)).toBe(false);
  });
});

describe("coding lists", () => {
  const threads = [
    thread({ id: "coding-1", purpose: "coding" }),
    thread({ id: "legacy-1" }),
    thread({ id: "navigator-1", purpose: "navigator" }),
  ];

  it("excludes Navigator conversations without touching anything else", () => {
    expect(codingThreadsOnly(threads).map((entry) => entry.id)).toEqual(["coding-1", "legacy-1"]);
    // Filtering is a view. The source list is unchanged — nothing archived,
    // retitled or dropped from the durable record.
    expect(threads.map((entry) => entry.id)).toEqual(["coding-1", "legacy-1", "navigator-1"]);
  });

  it("cannot hand a Navigator thread to a coding fallback", () => {
    // The fallback picks the first of whatever it is given, so the guarantee
    // is that the Navigator thread is never in that list — even when it is
    // the only thread left.
    expect(codingThreadsOnly([thread({ id: "navigator-only", purpose: "navigator" })])).toEqual([]);
  });

  it("keeps the Navigator conversations for the surface that wants them", () => {
    expect(navigatorThreadsOnly(threads).map((entry) => entry.id)).toEqual(["navigator-1"]);
  });
});

describe("navigator landing groups", () => {
  it("lists every project, including ones with no conversation yet", () => {
    const groups = groupNavigatorThreadsByProject(
      [project("project-1"), project("project-2")],
      [thread({ id: "navigator-1", purpose: "navigator" })],
    );
    expect(groups.map((group) => group.project.id)).toEqual(["project-1", "project-2"]);
    expect(groups[1]?.conversations).toEqual([]);
  });

  it("keeps every conversation a project has, newest first", () => {
    // A project can have more than one line of thinking open. Choosing one on
    // the owner's behalf would hide the others.
    const groups = groupNavigatorThreadsByProject(
      [project("project-1")],
      [
        thread({ id: "older", purpose: "navigator", updatedAt: "2026-01-01T00:00:00.000Z" }),
        thread({ id: "newer", purpose: "navigator", updatedAt: "2026-01-02T00:00:00.000Z" }),
      ],
    );
    expect(groups[0]?.conversations.map((entry) => entry.id)).toEqual(["newer", "older"]);
  });

  it("shows only Navigator conversations, and only active ones", () => {
    const groups = groupNavigatorThreadsByProject(
      [project("project-1")],
      [
        thread({ id: "coding", purpose: "coding" }),
        thread({ id: "legacy" }),
        thread({ id: "archived", purpose: "navigator", archivedAt: "2026-01-03T00:00:00.000Z" }),
        thread({ id: "active", purpose: "navigator" }),
      ],
    );
    expect(groups[0]?.conversations.map((entry) => entry.id)).toEqual(["active"]);
  });

  it("does not mix projects or environments", () => {
    const groups = groupNavigatorThreadsByProject(
      [project("project-1", "env-1"), project("project-1", "env-2")],
      [
        thread({ id: "in-env-1", purpose: "navigator", environmentId: "env-1" }),
        thread({ id: "in-env-2", purpose: "navigator", environmentId: "env-2" }),
      ],
    );
    expect(groups[0]?.conversations.map((entry) => entry.id)).toEqual(["in-env-1"]);
    expect(groups[1]?.conversations.map((entry) => entry.id)).toEqual(["in-env-2"]);
  });
});
