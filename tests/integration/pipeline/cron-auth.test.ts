// Cron route auth tests — asserts the 3 cron endpoints reject missing
// or mismatched CRON_SECRET without touching the underlying job.
//
// We deliberately do NOT test the 200/success path from here: that path
// would call runJob → discoverJob/refreshJob/dormantJob, which need a
// real DB + token pool + mocked fetch. Those paths are covered by the
// job-specific integration tests. The only contract we guard here is
// "wrong secret → 401".

import { describe, expect, it } from "vitest";
import { GET as discoverGET } from "@/app/api/cron/discover/route";
import { GET as dormantGET } from "@/app/api/cron/dormant/route";
import { GET as refreshGET } from "@/app/api/cron/refresh/route";

const routes: Array<{ name: string; handler: (req: Request) => Promise<Response> }> = [
  { name: "discover", handler: discoverGET },
  { name: "refresh", handler: refreshGET },
  { name: "dormant", handler: dormantGET },
];

describe("cron route auth", () => {
  for (const { name, handler } of routes) {
    describe(`/api/cron/${name}`, () => {
      it("returns 401 when no Authorization header is present", async () => {
        const req = new Request(`https://example.test/api/cron/${name}`);
        const res = await handler(req);
        expect(res.status).toBe(401);
      });

      it("returns 401 when the bearer token is wrong", async () => {
        const req = new Request(`https://example.test/api/cron/${name}`, {
          headers: { Authorization: "Bearer wrong-secret" },
        });
        const res = await handler(req);
        expect(res.status).toBe(401);
      });

      it("returns 401 when the header is present but malformed (no 'Bearer ' prefix)", async () => {
        const req = new Request(`https://example.test/api/cron/${name}`, {
          headers: { Authorization: "not-a-bearer-token" },
        });
        const res = await handler(req);
        expect(res.status).toBe(401);
      });
    });
  }
});
