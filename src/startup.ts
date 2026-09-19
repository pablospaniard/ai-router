export function shouldRunInitialSetup(raw: string[], isTTY: boolean, hasConfig: boolean): boolean {
  if (hasConfig || !isTTY) return false;
  if (["setup", "models", "config"].includes(raw[0] ?? "")) return false;
  return !raw.includes("--help") && !raw.includes("-h") && !raw.includes("--version") && !raw.includes("-v");
}
