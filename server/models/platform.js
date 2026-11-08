// What every record gets, whatever its type: comments, files, assignments, notifications,
// custom fields, permission overrides, saved reports, scheduled jobs.
import mongoose from 'mongoose';
import { baseOptions } from './plugins.js';

const { Schema } = mongoose;
const Id = Schema.Types.ObjectId;

const entity = {
  entityType: { type: String, required: true },
  entityId: { type: String, required: true },
};

const commentSchema = new Schema({
  ...entity,
  body: { type: String, required: true },
  byId: { type: Id, ref: 'User' },
  byName: String,
}, baseOptions);
commentSchema.index({ entityType: 1, entityId: 1, createdAt: -1 });
export const Comment = mongoose.model('Comment', commentSchema);

const attachmentSchema = new Schema({
  ...entity,
  fileId: { type: Id, required: true },
  filename: { type: String, required: true },
  contentType: { type: String, required: true },
  sizeBytes: { type: Number, required: true },
  byId: { type: Id, ref: 'User' },
  byName: String,
}, baseOptions);
attachmentSchema.index({ entityType: 1, entityId: 1, createdAt: -1 });
export const Attachment = mongoose.model('Attachment', attachmentSchema);

const todoSchema = new Schema({
  ...entity,
  entityLabel: { type: String, default: '' },
  assignedTo: { type: Id, ref: 'User', required: true },
  assignedToName: String,
  assignedByName: String,
  note: { type: String, default: '' },
  dueOn: { type: String, default: null },
  isDone: { type: Boolean, default: false },
  doneAt: { type: Date, default: null },
}, baseOptions);
todoSchema.index({ assignedTo: 1, isDone: 1, dueOn: 1 });
todoSchema.index({ entityType: 1, entityId: 1 });
export const Todo = mongoose.model('Todo', todoSchema);

const notificationSchema = new Schema({
  userId: { type: Id, ref: 'User', required: true },
  title: { type: String, required: true },
  link: { type: String, default: null },
  readAt: { type: Date, default: null },
}, baseOptions);
notificationSchema.index({ userId: 1, readAt: 1, createdAt: -1 });
export const Notification = mongoose.model('Notification', notificationSchema);

const customFieldSchema = new Schema({
  doctype: { type: String, required: true },
  key: { type: String, required: true },
  label: { type: String, required: true },
  type: { type: String, enum: ['text', 'long', 'int', 'check', 'date', 'select', 'money', 'qty'], required: true },
  options: { type: [String], default: undefined },
  required: { type: Boolean, default: false },
}, baseOptions);
customFieldSchema.index({ doctype: 1, key: 1 }, { unique: true });
export const CustomField = mongoose.model('CustomField', customFieldSchema);

const rolePermissionSchema = new Schema({
  doctype: { type: String, required: true },
  role: { type: String, required: true },
  read: { type: Boolean, default: false },
  write: { type: Boolean, default: false },
  submit: { type: Boolean, default: false },
  cancel: { type: Boolean, default: false },
}, baseOptions);
rolePermissionSchema.index({ doctype: 1, role: 1 }, { unique: true });
export const RolePermission = mongoose.model('RolePermission', rolePermissionSchema);

const savedReportSchema = new Schema({
  name: { type: String, required: true },
  doctype: { type: String, required: true },
  columns: { type: [String], default: [] },
  groupBy: { type: String, default: null },
  sums: { type: [String], default: [] },
  filters: { type: Schema.Types.Mixed, default: {} },
  isShared: { type: Boolean, default: false },
  byId: { type: Id, ref: 'User' },
}, baseOptions);
export const SavedReport = mongoose.model('SavedReport', savedReportSchema);

const jobStateSchema = new Schema({
  _id: String,
  nextRunAt: { type: Date, default: () => new Date(0) },
  lockedUntil: { type: Date, default: () => new Date(0) },
  lastRunAt: { type: Date, default: null },
  lastResult: { type: String, default: null },
  lastError: { type: String, default: null },
}, { versionKey: false, toJSON: baseOptions.toJSON });
export const JobState = mongoose.model('JobState', jobStateSchema);

const emailSchema = new Schema({
  to: { type: String, required: true },
  subject: { type: String, required: true },
  body: { type: String, required: true },
  status: { type: String, enum: ['QUEUED', 'SENT', 'FAILED', 'NOT_CONFIGURED'], default: 'QUEUED' },
  attempts: { type: Number, default: 0 },
  error: { type: String, default: null },
  sentAt: { type: Date, default: null },
}, baseOptions);
emailSchema.index({ status: 1, createdAt: 1 });
export const EmailQueue = mongoose.model('EmailQueue', emailSchema);
