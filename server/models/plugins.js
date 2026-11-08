// Shared schema behaviour.
// Renames _id to id all the way down, because a line on a document needs its id too.
function renameIds(value) {
  if (Array.isArray(value)) {
    value.forEach(renameIds);
    return;
  }
  if (!value || typeof value !== 'object' || Object.getPrototypeOf(value) !== Object.prototype) return;
  if (value._id !== undefined) {
    value.id = String(value._id);
    delete value._id;
  }
  delete value.__v;
  Object.values(value).forEach(renameIds);
}

export const jsonOptions = {
  virtuals: false,
  versionKey: false,
  transform(_doc, ret) {
    renameIds(ret);
    return ret;
  },
};

const BLOCKED_QUERIES = [
  'updateOne', 'updateMany', 'findOneAndUpdate', 'findOneAndReplace', 'replaceOne',
  'deleteOne', 'deleteMany', 'findOneAndDelete',
];

// A ledger only ever grows. This stops application code; the database role in
// scripts/dbRoles.js stops everything else in production.
export function appendOnly(schema, { name }) {
  const refuse = () => {
    throw new Error(`${name} is append-only`);
  };
  for (const op of BLOCKED_QUERIES) {
    schema.pre(op, { document: false, query: true }, refuse);
  }
  schema.pre('deleteOne', { document: true, query: false }, refuse);
  schema.pre('bulkWrite', refuse);
  schema.pre('save', function guardSave() {
    if (!this.isNew) refuse();
  });
}

export const baseOptions = { timestamps: true, toJSON: jsonOptions, toObject: jsonOptions };
