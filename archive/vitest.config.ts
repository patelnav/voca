import { defineConfig } from 'vitest/config';
import path from 'path'; // Import path module

export default defineConfig({
  test: {
    // Vitest configuration options
    globals: true, // Use global APIs (describe, test, expect, etc.) without imports
    environment: 'node', // Specify the test environment
    testTimeout: 15000, // Increase timeout to 15 seconds
    // Include test files matching these patterns
    include: ['src/tests/unit/**/*.spec.ts', 'src/tests/e2e/**/*.spec.ts'], // Scan specific test directories
    // Exclude Playwright E2E tests
    exclude: [
      '**/node_modules/**', 
      '**/dist/**', 
      'src/tests/playwright/**'
    ],
    isolate: true, // Run each test file in isolation
    // Setup file (optional, for global setup like loading env vars)
    // setupFiles: ['./src/tests/setup.ts'],
    // Configure thread options for parallel execution
    // threads: true, // Enabled by default
    // isolate: false, // Run tests within the same worker process (can speed up but risks state leakage if not careful)
    // reporters: ['verbose'], // Default reporter is good, 'verbose' adds more detail
  },
  // Add resolve configuration for path aliases
  resolve: {
    alias: {
      '@': path.resolve(__dirname, './src'),
      // You might need the @tests alias later if you have tests outside src
      '@tests': path.resolve(__dirname, './src/tests'), 
    },
  },
}); 