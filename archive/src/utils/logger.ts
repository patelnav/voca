import * as fs from 'node:fs';
import * as path from 'node:path';
import * as crypto from 'node:crypto';
import * as util from 'node:util';

/**
 * Centralized logger that stores all logs in a timestamp-based directory structure
 * Consolidates logs from:
 * - diagnostics/ directory
 * - cli-log-* files in root
 * - logs/ directory
 */
export class Logger {
  private sessionDir: string;
  private diagnosticsDir: string;
  private apiLogsDir: string;
  private cliLogsDir: string;
  private errorsDir: string;
  private originalConsole: { [key: string]: any } = {};

  constructor() {
    // Create a session timestamp and ID
    const timestamp = new Date().toISOString().replace(/:/g, '-').split('.')[0];
    
    // Create directory structure
    this.sessionDir = path.join(process.cwd(), 'logs', timestamp);
    this.diagnosticsDir = path.join(this.sessionDir, 'diagnostics');
    this.apiLogsDir = path.join(this.sessionDir, 'api');
    this.cliLogsDir = path.join(this.sessionDir, 'cli');
    this.errorsDir = path.join(this.sessionDir, 'errors');
    
    // Create directories
    this.ensureDirectoriesExist();
    
    // Set up console capture
    this.setupConsoleCapture();
  }

  /**
   * Strip ANSI color codes from a string
   * @param input The string to strip color codes from
   * @returns The string without color codes
   */
  private stripAnsiColorCodes(input: string): string {
    // Replace the regex with control characters with a string literal
    const ANSI_COLOR_REGEX = '\x1b\\[[0-9;]*m';
    return input.replace(ANSI_COLOR_REGEX, '');
  }

  /**
   * Set up console capture to log all console output
   */
  private setupConsoleCapture(): void {
    // Save original console methods
    this.originalConsole.log = console.log;
    this.originalConsole.error = console.error;
    this.originalConsole.warn = console.warn;
    this.originalConsole.info = console.info;
    this.originalConsole.debug = console.debug;
    
    // Override console.log
    console.log = (...args: any[]) => {
      // Call original console.log
      this.originalConsole.log(...args);
      
      // Log to file
      const message = args.map(arg => 
        typeof arg === 'string' ? arg : util.inspect(arg)
      ).join(' ');
      
      // Strip color codes before logging
      this.logCli(`[LOG] ${this.stripAnsiColorCodes(message)}`);
    };
    
    // Override console.error
    console.error = (...args: any[]) => {
      // Call original console.error
      this.originalConsole.error(...args);
      
      // Log to file
      const message = args.map(arg => 
        typeof arg === 'string' ? arg : util.inspect(arg)
      ).join(' ');
      
      // Strip color codes before logging
      this.logCli(`[ERROR] ${this.stripAnsiColorCodes(message)}`);
    };
    
    // Override console.warn
    console.warn = (...args: any[]) => {
      // Call original console.warn
      this.originalConsole.warn(...args);
      
      // Log to file
      const message = args.map(arg => 
        typeof arg === 'string' ? arg : util.inspect(arg)
      ).join(' ');
      
      // Strip color codes before logging
      this.logCli(`[WARN] ${this.stripAnsiColorCodes(message)}`);
    };
    
    // Override console.info
    console.info = (...args: any[]) => {
      // Call original console.info
      this.originalConsole.info(...args);
      
      // Log to file
      const message = args.map(arg => 
        typeof arg === 'string' ? arg : util.inspect(arg)
      ).join(' ');
      
      // Strip color codes before logging
      this.logCli(`[INFO] ${this.stripAnsiColorCodes(message)}`);
    };
  }

  /**
   * Ensure all required directories exist
   */
  private ensureDirectoriesExist(): void {
    try {
      fs.mkdirSync(this.sessionDir, { recursive: true });
      fs.mkdirSync(this.diagnosticsDir, { recursive: true });
      fs.mkdirSync(this.apiLogsDir, { recursive: true });
      fs.mkdirSync(this.cliLogsDir, { recursive: true });
      fs.mkdirSync(this.errorsDir, { recursive: true });
      
      // Create empty log files to ensure they exist
      const cliLogPath = path.join(this.cliLogsDir, 'cli.log');
      const errorLogPath = path.join(this.errorsDir, 'all-errors.log');
      const apiPlaceholderPath = path.join(this.apiLogsDir, 'api-log-placeholder.json');
      const diagnosticsPlaceholderPath = path.join(this.diagnosticsDir, 'diagnostics-placeholder.json');
      
      if (!fs.existsSync(cliLogPath)) {
        fs.writeFileSync(cliLogPath, `[${new Date().toISOString()}] Log file created\n`, 'utf8');
      }
      
      if (!fs.existsSync(errorLogPath)) {
        fs.writeFileSync(errorLogPath, `[${new Date().toISOString()}] Error log file created\n`, 'utf8');
      }
      
      if (!fs.existsSync(apiPlaceholderPath)) {
        const placeholderContent = JSON.stringify({
          timestamp: new Date().toISOString(),
          message: 'API logs placeholder file created'
        }, null, 2);
        fs.writeFileSync(apiPlaceholderPath, placeholderContent, 'utf8');
      }
      
      if (!fs.existsSync(diagnosticsPlaceholderPath)) {
        const placeholderContent = JSON.stringify({
          timestamp: new Date().toISOString(),
          message: 'Diagnostics placeholder file created'
        }, null, 2);
        fs.writeFileSync(diagnosticsPlaceholderPath, placeholderContent, 'utf8');
      }
    } catch (error) {
      console.error(`Failed to create log directories: ${(error as Error).message}`);
    }
  }

  /**
   * Get the path to the session directory
   */
  public getSessionDir(): string {
    return this.sessionDir;
  }

  /**
   * Get the path to the diagnostics directory
   */
  public getDiagnosticsDir(): string {
    return this.diagnosticsDir;
  }

  /**
   * Get the path to the CLI logs directory
   */
  public getCliLogsDir(): string {
    return this.cliLogsDir;
  }

  /**
   * Get the path to the API logs directory
   */
  public getApiLogsDir(): string {
    return this.apiLogsDir;
  }

  /**
   * Get the path to the errors directory
   */
  public getErrorsDir(): string {
    return this.errorsDir;
  }

  /**
   * Save diagnostic data to the diagnostics directory
   * @param data The data to save
   * @param filename The filename to use
   */
  public saveDiagnostic(data: unknown, filename: string): void {
    try {
      // Sanitize the filename - remove any invalid characters and ensure it's a valid filename
      // This prevents file system errors when JSON or other content is passed instead of a proper filename
      let sanitizedName = String(filename)
        .replace(/[^a-z0-9_\-.]/gi, '_') // Replace invalid chars with underscore
        .substring(0, 40);  // Hard limit on base name length
      
      // Ensure filename has the correct extension
      const safeFilename = sanitizedName.endsWith('.json') 
        ? sanitizedName 
        : `${sanitizedName}.json`;
      
      // Add a timestamp and random ID to make filenames unique and avoid collisions
      const timestamp = new Date().toISOString().split('T')[1].split(':').join('-').split('.')[0];
      const randomId = crypto.randomBytes(4).toString('hex');
      const uniqueFilename = `${timestamp}-${safeFilename.replace(/\.json$/, '')}-${randomId}.json`;
      
      const filePath = path.join(this.diagnosticsDir, uniqueFilename);
      
      // If data is an object, stringify it
      const content = typeof data === 'object' 
        ? JSON.stringify(data, null, 2) 
        : String(data);
      
      fs.writeFileSync(filePath, content, 'utf8');
    } catch (error) {
      console.error(`Failed to save diagnostic data: ${(error as Error).message}`);
    }
  }

  /**
   * Log an error to the errors directory
   * @param error The error to log
   * @param context Additional context for the error
   */
  public logError(error: Error | unknown, context: string = ''): void {
    try {
      const timestamp = new Date().toISOString().replace(/:/g, '-');
      const errorId = crypto.randomUUID().substring(0, 8);
      const filename = `error-${timestamp}-${errorId}.log`;
      const filePath = path.join(this.errorsDir, filename);
      
      // Format the error
      const err = error instanceof Error ? error : new Error(String(error));
      const content = [
        `Timestamp: ${new Date().toISOString()}`,
        `Context: ${context}`,
        `Error: ${err.message}`,
        `Stack: ${err.stack || 'No stack trace available'}`,
      ].join('\n');
      
      fs.writeFileSync(filePath, content, 'utf8');
      
      // Also append to main error log
      this.appendLog(path.join(this.errorsDir, 'all-errors.log'), 
        `[${new Date().toISOString()}] ${context}: ${err.message}\n`);
    } catch (loggingError) {
      console.error(`Failed to log error: ${(loggingError as Error).message}`);
      console.error('Original error:', error);
    }
  }

  /**
   * Save an API log to the API logs directory
   * @param type The type of API log (request, response, etc.)
   * @param data The data to log
   */
  public saveApiLog(type: string, data: unknown): void {
    try {
      // Create a placeholder file if the directory is empty
      this.ensureApiLogExists();
      
      const timestamp = new Date().toISOString().replace(/:/g, '-');
      const filename = `api-${type}-${timestamp}.json`;
      const filePath = path.join(this.apiLogsDir, filename);
      
      // If data is an object, stringify it
      const content = typeof data === 'object' 
        ? JSON.stringify(data, null, 2) 
        : String(data);
      
      fs.writeFileSync(filePath, content, 'utf8');
    } catch (error) {
      console.error(`Failed to save API log: ${(error as Error).message}`);
    }
  }

  /**
   * Ensure that at least one placeholder file exists in the API logs directory
   */
  private ensureApiLogExists(): void {
    try {
      // Check if the directory is empty
      const files = fs.readdirSync(this.apiLogsDir);
      
      if (files.length === 0) {
        // Create a placeholder file
        const placeholderPath = path.join(this.apiLogsDir, 'api-log-placeholder.json');
        const placeholderContent = JSON.stringify({
          timestamp: new Date().toISOString(),
          message: 'API logs placeholder file created'
        }, null, 2);
        
        fs.writeFileSync(placeholderPath, placeholderContent, 'utf8');
      }
    } catch (error) {
      console.error(`Failed to ensure API log exists: ${(error as Error).message}`);
    }
  }

  /**
   * Log a CLI message to the CLI logs directory
   * @param message The message to log
   */
  public logCli(message: string): void {
    try {
      const timestamp = new Date().toISOString();
      const logLine = `[${timestamp}] ${message}\n`;
      
      // Append to main CLI log - use direct file operations to avoid infinite loop
      try {
        fs.appendFileSync(path.join(this.cliLogsDir, 'cli.log'), logLine, 'utf8');
      } catch (error) {
        // Use original console to avoid infinite loop
        if (this.originalConsole && this.originalConsole.error) {
          this.originalConsole.error(`Failed to log CLI message: ${(error as Error).message}`);
        }
      }

      // Also, print to original console if it exists and we are in debug mode
      // Check for an environment variable to control CLI output during tests or normal runs
      // const shouldOutputToConsole = process.env.AGENT_LOG_TO_CONSOLE === 'true' || process.env.NODE_ENV !== 'test';
      const shouldOutputToConsole = true; // FORCED FOR RELIABLE DEBUGGING
      
      if (this.originalConsole.log && shouldOutputToConsole) {
        this.originalConsole.log(this.stripAnsiColorCodes(message)); // Use originalConsole.log to avoid recursion
      }
    } catch (error) {
      // Use original console to avoid infinite loop
      if (this.originalConsole && this.originalConsole.error) {
        this.originalConsole.error(`Failed to log CLI message: ${(error as Error).message}`);
      }
    }
  }

  /**
   * Append to a log file
   * @param filePath The path to the log file
   * @param content The content to append
   */
  private appendLog(filePath: string, content: string): void {
    try {
      // Always use synchronous file operations to ensure logs are written immediately
      fs.appendFileSync(filePath, content, 'utf8');
    } catch (error) {
      console.error(`Failed to append to log: ${(error as Error).message}`);
    }
  }

  /**
   * Get a single instance of the logger
   */
  public static getInstance(): Logger {
    if (!Logger.instance) {
      Logger.instance = new Logger();
    }
    return Logger.instance;
  }

  /**
   * Explicitly flush logs - this is a no-op since we use synchronous file operations,
   * but it's included for API completeness and future-proofing
   */
  public flush(): void {
    try {
      // Log a flush marker
      const timestamp = new Date().toISOString();
      const flushMarker = `[${timestamp}] === FLUSH MARKER ===\n`;
      
      // Write flush markers to all log files
      fs.appendFileSync(path.join(this.cliLogsDir, 'cli.log'), flushMarker, 'utf8');
      fs.appendFileSync(path.join(this.errorsDir, 'all-errors.log'), flushMarker, 'utf8');
      
      // We use synchronous file operations, so no explicit flush is needed beyond this
      if (this.originalConsole && this.originalConsole.debug) {
        this.originalConsole.debug('Logger flush called - flush markers written');
      }
    } catch (error) {
      if (this.originalConsole && this.originalConsole.error) {
        this.originalConsole.error(`Failed to flush logs: ${(error as Error).message}`);
      }
    }
  }

  private static instance: Logger | null = null;
}

// Export a singleton instance of the logger
export const logger = Logger.getInstance(); 