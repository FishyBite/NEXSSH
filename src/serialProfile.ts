export interface SerialProfile {
  id: string;
  workspaceId: string;
  name: string;
  port: string;
  baud: number;
  dataBits: number;
  stopBits: number;
  parity: "none" | "even" | "odd";
  flow: "none" | "hardware" | "software";
  enter: "cr" | "lf" | "crlf";
  localEcho: boolean;
}

export function newSerialProfile(workspaceId: string): SerialProfile {
  return {
    id: crypto.randomUUID(),
    workspaceId,
    name: "",
    port: "",
    baud: 9600,
    dataBits: 8,
    stopBits: 1,
    parity: "none",
    flow: "none",
    enter: "cr",
    localEcho: false,
  };
}

export function validSerialProfile(value: unknown): value is SerialProfile {
  if (!value || typeof value !== "object") return false;
  const p = value as SerialProfile;
  return (
    typeof p.id === "string" &&
    !!p.id &&
    typeof p.workspaceId === "string" &&
    typeof p.name === "string" &&
    typeof p.port === "string" &&
    Number.isInteger(p.baud) &&
    p.baud >= 50 &&
    p.baud <= 4000000 &&
    [5, 6, 7, 8].includes(p.dataBits) &&
    [1, 2].includes(p.stopBits) &&
    ["none", "even", "odd"].includes(p.parity) &&
    ["none", "hardware", "software"].includes(p.flow) &&
    ["cr", "crlf", "lf"].includes(p.enter) &&
    typeof p.localEcho === "boolean"
  );
}

export const serialFraming = (p: SerialProfile) =>
  p.dataBits + p.parity[0].toUpperCase() + p.stopBits;
export function serialInput(input: string, enter: SerialProfile["enter"]) {
  if (input !== "\r") return input;
  return enter === "lf" ? "\n" : enter === "crlf" ? "\r\n" : "\r";
}
