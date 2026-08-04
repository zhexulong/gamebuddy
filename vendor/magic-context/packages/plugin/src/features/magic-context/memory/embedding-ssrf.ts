/**
 * Narrow SSRF guard for the OpenAI-compatible embedding endpoint.
 *
 * The endpoint can be set from a (now-hardened, but still attacker-influenced)
 * project config. The request body is memory content, which can contain
 * captured secrets/code. The classic SSRF target is the cloud **metadata**
 * service (`169.254.169.254` / `metadata.google.internal`), reachable from
 * inside most cloud VMs with no auth.
 *
 * Design choice — proportionate, NOT a blanket internal-network block:
 *   - BLOCK link-local (169.254.0.0/16, incl. AWS/GCP/Azure metadata) and the
 *     known metadata hostnames. These are never a legitimate embedding host.
 *   - ALLOW loopback (127.0.0.0/8, localhost, ::1) and RFC1918 private ranges
 *     (10/8, 172.16/12, 192.168/16). Self-hosted embeddings (LMStudio on
 *     localhost, Ollama on a LAN GPU box) are the common case and must keep
 *     working.
 *
 * This is a string/host-level check, not a DNS-resolving guard: a determined
 * attacker could still point a domain at a link-local IP (DNS rebinding). Full
 * resolution-time protection is heavier and deferred; this closes the direct
 * literal-metadata-endpoint vector without breaking any legitimate setup.
 */

const METADATA_HOSTNAMES = new Set(["metadata.google.internal", "metadata.goog"]);

/**
 * AWS exposes its instance metadata service over IPv6 at the fixed unique-local
 * address `fd00:ec2::254` (in addition to the IPv4 `169.254.169.254`). The
 * broader `fc00::/7` unique-local range is NOT blocked wholesale — legitimate
 * self-hosted embedding servers may live on ULA addresses — so we block only the
 * known fixed metadata literal, matching the "block known metadata, allow
 * private/self-hosted" design. WHATWG URL canonicalizes the address (e.g.
 * `[fd00:ec2:0:0:0:0:0:254]` → `fd00:ec2::254`), so compare the compressed form.
 */
const IPV6_METADATA_HOSTS = new Set(["fd00:ec2::254"]);

/** 169.254.0.0/16 — link-local, which includes the cloud metadata IP. */
function isLinkLocalIpv4(host: string): boolean {
    return /^169\.254\.\d{1,3}\.\d{1,3}$/.test(host);
}

/**
 * Extract a dotted-quad IPv4 from an IPv4-mapped IPv6 host so the link-local
 * check sees it. WHATWG URL canonicalizes plain IPv4 literals (decimal/octal/hex
 * → dotted) for http(s) on its own, but it keeps IPv4-mapped IPv6 in HEX form,
 * e.g. `http://[::ffff:169.254.169.254]` → hostname `::ffff:a9fe:a9fe`. Without
 * decoding that, `::ffff:a9fe:a9fe` slips past a string check and still routes to
 * the metadata IP. Handles both the dotted (`::ffff:169.254.169.254`) and hex
 * (`::ffff:a9fe:a9fe`) tails. Returns null when the host isn't IPv4-mapped.
 */
function ipv4FromMappedIpv6(host: string): string | null {
    const m = /^::ffff:(.+)$/.exec(host);
    if (!m) return null;
    const tail = m[1];
    // Dotted form: ::ffff:169.254.169.254
    if (/^\d{1,3}(\.\d{1,3}){3}$/.test(tail)) return tail;
    // Hex form: ::ffff:a9fe:a9fe → 169.254.169.254
    const hex = /^([0-9a-f]{1,4}):([0-9a-f]{1,4})$/.exec(tail);
    if (hex) {
        const hi = Number.parseInt(hex[1], 16);
        const lo = Number.parseInt(hex[2], 16);
        if (Number.isNaN(hi) || Number.isNaN(lo)) return null;
        return `${(hi >> 8) & 0xff}.${hi & 0xff}.${(lo >> 8) & 0xff}.${lo & 0xff}`;
    }
    return null;
}

/**
 * Returns a non-empty reason string when the endpoint host is blocked, or null
 * when it is allowed. Malformed URLs are blocked (fail closed) since a config
 * value that can't even be parsed as a URL should not reach `fetch`.
 */
export function blockedEmbeddingEndpointReason(endpoint: string): string | null {
    const trimmed = endpoint.trim();
    if (trimmed.length === 0) return null; // empty → provider already no-ops

    let url: URL;
    try {
        url = new URL(trimmed);
    } catch {
        return `embedding endpoint is not a valid URL: ${trimmed}`;
    }

    // WHATWG URL keeps the brackets on IPv6 hostnames ("[fe80::1]"); strip them
    // so the link-local prefix checks below match. Lowercase for comparison.
    const host = url.hostname.toLowerCase().replace(/^\[/, "").replace(/\]$/, "");

    if (METADATA_HOSTNAMES.has(host)) {
        return `embedding endpoint host ${host} is a cloud metadata service (blocked)`;
    }
    if (IPV6_METADATA_HOSTS.has(host)) {
        return `embedding endpoint host ${host} is the AWS IPv6 metadata service (blocked)`;
    }
    if (isLinkLocalIpv4(host)) {
        return `embedding endpoint host ${host} is link-local / cloud metadata (blocked)`;
    }
    // IPv4-mapped IPv6 (::ffff:a.b.c.d or hex ::ffff:hhhh:hhhh) — decode to the
    // embedded IPv4 and re-check link-local so the metadata IP can't slip through
    // an alternate spelling.
    const mappedV4 = ipv4FromMappedIpv6(host);
    if (mappedV4 && isLinkLocalIpv4(mappedV4)) {
        return `embedding endpoint host ${host} (IPv4-mapped ${mappedV4}) is link-local / cloud metadata (blocked)`;
    }
    // IPv6 link-local (fe80::/10).
    if (host.startsWith("fe80:")) {
        return `embedding endpoint host ${host} is link-local / cloud metadata (blocked)`;
    }

    return null;
}
