import type { CoordinationDatabase } from "../db/index.js";

export type MessagingDatabase = Pick<
  CoordinationDatabase,
  "readOne" | "readAll" | "mutateWithEvent"
>;

export function isSqliteConstraint(error: unknown): boolean {
  return error instanceof Error && "code" in error &&
    String(error.code).startsWith("SQLITE_CONSTRAINT");
}
