/**
 * IDE Agent Error Classes
 * 
 * Custom error types for IDEAgent safety and limit enforcement.
 * These provide clear error categorization for:
 * - Path security violations
 * - Operation limit enforcement
 * - Dangerous command blocking
 */

/**
 * PathSecurityError - Thrown when path validation fails
 * 
 * Triggers:
 * - Path traversal attempts (../)
 * - Access to denied paths (.git, node_modules, .env, etc.)
 * - Paths outside workspace root
 */
class PathSecurityError extends Error {
  constructor(message) {
    super(message);
    this.name = 'PathSecurityError';
    this.code = 'PATH_SECURITY';
  }
}

/**
 * LimitExceededError - Thrown when operation limits are exceeded
 * 
 * Triggers:
 * - Max files modified reached
 * - Max write size per file exceeded
 * - Total bytes written limit exceeded
 */
class LimitExceededError extends Error {
  constructor(message) {
    super(message);
    this.name = 'LimitExceededError';
    this.code = 'LIMIT_EXCEEDED';
  }
}

/**
 * CommandBlockedError - Thrown when terminal command is blocked
 * 
 * Triggers:
 * - Dangerous rm commands
 * - sudo usage
 * - Pipe to shell patterns
 * - Filesystem operations (mkfs, etc.)
 */
class CommandBlockedError extends Error {
  constructor(message) {
    super(message);
    this.name = 'CommandBlockedError';
    this.code = 'COMMAND_BLOCKED';
  }
}

module.exports = {
  PathSecurityError,
  LimitExceededError,
  CommandBlockedError
};
