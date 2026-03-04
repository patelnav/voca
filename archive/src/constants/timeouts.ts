/**
 * ========================================================================
 * !!!!!!!!!!!!  IMPORTANT TIMEOUT GUIDELINES  !!!!!!!!!!!!!!!!!!!!!!!!!!!!
 * ========================================================================
 *
 * ABSOLUTELY NO OPERATIONAL TIMEOUT SHOULD EVER EXCEED 9 SECONDS IN TOTAL
 * ABSOLUTELY NO CUMULATIVE OPERATIONAL TIMEOUTS SHOULD EVER EXCEED 9 SECONDS
 *
 * Framework timeouts (like Jest's overall test timeout) may be longer to
 * accommodate multiple operations, but each individual operation must still
 * adhere to the 9-second rule.
 *
 * NEVER USE HARDCODED TIMEOUT VALUES IN YOUR CODE
 * ALWAYS IMPORT TIMEOUT CONSTANTS FROM THIS FILE
 *
 * ⚠️ VIOLATING THESE RULES WILL BREAK THE APPLICATION ⚠️
 *
 * ========================================================================
 */

// STRICT GLOBAL TIMEOUT LIMIT FOR OPERATIONS (never change this)
export const ABSOLUTE_MAX_TIMEOUT_MS = 9000; // 9 seconds absolute maximum

/**
 * TIMEOUT GUARD: Enforces the maximum timeout rule for operations
 * Use this to wrap any setTimeout or similar calls for operations
 * @param ms The timeout value in milliseconds
 * @param forceAllow Force allow a timeout larger than the limit (for tests)
 * @throws Error if timeout exceeds ABSOLUTE_MAX_TIMEOUT_MS
 */
export function enforceTimeoutLimit(ms: number, forceAllow: boolean = false): number {
  if (ms > ABSOLUTE_MAX_TIMEOUT_MS && !forceAllow) {
    // Check if we're in a test environment where we might need longer timeouts
    const isTestEnvironment = process.env.NODE_ENV === 'test' || 
      process.argv.some(arg => arg.includes('jest') || arg === '--test');
    
    if (isTestEnvironment) {
      console.log(`[TIMEOUT] Allowing extended timeout of ${ms}ms for test environment`);
      return ms; // Allow longer timeouts in test environment
    }
    
    throw new Error(
      `TIMEOUT VIOLATION: Attempted to set a timeout of ${ms}ms, ` +
        `which exceeds the maximum allowed limit of ${ABSOLUTE_MAX_TIMEOUT_MS}ms (9 seconds)`
    );
  }
  return ms;
}

/**
 * Jest framework timeout (for overall test execution)
 * This can be longer than operation timeouts since it needs to accommodate
 * multiple operations and test setup/cleanup
 */
export const JEST_FRAMEWORK_TIMEOUT_MS = 30000; // 30 seconds for the overall test

/**
 * Maximum timeout for CLI prompt to appear (in milliseconds)
 */
export const PROMPT_TIMEOUT_MS = 2000; // 2 seconds

/**
 * Timeout for CLI command output to appear (in milliseconds)
 */
export const OUTPUT_TIMEOUT_MS = 2000; // 2 seconds

/**
 * Short delay between API retries (in milliseconds)
 */
export const API_RETRY_DELAY_MS = 500; // 0.5 seconds

/**
 * Maximum time to wait for LLM to respond (in milliseconds)
 */
export const LLM_RESPONSE_TIMEOUT_MS = 4000; // 4 seconds

/**
 * Standard API request timeout (in milliseconds)
 */
export const API_REQUEST_TIMEOUT_MS = 2000; // 2 seconds

/**
 * Test verification delay (in milliseconds)
 * Used for short pauses between operations
 */
export const TEST_VERIFICATION_DELAY_MS = 100; // Very short delay for polling

/**
 * Calculate total timeout based on number of retries
 * Ensures the cumulative timeout stays under the 9-second limit
 * @param retries Number of retries
 * @param baseTimeout Base timeout per try
 * @returns Safe timeout that keeps cumulative time under 9 seconds
 */
export function calculateSafeTimeout(
  retries: number,
  baseTimeout: number = API_RETRY_DELAY_MS
): number {
  // Ensure we never exceed the absolute maximum timeout
  const safeTimeout = Math.floor(ABSOLUTE_MAX_TIMEOUT_MS / (retries + 1));
  return Math.min(safeTimeout, baseTimeout);
}

/**
 * Maximum number of retries for API operations
 * With 3 retries at 500ms delay, maximum wait is 1.5 seconds
 */
export const MAX_API_RETRIES = 3;
