import { defineConfig, globalIgnores } from "eslint/config";
import nextVitals from "eslint-config-next/core-web-vitals";
import nextTs from "eslint-config-next/typescript";

const eslintConfig = defineConfig([
  ...nextVitals,
  ...nextTs,
  // Every chart zooms through its container (components/charts/zoom.tsx).
  {
    files: ["app/**/*.{ts,tsx}", "components/**/*.{ts,tsx}"],
    ignores: ["components/charts/zoom.tsx"],
    rules: {
      "no-restricted-imports": ["error", {
        paths: [{ name: "recharts", importNames: ["ResponsiveContainer"], message: "Import ResponsiveContainer from @/components/charts/zoom — it makes the chart zoomable." }],
      }],
    },
  },
  // Override default ignores of eslint-config-next.
  globalIgnores([
    // Default ignores of eslint-config-next:
    ".next/**",
    "out/**",
    "build/**",
    "next-env.d.ts",
  ]),
]);

export default eslintConfig;
