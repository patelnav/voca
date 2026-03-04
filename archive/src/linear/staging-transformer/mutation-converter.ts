import { type GraphQLMutation } from './types';
import { type StagedChange } from '../changes/types';
import chalk from 'chalk';
import { v4 as uuidv4 } from 'uuid';
import { type LinearChangeOperation, type LinearEntityType } from '../changes/types';
import { type LinearGuid, asLinearFriendlyId, isLinearGuid } from '../../types/linear-ids';
import { type LinearClient } from '@linear/sdk';
import { type IdMapper } from '../id-mapper';

/**
 * Class responsible for converting GraphQL mutations to StagedChanges
 */
export class MutationConverter {
  private linearClient: LinearClient;
  private idMapper: IdMapper;

  constructor(linearClient: LinearClient, idMapper: IdMapper) {
    if (!linearClient) {
      throw new Error("[MutationConverter] Constructor: LinearClient dependency is required.");
    }
    if (!idMapper) {
      throw new Error("[MutationConverter] Constructor: IdMapper dependency is required.");
    }
    this.linearClient = linearClient;
    this.idMapper = idMapper;
    console.log("[MutationConverter] Initialized with LinearClient and IdMapper.");
  }

  /**
   * Convert GraphQL mutations to StagedChanges
   * @param mutations GraphQL mutations to convert
   * @param currentFocusedProjectId The current focused project ID
   * @returns StagedChanges ready for the LinearChangeManager
   */
  public async convertMutationsToStagedChanges(
    mutations: GraphQLMutation[],
    currentFocusedProjectId: LinearGuid | null
  ): Promise<StagedChange[]> {
    const changes: StagedChange[] = [];
    const idMap = new Map<string, string>(); // Maps result_ids to change IDs
    
    console.log(chalk.cyan('Converting GraphQL mutations to staged changes...'));
    console.log(`Runtime focused project ID: ${currentFocusedProjectId || 'none'}`);
    
    // Filter out project creation mutations if we have a focused project ID passed in
    const filteredMutations = currentFocusedProjectId 
      ? mutations.filter(m => !(m.mutation === 'projectCreate'))
      : mutations;
    
    if (filteredMutations.length < mutations.length) {
      console.log(chalk.yellow(`\n⚠️ Filtered out ${mutations.length - filteredMutations.length} project creation mutations because a project ID was provided.`));
    }
    
    for (const mutation of filteredMutations) {
      // Process the mutation asynchronously and create a staged change, passing context
      try {
        const change = await this.processMutation(mutation, idMap, currentFocusedProjectId);
        // Handle case where one mutation results in multiple changes (e.g., multi-parent link)
        if (Array.isArray(change)) {
            for (const c of change) {
                changes.push(c);
                // Note: Only mapping the ID of the first generated change if mutation.result_id exists
                if (mutation.result_id && c === change[0]) {
                    idMap.set(mutation.result_id, c.id);
                }
            }
        } else {
            changes.push(change);
            if (mutation.result_id) {
              idMap.set(mutation.result_id, change.id);
            }
        }
      } catch (error: any) {
        console.error(chalk.red(`[MutationConverter] Error processing mutation ${mutation.mutation}: ${error.message}`));
        // Optionally re-throw or handle more gracefully
        throw error;
      }
    }
    
    return changes;
  }

  /**
   * Process variables to handle ID references
   * @param variables Variables from the mutation
   * @param idMap Map of result_ids to change IDs
   * @param dependsOn Array to collect dependencies
   * @param currentFocusedProjectId The current focused project ID
   * @returns Processed variables with resolved references
   */
  private processVariableReferences(
    variables: Record<string, any>,
    idMap: Map<string, string>,
    dependsOn: string[],
    currentFocusedProjectId: LinearGuid | null 
  ): Record<string, any> {
    const processed: Record<string, any> = {};
    
    console.log(chalk.cyan('Processing variable references:'));
    console.log(`Variables: ${JSON.stringify(variables, null, 2)}`);
    console.log(`ID Map: ${JSON.stringify(Array.from(idMap.entries()), null, 2)}`);
    
    for (const [key, value] of Object.entries(variables)) {
      if (typeof value === 'string' && value.startsWith('{{') && value.endsWith('}}')) {
        const refId = value.substring(2, value.length - 2);
        console.log(`Found template variable: ${value}, reference ID: ${refId}`);
        
        // Handle {{project_id}} template variable using PASSED context
        if (refId === 'project_id' && currentFocusedProjectId) {
          processed[key] = currentFocusedProjectId;
          console.log(`Resolved template variable {{project_id}} to focused project ID: ${currentFocusedProjectId}`);
        }
        // Handle references to other mutations
        else if (idMap.has(refId)) {
          processed[key] = `TMP-${refId}`;
          dependsOn.push(idMap.get(refId)!);
          console.log(`Resolved reference {{${refId}}} to TMP-${refId}`);
        }
        // Handle {{*_issue_id}} template variables - mark them clearly for later resolution
        else if (refId.endsWith('_issue_id')) {
          // Extract the entity name from the template variable (e.g., "balcony" from "balcony_issue_id")
          const entityName = refId.replace(/_issue_id$/, '');
          console.log(`Template variable ${value} refers to issue with name containing "${entityName}"`);
          
          // Keep the template variable as is, but add a comment for debugging
          processed[key] = value;
          console.log(`Template variable ${value} will be resolved during execution phase`);
          
          // Add a diagnostic log to help with debugging
          console.log(chalk.yellow(`⚠️ Note: Template variable ${value} needs to be resolved to an actual issue ID during execution`));
        }
        // Other template variables
        else {
          processed[key] = value;
          console.log(`Unresolved template variable: ${value}`);
        }
      } else if ((key === 'parentId' || key === 'id') && typeof value === 'string') {
        // Handle both parentId and id references in relationship operations
        if (value.startsWith('TMP-')) {
          processed[key] = value;
          const refId = value.replace('TMP-', '');
          const dependencyId = idMap.get(refId);
          if (dependencyId) {
            dependsOn.push(dependencyId);
            console.log(`Added dependency ${dependencyId} for ${key} reference ${value}`);
          }
        } else {
          // For id field, preserve the existing Linear-friendly ID
          // For parentId field, it should already be a TMP- ID from a previous mutation
          processed[key] = value;
          console.log(`Using existing ID ${value} for ${key}`);
        }
      } else {
        processed[key] = value;
      }
    }
    
    console.log(`Processed variables: ${JSON.stringify(processed, null, 2)}`);
    return processed;
  }

  /**
   * Process a single GraphQL mutation and convert it to a staged change (or changes).
   * @param mutation The GraphQL mutation to process
   * @param idMap Map of result IDs to change IDs
   * @param currentFocusedProjectId The current focused project ID
   * @returns The created staged change(s)
   */
  private async processMutation(
    mutation: GraphQLMutation,
    idMap: Map<string, string>,
    currentFocusedProjectId: LinearGuid | null
  ): Promise<StagedChange | StagedChange[]> { // Return type can be single or array
    const { operation, entityType } = this.parseMutationName(mutation.mutation);
    
    console.log(`Processing mutation: ${mutation.mutation}`);
    console.log(`Operation: ${operation}, Entity Type: ${entityType}`);
    
    const dependsOn: string[] = [];
    let payload = this.processVariableReferences(
      mutation.variables,
      idMap,
      dependsOn,
      currentFocusedProjectId
    );
    
    console.log(`Processed variables before enrichment: ${JSON.stringify(payload, null, 2)}`);

    // --- Enrich and Validate Payload based on operation ---
    if (entityType === 'issue' && operation === 'create') {
      payload = await this._prepareIssueCreatePayload(payload, currentFocusedProjectId);
    } else if (entityType === 'issue' && operation === 'update') {
      payload = await this._prepareIssueUpdatePayload(payload);
    } else if (entityType === 'relationship' && operation === 'link') {
        // This case is handled by the special 'issueParentUpdate' mutation name below
    } else if (entityType === 'project' && operation === 'create') {
        // TODO: Implement _prepareProjectCreatePayload if needed
        console.log(`Project create payload preparation pending implementation.`);
    } else if (entityType === 'comment' && operation === 'create') {
        payload = await this._prepareCommentCreatePayload(payload);
    }
    // Add other else if blocks for other entityType/operation combinations as needed

    console.log(`Processed variables AFTER enrichment: ${JSON.stringify(payload, null, 2)}`);
    console.log(`Dependencies: ${JSON.stringify(dependsOn, null, 2)}`);
    
    // Special handling for parent-child relationships (can create multiple changes)
    if (mutation.mutation === 'issueParentUpdate') {
      return this._prepareRelationshipLinkPayload(payload, idMap, dependsOn);
    }

    // Create the final single change with enriched/validated payload
    return {
      id: uuidv4(),
      operation,
      entityType,
      payload: payload,
      description: this.generateDescription(operation, entityType, payload),
      dependsOn
    };
  }

  // --- Start Helper Methods for Payload Preparation ---

  /**
   * Prepares and validates the payload for an issue creation operation.
   * Injects focused project ID if necessary and resolves parentId.
   */
  private async _prepareIssueCreatePayload(
    payload: Record<string, any>,
    currentFocusedProjectId: LinearGuid | null
  ): Promise<Record<string, any>> {
      // Ensure projectId exists
      if (!payload.projectId && currentFocusedProjectId) {
          console.warn(`[MutationConverter] Missing projectId for issueCreate. Injecting focused project ID: ${currentFocusedProjectId}`);
          payload.projectId = currentFocusedProjectId;
      }
      if (!payload.projectId) {
          throw new Error('[MutationConverter] Missing required projectId for issue.create operation. Cannot determine project context.');
      }

      // Ensure parentId is resolved to GUID if provided as friendly ID
      if (payload.parentId && typeof payload.parentId === 'string' && !isLinearGuid(payload.parentId) && !payload.parentId.startsWith('TMP-')) {
          const friendlyParentId = asLinearFriendlyId(payload.parentId); // Assert/validate type
          console.log(`[MutationConverter] Resolving friendly parentId '${friendlyParentId}' for issue.create...`);
          try {
              const resolvedParentGuid = await this.idMapper.getLinearGuid('issue', friendlyParentId);
              if (!resolvedParentGuid) {
                   throw new Error(`Could not resolve friendly parentId '${friendlyParentId}' to a GUID.`);
              }
              payload.parentId = resolvedParentGuid;
              console.log(`[MutationConverter] Resolved friendly parentId '${friendlyParentId}' to GUID '${resolvedParentGuid}'.`);
          } catch (err: any) {
               console.error(`[MutationConverter] Error resolving parentId '${friendlyParentId}': ${err.message}`);
               throw new Error(`Failed to resolve parent issue ID '${friendlyParentId}' for issue creation.`);
          }
      }
      return payload;
  }

  /**
   * Prepares and validates the payload for an issue update operation.
   * Resolves issue ID and parentId, converts priority and status names.
   */
  private async _prepareIssueUpdatePayload(
      payload: Record<string, any>
  ): Promise<Record<string, any>> {
      if (!this.idMapper) {
          throw new Error('[MutationConverter] IdMapper dependency not set. Cannot resolve issue ID for update.');
      }
      if (!payload.id || typeof payload.id !== 'string') {
           throw new Error(`[MutationConverter] Missing or invalid issue ID in payload for update: ${payload.id}`);
      }

      const issueFriendlyOrGuid = payload.id;
      let issueGuidForUpdate: LinearGuid; // Keep GUID for status resolution

      try {
        const resolvedGuid = await this.idMapper.getGuid('issue', issueFriendlyOrGuid as any);
        if (!resolvedGuid || !isLinearGuid(resolvedGuid)) {
           throw new Error(`Could not resolve issue ID "${issueFriendlyOrGuid}" to a valid Linear GUID.`);
        }
        issueGuidForUpdate = resolvedGuid; // Assign the confirmed LinearGuid

        console.log(`[MutationConverter] Resolved issue ID "${issueFriendlyOrGuid}" to GUID "${issueGuidForUpdate}" for update.`);
        payload.id = issueGuidForUpdate; // Always update payload ID to GUID

        // Resolve parentId for issue updates
        if (payload.parentId && typeof payload.parentId === 'string' && !isLinearGuid(payload.parentId) && !payload.parentId.startsWith('TMP-')) {
            const friendlyParentId = asLinearFriendlyId(payload.parentId);
            console.log(`[MutationConverter] Resolving friendly parentId '${friendlyParentId}' for issue.update...`);
            const resolvedParentGuid = await this.idMapper.getLinearGuid('issue', friendlyParentId);
            if (!resolvedParentGuid) {
                throw new Error(`Could not resolve friendly parentId '${friendlyParentId}' to a GUID for update.`);
            }
            payload.parentId = resolvedParentGuid;
            console.log(`[MutationConverter] Resolved friendly parentId '${friendlyParentId}' to GUID '${resolvedParentGuid}' for update.`);
        }

        // Convert priority string to number
        if (payload.priority && typeof payload.priority === 'string') {
            const priorityName = payload.priority.toLowerCase();
            let priorityNumber: number | null = null;
            switch (priorityName) {
                case 'urgent': priorityNumber = 1; break;
                case 'high': priorityNumber = 2; break;
                case 'medium': priorityNumber = 3; break;
                case 'low': priorityNumber = 4; break;
                case 'none':
                case 'no priority': priorityNumber = 0; break;
                default:
                    console.warn(`[MutationConverter] Unrecognized priority string "${payload.priority}". Setting priority to 0 (No Priority).`);
                    priorityNumber = 0;
            }
            payload.priority = priorityNumber;
            console.log(`[MutationConverter] Converted priority string "${priorityName}" to number ${priorityNumber}.`);
        }

        // Handle status name to stateId conversion
        if (typeof payload.status === 'string') {
            const statusName = payload.status;
            try {
                console.log(`[MutationConverter] Resolving status name "${statusName}" for issue GUID ${issueGuidForUpdate}...`);
                const issue = await this.linearClient.issue(issueGuidForUpdate);
                if (!issue) throw new Error(`Issue ${issueGuidForUpdate} not found.`);
                const team = await issue.team;
                if (!team) throw new Error(`Team not found for issue ${issueGuidForUpdate}.`);
                const states = await team.states();
                const targetState = states.nodes.find(state => state.name.toLowerCase() === statusName.toLowerCase());
                if (!targetState) {
                  throw new Error(`Status "${statusName}" not found in workflow states for team ${team.key}. Available states: ${states.nodes.map(s => s.name).join(', ')}`);
                }
                console.log(`[MutationConverter] Resolved status "${statusName}" to stateId ${targetState.id}`);
                payload.stateId = targetState.id;
                delete payload.status;
            } catch (err: any) {
                console.error(chalk.red(`[MutationConverter] Failed to resolve status name "${statusName}" for issue ${issueGuidForUpdate}: ${err.message}`));
                throw new Error(`Failed to resolve status name "${statusName}": ${err.message}`);
            }
        }

      } catch (err: any) {
          console.error(chalk.red(`[MutationConverter] Failed to resolve issue ID "${issueFriendlyOrGuid}" for update: ${err.message}`));
          throw new Error(`Failed to resolve issue ID "${issueFriendlyOrGuid}": ${err.message}`);
      }
      return payload;
  }

  /**
   * Prepares payload for comment creation. Resolves issue ID.
   */
  private async _prepareCommentCreatePayload(
      payload: Record<string, any>
  ): Promise<Record<string, any>> {
      if (!payload.issueId || typeof payload.issueId !== 'string') {
          throw new Error(`[MutationConverter] Missing or invalid issueId for comment.create: ${payload.issueId}`);
      }
      if (!payload.body || typeof payload.body !== 'string') {
          throw new Error(`[MutationConverter] Missing or invalid body for comment.create`);
      }

      const issueFriendlyOrTmpId = payload.issueId;
      if (!isLinearGuid(issueFriendlyOrTmpId) && !issueFriendlyOrTmpId.startsWith('TMP-')) {
          console.log(`[MutationConverter] Resolving friendly/temp issue ID '${issueFriendlyOrTmpId}' for comment.create...`);
          try {
              const resolvedGuid = await this.idMapper.getGuid('issue', issueFriendlyOrTmpId as any);
              if (!resolvedGuid || !isLinearGuid(resolvedGuid)) {
                   throw new Error(`Could not resolve issue ID "${issueFriendlyOrTmpId}" to a valid Linear GUID for comment.`);
              }
              payload.issueId = resolvedGuid;
              console.log(`[MutationConverter] Resolved issue ID '${issueFriendlyOrTmpId}' to GUID '${resolvedGuid}' for comment.`);
          } catch (err: any) {
               console.error(chalk.red(`[MutationConverter] Failed to resolve issue ID "${issueFriendlyOrTmpId}" for comment: ${err.message}`));
               throw new Error(`Failed to resolve issue ID "${issueFriendlyOrTmpId}" for comment: ${err.message}`);
          }
      } else {
          // It's already a GUID or a TMP- ID which will be resolved later
          console.log(`[MutationConverter] Using provided GUID/TMP ID '${issueFriendlyOrTmpId}' for comment's issueId.`);
      }
      return payload;
  }

  /**
   * Prepares payload(s) for relationship linking (issueParentUpdate).
   * Handles single or multiple parents and sets dependencies correctly.
   */
  private _prepareRelationshipLinkPayload(
      payload: Record<string, any>,
      idMap: Map<string, string>,
      baseDependsOn: string[]
  ): StagedChange | StagedChange[] { // Can return single or array
      // Check if the parentId is an array (multiple parents)
      if (Array.isArray(payload.parentId)) {
        console.log(`Found multiple parents: ${JSON.stringify(payload.parentId, null, 2)}`);

        // Create a separate change for each parent
        const changes: StagedChange[] = [];
        for (const parentId of payload.parentId) {
          // Get the dependency ID for this parent
          const parentRefId = parentId.replace('TMP-', '');
          const parentDependencyId = idMap.get(parentRefId);
          const dependsOn = parentDependencyId ? [...baseDependsOn, parentDependencyId] : baseDependsOn;

          const change: StagedChange = {
            id: uuidv4(),
            operation: 'link',
            entityType: 'relationship',
            payload: {
              parentId, // This should be a TMP- ID resolved later
              childId: payload.id, // This should be a TMP- ID resolved later
              id: payload.id // Alias for childId used by entity-operations
            },
            description: `Link issue ${payload.id} as a subtask of ${parentId}`,
            dependsOn: dependsOn
          };
          changes.push(change);
        }
        return changes; // Return array of changes
      }

      // Single parent case
      const parentId = payload.parentId;
      const parentRefId = parentId.replace('TMP-', '');
      const parentDependencyId = idMap.get(parentRefId);
      const dependsOn = parentDependencyId ? [...baseDependsOn, parentDependencyId] : baseDependsOn;

      // Return single change
      return {
        id: uuidv4(),
        operation: 'link',
        entityType: 'relationship',
        payload: {
          parentId, // This should be a TMP- ID resolved later
          childId: payload.id, // This should be a TMP- ID resolved later
          id: payload.id // Alias for childId used by entity-operations
        },
        description: `Link issue ${payload.id} as a subtask of ${parentId}`,
        dependsOn: dependsOn
      };
  }

  // --- End Helper Methods ---

  /**
   * Parse a mutation name to extract the operation and entity type
   * @param mutationName The name of the GraphQL mutation
   * @returns The operation and entity type
   */
  private parseMutationName(mutationName: string): { operation: LinearChangeOperation; entityType: LinearEntityType } {
    // Example: issueCreate -> { operation: 'create', entityType: 'issue' }
    // Example: projectUpdate -> { operation: 'update', entityType: 'project' }
    // Handle relationship link special case
    if (mutationName === 'issueParentUpdate') {
        return { operation: 'link', entityType: 'relationship' };
    }

    const match = mutationName.match(/^(issue|project|comment|team|cycle|document|organization|user|workflowState|projectUpdate|issueRelation|integration|emoji|attachment|customView|webhook|apiKey|notification|notificationSubscription|favorite|template|documentContent|projectLink|issueLabel)(Create|Update|Delete|Archive|Unarchive|Add|Remove|Set|Link|Assign|Subscribe|Unsubscribe|Append|Move)$/i);

    if (!match || match.length < 3) {
        console.error(chalk.red(`[MutationConverter] Could not parse mutation name: ${mutationName}`));
        throw new Error(`Invalid mutation name format: ${mutationName}`);
    }

    const entity = match[1].toLowerCase() as LinearEntityType;
    const op = match[2].toLowerCase() as LinearChangeOperation;

    // Additional check for valid LinearEntityType and LinearChangeOperation if stricter typing is needed
    // ...

    console.log(`Parsed mutation: ${mutationName} -> Entity: ${entity}, Operation: ${op}`);
    return { operation: op, entityType: entity };
  }

  /**
   * Generate a human-readable description for the staged change
   * @param operation The operation type (create, update, delete)
   * @param entityType The entity type (issue, project)
   * @param payload The payload for the operation
   * @returns A descriptive string
   */
  private generateDescription(operation: string, entityType: string, payload: any): string {
    let desc = `${operation} ${entityType}`;
    if (entityType === 'issue') {
      if (operation === 'create' && payload.title) desc += `: "${payload.title}"`;
      else if (payload.id) desc += ` ${payload.id}`;
    } else if (entityType === 'project') {
      if (operation === 'create' && payload.name) desc += `: "${payload.name}"`;
      else if (payload.projectId) desc += ` ${payload.projectId}`;
    } else if (entityType === 'comment') {
        if (payload.issueId) desc += ` on issue ${payload.issueId}`;
    } else if (entityType === 'relationship') {
        if (payload.parentId && payload.childId) desc += ` parent ${payload.parentId} to child ${payload.childId}`;
    }
    // Add more specific descriptions as needed
    return desc;
  }
}