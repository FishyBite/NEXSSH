import type { Host } from "./types";

export const environmentNames = { production: "Production", staging: "Staging", development: "Development", lab: "Lab" };
export function EnvironmentBadge({ value }: { value: Host["environmentLabel"] }) {
  if (!value || !Object.hasOwn(environmentNames, value)) return null;
  return <span className={`environment-badge env-${value}`}>{environmentNames[value]}</span>;
}
