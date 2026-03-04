import * as crypto from 'node:crypto';
import chalk from 'chalk';
import type { ChangeResult } from '@/linear/changes';
import { logger } from '@/utils/logger';

export class ErrorLogger {
  constructor() {}

  /**
   * Log any global error that wasn't caught by normal error handling
   */
  public async logGlobalError(
    errorType: string,
    error: Error,
    additionalData: Record<string, any> = {},
    context: { linearChanges: any[]; state: any }
  ): Promise<void> {
    try {
      const timestamp = new Date().toISOString();
      const errorId = crypto.randomUUID().substring(0, 8);
      
      const logEntry = {
        timestamp,
        errorType,
        error: {
          message: error.message,
          name: error.name,
          stack: error.stack,
          ...Object.fromEntries(
            Object.entries(error).filter(([key]) => !['message', 'stack', 'name'].includes(key))
          ),
        },
        additionalData,
        context: {
          linearChanges: context.linearChanges,
          state: context.state,
          system: {
            platform: process.platform,
            nodeVersion: process.version,
            cwd: process.cwd(),
          },
        },
      };

      // Use our centralized logger to save the error
      logger.saveDiagnostic(logEntry, `global-error-${errorType}-${errorId}`);
      logger.logError(error, `Global error: ${errorType}`);

      console.error(chalk.red(`Global error logged to logs directory`));
    } catch (logError) {
      // Last resort if we can't even log the error
      console.error('CRITICAL: Failed to log error:', logError);
      console.error('Original error:', error);
    }
  }

  /**
   * Consolidated error logging method that handles all types of errors
   */
  public async logError(
    error: Error | ChangeResult[] | unknown,
    context: string = '',
    systemContext: { linearChangesCount: number; projectsCount: number }
  ): Promise<void> {
    try {
      const timestamp = new Date().toISOString();
      const errorId = crypto.randomUUID().substring(0, 8);

      // Prepare the error details and log them
      if (Array.isArray(error)) {
        // Handle array of ChangeResults
        const failedResults = error.filter((r) => !r.success);
        if (failedResults.length === 0) return;

        // Format the error details
        const errorDetails = {
          errorId,
          timestamp,
          context: context || 'Linear Changes Failure',
          failedOperations: failedResults.map((result, index) => {
            const err = result.error instanceof Error ? result.error : new Error(String(result.error));
            return {
              index: index + 1,
              operation: `${result.change.operation} ${result.change.entityType}`,
              description: result.change.description,
              error: err.message,
              stack: err.stack || 'No stack trace available',
              payload: result.change.payload
            };
          }),
          systemContext
        };
        
        // Log the error using our centralized logger
        logger.saveDiagnostic(errorDetails, `linear-errors-${errorId}`);
        
        // Also log each error individually for better traceability
        failedResults.forEach((result, index) => {
          const err = result.error instanceof Error ? result.error : new Error(String(result.error));
          logger.logError(err, `${context}: Operation ${index + 1} - ${result.change.operation} ${result.change.entityType}`);
        });
      } else {
        // Handle single error
        const err = error instanceof Error ? error : new Error(String(error));
        
        // Format the error details
        const errorDetails = {
          errorId,
          timestamp,
          context: context || 'Unknown Context',
          error: {
            message: err.message,
            stack: err.stack || 'No stack trace available'
          },
          systemInfo: {
            nodeVersion: process.version,
            platform: process.platform,
            workingDirectory: process.cwd(),
          },
          systemContext
        };
        
        // Log the error using our centralized logger
        logger.saveDiagnostic(errorDetails, `error-${errorId}`);
        logger.logError(err, context);
      }

      // Console output for immediate feedback
      console.error(chalk.red(`\nError logged to logs directory`));
    } catch (loggingError) {
      // Last resort if logging completely fails
      console.error(chalk.red(`\nCRITICAL: Failed to log error: ${loggingError}`));
      console.error(chalk.red('Original error:'));
      console.error(error);
    }
  }
}
