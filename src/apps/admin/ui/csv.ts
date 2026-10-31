/**
 * One quoted CSV field. Values that a spreadsheet would evaluate as a formula (leading = + - @ or
 * control whitespace) get a literal apostrophe prefix, so an attacker-chosen email cannot execute.
 */
export function csvField(value: string): string {
  const guarded = /^[=+@\-\t\r]/.test(value) ? `'${value}` : value;
  return `"${guarded.replaceAll('"', '""')}"`;
}

export function csvRow(values: readonly string[]): string {
  return values.map(csvField).join(",");
}
