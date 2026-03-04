import { type LinearClient } from '@linear/sdk';
import { fetchProjectIssues, type BaseIssue } from './issues';
import { type LinearGuid, asLinearGuid } from '../types/linear-ids';

/**
 * Options for controlling the focus behavior
 */
export interface FocusOptions {
  /** Maximum depth of the issue hierarchy to retrieve (default: 2) */
  maxDepth?: number;
  /** Only include issues updated within this number of days (default: undefined - no filter) */
  recentDays?: number;
  /** Only include issues with these statuses (default: undefined - all statuses) */
  statuses?: string[];
  /** Force refresh of the cache (default: false) */
  forceRefresh?: boolean;
}

// Extend the base issue type and only add what we need for hierarchy
export interface HierarchicalIssue extends BaseIssue {
  children?: HierarchicalIssue[];
}

/**
 * Manages the "focus" concept for Linear integration
 * This allows us to limit the context sent to the LLM by focusing on a specific
 * project and its most relevant issues
 */
export class FocusManager {
  private focusedProjectId: LinearGuid | null = null;
  private focusedProjectName: string | null = null;
  private linearClient: LinearClient;
  // Cache for issues to avoid multiple API calls
  private issuesCache: Map<string, { issues: BaseIssue[], timestamp: number }> = new Map();
  // Cache expiration time (30 minutes)
  private readonly CACHE_EXPIRATION_MS = 30 * 60 * 1000;

  constructor(linearClient: LinearClient) {
    this.linearClient = linearClient;
  }

  /**
   * Sets the focus to a specific project identified by its GUID or slugId.
   * Performs lookup, validation, and updates internal state.
   * @param idOrSlug The GUID or slugId of the project.
   * @returns The project info { id: LinearGuid, name: string } if successful, otherwise null.
   */
  async setFocusByAnyId(idOrSlug: string): Promise<{ id: LinearGuid, name: string } | null> {
    let projectInfo: { id: LinearGuid, name: string } | null = null;

    // Try fetching directly by ID (assuming it might be a GUID)
    try {
      console.log(`[FocusManager] Attempting lookup by ID: ${idOrSlug}`);
      const projectById = await this.linearClient.project(idOrSlug);
      if (projectById) {
        console.log(`[FocusManager] Found project by ID: ${projectById.id}`);
        // Attempt to cast to LinearGuid. If this fails, asLinearGuid will throw.
        projectInfo = { id: asLinearGuid(projectById.id), name: projectById.name };
      }
    } catch (error: any) {
      // Ignore "not found" errors, log others, clear potential partial match
      projectInfo = null;
      if (!error.message?.includes('not found')) {
        console.warn(`[FocusManager] Error fetching project by ID ${idOrSlug}: ${error.message}`);
      }
    }

    // If not found by ID, try fetching all projects and matching slugId
    if (!projectInfo) {
      console.log(`[FocusManager] Project not found by ID, searching by slugId: ${idOrSlug}`);
      try {
        const projects = await this.linearClient.projects({ first: 250 }); // Fetch projects (consider pagination if >250)
        const projectBySlug = projects.nodes.find(p => p.slugId.toLowerCase() === idOrSlug.toLowerCase());

        if (projectBySlug) {
          console.log(`[FocusManager] Found project by slugId: ${projectBySlug.id}`);
          // Attempt to cast to LinearGuid. If this fails, asLinearGuid will throw.
          projectInfo = { id: asLinearGuid(projectBySlug.id), name: projectBySlug.name };
        }
      } catch (error: any) {
        projectInfo = null; // Clear potential partial match on error
        console.error(`[FocusManager] Error fetching projects to search by slugId: ${error.message}`);
      }
    }

    // If found and cast successfully, update internal state
    if (projectInfo) {
      console.log(`[FocusManager] Setting focus to: ${projectInfo.name} (${projectInfo.id})`);
      this.focusedProjectId = projectInfo.id;
      this.focusedProjectName = projectInfo.name;
      return projectInfo;
    } else {
      // If not found either way or casting failed
      console.warn(`[FocusManager] Project not found or ID invalid for identifier: ${idOrSlug}`);
      // Ensure focus is cleared if lookup fails
      this.clearFocus();
      return null;
    }
  }

  /**
   * Set the focus to a specific project
   * @param projectId The ID of the project to focus on
   * @param projectName The name of the project
   */
  async setFocus(projectId: string, projectName: string): Promise<void> {
    // Verify project exists before setting focus
    const project = await this.linearClient.project(projectId);
    if (!project) {
      throw new Error(`Project with ID ${projectId} not found`);
    }

    this.focusedProjectId = asLinearGuid(projectId);
    this.focusedProjectName = projectName;
  }

  /**
   * Clear the current focus
   */
  clearFocus(): void {
    this.focusedProjectId = null;
    this.focusedProjectName = null;
  }

  /**
   * Get the current focused project ID
   */
  getFocusedProjectId(): LinearGuid | null {
    return this.focusedProjectId;
  }

  /**
   * Get the current focused project name
   */
  getFocusedProjectName(): string | null {
    return this.focusedProjectName;
  }

  /**
   * Check if there is an active focus
   */
  hasFocus(): boolean {
    return this.focusedProjectId !== null;
  }

  /**
   * Clear the issues cache for a specific project or all projects
   * @param projectId Optional project ID to clear cache for, if omitted clears all caches
   */
  clearCache(projectId?: LinearGuid): void {
    if (projectId) {
      this.issuesCache.delete(String(projectId));
    } else {
      this.issuesCache.clear();
    }
  }

  /**
   * Get focused issues with depth limiting and filtering
   * @param options FocusOptions to control the focus behavior
   */
  async getFocusedIssues(options: FocusOptions = {}): Promise<HierarchicalIssue[]> {
    if (!this.focusedProjectId) {
      return [];
    }

    // Get all issues for the project (leveraging cache)
    const issues = await this.getIssues(this.focusedProjectId, options.forceRefresh || false);
    
    // Apply filters based on options
    let filteredIssues = issues;

    // 1. Filter by status (if provided)
    if (options.statuses && options.statuses.length > 0) {
      const lowerCaseStatuses = options.statuses.map(s => s.toLowerCase());
      filteredIssues = filteredIssues.filter(issue => 
        issue.state?.name && lowerCaseStatuses.includes(issue.state.name.toLowerCase())
      );
    }

    // 2. Filter by recent updates (if provided)
    if (options.recentDays && options.recentDays > 0) {
      const cutoffDate = new Date();
      cutoffDate.setDate(cutoffDate.getDate() - options.recentDays);
      filteredIssues = filteredIssues.filter(issue => 
        issue.updatedAt && new Date(issue.updatedAt) >= cutoffDate
      );
    }

    // Build hierarchy from the *filtered* issues
    // TODO: Re-evaluate if hierarchy building is needed here or if a flat filtered list is sufficient
    // For now, keep hierarchy building but operate on the filtered list
    const hierarchy = this.buildHierarchy(filteredIssues, options.maxDepth || 2);

    return hierarchy;
  }

  /**
   * Get issues for a project, using cache if available and not expired
   * @param projectId Project ID to get issues for
   * @param forceRefresh Whether to force a cache refresh
   * @returns Array of issues
   */
  private async getIssues(projectId: LinearGuid, forceRefresh: boolean = false): Promise<BaseIssue[]> {
    const cacheKey = String(projectId);
    const now = Date.now();
    const cached = this.issuesCache.get(cacheKey);
    
    // Use cache if available, not expired, and not forcing refresh
    if (cached && !forceRefresh && (now - cached.timestamp < this.CACHE_EXPIRATION_MS)) {
      console.log(`[DEBUG] Using cached issues for project ${projectId} (${cached.issues.length} issues)`);
      return cached.issues;
    }
    
    // Otherwise fetch issues and update cache
    console.log(`[DEBUG] Fetching issues for project ${projectId} (cache miss or forced refresh)`);
    const issues = await fetchProjectIssues(this.linearClient, projectId);
    
    // Update cache
    this.issuesCache.set(cacheKey, { 
      issues, 
      timestamp: now 
    });
    
    return issues;
  }

  private buildHierarchy(
    issues: BaseIssue[],
    maxDepth: number,
    depth: number = 0,
    parentId?: LinearGuid
  ): HierarchicalIssue[] {
    if (depth >= maxDepth) {
      return [];
    }

    const filteredIssues = issues.filter(issue => {
      const hasCorrectParent = parentId
        ? issue.parent?.id === parentId
        : !issue.parent;
      return hasCorrectParent;
    });

    return filteredIssues.map(issue => {
      const children = this.buildHierarchy(issues, maxDepth, depth + 1, issue.id);
      if (children.length > 0) {
        return { ...issue, children } as HierarchicalIssue;
      }
      return issue as HierarchicalIssue;
    });
  }
}
