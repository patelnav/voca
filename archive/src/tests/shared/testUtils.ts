import type { LinearGuid } from '@/types/linear-ids';

/**
 * Creates a mock LinearGuid from a string.
 * Useful for testing where a valid GUID string is needed but strict branding is not under test.
 * @param id The string to be cast to LinearGuid.
 * @returns The string cast as a LinearGuid.
 */
export function createMockGuid(id: string): LinearGuid {
  return id as any as LinearGuid; // Centralized casting
} 