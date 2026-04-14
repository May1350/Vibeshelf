// Intentionally violates Foundation rule F4 (pipeline jobs must use
// ctx.db, not createServiceClient directly). dep-cruiser's
// pipeline-jobs-use-ctx-db-only rule flags this import.
// Part of the `lint:neg:depcruise` npm script to prove the rule is
// alive — this file cruised in isolation MUST fail.

import { createServiceClient } from "@/lib/db/service-client";

export const _BAD_IMPORT_VIOLATION_FIXTURE = createServiceClient;
