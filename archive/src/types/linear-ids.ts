import crypto from 'crypto';

/**
 * Type definitions for working with Linear IDs in a type-safe way
 * This helps prevent mixing different ID types and ensures type safety
 */

/**
 * Represents Linear's native friendly identifier
 * Examples: "ABC-123", "LIN-456"
 */
export type LinearFriendlyId = string & { readonly __brand: 'linearFriendly' };

/**
 * Represents a Linear project slug ID
 * Examples: "14964d0d51d6"
 */
export type ProjectSlugId = string & { readonly __brand: 'projectSlug' };

/**
 * Represents a Linear UUID that can be used in GraphQL operations
 * Example: "12345678-1234-1234-1234-123456789012"
 */
export type LinearGuid = string & { readonly __brand: 'linearGuid' };

/**
 * Represents a temporary friendly ID for entities not yet in Linear
 * Examples: "TMP-123", "TMP-456"
 */
export type TemporaryFriendlyId = string & { readonly __brand: 'temporaryFriendly' };

/**
 * Represents a temporary UUID for entities not yet in Linear
 * Example: "temp-12345678-1234-1234-1234-123456789012"
 */
export type TemporaryGuid = string & { readonly __brand: 'temporaryGuid' };

/**
 * Union type for all friendly IDs (Linear or Temporary)
 */
export type FriendlyId = LinearFriendlyId | TemporaryFriendlyId;

/**
 * Union type for all GUIDs (Linear or Temporary)
 */
export type Guid = LinearGuid | TemporaryGuid;

/**
 * Type guard to check if an ID is a Linear friendly identifier
 * @param id Any string ID
 * @returns Whether the ID is a Linear friendly identifier
 */
export function isLinearFriendlyId(id: string): id is LinearFriendlyId {
  return /^[A-Z]+-\d+$/i.test(id) && !id.toUpperCase().startsWith('TMP-');
}

/**
 * Type guard to check if an ID is a valid Linear GUID
 * @param id Any string ID
 * @returns Whether the ID is a valid Linear GUID
 */
export function isLinearGuid(id: string): id is LinearGuid {
  return /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(id) && 
         !id.startsWith('temp-');
}

/**
 * Type guard to check if an ID is a temporary friendly identifier
 * @param id Any string ID
 * @returns Whether the ID is a temporary friendly identifier
 */
export function isTemporaryFriendlyId(id: string): id is TemporaryFriendlyId {
  return /^TMP-\d+$/i.test(id);
}

/**
 * Type guard to check if an ID is a temporary GUID
 * @param id Any string ID
 * @returns Whether the ID is a temporary GUID
 */
export function isTemporaryGuid(id: string): id is TemporaryGuid {
  return /^temp-[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(id);
}

/**
 * Type guard to check if an ID is any kind of friendly ID
 * @param id Any string ID
 * @returns Whether the ID is any kind of friendly ID
 */
export function isFriendlyId(id: string): id is FriendlyId {
  return isLinearFriendlyId(id) || isTemporaryFriendlyId(id);
}

/**
 * Type guard to check if an ID is any kind of GUID
 * @param id Any string ID
 * @returns Whether the ID is any kind of GUID
 */
export function isGuid(id: string): id is Guid {
  return isLinearGuid(id) || isTemporaryGuid(id);
}

/**
 * Type guard to check if an ID is temporary (either temporary friendly or temporary GUID)
 * @param id Any string ID
 * @returns Whether the ID is temporary
 */
export function isTemporary(id: string): boolean {
  return isTemporaryFriendlyId(id) || isTemporaryGuid(id);
}

/**
 * Safely cast a string to a LinearFriendlyId when you're certain it's valid
 * @param id String ID to cast
 * @returns The ID as a LinearFriendlyId
 */
export function asLinearFriendlyId(id: string): LinearFriendlyId {
  if (!isLinearFriendlyId(id)) {
    throw new Error(`Invalid Linear Friendly ID: ${id}. Must be in format ABC-123.`);
  }
  return id as LinearFriendlyId;
}

/**
 * Safely cast a string to a LinearGuid when you're certain it's valid
 * @param id String ID to cast
 * @returns The ID as a LinearGuid
 */
export function asLinearGuid(id: string): LinearGuid {
  if (!isLinearGuid(id)) {
    throw new Error(`Invalid Linear GUID: ${id}. Must be a valid UUID.`);
  }
  return id as LinearGuid;
}

/**
 * Safely cast a string to a TemporaryFriendlyId when you're certain it's valid
 * @param id String ID to cast
 * @returns The ID as a TemporaryFriendlyId
 */
export function asTemporaryFriendlyId(id: string): TemporaryFriendlyId {
  if (!isTemporaryFriendlyId(id)) {
    throw new Error(`Invalid Temporary Friendly ID: ${id}. Must be in format TMP-123.`);
  }
  return id as TemporaryFriendlyId;
}

/**
 * Safely cast a string to a TemporaryGuid when you're certain it's valid
 * @param id String ID to cast
 * @returns The ID as a TemporaryGuid
 */
export function asTemporaryGuid(id: string): TemporaryGuid {
  if (!isTemporaryGuid(id)) {
    throw new Error(`Invalid Temporary GUID: ${id}. Must be in format temp-UUID.`);
  }
  return id as TemporaryGuid;
}

/**
 * Create a new temporary friendly ID with the given number
 * @param number The number to use
 * @returns A new temporary friendly ID
 */
export function createTemporaryFriendlyId(number: number): TemporaryFriendlyId {
  return `TMP-${number}` as TemporaryFriendlyId;
}

/**
 * Create a new temporary GUID
 * @returns A new temporary GUID
 */
export function createTemporaryGuid(): TemporaryGuid {
  const uuid = crypto.randomUUID();
  return `temp-${uuid}` as TemporaryGuid;
}

/**
 * Type guard to check if an ID is a project slug ID
 * @param id Any string ID
 * @returns Whether the ID is a project slug ID
 */
export function isProjectSlugId(id: string): id is ProjectSlugId {
  return /^[a-f0-9]+$/.test(id);
}

/**
 * Safely cast a string to a ProjectSlugId when you're certain it's valid
 * @param id String ID to cast
 * @returns The ID as a ProjectSlugId
 */
export function asProjectSlugId(id: string): ProjectSlugId {
  if (!isProjectSlugId(id)) {
    throw new Error(`Invalid Project Slug ID: ${id}. Must be a hexadecimal string.`);
  }
  return id as ProjectSlugId;
} 