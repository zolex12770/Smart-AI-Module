import { and, eq, inArray, ne } from "drizzle-orm";
import type { DrizzleDb } from "../client.js";
import {
  assets,
  documents,
  organizationMembers,
  organizations,
  projectMembers,
  projects,
  users,
} from "../schema/index.js";

/**
 * Account and data deletion — NFR-008, docs/26_DECISIONS.md ADR-102.
 *
 * WHAT WAS MISSING. There was no way to delete an account or its data: no route, no CLI, no
 * repository call, and no way even to suspend one. NFR-008 is a P1 privacy requirement
 * ("a deletion request removes rows/objects across all owning tables and buckets") and it was
 * not merely unimplemented but unreachable, while the status document claimed "P1 remaining: 0".
 *
 * AND IT IS NOT ACHIEVABLE BY DELETING THE USER ROW. Content does not hang off the user: it
 * hangs off the PROJECT. `conversations`, `tasks`, `documents`, `image_generations`,
 * `video_projects` and `usage_records` all carry `createdByUserId` with
 * `onDelete: "set null"` — deliberately, so an audit trail survives a departing colleague — so
 * deleting the user would leave every message, document and generated asset in place with a null
 * author. The honest unit of deletion is the organization, which cascades to projects and from
 * there to everything.
 *
 * WHAT THIS DELETES, and what it deliberately does not:
 *
 *  - Organizations where this user is the ONLY member cascade away entirely: projects,
 *    conversations, messages, tasks, nodes, transitions, documents, chunks, memory, assets,
 *    image and video rows, usage records.
 *  - Organizations with OTHER members keep their content — it is not this user's to destroy —
 *    and the user's memberships are removed so their access ends immediately.
 *  - The user row goes last, cascading sessions, API keys and personal memory items.
 *  - `audit_log` rows survive with a null user id. A deletion record that deletes itself is not
 *    an audit trail, and the row retains no personal data once the user is gone.
 *
 * STORAGE OBJECTS ARE NOT DELETED HERE. This package knows nothing about object storage, so the
 * asset rows' storage paths are RETURNED and the caller removes the files. The database is
 * committed first on purpose: an orphaned file is a privacy problem an operator can finish by
 * hand from the returned list, while rows pointing at files that are already gone would be a
 * corrupted database nobody can repair.
 */
export interface DeletedAsset {
  id: string;
  projectId: string | null;
  storagePath: string;
}

export interface AccountDeletionResult {
  userId: string;
  /** Organizations deleted outright, because this user was their only member. */
  deletedOrganizationIds: string[];
  /** Projects that went with them. */
  deletedProjectIds: string[];
  /** Organizations kept because someone else is still a member; the user's access was removed. */
  retainedOrganizationIds: string[];
  /** Storage objects the CALLER must now delete. Empty is a valid answer. */
  assets: DeletedAsset[];
}

export async function deleteUserAccount(db: DrizzleDb, userId: string): Promise<AccountDeletionResult> {
  return db.transaction(async (tx) => {
    const existing = await tx.select({ id: users.id }).from(users).where(eq(users.id, userId)).limit(1);
    if (existing.length === 0) {
      throw new Error(`Cannot delete account "${userId}": no such user.`);
    }

    const memberships = await tx
      .select({ organizationId: organizationMembers.organizationId })
      .from(organizationMembers)
      .where(eq(organizationMembers.userId, userId));
    const orgIds = [...new Set(memberships.map((m) => m.organizationId))];

    const soleOwned: string[] = [];
    const shared: string[] = [];
    for (const orgId of orgIds) {
      // Anyone else at all, not "any other owner": an organization with a second member is not
      // this user's to destroy whatever their roles are.
      const others = await tx
        .select({ userId: organizationMembers.userId })
        .from(organizationMembers)
        .where(and(eq(organizationMembers.organizationId, orgId), ne(organizationMembers.userId, userId)))
        .limit(1);
      (others.length === 0 ? soleOwned : shared).push(orgId);
    }

    let doomedProjectIds: string[] = [];
    let doomedAssets: DeletedAsset[] = [];
    if (soleOwned.length > 0) {
      doomedProjectIds = (
        await tx.select({ id: projects.id }).from(projects).where(inArray(projects.organizationId, soleOwned))
      ).map((p) => p.id);

      if (doomedProjectIds.length > 0) {
        doomedAssets = await tx
          .select({ id: assets.id, projectId: assets.projectId, storagePath: assets.storagePath })
          .from(assets)
          .where(inArray(assets.projectId, doomedProjectIds));

        // Documents first. `documents.assetId` is the one foreign key in the schema with no
        // cascade, so a single cascading delete of the project can reach `assets` while document
        // rows still reference them. Removing the referencing side explicitly makes the order
        // deterministic instead of relying on the engine's choice.
        await tx.delete(documents).where(inArray(documents.projectId, doomedProjectIds));
      }

      // One delete; the cascades do the rest. Enumerating twenty child tables here would go
      // stale the day someone adds the twenty-first, and the schema already states the shape.
      await tx.delete(organizations).where(inArray(organizations.id, soleOwned));
    }

    // Access to organizations that outlive the user ends here.
    if (shared.length > 0) {
      await tx.delete(organizationMembers).where(
        and(eq(organizationMembers.userId, userId), inArray(organizationMembers.organizationId, shared))
      );
      await tx.delete(projectMembers).where(eq(projectMembers.userId, userId));
    }

    // Last: cascades sessions, API keys and memory items; nulls the authorship columns on
    // anything left in an organization that survives.
    await tx.delete(users).where(eq(users.id, userId));

    return {
      userId,
      deletedOrganizationIds: soleOwned,
      deletedProjectIds: doomedProjectIds,
      retainedOrganizationIds: shared,
      assets: doomedAssets,
    };
  });
}
