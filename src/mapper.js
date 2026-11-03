const read = (record, path) =>
  path.split('.').reduce((value, key) => (value == null ? undefined : value[key]), record);

/**
 * Builds a mapper (your record -> what the platform expects) from a spec. Each entry is
 *   - a string: a (dotted) path into your record          { name: 'fullName', 'info.name': 'site.title' }
 *   - a function: computed from the record               { name: (r) => `${r.first} ${r.last}` }
 *   - constant('x'): a fixed value                        { elementId: constant('abc...'), type: constant('FARMER') }
 *   - a number / boolean / object: also taken as is
 * Dotted keys build nested objects, `undefined` / `null` results are left out so an update never blanks a field.
 */
/** A fixed value for every record. Plain strings are always paths into the record, so a literal string needs this. */
export const constant = (value) => () => value;

export function createMapper(spec) {
  return (record) => {
    const out = {};
    for (const [key, source] of Object.entries(spec)) {
      const value =
        typeof source === 'function' ? source(record) : typeof source === 'string' ? read(record, source) : source;
      if (value === undefined || value === null) continue;
      const parts = key.split('.');
      let target = out;
      for (const part of parts.slice(0, -1)) target = target[part] ??= {};
      target[parts.at(-1)] = value;
    }
    return out;
  };
}
