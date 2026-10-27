/**
 * Re-render a form with the user's input and error messages instead of losing what they typed.
 * Unexpected (non-user-facing) errors are rethrown to the central error handler.
 */
export function renderFormError(res, err, view, locals = {}) {
  if (!err.expose) throw err;
  res.status(err.status || 400).render(view, {
    ...locals,
    values: locals.values ?? res.req.body ?? {},
    errors: err.fieldErrors || {},
    formError: err.message,
  });
}

/** Parse a route param as a positive integer id; anything else is a 404. */
export function idParam(req, name = 'id') {
  const n = Number(req.params[name]);
  if (!Number.isInteger(n) || n <= 0 || n > 2_147_483_647) {
    const e = new Error('Not found');
    e.status = 404; e.expose = true;
    throw e;
  }
  return n;
}
