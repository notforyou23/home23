export class CoordinationWriterBusyError extends Error {
  readonly databasePath: string;

  constructor(databasePath: string) {
    super(`coordination product-writer lock is held or unavailable: ${databasePath}`);
    this.name = "CoordinationWriterBusyError";
    this.databasePath = databasePath;
  }
}

export class SchemaCompatibilityError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "SchemaCompatibilityError";
  }
}

export class DatabaseIntegrityError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "DatabaseIntegrityError";
  }
}
