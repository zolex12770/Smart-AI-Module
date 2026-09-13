import { and, eq, inArray, ne, sql } from "drizzle-orm";
import type { DrizzleDb } from "../client.js";
import {
  assets,
  auditLog,
  documents,
  organizationMembers,
  organizations,
  projectMembers,
  projects,
  users,
} from "../schema/index.js";

/**
 * Account and data deletion — NFR-008, docs/26_DECISIONS.md ADR-102, corrected by ADR-107 and
 * ADR-109.
 *
 * Content hangs off the PROJECT, not the user — the authorship columns are `onDelete: "set null"` —
 * so deleting the user row alone would leave every message and document behind with a null author.
 *
 * WHAT THIS DELETES, decided PER PROJECT:
 *
 *  - The organizations considered are every one the user can reach by EITHER route: an
 *    `organization_members` row, or a `project_members` row on one of its projects. ADR-107's version
 *    considered only the first, so when the last collaborator on a kept project deleted their account
 *    the organization was never looked at again, and its content outlived everyone who could reach it.
 *  - An organization with ANOTHER organization member is kept whole: any organization role reaches
 *    every project in it, so none of it is only this user's.
 *  - Otherwise each project is judged on its own. A project another user is a member of is kept; every
 *    other project is deleted with its content. ADR-107's version judged the organization as a unit, so
 *    one collaborator on ANY project kept a private project nobody else could reach — "alice's private
 *    diary" survived her deletion, ownerless and unreachable. If no project is kept, the organization
 *    goes too.
 *  - The user's memberships in everything that survives are removed, so their access ends at once.
 *  - `audit_log` rows are kept, as an audit trail must be, but scrubbed of personal data: `ip_address`
 *    is cleared and `email` is removed from `detail`, both on rows that name the user and on
 *    denied-login rows that recorded the address without a user id. An earlier comment here claimed
 *    "the row retains no personal data once the user is gone" while the rows kept every login IP.
 *  - The user row goes last, cascading sessions, API keys and personal memory items.
 *
 * STORAGE OBJECTS AND WORKSPACES ARE NOT REMOVED HERE. This package knows nothing about object
 * storage or the agent sandbox, so the deleted projects' asset paths and ids are RETURNED and the
 * caller removes the files and workspace directories after the commit. The database is committed
 * first on purpose: an orphaned file is a privacy problem an operator can finish from the returned
 * list, while rows pointing at files that are already gone would be a corrupt database.
 */
export interface DeletedAsset {
  id: string;
  projectId: string | null;
  storagePath: string;
}

export interface AccountDeletionResult {
  userId: string;
  /** Organizations deleted outright: no other member, and no project anyone else is a member of. */
  deletedOrganizationIds: string[];
  /** Every project deleted with its content, including private projects in organizations that survive. */
  deletedProjectIds: string[];
  /** Organizations kept because another user can still reach at least part of them. */
  retainedOrganizationIds: string[];
  /** Projects kept because another user is a member of them (or of their organization). */
  retainedProjectIds: string[];
  /** Storage objects the CALLER must now delete. Empty is a valid answer. */
  assets: DeletedAsset[];
}

export async function deleteUserAccount(db: DrizzleDb, userId: string): Promise<AccountDeletionResult> {
  return db.transaction(async (tx) => {
    const existing = await tx
      .select({ id: users.id, email: users.email })
      .from(users)
      .where(eq(users.id, userId))
      .limit(1);
    if (existing.length === 0) {
      throw new Error(`Cannot delete account "${userId}": no such user.`);
    }
    const email = existing[0].email;

    const viaOrganization = await tx
      .select({ organizationId: organizationMembers.organizationId })
      .from(organizationMembers)
      .where(eq(organizationMembers.userId, userId));
    const viaProject = await tx
      .select({ organizationId: projects.organizationId })
      .from(projectMembers)
      .innerJoin(projects, eq(projectMembers.projectId, projects.id))
      .where(eq(projectMembers.userId, userId));
    const orgIds = [...new Set([...viaOrganization, ...viaProject].map((r) => r.organizationId))];

    const deletedOrganizationIds: string[] = [];
    const retainedOrganizationIds: string[] = [];
    const deletedProjectIds: string[] = [];
    const retainedProjectIds: string[] = [];
    const deletedProjectsInRetainedOrgs: string[] = [];

    for (const orgId of orgIds) {
      const orgProjectIds = (
        await tx.select({ id: projects.id }).from(projects).where(eq(projects.organizationId, orgId))
      ).map((p) => p.id);

      const otherOrgMember = await tx
        .select({ userId: organizationMembers.userId })
        .from(organizationMembers)
        .where(and(eq(organizationMembers.organizationId, orgId), ne(organizationMembers.userId, userId)))
        .limit(1);
      if (otherOrgMember.length > 0) {
        retainedOrganizationIds.push(orgId);
        retainedProjectIds.push(...orgProjectIds);
        continue;
      }

      const keep: string[] = [];
      const doom: string[] = [];
      for (const projectId of orgProjectIds) {
        const otherProjectMember = await tx
          .select({ userId: projectMembers.userId })
          .from(projectMembers)
          .where(and(eq(projectMembers.projectId, projectId), ne(projectMembers.userId, userId)))
          .limit(1);
        (otherProjectMember.length > 0 ? keep : doom).push(projectId);
      }
      deletedProjectIds.push(...doom);
      retainedProjectIds.push(...keep);
      if (keep.length === 0) {
        deletedOrganizationIds.push(orgId);
      } else {
        retainedOrganizationIds.push(orgId);
        deletedProjectsInRetainedOrgs.push(...doom);
      }
    }

    let doomedAssets: DeletedAsset[] = [];
    if (deletedProjectIds.length > 0) {
      doomedAssets = await tx
        .select({ id: assets.id, projectId: assets.projectId, storagePath: assets.storagePath })
        .from(assets)
        .where(inArray(assets.projectId, deletedProjectIds));

      // Documents first. `documents.assetId` is the one foreign key in the schema with no cascade,
      // so a cascading delete of the project can reach `assets` while document rows still reference
      // them. Removing the referencing side explicitly makes the order deterministic.
      await tx.delete(documents).where(inArray(documents.projectId, deletedProjectIds));
    }
    if (deletedProjectsInRetainedOrgs.length > 0) {
      await tx.delete(projects).where(inArray(projects.id, deletedProjectsInRetainedOrgs));
    }
    if (deletedOrganizationIds.length > 0) {
      // One delete per organization set; the cascades remove projects and everything under them.
      await tx.delete(organizations).where(inArray(organizations.id, deletedOrganizationIds));
    }

    // Access to everything that outlives the user ends here.
    await tx.delete(organizationMembers).where(eq(organizationMembers.userId, userId));
    await tx.delete(projectMembers).where(eq(projectMembers.userId, userId));

    // The audit trail survives; the person's data in it does not (ADR-109).
    const scrubbed = { ipAddress: null, detail: sql`${auditLog.detail} - 'email'` };
    await tx.update(auditLog).set(scrubbed).where(eq(auditLog.userId, userId));
    await tx.update(auditLog).set(scrubbed).where(sql`${auditLog.detail} ->> 'email' = ${email}`);

    // Last: cascades sessions, API keys and memory items; nulls the authorship columns on anything
    // left in a project that survives.
    await tx.delete(users).where(eq(users.id, userId));

    return {
      userId,
      deletedOrganizationIds,
      deletedProjectIds,
      retainedOrganizationIds,
      retainedProjectIds,
      assets: doomedAssets,
    };
  });
}
