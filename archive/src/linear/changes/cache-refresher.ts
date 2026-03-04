import type { LinearClient } from '@linear/sdk';
import type { IdMapper } from '@/linear/id-mapper';
import type { FocusManager } from '@/linear/focus-manager';
import type { LinearGuid } from '@/types/linear-ids';
import { asLinearFriendlyId } from '@/types/linear-ids';
import chalk from 'chalk';

/**
 * Handles refreshing local caches (IdMapper, FocusManager) after changes
 * have been applied to the Linear API.
 */
export class CacheRefresher {
    private linearClient: LinearClient;
    private idMapper: IdMapper;
    private focusManager: FocusManager | null; // Can be null if not provided initially
    private focusedProjectId: LinearGuid | null;

    constructor(
        linearClient: LinearClient,
        idMapper: IdMapper,
        focusManager: FocusManager | null,
        focusedProjectId: LinearGuid | null
    ) {
        this.linearClient = linearClient;
        this.idMapper = idMapper;
        this.focusManager = focusManager;
        this.focusedProjectId = focusedProjectId;
    }

    /**
     * Refresh the ID mapper and focus manager caches.
     */
    async refresh(): Promise<void> {
        try {
            console.log(chalk.yellow('\n=== REFRESHING CACHES ==='));
            
            // 1. Refresh the main ID mapper
            if (this.idMapper) {
                console.log('  Refreshing ID mapper...');
                // DO NOT CLEAR! We need to preserve temporary ID mappings established during applyChanges.
                // this.idMapper.clear(); 
                // console.log('    Cleared main IdMapper.');
                
                // Re-register the focused project if it exists
                if (this.focusedProjectId) {
                     try {
                         // Fetch project details to get the name/identifier if needed
                         const project = await this.linearClient.project(this.focusedProjectId);
                         this.idMapper.registerProject(
                            project.name || 'Focused Project', 
                            this.focusedProjectId, 
                            project.slugId ? asLinearFriendlyId(project.slugId) : undefined
                        );
                         console.log(`    Re-registered focused project ${project.slugId || this.focusedProjectId} in IdMapper.`);
                    } catch (error) { 
                         console.warn(chalk.yellow(`    Could not fetch focused project details (${this.focusedProjectId}) for IdMapper re-registration: ${error}`));
                         // Register with placeholder name if fetch fails
                         this.idMapper.registerProject('Focused Project', this.focusedProjectId, undefined);
                         console.log(`    Re-registered focused project ${this.focusedProjectId} in IdMapper (placeholder name).`);
                    }
                }
            } else {
                console.log('  IdMapper not provided, skipping its refresh.');
            }
            
            // 2. Refresh issues using FocusManager
            let currentFocusManager = this.focusManager;
            
            // If no FocusManager was provided, create a temporary one
            if (!currentFocusManager) {
                 console.log('  FocusManager not provided, creating temporary instance...');
                 try {
                    const FocusManagerModule = await import('@/linear/focus-manager');
                    currentFocusManager = new FocusManagerModule.FocusManager(this.linearClient);
                    console.log('    Temporary FocusManager created.');
                 } catch (error) {
                      console.error(chalk.red('    Failed to create temporary FocusManager:'), error);
                      // Cannot proceed with issue refresh without FocusManager
                      console.log(chalk.yellow('=== CACHE REFRESH COMPLETE (with errors) ==='));
                      return;
                 }
            }

            console.log('  Refreshing issues via FocusManager...');
            if (this.focusedProjectId) {
                try {
                    // Ensure focus is set correctly, especially if using a temporary manager
                    await currentFocusManager.setFocus(this.focusedProjectId, 'Refreshing Cache');
                    console.log(`    Focus set to project ${this.focusedProjectId}.`);

                    // --- Introduce a small delay to allow Linear API propagation ---
                    console.log('    Adding short delay before fetching issues...');
                    await new Promise(resolve => setTimeout(resolve, 500)); // 500ms delay
                    // -------------------------------------------------------------
                    
                    // Force refresh issues for the focused project
                    const issues = await currentFocusManager.getFocusedIssues({ forceRefresh: true });
                    console.log(`    Fetched ${issues.length} issues via FocusManager.`);
                    
                    // Re-register all fetched issues with the main ID mapper
                    if (this.idMapper) {
                        for (const issue of issues) {
                            this.idMapper.registerIssue(
                                issue.title,
                                issue.id,
                                issue.identifier ? asLinearFriendlyId(issue.identifier) : undefined
                            );
                        }
                        console.log(`    Re-registered ${issues.length} issues in main IdMapper.`);
                    } else {
                        console.log('    IdMapper not available, skipping issue re-registration.');
                    }
                } catch (error) {
                     console.error(chalk.red(`    Error refreshing issues via FocusManager for project ${this.focusedProjectId}:`), error);
                }
            } else {
                console.log(chalk.yellow('  No focused project ID set, cannot refresh issues via FocusManager.'));
            }
            
            console.log(chalk.green('=== CACHE REFRESH COMPLETE ==='));
        } catch (error) {
            console.error(chalk.red('Error during cache refresh:'), error);
             console.log(chalk.yellow('=== CACHE REFRESH COMPLETE (with errors) ==='));
        }
    }
} 