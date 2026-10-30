// A valid project name from a folder's or repository's name: lowercase words joined by
// single hyphens, starting with a letter, 3 to 48 characters (see projectSchema).
export function projectNameFrom(name: string) {
  let result = name
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
  if (!/^[a-z]/.test(result)) result = `app-${result}`;
  result = result.slice(0, 48).replace(/-+$/, '');
  return result.length < 3 ? `${result}-app` : result;
}
