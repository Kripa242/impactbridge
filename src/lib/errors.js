/** An error whose message is safe to show to the user. */
export class AppError extends Error {
  constructor(status, message, extra = {}) {
    super(message);
    this.status = status;
    this.expose = true;
    Object.assign(this, extra);
  }
}

/** Input failed validation. `fieldErrors` maps field -> message for re-rendering forms. */
export class ValidationError extends AppError {
  constructor(fieldErrors) {
    super(400, 'Please fix the highlighted fields.', { fieldErrors });
  }
}

export const badRequest = (msg) => new AppError(400, msg);
export const unauthorized = (msg = 'Please log in to continue.') => new AppError(401, msg);
export const forbidden = (msg = 'You do not have permission to do that.') => new AppError(403, msg);
export const notFound = (what = 'Page') => new AppError(404, `${what} not found.`);
export const conflict = (msg) => new AppError(409, msg);
