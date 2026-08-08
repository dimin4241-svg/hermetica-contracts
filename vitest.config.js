/// <reference types="vitest" />

import { defineConfig } from "vitest/config";
import { vitestSetupFilePath, getClarinetVitestsArgv } from "@stacks/clarinet-sdk/vitest";

export default defineConfig({
  test: {
    include: ['tests/**/*.{test,spec}.{js,ts}'],
    environment: "clarinet",
    pool: "forks",
    // Clarinet resets simnet state between tests. Vitest v4's supported
    // configuration is one worker with isolation disabled rather than the
    // legacy top-level `singleFork` option used by this repository.
    isolate: false,
    maxWorkers: 1,
    setupFiles: [vitestSetupFilePath],
    environmentOptions: {
      clarinet: {
        ...getClarinetVitestsArgv(),
      },
    },
    hookTimeout: 180000,
    testTimeout: 180000,
  },
});
