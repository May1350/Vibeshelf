// Permissive OSS licenses we allow into the marketplace.
// SPDX identifiers (lowercased) match what GitHub returns via the
// `license.spdx_id` field of the repo API. The allowlist is
// intentionally small: only licenses that permit commercial use,
// modification, and distribution with minimal compliance burden.
//
// Exclusions worth calling out:
//   - GPL-*, AGPL-*, LGPL-*: copyleft, poor fit for templates users fork
//   - MPL-*: file-level copyleft, too surprising for casual forkers
//   - CC-*: documentation licenses, not source code licenses
//   - Unlicense, WTFPL: legally ambiguous in many jurisdictions
export const ALLOWED_LICENSES = new Set([
  "mit",
  "apache-2.0",
  "bsd-2-clause",
  "bsd-3-clause",
  "0bsd",
]);

export function isLicenseAllowed(spdxId: string | null | undefined): boolean {
  if (!spdxId) return false;
  return ALLOWED_LICENSES.has(spdxId.toLowerCase());
}
