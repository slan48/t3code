/**
 * The Navigator landing surface, as a pure component.
 *
 * Projects, and the Navigator conversations that already exist under each.
 * Everything it renders comes from orchestration project and thread shells —
 * the same durable data the coding sidebar reads. It asks Peer Loop nothing:
 * no status, no run list, no subscription, no command. Opening this page must
 * not spawn the bridge, and the surest way to guarantee that is for the module
 * to have no way to reach it.
 *
 * Execution — turning an agreed proposal into a Peer Loop run — is a later
 * increment. This one is the conversation.
 *
 * @module NavigatorLandingView
 */
import { Link } from "@tanstack/react-router";
import { memo } from "react";

import { Button } from "../ui/button";
import type { NavigatorProjectGroup } from "~/navigatorThreads";

export interface NavigatorProject {
  readonly id: string;
  readonly environmentId: string;
  readonly title: string;
}

export interface NavigatorConversation {
  readonly id: string;
  readonly environmentId: string;
  readonly projectId: string;
  readonly title: string;
  readonly updatedAt: string;
  readonly archivedAt?: string | null;
  readonly purpose?: "coding" | "navigator";
}

export type NavigatorLandingGroups = ReadonlyArray<
  NavigatorProjectGroup<NavigatorProject, NavigatorConversation>
>;

export const NavigatorLandingView = memo(function NavigatorLandingView({
  groups,
  connected,
  loading,
  onStartConversation,
}: {
  readonly groups: NavigatorLandingGroups;
  readonly connected: boolean;
  readonly loading: boolean;
  readonly onStartConversation: (project: NavigatorProject) => void;
}) {
  if (!connected) {
    return (
      <p role="status" className="text-sm text-muted-foreground">
        Not connected to an environment. Navigator conversations live with your projects, so this
        list fills in once a connection is back.
      </p>
    );
  }

  if (loading) {
    return (
      <p role="status" className="text-sm text-muted-foreground">
        Reading your projects…
      </p>
    );
  }

  if (groups.length === 0) {
    return (
      <p className="text-sm text-muted-foreground">
        No projects yet. Add one and Navigator can help you plan work in it.
      </p>
    );
  }

  return (
    <div className="flex min-w-0 flex-col gap-6">
      <p className="text-sm text-muted-foreground">
        Navigator is a planning conversation. It discusses approaches and keeps a proposed plan; it
        does not change your repository.
      </p>

      {groups.map(({ project, conversations }) => (
        <section
          key={`${project.environmentId}:${project.id}`}
          className="flex min-w-0 flex-col gap-2"
        >
          <div className="flex min-w-0 flex-wrap items-center justify-between gap-2">
            <h2 className="truncate text-sm font-medium text-foreground">{project.title}</h2>
            <Button size="xs" variant="outline" onClick={() => onStartConversation(project)}>
              New Navigator conversation
            </Button>
          </div>

          {conversations.length === 0 ? (
            <p className="text-xs text-muted-foreground">No Navigator conversations yet.</p>
          ) : (
            <ul className="flex min-w-0 flex-col gap-1.5">
              {/*
                Every conversation, newest first. A project may legitimately
                have more than one line of thinking open, and picking one on
                the owner's behalf would hide the others.
              */}
              {conversations.map((conversation) => (
                <li key={`${conversation.environmentId}:${conversation.id}`} className="min-w-0">
                  <Link
                    to="/$environmentId/$threadId"
                    params={{
                      environmentId: conversation.environmentId,
                      threadId: conversation.id,
                    }}
                    className="flex min-w-0 items-center gap-2 rounded-md border px-3 py-2 text-left transition-colors hover:bg-accent/50"
                  >
                    <span className="truncate text-sm text-foreground">{conversation.title}</span>
                  </Link>
                </li>
              ))}
            </ul>
          )}
        </section>
      ))}
    </div>
  );
});
