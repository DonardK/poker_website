/** @type {import('jest').Config} */
module.exports = {
  testEnvironment: "node",
  preset: "ts-jest/presets/default-esm",
  extensionsToTreatAsEsm: [".ts"],
  testMatch: ["**/__tests__/**/*.test.ts"],
  moduleNameMapper: {
    "^(\\.{1,2}/.*)\\.js$": "$1",
    "^@poker/shared$": "<rootDir>/../shared/src/index.ts",
  },
  transform: {
    "^.+\\.tsx?$": [
      "ts-jest",
      {
        useESM: true,
        tsconfig: {
          module: "ESNext",
          moduleResolution: "bundler",
          esModuleInterop: true,
          strict: true,
          target: "ES2022",
        },
      },
    ],
  },
};
