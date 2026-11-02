import { describe, expect, test } from "bun:test";
import { isAllowedClient, isPrivateIpv4, localSubnets, subnetOf } from "../src/lan";

const home = [subnetOf("10.20.30.233", 24)!];

describe("LAN gate", () => {
  test("allows a phone on the same /24", () => {
    expect(isAllowedClient("10.20.30.50", home)).toBe(true);
    expect(isAllowedClient("::ffff:10.20.30.50", home)).toBe(true);
  });

  test("refuses other private subnets, public, IPv6 and garbage", () => {
    expect(isAllowedClient("10.20.31.50", home)).toBe(false);
    expect(isAllowedClient("172.16.0.4", home)).toBe(false);
    expect(isAllowedClient("8.8.8.8", home)).toBe(false);
    expect(isAllowedClient("2001:db8::1", home)).toBe(false);
    expect(isAllowedClient("127.0.0.1", home)).toBe(false);
    expect(isAllowedClient("10.20.30.256", home)).toBe(false);
    expect(isAllowedClient("", home)).toBe(false);
  });

  test("a public interface address never becomes an allowed subnet", () => {
    const subnets = localSubnets({
      eth0: [{ address: "203.0.113.7", netmask: "255.255.255.0", family: "IPv4", mac: "", internal: false, cidr: "203.0.113.7/24" }],
      lo: [{ address: "127.0.0.1", netmask: "255.0.0.0", family: "IPv4", mac: "", internal: true, cidr: "127.0.0.1/8" }],
      docker0: [{ address: "172.17.0.1", netmask: "255.255.0.0", family: "IPv4", mac: "", internal: false, cidr: "172.17.0.1/16" }],
      enp2s0: [{ address: "10.20.30.233", netmask: "255.255.255.0", family: "IPv4", mac: "", internal: false, cidr: "10.20.30.233/24" }],
    });
    expect(subnets.map((s) => s.cidr)).toEqual(["10.20.30.0/24"]);
  });

  test("private ranges", () => {
    expect(isPrivateIpv4("172.31.255.1")).toBe(true);
    expect(isPrivateIpv4("172.32.0.1")).toBe(false);
  });
});
