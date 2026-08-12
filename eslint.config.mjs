import eslint from "@eslint/js";
import globals from "globals";
import nodePlugin from "eslint-plugin-n";
import tseslint from "typescript-eslint";

const typescriptFiles = ["packages/**/*.ts", "packaging/**/*.ts"];

export default [
  {
    ignores: [
      "**/.gitatlas/**",
      "**/fixtures/**",
      "**/test/repos/**",
      "coverage/**",
      "dist/**",
      "node_modules/**",
    ],
  },
  {
    ...eslint.configs.recommended,
    files: ["bin/gitatlas.js"],
    languageOptions: {
      ecmaVersion: "latest",
      sourceType: "commonjs",
      globals: globals.node,
    },
    plugins: { n: nodePlugin },
    rules: {
      ...eslint.configs.recommended.rules,
      "n/no-process-exit": "error",
    },
  },
  ...tseslint.configs.recommended.map((config) => ({ ...config, files: typescriptFiles })),
  {
    files: typescriptFiles,
    languageOptions: {
      parserOptions: {
        projectService: true,
        tsconfigRootDir: import.meta.dirname,
      },
      globals: globals.node,
    },
    plugins: { n: nodePlugin },
    rules: {
      "no-unused-vars": "off",
      "@typescript-eslint/no-explicit-any": "off",
      "@typescript-eslint/no-require-imports": "off",
      "@typescript-eslint/no-floating-promises": "error",
      "@typescript-eslint/no-misused-promises": "error",
      "@typescript-eslint/no-unused-vars": ["error", {
        argsIgnorePattern: "^_",
        caughtErrorsIgnorePattern: "^_",
      }],
      "@typescript-eslint/restrict-template-expressions": ["error", {
        allowBoolean: true,
        allowNullish: true,
        allowNumber: true,
      }],
      "n/no-process-exit": "error",
    },
  },
  {
    files: ["packages/**/test/**/*.ts", "packaging/test/**/*.ts"],
    rules: {
      "@typescript-eslint/no-floating-promises": "off",
    },
  },
  {
    files: ["bin/gitatlas.js", "packages/*/src/cli.ts"],
    rules: {
      "n/no-process-exit": "off",
    },
  },
];
