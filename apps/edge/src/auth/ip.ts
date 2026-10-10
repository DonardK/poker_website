/**
 * Coarse network for display: /24 for IPv4, /48 for IPv6. Enough to recognize
 * a home connection without showing the full address.
 */
export function coarseIp(ip: string | null | undefined): string | null {
  if (!ip) return null;
  const bare = ip.split("%")[0]!;
  const v4 = bare.toLowerCase().startsWith("::ffff:") && isIP(bare.slice(7)) === 4 ? bare.slice(7) : bare;
  if (isIP(v4) === 4) {
    const [a, b, c] = v4.split(".");
    return `${a}.${b}.${c}.0/24`;
  }
  if (isIP(v4) !== 6) return null;
  const [head, tail] = v4.includes("::") ? v4.split("::") as [string, string] : [v4, null];
  const left = head ? head.split(":") : [];
  const right = tail ? tail.split(":") : [];
  const groups = tail === null ? left : [...left, ...Array<string>(8 - left.length - right.length).fill("0"), ...right];
  return `${groups.slice(0, 3).map((g) => (parseInt(g, 16) || 0).toString(16)).join(":")}::/48`;
}

/**
 * Address key for familiar-device lockout. IPv4 is the whole address.
 * IPv6 is masked to /56, matching the previous express-rate-limit key.
 */
export function addressKey(ip: string | null | undefined): string | null {
  if (!ip) return null;
  const bare = ip.split("%")[0] ?? "";
  const mapped = bare.toLowerCase().startsWith("::ffff:") ? bare.slice(7) : bare;
  if (isIP(mapped) === 4) return mapped;
  if (isIP(bare) !== 6) return bare;
  const groups = expandIpv6(bare);
  if (!groups) return bare;
  const bits = groups.flatMap((group) => group.toString(2).padStart(16, "0").split(""));
  for (let i = 56; i < bits.length; i++) bits[i] = "0";
  const masked: number[] = [];
  for (let i = 0; i < 8; i++) masked.push(parseInt(bits.slice(i * 16, i * 16 + 16).join(""), 2));
  return masked.map((group) => group.toString(16)).join(":");
}

/** Same contract as Node `net.isIP`: 4, 6, or 0. */
function isIP(input: string): 0 | 4 | 6 {
  if (isIPv4(input)) return 4;
  if (isIPv6(input)) return 6;
  return 0;
}

function isIPv4(input: string): boolean {
  const parts = input.split(".");
  if (parts.length !== 4) return false;
  return parts.every((part) => /^(0|[1-9]\d{0,2})$/.test(part) && Number(part) <= 255);
}

function isIPv6(input: string): boolean {
  if (input.length === 0 || input.includes("%")) return false;
  return expandIpv6(input) !== null;
}

function expandIpv6(ip: string): number[] | null {
  const lower = ip.toLowerCase();
  const zone = lower.split("%")[0] ?? lower;
  const double = zone.split("::");
  if (double.length > 2) return null;
  const parseGroup = (group: string): number | null => {
    if (!/^[0-9a-f]{1,4}$/.test(group)) return null;
    return parseInt(group, 16);
  };
  const parseSide = (side: string, allowV4: boolean): number[] | null => {
    if (side.length === 0) return [];
    const parts = side.split(":");
    const out: number[] = [];
    for (let i = 0; i < parts.length; i++) {
      const part = parts[i] ?? "";
      if (allowV4 && i === parts.length - 1 && part.includes(".")) {
        if (!isIPv4(part)) return null;
        const [a, b, c, d] = part.split(".").map(Number) as [number, number, number, number];
        out.push((a << 8) | b, (c << 8) | d);
      } else {
        const value = parseGroup(part);
        if (value === null) return null;
        out.push(value);
      }
    }
    return out;
  };
  if (double.length === 1) {
    const groups = parseSide(zone, true);
    return groups && groups.length === 8 ? groups : null;
  }
  const left = parseSide(double[0] ?? "", false);
  const right = parseSide(double[1] ?? "", true);
  if (!left || !right) return null;
  const missing = 8 - left.length - right.length;
  if (missing < 0) return null;
  return [...left, ...Array<number>(missing).fill(0), ...right];
}
