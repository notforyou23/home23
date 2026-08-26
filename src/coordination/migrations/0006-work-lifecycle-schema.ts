// M11's reviewed schema delta lands through the M04 migration owner here.
// Importing the immutable SQL avoids a second, drifting definition.
export { WORK_SCHEMA_DELTA_SQL as WORK_LIFECYCLE_SCHEMA_MIGRATION_SQL } from "../work/schema-delta.js";
