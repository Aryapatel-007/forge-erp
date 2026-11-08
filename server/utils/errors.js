export class AppError extends Error {
  constructor(status, code, message, details) {
    super(message);
    this.status = status;
    this.code = code;
    this.details = details;
  }
}

export const badRequest = (message, details) => new AppError(400, 'VALIDATION_FAILED', message, details);
export const unauthenticated = (message = 'Please sign in.') => new AppError(401, 'UNAUTHENTICATED', message);
export const forbidden = (message = 'You do not have permission to do this.') => new AppError(403, 'FORBIDDEN', message);
export const notFound = (what = 'Record') => new AppError(404, 'NOT_FOUND', `${what} was not found.`);
export const conflict = (message, code = 'CONFLICT', details) => new AppError(409, code, message, details);
export const rule = (message, code = 'BUSINESS_RULE_VIOLATED', details) => new AppError(422, code, message, details);
