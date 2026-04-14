// Intentionally violates `no-marketplace-imports-pipeline` rule.
// dep-cruiser cruising this file in isolation MUST fail.
import { echoJob } from "@/lib/pipeline/jobs/echo";

export const _BAD_MARKETPLACE_PIPELINE_FIXTURE = echoJob;
