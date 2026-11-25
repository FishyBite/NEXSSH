export const engines = {
  mysql: { name: "MySQL", port: 3306, database: "" },
  postgresql: { name: "PostgreSQL", port: 5432, database: "postgres" },
  oracle: { name: "Oracle", port: 1521, database: "" },
  sqlite: { name: "SQLite", port: 0, database: "" },
  sqlserver: { name: "SQL Server", port: 1433, database: "master" },
  mariadb: { name: "MariaDB", port: 3306, database: "" },
  mongodb: { name: "MongoDB", port: 27017, database: "test" },
  redis: { name: "Redis", port: 6379, database: "0" },
} as const;

export type Engine = keyof typeof engines;
export type Preset = { id: string; group: string; title: string; engine: Engine; port?: number };
function cloud(group: string, slug: string, choices: [Engine, string, number?][]): Preset[] {
  return choices.map(([engine, title, port]) => ({ id: slug + "-" + engine, group, title, engine, port }));
}
export const presets: Preset[] = [
  ...(Object.keys(engines) as Engine[]).map(engine => ({ id: engine, group: "Database", title: engines[engine].name, engine })),
  ...cloud("Amazon AWS", "aws", [["mysql", "RDS / Aurora MySQL"], ["postgresql", "RDS / Aurora PostgreSQL"], ["mariadb", "RDS for MariaDB"], ["sqlserver", "RDS for SQL Server"], ["oracle", "RDS for Oracle"]]),
  ...cloud("Google Cloud", "google", [["mysql", "Cloud SQL for MySQL"], ["postgresql", "Cloud SQL for PostgreSQL"], ["sqlserver", "Cloud SQL for SQL Server"]]),
  ...cloud("Oracle Cloud", "oci", [["oracle", "Oracle Database"], ["mysql", "MySQL HeatWave"]]),
  ...cloud("Microsoft Azure", "azure", [["sqlserver", "Azure SQL Database"], ["postgresql", "Azure Database for PostgreSQL"], ["mysql", "Azure Database for MySQL"]]),
  ...cloud("MongoDB Cloud Services", "atlas", [["mongodb", "MongoDB Atlas"]]),
  ...cloud("Redis Enterprise Cloud", "redis-cloud", [["redis", "Redis Cloud"]]),
  ...cloud("Alibaba Cloud", "alibaba", [["mysql", "ApsaraDB RDS for MySQL"], ["postgresql", "ApsaraDB RDS for PostgreSQL"]]),
  ...cloud("Tencent Cloud", "tencent", [["mysql", "TencentDB for MySQL"], ["postgresql", "TencentDB for PostgreSQL"]]),
  ...cloud("Huawei Cloud", "huawei", [["mysql", "RDS for MySQL"], ["postgresql", "RDS for PostgreSQL"]]),
  ...cloud("OceanBase", "oceanbase", [["mysql", "MySQL-compatible tenant", 2881]]),
];
export const presetGroups = [...new Set(presets.map(preset => preset.group))];

export interface DatabaseProfile {
  id: string;
  name: string;
  presetId: string;
  host: string;
  port: number;
  username: string;
  database: string;
  authSource: string;
  path: string;
  tls: boolean;
  viaSsh: boolean;
  sshHostId: string;
  production: boolean;
  readOnly: boolean;
  passwordMode?: "saved" | "prompt" | "none";
}
export const presetFor = (profile: DatabaseProfile) => presets.find(item => item.id === profile.presetId)!;
export const usesMongoSrv = (profile: DatabaseProfile) => profile.presetId === "atlas-mongodb" && !profile.viaSsh;
export function newProfile(preset: Preset, id: string): DatabaseProfile {
  return {
    id, name: "", presetId: preset.id, host: preset.group === "Database" ? "localhost" : "",
    port: preset.port ?? engines[preset.engine].port, username: "", database: engines[preset.engine].database,
    authSource: preset.id === "atlas-mongodb" ? "admin" : "", path: "", tls: preset.engine !== "sqlite",
    viaSsh: false, sshHostId: "", production: false, readOnly: false,
  };
}
// Copy only connection metadata across the storage boundary, including when reading an old profile.
export function cleanProfile(input: unknown): DatabaseProfile | null {
  if (!input || typeof input !== "object") return null;
  const entry = input as Record<string, unknown>;
  const preset = presets.find(candidate => candidate.id === entry.presetId);
  if (!preset || typeof entry.id !== "string" || !/^[\w-]{1,100}$/.test(entry.id)) return null;
  const result = newProfile(preset, entry.id);
  for (const key of ["name", "host", "username", "database", "path", "authSource", "sshHostId"] as const) {
    if (typeof entry[key] === "string") result[key] = entry[key].trim();
  }
  if (typeof entry.port === "number" && Number.isInteger(entry.port)) result.port = entry.port;
  result.tls = preset.engine !== "sqlite" && entry.tls !== false;
  result.viaSsh = preset.engine !== "sqlite" && entry.viaSsh === true;
  result.production = entry.production === true;
  result.readOnly = entry.readOnly === true || (result.production && entry.readOnly !== false);
  if (preset.engine !== "sqlite" && (entry.passwordMode === "saved" || entry.passwordMode === "prompt" || entry.passwordMode === "none")) {
    result.passwordMode = entry.passwordMode;
  }
  if (!result.viaSsh) result.sshHostId = "";
  return result;
}
export function validateProfile(profile: DatabaseProfile): string {
  const { engine } = presetFor(profile);
  if (!profile.name.trim()) return "Enter a connection name.";
  if (engine === "sqlite") return profile.path.trim() ? "" : "Choose a SQLite database file.";
  if (!profile.host.trim() || /[\s@/\\?#;]/.test(profile.host)) return "Enter a hostname or IP address, without credentials or a connection string.";
  if (usesMongoSrv(profile) && profile.host.includes(":")) return "Enter the Atlas cluster hostname without a port.";
  if (!Number.isInteger(profile.port) || profile.port < 1 || profile.port > 65535) return "Enter a port between 1 and 65535.";
  if (engine === "oracle" && !profile.database.trim()) return "Enter the Oracle service name.";
  if (engine === "redis" && !/^\d+$/.test(profile.database)) return "Enter a Redis database number starting at 0.";
  if (engine === "mongodb" && !profile.database) return "Enter the MongoDB database name.";
  return "";
}
export function readProfiles(workspace: string): DatabaseProfile[] {
  try {
    const value: unknown = JSON.parse(localStorage.getItem(profileKey(workspace)) || "[]");
    if (!Array.isArray(value)) return [];
    return value.map(cleanProfile).filter((item): item is DatabaseProfile => !!item && !validateProfile(item));
  } catch { return []; }
}
const profileKey = (workspace: string) => "nexssh.db.profiles.v1." + workspace;
const profileChanges = new EventTarget();
export function saveProfiles(workspace: string, profiles: DatabaseProfile[]) {
  localStorage.setItem(profileKey(workspace), JSON.stringify(profiles.map(cleanProfile)));
  profileChanges.dispatchEvent(new Event(profileKey(workspace)));
}
export function observeProfiles(workspace: string, refresh: () => void) {
  const key = profileKey(workspace);
  profileChanges.addEventListener(key, refresh);
  return () => profileChanges.removeEventListener(key, refresh);
}
export function connectionArgs(profile: DatabaseProfile, password: string, sshSessionId: string) {
  const { engine } = presetFor(profile);
  return {
    engine, host: profile.host, port: profile.port, username: profile.username,
    password, database: profile.database, path: profile.path, tls: profile.tls, authSource: profile.authSource,
    readOnly: profile.readOnly,
    ...(usesMongoSrv(profile) ? { mongoSrv: true } : {}),
    ...(profile.viaSsh ? { sshSessionId } : {}),
  };
}
export interface DbObject { schema: string; name: string; kind: string }
export interface DbGrid { columns: string[]; rows: (string | null)[][]; affected?: number; truncated: boolean }
