import { describe, expect, it } from "vitest";
import { serialPortLabel, suggestedPort, updateSerialPorts, type DetectedPort } from "./useSerialPorts";

const port = (name: string, inUse = false): DetectedPort => ({
  name, inUse, kind: "USB", product: "USB UART (" + name + ")",
  manufacturer: "Adapter maker", usbId: "0403:6001",
});
const first = updateSerialPorts({ ports: [], added: new Map() }, [port("COM4")], 0, true);

describe("detecting serial devices", () => {
  it("keeps names informative even when a driver omits its product or repeats the port name", () => {
    expect(serialPortLabel(port("COM4"))).toBe("COM4 · USB UART · Adapter maker · 0403:6001");
    expect(serialPortLabel({ ...port("COM4"), manufacturer: null, product: null })).toBe("COM4 · USB · 0403:6001");
  });
  it("only identifies unique arrivals after a successful initial scan", () => {
    expect(suggestedPort("", first)).toBe("");
    const arrived = updateSerialPorts(first, [...first.ports, port("COM7")], 100, false);
    expect(suggestedPort("", arrived)).toBe("COM7");
    const both = updateSerialPorts(arrived, [...arrived.ports, port("COM9")], 200, false);
    expect(suggestedPort("COM7", both)).toBe("");
    const removed = updateSerialPorts(both, first.ports, 300, false);
    expect(suggestedPort("COM7", removed)).toBe("");
    const occupied = updateSerialPorts(removed, [...first.ports, port("COM7", true)], 400, false);
    expect(suggestedPort("", occupied)).toBe("");
  });
  it("expires indicators, preserves an existing suggestion while present, and re-baselines on view return", () => {
    const arrived = updateSerialPorts(first, [...first.ports, port("COM7")], 100, false);
    const expired = updateSerialPorts(arrived, arrived.ports, 30100, false);
    expect(expired.added.size).toBe(0);
    expect(suggestedPort("COM7", expired)).toBe("COM7");
    expect(updateSerialPorts(arrived, arrived.ports, 200, true).added.size).toBe(0);
  });
});
