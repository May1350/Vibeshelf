// This file MUST fail ESLint no-restricted-syntax.
// If it passes, DFL rule 5 is broken.
const x = process.env.SOME_VAR;
export const dummy = x;
