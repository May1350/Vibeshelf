import nextPlugin from "@next/eslint-plugin-next"

const processEnvSelectors = [
  {
    selector: "MemberExpression[object.name='process'][property.name='env']",
    message: "Read env vars via `@/lib/env` only. Add new vars to the zod schema there.",
  },
  {
    selector: "MemberExpression[object.name='process'][computed=true][property.value='env']",
    message: "Read env vars via `@/lib/env` only (computed access is also banned).",
  },
]

export default [
  nextPlugin.configs.recommended,

  {
    files: ["**/*.{ts,tsx}"],
    ignores: ["lib/env.ts"],
    rules: {
      "no-restricted-syntax": ["error", ...processEnvSelectors],
    },
  },

  {
    files: ["lib/pipeline/**/*.ts"],
    rules: {
      "no-restricted-syntax": [
        "error",
        ...processEnvSelectors,
        {
          selector: "ExpressionStatement > Literal[value='use cache']",
          message: "DFL rule 9: 'use cache' directive forbidden inside lib/pipeline/.",
        },
        {
          selector: "ExpressionStatement > Literal[value='use server']",
          message: "DFL rule 9: 'use server' directive forbidden inside lib/pipeline/.",
        },
      ],
    },
  },

  {
    files: ["lib/pipeline/**/*.ts", "lib/types/**/*.ts"],
    rules: {
      "no-restricted-imports": [
        "error",
        {
          patterns: [
            { group: ["next", "next/*"], message: "Framework-free: use lib/types/ + plain TS only." },
            { group: ["react", "react-*"], message: "Framework-free: no React inside lib/pipeline or lib/types." },
          ],
        },
      ],
    },
  },
]
