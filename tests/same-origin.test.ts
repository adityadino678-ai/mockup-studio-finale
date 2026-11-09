import { describe, expect, it } from "vitest";
import { sameOriginRequest } from "@/lib/server/same-origin";

/** The guard was moved out of status.ts verbatim; pin its behaviour. */
describe("sameOriginRequest", () => {
  it("allows a request with no Origin (same-origin fetch or curl)", () => {
    expect(sameOriginRequest(new Request("http://localhost/api/integrations/readiness"))).toBe(true);
  });

  it("rejects a cross-site sec-fetch-site or a different Origin", () => {
    const crossSite = new Request("http://localhost/api/integrations/readiness", {
      headers: { "sec-fetch-site": "cross-site" },
    });
    const otherOrigin = new Request("http://localhost/api/integrations/readiness", {
      headers: { origin: "https://evil.example" },
    });
    expect(sameOriginRequest(crossSite)).toBe(false);
    expect(sameOriginRequest(otherOrigin)).toBe(false);
  });

  it("allows the matching Origin and rejects a malformed one", () => {
    const same = new Request("http://localhost/api/integrations/readiness", {
      headers: { origin: "http://localhost" },
    });
    const malformed = new Request("http://localhost/api/integrations/readiness", {
      headers: { origin: "not a url" },
    });
    expect(sameOriginRequest(same)).toBe(true);
    expect(sameOriginRequest(malformed)).toBe(false);
  });
});
