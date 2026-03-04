import { type LinearClient } from '@linear/sdk';
import { 
  type LinearFriendlyId, 
  type LinearGuid, 
  isLinearGuid,
  isLinearFriendlyId,
  asLinearGuid
} from '@/types/linear-ids';
import { EnrichmentError } from '@/linear/enrichment';

/**
 * Resolves a potentially friendly Linear ID (e.g., "TEAM-123") to its corresponding GUID.
 * If the input is already a GUID, it's returned directly.
 * Throws an error if the ID format is invalid or the entity is not found.
 * Uses EnrichmentError for resolution failures.
 * 
 * @param client - The LinearClient instance.
 * @param identifier - The ID to resolve (LinearGuid, LinearFriendlyId, or potentially a temporary string).
 * @param entityName - The name of the entity type (e.g., "issue", "project") for error messages.
 * @returns The resolved Linear GUID.
 */
export async function resolveFriendlyIdToGuid(
  client: LinearClient,
  identifier: LinearGuid | LinearFriendlyId | string,
  entityName: string = 'entity' // Default entity name for generic messages
): Promise<LinearGuid> {
  // Check if it's already a GUID
  if (isLinearGuid(identifier)) {
    return identifier;
  }

  // If it's a friendly ID, resolve it
  if (isLinearFriendlyId(identifier)) {
    console.log(`Resolving friendly ID ${identifier} to GUID for ${entityName}`);
    try {
      // Extract the entity number from the friendly ID (e.g., "TEAM-123" -> 123)
      // This assumes a standard "PREFIX-NUMBER" format. Adjust if needed for other entities.
      const idParts = identifier.split('-');
      if (idParts.length !== 2) {
        throw new EnrichmentError(`Invalid ${entityName} friendly identifier format: ${identifier}. Expected PREFIX-NUMBER.`);
      }
      
      const entityNumber = parseInt(idParts[1], 10);
      if (isNaN(entityNumber)) {
        throw new EnrichmentError(`Invalid ${entityName} number in identifier: ${identifier}`);
      }

      // Query Linear API based on entity type (currently only supports issue numbers)
      // TODO: Extend this to support other entity types like projects if needed
      let guid: LinearGuid | undefined;

      if (entityName === 'issue') {
        const issues = await client.issues({
          filter: {
            number: { eq: entityNumber },
            // Optionally add team key filter if available/necessary
            // team: { key: { eq: idParts[0] } } // If API supports this
          }
        });
        if (!issues || !issues.nodes || issues.nodes.length === 0) {
          // Try searching across all teams if team-specific fails or isn't specified?
          throw new EnrichmentError(`Issue with identifier ${identifier} not found.`);
        }
        // TODO: Handle multiple matches? Usually number should be unique within team.
        guid = asLinearGuid(issues.nodes[0].id);

      } else if (entityName === 'project') {
        // NOTE: As of current SDK knowledge, filtering projects by team key and number 
        // directly via filter is not supported. The primary method is direct fetch by friendly ID.
        // TODO: Revisit project friendly ID resolution if Linear API/SDK adds better filtering options.

        console.log(`Attempting to resolve project friendly ID ${identifier} via direct fetch.`);

        // Attempt: Direct fetch using the friendly ID (client.project might handle TEAM-123)
        try {
          const project = await client.project(identifier);
          if (project) {
            guid = asLinearGuid(project.id);
            console.log(`Resolved project ${identifier} via direct fetch.`);
          } else {
            // If client.project returns null/undefined without erroring
            throw new EnrichmentError(`Project with identifier ${identifier} not found via direct fetch.`);
          }
        } catch (directFetchError) {
          console.warn(`Direct fetch for project ${identifier} failed:`, directFetchError);
          // Consider adding a fallback search by name if direct fetch fails?
          // e.g., client.projects({ filter: { name: { eq: identifier } } })
          throw new EnrichmentError(`Project with identifier ${identifier} could not be resolved. Direct fetch failed.`);
        }

        if (!guid) { // Should not be reached if direct fetch throws, but as safeguard
          throw new EnrichmentError(`Project with identifier ${identifier} could not be resolved.`);
        }

      } else {
        // Add logic here for other entity types if they use numeric IDs within friendly IDs
        throw new Error(`Resolution of friendly ID for entity type '${entityName}' is not supported yet.`);
      }

      console.log(`Resolved friendly ID ${identifier} to GUID ${guid}`);
      return guid;

    } catch (error) {
      console.error(`Failed to resolve friendly ID ${identifier} for ${entityName}:`, error);
      // Re-throw EnrichmentErrors directly, wrap others
      if (error instanceof EnrichmentError) {
          throw error;
      }
      throw new EnrichmentError(`Cannot proceed with ${entityName} ID ${identifier}: ${error instanceof Error ? error.message : String(error)}`);
    }
  }
  
  // If it's neither a GUID nor a friendly ID, treat it as a raw/temporary ID (e.g., TMP-...)
  // We might want stricter validation here depending on usage
  console.log(`Using raw/temporary identifier for ${entityName}: ${identifier}`);
  // We assume it's intended to be a GUID if it reaches here, but cast carefully.
  // Consider throwing an error if only GUIDs/FriendlyIDs are expected at this point.
  return identifier as LinearGuid; 
} 