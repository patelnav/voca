/**
 * Interface for GraphQL mutation
 */
export interface GraphQLMutation {
  mutation: string;
  variables: Record<string, any>;
  result_id?: string;
}

/**
 * Interface for transformed staging data
 */
export interface StagingTransformation {
  plainText: string;
  mutations?: GraphQLMutation[];
}

/**
 * Possible entity types for staged changes
 */
export type EntityType = 'project' | 'issue' | 'relationship' | 'label' | 'comment';

/**
 * Possible operations for staged changes
 */
export type Operation = 'create' | 'update' | 'delete' | 'link' | 'archive'; 