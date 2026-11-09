import rateLimit from 'express-rate-limit';
import mongoose from 'mongoose';
import { User } from '../models/core.js';
import { can } from '../config/permissions.js';
import { isTest } from '../config/env.js';
import { verifyAccessToken } from '../services/authService.js';
import { allowed, featureOff, featureOffError, policy } from '../services/policyService.js';
import { FEATURE_OF_PERM } from '../config/features.js';
import { AppError, badRequest, forbidden, unauthenticated } from '../utils/errors.js';

export async function authenticate(req, _res, next) {
  const header = req.get('authorization') ?? '';
  const token = header.startsWith('Bearer ') ? header.slice(7) : null;
  if (!token) throw unauthenticated();
  let claims;
  try {
    claims = verifyAccessToken(token);
  } catch (error) {
    if (error.name === 'TokenExpiredError') throw new AppError(401, 'TOKEN_EXPIRED', 'Your session has expired.');
    throw unauthenticated();
  }
  const user = await User.findById(claims.sub).lean();
  if (!user || !user.isActive) throw unauthenticated();
  // A token minted before a password change stops working. Fails closed on the same second.
  if (user.passwordChangedAt && claims.iat * 1000 <= user.passwordChangedAt.getTime()) throw unauthenticated();
  // Closed by default: a new route cannot leak to a portal sign-in by being forgotten here.
  if (user.role === 'PORTAL' && !/^\/api\/v1\/(portal|auth|meta)(\/|$|\?)/.test(req.originalUrl)) throw forbidden();
  // The role is always read fresh, so a demoted user loses access at once.
  req.user = { id: user._id, name: user.name, email: user.email, role: user.role };
  next();
}

// The role's permission, unless the maintainer switched the feature off or took the screen
// away from that role.
export const requirePerm = (permission) => async (req, _res, next) => {
  if (!can(req.user.role, permission)) throw forbidden();
  if (featureOff(await policy(), FEATURE_OF_PERM.get(permission))) throw featureOffError();
  if (!(await allowed(req.user.role, permission))) throw forbidden('The maintainer has not given your role this screen.');
  next();
};

// Validates and replaces the body. Unknown fields are refused by the strict schemas.
export const validate = (schema) => (req, _res, next) => {
  const result = schema.safeParse(req.body ?? {});
  if (!result.success) {
    const fields = {};
    for (const issue of result.error.issues) fields[issue.path.join('.') || '_'] = issue.message;
    throw badRequest('Please check the form.', { fields });
  }
  req.body = result.data;
  next();
};

export function requireObjectId(req, _res, next, value) {
  if (!mongoose.isValidObjectId(value)) throw badRequest('That id is not valid.');
  next();
}

// A cross-site form or image cannot set this header, and a cross-site fetch that sets it
// fails the CORS preflight. Guards the routes that act on the refresh cookie.
export function requireCsrfHeader(req, _res, next) {
  if (req.get('x-requested-with') !== 'forge') throw forbidden('Missing request header.');
  next();
}

const limitHandler = (_req, res) => {
  res.status(429).json({ success: false, error: { code: 'RATE_LIMITED', message: 'Too many attempts. Please wait and try again.' } });
};

export const loginLimiter = rateLimit({ windowMs: 15 * 60000, limit: 10, skipSuccessfulRequests: true, skip: () => isTest, handler: limitHandler, standardHeaders: true, legacyHeaders: false });
export const apiLimiter = rateLimit({ windowMs: 15 * 60000, limit: 5000, skip: () => isTest, handler: limitHandler, standardHeaders: true, legacyHeaders: false });

export function errorHandler(error, req, res, _next) {
  let appError = error instanceof AppError ? error : null;
  if (!appError && error?.code === 11000) {
    appError = new AppError(409, 'DUPLICATE', 'A record with those details already exists.');
  }
  if (!appError && error?.name === 'ValidationError') {
    const fields = {};
    for (const [key, value] of Object.entries(error.errors ?? {})) fields[key] = value.message;
    appError = badRequest('Please check the form.', { fields });
  }
  if (!appError && error?.name === 'ZodError') {
    const fields = {};
    for (const issue of error.issues ?? []) fields[issue.path.join('.') || '_'] = issue.message;
    appError = badRequest('Please check the form.', { fields });
  }
  if (!appError && error?.name === 'CastError') appError = badRequest('A value in this request is not valid.');
  if (!appError && error?.type === 'entity.parse.failed') appError = badRequest('The request body is not valid JSON.');
  if (!appError && error?.type === 'entity.too.large') appError = new AppError(413, 'TOO_LARGE', 'This request is too large.');
  if (!appError) {
    req.log?.error({ err: error, route: req.originalUrl }, 'Unhandled error');
    appError = new AppError(500, 'INTERNAL_ERROR', 'Something went wrong on our side.');
  }
  res.status(appError.status).json({
    success: false,
    error: { code: appError.code, message: appError.message, ...(appError.details ?? {}) },
  });
}
