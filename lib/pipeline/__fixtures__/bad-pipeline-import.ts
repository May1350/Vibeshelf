// This file MUST fail dep-cruiser and ESLint.
// If it passes, a boundary rule is broken.
// Excluded from tsconfig via __fixtures__ pattern.
import { cookies } from "next/headers";

export const dummy = cookies;
