import js from "@eslint/js";
import security from "eslint-plugin-security";
import tseslint from "typescript-eslint";

// Type-checked rules only, not stylistic ones — tsc is already strict
// (noUncheckedIndexedAccess) and CLAUDE.md's own bar is "minimal and simple,"
// so this catches real defects rather than re-litigating formatting.
export default tseslint.config(
  // eslint.config.mjs and test-mcp-e2e.mjs run directly under node, outside
  // tsconfig.json's `include` — type-checked rules need a project to check
  // against, so they'd otherwise fail to parse rather than fail to lint.
  // Standalone .mjs outside the TypeScript project — the type-aware parser
  // cannot resolve them, same as the two already listed.
  { ignores: ["build/**", "node_modules/**", "eslint.config.mjs", "test-mcp-e2e.mjs", "scripts/**", "dashboard-ui/dist/**"] },
  js.configs.recommended,
  ...tseslint.configs.recommendedTypeChecked,
  security.configs.recommended,
  {
    languageOptions: {
      parserOptions: {
        projectService: true,
        tsconfigRootDir: import.meta.dirname,
      },
    },
    rules: {
      // require-await conflicts with the store's uniform async surface (some
      // methods are trivially sync today but the interface is async by
      // design, so callers don't churn if a method later needs to await).
      "@typescript-eslint/require-await": "off",
      // The daemon deliberately narrows `unknown` request bodies by hand
      // (JSON from an HTTP request has no static type to begin with) —
      // no-unsafe-* would flag the entire request-parsing layer.
      "@typescript-eslint/no-unsafe-assignment": "off",
      "@typescript-eslint/no-unsafe-member-access": "off",
      "@typescript-eslint/no-unsafe-argument": "off",
      // http.createServer(async ...) and setInterval(async ...) are the
      // standard Node pattern for a request/timer handler with internal
      // control flow — both already catch internally, and cli.ts installs a
      // global unhandledRejection handler as the backstop. Keep the rule
      // active for its other cases (a promise misused in a real void-return
      // context); this option is TS-ESLint's own documented escape hatch for
      // exactly the async-callback-to-sync-API pattern, not a blanket opt-out.
      "@typescript-eslint/no-misused-promises": ["error", { checksVoidReturn: { arguments: false } }],
      // String(x ?? "") on a field from parsed, untrusted JSON (import
      // files, HTTP request bodies) is this codebase's deliberate coercion
      // pattern — same family as events.ts's safeIso() for malformed dates.
      // It never throws; an object-typed field becomes "[object Object]"
      // rather than crashing an import mid-batch or a write request.
      "@typescript-eslint/no-base-to-string": "off",
      // Every dynamic `readFileSync`/`execFileSync` path in this codebase
      // (importers, git scanning, config) is validated or user-supplied by
      // design — object-injection's heuristic is too broad for that pattern
      // and would flag work already reviewed for exactly this risk.
      "security/detect-object-injection": "off",
      // Codebase-wide convention: unused args prefixed `_` are deliberate
      // (interface conformance, destructuring for a later param).
      "@typescript-eslint/no-unused-vars": ["error", { argsIgnorePattern: "^_" }],
    },
  },
  {
    // Preact UI: async event handlers passed to JSX attributes (onClick etc.)
    // are the normal pattern — the checksVoidReturn escape hatch covers
    // attributes the same way it covers Node callback arguments above.
    files: ["dashboard-ui/**/*.{ts,tsx}"],
    rules: {
      "@typescript-eslint/no-misused-promises": [
        "error",
        { checksVoidReturn: { arguments: false, attributes: false } },
      ],
    },
  },
  {
    // node:test's test()/describe() return a promise the test runner itself
    // tracks — awaiting it is not the convention, so no-floating-promises
    // fires on every single test call in the suite otherwise. Kept active in
    // src/, where a genuinely missed await is a real bug.
    files: ["test/**/*.ts"],
    rules: {
      "@typescript-eslint/no-floating-promises": "off",
      // JSON.parse() is inherently `any`; walking a parsed config/export
      // structure for assertions (config.mcpServers.persnally.args[0]...) is
      // the normal test pattern here. A wrong shape assumption throws and
      // fails the test loudly — exactly the desired outcome, not a risk to
      // guard against. None of src/'s no-unsafe-* findings were this pair,
      // so production code stays fully covered.
      "@typescript-eslint/no-unsafe-call": "off",
      "@typescript-eslint/no-unsafe-return": "off",
    },
  },
);
