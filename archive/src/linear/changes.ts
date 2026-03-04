import { type LinearClient } from '@linear/sdk';
import { v4 as uuidv4 } from 'uuid';
// Runtime values




// Types
import type { 
    LinearFriendlyId, 
    LinearGuid
} from '@/types/linear-ids';
// Import moved types
import type {
    StagedChange,
    ChangeResult
} from '@/linear/changes/types';
// Re-export the types for downstream consumers
export type * from '@/linear/changes/types';
import { type IdMapper } from '@/linear/id-mapper';
import { type FocusManager } from '@/linear/focus-manager';
import chalk from 'chalk';
import { IdRegistry } from './changes/id-registry';
import { ChangeFactory } from '@/linear/changes/change-factory';
import { TemporaryIdMapper } from '@/linear/changes/temporary-id-mapper';
import { ChangeApplier } from '@/linear/changes/change-applier';
import { CacheRefresher } from '@/linear/changes/cache-refresher';
import { type ApplyChangesResult } from '@/linear/changes/change-applier';

/**
 * Manager for staged Linear API changes
 */
export class LinearChangeManager {
  private stagedChanges: StagedChange[] = [];
  private linearClient: LinearClient;
  private focusedProjectId: LinearGuid | null;
  private idMapper: IdMapper;
  private focusManager: FocusManager | null;
  private projectCounter = 1;
  private issueCounter = 1;
  private idRegistry: IdRegistry;
  public readonly changes: ChangeFactory;
  private temporaryIdMapper: TemporaryIdMapper;
  private changeApplier: ChangeApplier;
  private cacheRefresher: CacheRefresher;
  
  /**
   * Create a new LinearChangeManager
   * @param linearClient An initialized Linear client
   * @param focusedProjectId Optional project ID to focus on
   * @param idMapper Optional IdMapper instance for ID resolution
   * @param focusManager Optional FocusManager instance for focus management
   */
  constructor(
    linearClient: LinearClient,
    focusedProjectId: LinearGuid | null = null,
    idMapper: IdMapper,
    focusManager: FocusManager | null = null
  ) {
    this.linearClient = linearClient;
    this.focusedProjectId = focusedProjectId;
    this.idMapper = idMapper;
    this.focusManager = focusManager;
    this.idRegistry = new IdRegistry();
    this.changes = new ChangeFactory(
        this.addChange.bind(this),
        this.idRegistry,
        () => this.issueCounter++,
        () => this.projectCounter++
    );
    this.temporaryIdMapper = new TemporaryIdMapper(
        this.linearClient,
        this.idMapper,
        this.focusedProjectId
    );
    // Instantiate the CacheRefresher
    this.cacheRefresher = new CacheRefresher(
        this.linearClient,
        this.idMapper,
        this.focusManager,
        this.focusedProjectId
    );
    // Instantiate the ChangeApplier
    this.changeApplier = new ChangeApplier(
        this.linearClient,
        this.temporaryIdMapper,
        this.idRegistry,
        this.idMapper,
        () => this.stagedChanges,
        (remainingChanges) => { this.stagedChanges = remainingChanges; },
        this.cacheRefresher.refresh.bind(this.cacheRefresher),
        () => this.issueCounter++
    );
  }

  /**
   * Add a new change to the staging area
   * @param change The change to stage
   * @returns The ID of the added change
   */
  addChange(change: StagedChange): string {
    const changeWithId = {
      ...change,
      id: change.id || uuidv4(),
    };
    this.stagedChanges.push(changeWithId);
    return changeWithId.id;
  }

  /**
   * Add multiple changes at once
   * @param changes Array of changes to add
   * @returns Array of added change IDs
   */
  addChanges(changes: Omit<StagedChange, 'id'>[]): string[] {
    return changes.map((change) => this.addChange(change as StagedChange));
  }

  /**
   * Remove a specific change
   * @param id ID of the change to remove
   */
  removeChange(id: string): void {
    this.stagedChanges = this.stagedChanges.filter((c) => c.id !== id);
  }

  /**
   * Get all currently staged changes
   * @returns Copy of the staged changes array
   */
  getChanges(): StagedChange[] {
    return [...this.stagedChanges];
  }

  /**
   * Clear all staged changes
   */
  clearChanges(): void {
    this.stagedChanges = [];
    // Also clear the ID registry when changes are cleared
    this.idRegistry.clear();
  }

  /**
   * Apply all staged changes to Linear
   * Delegates the complex application logic to the ChangeApplier.
   * @returns Results of all change operations
   */
  async applyChanges(): Promise<ApplyChangesResult> {
    // Delegate to the ChangeApplier instance
    return this.changeApplier.applyChanges();
  }

  /**
   * Get a project by ID
   * @param projectId The project ID to look up
   * @returns The project data or null if not found
   */
  async getProjectById(projectId: LinearFriendlyId): Promise<any> {
    try {
      const project = await this.linearClient.project(projectId);
      return project;
    } catch (error) {
      console.error(`Failed to fetch project ${projectId}:`, error);
      return null;
    }
  }

  /**
   * Set the focused project ID
   * @param projectId The project ID to focus on, or null to clear focus
   */
  setFocusedProjectId(projectId: LinearGuid | null): void {
    console.log(chalk.blue(`Setting focused project ID in LinearChangeManager to: ${projectId}`));
    this.focusedProjectId = projectId;
    // We also need to update the components that depend on this ID
    // TODO: Consider a better way to propagate this state change, maybe events or shared state object
    this.temporaryIdMapper = new TemporaryIdMapper(
        this.linearClient,
        this.idMapper,
        this.focusedProjectId
    );
     this.cacheRefresher = new CacheRefresher(
        this.linearClient,
        this.idMapper,
        this.focusManager,
        this.focusedProjectId
    );
    // ChangeApplier doesn't directly use focusedProjectId, so no need to reinstantiate it
  }

  /**
   * Get the focused project ID
   * @returns The focused project ID or null if none is focused
   */
  getFocusedProjectId(): LinearGuid | null {
    return this.focusedProjectId;
  }
}

