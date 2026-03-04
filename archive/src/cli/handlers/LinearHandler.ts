import chalk from 'chalk';
import type {
  LinearChangeManager,
  StagedChange,
  ChangeResult,
} from '@/linear/changes';
import { formatChangeResultsForDisplay } from '@/linear/ui';
import type { ErrorLogger } from '@/cli/logging/ErrorLogger';
import { type IdMapper } from '@/linear/id-mapper';
import { 
  type LinearFriendlyId, 
  type LinearGuid, 
  isLinearGuid, 
  asLinearFriendlyId, 
  asLinearGuid 
} from '@/types/linear-ids';

export class LinearHandler {
  constructor(
    private readonly linearChangeManager: LinearChangeManager,
    private readonly errorLogger: ErrorLogger,
    private readonly idMapper?: IdMapper
  ) {}

  /**
   * Display currently staged Linear changes
   */
  displayLinearChanges() {
    const changes = this.linearChangeManager.getChanges();

    if (changes.length === 0) {
      console.log(chalk.gray('\nNo pending changes for Linear. Type a request to propose changes.'));
      return;
    }

    console.log(chalk.cyan('\n📋 Pending Linear changes (' + changes.length + '):'));
    
    // Sort changes by dependency order for clearer display
    const sortedChanges = this.sortChangesByHierarchy(changes);
    
    // Display the changes with proper hierarchy and formatting
    sortedChanges.forEach((change, index) => {
      // Format the description based on depth
      let indent = '';
      if (change.indentation > 0) {
        indent = '  '.repeat(change.indentation);
      }
      
      // For changes with friendly IDs, enhance the display
      let enhancedDescription = change.change.description;
      if (this.idMapper) {
        enhancedDescription = this.enhanceChangeWithFriendlyIds(change.change);
      }
      
      // Format the short description
      const shortDesc = this.formatChangeDescription(enhancedDescription);
      
      // Show the full description for the first few changes or when specifically requested
      console.log(`${indent}${index + 1}. [${change.change.operation.toUpperCase()} ${change.change.entityType.toUpperCase()}] ${shortDesc}`);
      
      // Show additional details for certain change types
      if (change.change.payload.description && change.change.entityType === 'issue') {
        const desc = change.change.payload.description;
        // If description is long, truncate it
        if (desc.length > 60) {
          console.log(`${indent}   Description: ${desc.substring(0, 60)}...`);
        } else if (desc.length > 0) {
          console.log(`${indent}   Description: ${desc}`);
        }
      }
    });

    console.log(chalk.gray('\nType "execute" to execute these changes or "clear" to discard them.'));
  }
  
  /**
   * Sort changes by hierarchy for better display
   * @param changes List of staged changes
   * @returns Sorted changes with indentation info
   */
  private sortChangesByHierarchy(changes: StagedChange[]): { change: StagedChange; indentation: number }[] {
    const result: { change: StagedChange; indentation: number }[] = [];
    const visited = new Set<LinearGuid>();
    const parentChildMap = new Map<LinearGuid, LinearGuid[]>();
    
    // First, identify parent-child relationships
    // This includes both explicit parent-child changes and implicit relationships
    for (const change of changes) {
      // For explicit parent-child relationships
      if (change.entityType === 'relationship') {
        const parentId = asLinearGuid(change.payload.parentId);
        const childId = asLinearGuid(change.payload.childId);
        
        if (!parentChildMap.has(parentId)) {
          parentChildMap.set(parentId, []);
        }
        parentChildMap.get(parentId)?.push(childId);
      }
      
      // For implicit dependencies (like issues depending on projects)
      if (change.dependsOn && change.dependsOn.length > 0) {
        for (const dependencyId of change.dependsOn) {
          const guidDependencyId = asLinearGuid(dependencyId);
          if (!parentChildMap.has(guidDependencyId)) {
            parentChildMap.set(guidDependencyId, []);
          }
          parentChildMap.get(guidDependencyId)?.push(asLinearGuid(change.id));
        }
      }
    }
    
    // Recursive function to visit a change and its children
    const visit = (changeId: LinearGuid, depth: number) => {
      if (visited.has(changeId)) return;
      visited.add(changeId);
      
      const change = changes.find(c => asLinearGuid(c.id) === changeId);
      if (!change) return;
      
      result.push({ change, indentation: depth });
      
      // Visit all children
      const children = parentChildMap.get(changeId) || [];
      for (const childId of children) {
        visit(childId, depth + 1);
      }
    };
    
    // Start with all root nodes (those with no dependencies)
    const rootNodes = changes
      .filter(c => !c.dependsOn || c.dependsOn.length === 0)
      .filter(c => !changes.some(other => 
        other.entityType === 'relationship' && 
        asLinearGuid(other.payload.childId) === asLinearGuid(c.id)
      ));
    
    // Visit each root node
    for (const rootNode of rootNodes) {
      visit(asLinearGuid(rootNode.id), 0);
    }
    
    // Add any remaining nodes that weren't visited
    for (const change of changes) {
      const changeId = asLinearGuid(change.id);
      if (!visited.has(changeId)) {
        result.push({ change, indentation: 0 });
        visited.add(changeId);
      }
    }
    
    return result;
  }
  
  /**
   * Format a change description for display
   * @param description The change description
   * @returns Formatted description
   */
  private formatChangeDescription(description: string): string {
    // Truncate long descriptions with ellipsis
    if (description.length > 100) {
      return description.substring(0, 100) + '...';
    }
    return description;
  }
  
  /**
   * Enhance change description with friendly IDs
   * @param change The staged change to enhance
   * @returns Enhanced description with friendly IDs
   */
  private enhanceChangeWithFriendlyIds(change: StagedChange): string {
    let description = change.description;
    
    try {
      if (!this.idMapper) {
        return description;
      }
      
      // For relationship operations, enhance both parent and child IDs
      if (change.entityType === 'relationship') {
        const parentId = asLinearGuid(change.payload.parentId);
        const childId = asLinearGuid(change.payload.childId);
        
        if (parentId) {
          // Handle placeholder IDs like "NP-403_Linear_ID"
          const actualParentId = this.extractActualId(parentId);
          if (actualParentId) {
            description = description.replace(parentId, actualParentId);
          }
        }
        
        if (childId) {
          // Handle placeholder IDs like "NP-405_Linear_ID"
          const actualChildId = this.extractActualId(childId);
          if (actualChildId) {
            description = description.replace(childId, actualChildId);
          }
        }
      }
      
      // For other entity types, try to enhance IDs in the payload
      else if (change.entityType === 'issue' || change.entityType === 'project') {
        // For create operations, there's no ID to enhance
        if (change.operation === 'create') {
          return description;
        }
        
        // For update/delete operations, try to find the issue ID in the payload
        const issueId = change.payload.id;
        if (issueId) {
          // Handle placeholder IDs
          const actualId = this.extractActualId(issueId);
          if (actualId) {
            description = description.replace(issueId, actualId);
          }
        }
      }
    } catch (error) {
      // If anything goes wrong, just return the original description
      console.error('Error enhancing change description:', error);
    }
    
    return description;
  }

  /**
   * Extract the actual ID from a placeholder ID like "NP-403_Linear_ID"
   * @param id The placeholder ID
   * @returns The actual ID or the original ID if not a placeholder
   */
  private extractActualId(id: string): LinearFriendlyId | LinearGuid {
    // Check if this is a placeholder ID like "NP-403_Linear_ID"
    if (typeof id === 'string') {
      // Extract the actual ID part (e.g., "NP-403" from "NP-403_Linear_ID")
      const match = id.match(/^([A-Z]+-\d+)_/i);
      if (match && match[1]) {
        return asLinearFriendlyId(match[1]);
      }
    }
    
    // If it's a valid Linear GUID, return it as such
    if (isLinearGuid(id)) {
      return asLinearGuid(id);
    }
    
    // Return the original ID as a friendly ID if not a placeholder or GUID
    return asLinearFriendlyId(id);
  }

  /**
   * Clear pending Linear changes
   */
  public clearLinearChanges(): void {
    const changeCount = this.linearChangeManager.getChanges().length;

    if (changeCount === 0) {
      console.log(chalk.gray('No pending Linear changes to clear.'));
      return;
    }

    this.linearChangeManager.clearChanges();
    console.log(
      chalk.yellow(`Cleared ${changeCount} pending Linear change${changeCount === 1 ? '' : 's'}.`)
    );
  }

  /**
   * Apply pending Linear changes
   */
  public async applyLinearChanges(): Promise<void> {
    const changes = this.linearChangeManager.getChanges();

    if (changes.length === 0) {
      console.log(chalk.gray('No pending changes to apply.'));
      return;
    }

    console.log(
      chalk.cyan(
        `\n🔄 Applying ${changes.length} change${changes.length === 1 ? '' : 's'} to Linear...`
      )
    );

    try {
      const results = await this.linearChangeManager.applyChanges();
      
      // Enhance results with friendly IDs for display if ID mapper is available
      if (this.idMapper) {
        results.forEach(result => {
          if (result.success && result.result) {
            this.registerEntityFromChangeResult(result);
          }
        });
      }
      
      this.formatAndLogChangeResults(results);

      // Log failed results
      const failedResults = results.filter((r) => !r.success);
      if (failedResults.length > 0) {
        await this.errorLogger.logError(failedResults, 'Linear Changes Application', {
          linearChangesCount: this.linearChangeManager.getChanges().length,
          projectsCount: 0, // This will be set by the CLI class
        });
      }
    } catch (error: unknown) {
      const errorMessage = error instanceof Error ? error.message : String(error);
      console.error(chalk.red(`\n❌ Error applying changes: ${errorMessage}`));

      await this.errorLogger.logError(error, 'Linear Changes Application Error', {
        linearChangesCount: this.linearChangeManager.getChanges().length,
        projectsCount: 0, // This will be set by the CLI class
      });
    }
  }
  
  /**
   * Register new entities from successful change results
   */
  private registerEntityFromChangeResult(result: ChangeResult): void {
    if (!this.idMapper || !result.success || !result.result) return;
    
    const change = result.change;
    
    // For newly created projects
    if (change.entityType === 'project' && change.operation === 'create') {
      // Extract Linear ID from result
      let projectId: string | undefined;
      
      if (result.result.id) {
        projectId = result.result.id;
      } else if (result.result.project && result.result.project.id) {
        projectId = result.result.project.id;
      } else if (result.result._project && result.result._project.id) {
        projectId = result.result._project.id;
      }
      
      if (projectId) {
        const name = change.payload.name || 'project';
        this.idMapper.registerProject(projectId, name);
      }
    }
    
    // For newly created issues
    else if (change.entityType === 'issue' && change.operation === 'create') {
      // Extract Linear ID from result
      let issueId: string | undefined;
      
      if (result.result.id) {
        issueId = result.result.id;
      } else if (result.result.issue && result.result.issue.id) {
        issueId = result.result.issue.id;
      } else if (result.result._issue && result.result._issue.id) {
        issueId = result.result._issue.id;
      }
      
      if (issueId) {
        const name = change.payload.title || 'issue';
        this.idMapper.registerIssue(issueId, name);
      }
    }
  }

  /**
   * Format and log change results
   */
  private formatAndLogChangeResults(results: ChangeResult[]): void {
    // Format and display the results
    const formattedResults = formatChangeResultsForDisplay(results);
    console.log(chalk.cyan('\n📋 Results:'));
    console.log(formattedResults);

    // Count successes and failures
    const successCount = results.filter((r) => r.success).length;
    const failureCount = results.filter((r) => !r.success).length;

    // Log summary with color-coded result
    if (failureCount === 0) {
      console.log(
        chalk.green(
          `\n✅ Applied ${successCount} of ${results.length} changes to Linear successfully.`
        )
      );
    } else {
      console.log(
        chalk.yellow(`\n⚠️ Applied ${successCount} of ${results.length} changes to Linear:`)
      );
      console.log(
        chalk.green(
          `Applied ${successCount} changes successfully, ${failureCount} changes failed:\n`
        )
      );

      // Log details of failed changes for better debugging
      results
        .filter((r) => !r.success)
        .forEach((result, index) => {
          console.log(
            chalk.red(
              `❌ ${index + 1}. [${result.change.operation.toUpperCase()} ${result.change.entityType.toUpperCase()}] ${result.change.description}`
            )
          );

          // Enhanced error logging
          if (result.error) {
            let errorMessage = result.error.message || String(result.error);
            console.log(chalk.red(`   Error: ${errorMessage}`));

            // Log additional details if available
            if (result.error.stack && process.env.DEBUG) {
              console.log(chalk.gray(`   Stack: ${result.error.stack.split('\n')[0]}`));
            }

            // Log operation details for better debugging
            console.log(
              chalk.gray(`   Operation: ${result.change.operation} on ${result.change.entityType}`)
            );
            console.log(chalk.gray(`   Payload: ${JSON.stringify(result.change.payload)}`));
          }
        });

      // Add a separator before next prompt
      console.log(chalk.yellow('\nSome changes failed. The remaining changes were not applied.'));
    }
  }
}

