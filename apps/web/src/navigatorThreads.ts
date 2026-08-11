/**
 * Which threads are Navigator conversations, and where each list gets to see them.
 *
 * A Navigator thread is an ordinary durable thread with `purpose: "navigator"`,
 * synchronized exactly like any other. It is only its *presentation* that
 * differs: it does not belong in the coding-thread sidebar, in coding search
 * results, or in the fallback that picks "the thread to open" — landing in a
 * planning-only conversation because it happened to be the most recent thread
 * would be a confusing accident, not a feature.
 *
 * Nothing here deletes, archives, retitles or transforms anything. These are
 * filters over a list, and the same threads stay reachable from `/navigator`,
 * from a direct chat URL, and from the durable record.
 *
 * @module NavigatorThreads
 */
import type { ThreadPurpose } from "@t3tools/contracts";

/**
 * The purpose of a thread-like value, defaulting to `coding`.
 *
 * Written as a default rather than a required read so a shell decoded from an
 * older server — which had no `purpose` at all — is treated as the coding
 * thread it is, instead of vanishing from every list at once.
 */
export function threadPurposeOf(thread: { readonly purpose?: ThreadPurpose }): ThreadPurpose {
  return thread.purpose ?? "coding";
}

export function isNavigatorThread(thread: { readonly purpose?: ThreadPurpose }): boolean {
  return threadPurposeOf(thread) === "navigator";
}

/** Everything an ordinary coding list, search or fallback may consider. */
export function codingThreadsOnly<T extends { readonly purpose?: ThreadPurpose }>(
  threads: ReadonlyArray<T>,
): ReadonlyArray<T> {
  return threads.filter((thread) => !isNavigatorThread(thread));
}

/** Everything the Navigator landing lists. */
export function navigatorThreadsOnly<T extends { readonly purpose?: ThreadPurpose }>(
  threads: ReadonlyArray<T>,
): ReadonlyArray<T> {
  return threads.filter((thread) => isNavigatorThread(thread));
}

export interface NavigatorProjectGroup<TProject, TThread> {
  readonly project: TProject;
  /** Newest first. Every one of them: none is silently chosen or dropped. */
  readonly conversations: ReadonlyArray<TThread>;
}

/**
 * Active Navigator conversations, grouped under the project they belong to.
 *
 * Every project is listed even with no conversations yet — starting the first
 * one is the main thing the landing surface is for. A project can legitimately
 * have several Navigator conversations; all of them are listed, in most-recent
 * order, rather than the surface picking one on the owner's behalf.
 */
export function groupNavigatorThreadsByProject<
  TProject extends { readonly id: string; readonly environmentId: string },
  TThread extends {
    readonly projectId: string;
    readonly environmentId: string;
    readonly updatedAt: string;
    readonly id: string;
    readonly archivedAt?: string | null;
    readonly purpose?: ThreadPurpose;
  },
>(
  projects: ReadonlyArray<TProject>,
  threads: ReadonlyArray<TThread>,
): ReadonlyArray<NavigatorProjectGroup<TProject, TThread>> {
  const active = navigatorThreadsOnly(threads).filter(
    (thread) => thread.archivedAt === null || thread.archivedAt === undefined,
  );
  return projects.map((project) => ({
    project,
    conversations: active
      .filter(
        (thread) =>
          thread.projectId === project.id && thread.environmentId === project.environmentId,
      )
      .toSorted(
        (left, right) =>
          right.updatedAt.localeCompare(left.updatedAt) || left.id.localeCompare(right.id),
      ),
  }));
}
