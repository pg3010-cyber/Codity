// ApiError carries an HTTP status and a stable machine-readable code so
// clients can branch on `error.code` instead of parsing messages.

class ApiError extends Error {
  constructor(status, code, message, details) {
    super(message);
    this.status = status;
    this.code = code;
    this.details = details;
  }

  static badRequest(message, details) {
    return new ApiError(400, 'bad_request', message, details);
  }
  static unauthorized(message = 'Authentication required') {
    return new ApiError(401, 'unauthorized', message);
  }
  static forbidden(message = 'Insufficient permissions') {
    return new ApiError(403, 'forbidden', message);
  }
  static notFound(resource = 'Resource') {
    return new ApiError(404, 'not_found', `${resource} not found`);
  }
  static conflict(message, details) {
    return new ApiError(409, 'conflict', message, details);
  }
}

module.exports = { ApiError };
