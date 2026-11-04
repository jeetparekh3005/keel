import react from "@vitejs/plugin-react";
import { defineConfig } from "vitest/config";

// jsdom gives the component tests a DOM; the setup file registers the
// jest-dom matchers. Tests are co-located as *.test.tsx next to the code.
export default defineConfig({
  plugins: [react()],
  test: {
    environment: "jsdom",
    globals: false,
    setupFiles: ["./vitest.setup.ts"],
    include: ["**/*.test.{ts,tsx}"],
  },
});
