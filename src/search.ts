export function fuzzyMatch(query: string, value: string): boolean {
  const text = value.toLowerCase();
  let index = 0;
  for (const character of query.toLowerCase()) {
    index = text.indexOf(character, index);
    if (index === -1) return false;
    index++;
  }
  return true;
}
