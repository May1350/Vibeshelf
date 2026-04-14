// Verifies the cron discover route invalidates the correct cache tags.
//
// The cron route (app/api/cron/discover/route.ts) must call:
//   revalidateTag("repos:facets", "max")
//   revalidateTag("repos:list",   "max")
//   revalidateTag(`repo:${id}`,   "max")   — for each id in changedRepoIds
//
// Pipeline jobs cannot import next/cache (Foundation rule 9), so the cron
// route handler performs the invalidation from job output.
//
// CRITICAL: All mocks must be registered before `await import` of the route
// (Next module graph captures references on first load). We use vi.hoisted
// to share the revalidateTagMock with both the `vi.mock` factory and the
// assertions, and we gate the route import behind a per-test dynamic import
// with vi.resetModules so each describe-block gets a fresh module with the
// active runJob mock.

import { beforeEach, describe, expect, it, vi } from "vitest";

// vi.hoisted runs before any import/mock — so the mock below can close over
// revalidateTagMock safely.
const { revalidateTagMock, runJobMock } = vi.hoisted(() => ({
  revalidateTagMock: vi.fn(),
  runJobMock: vi.fn(),
}));

vi.mock("next/cache", () => ({
  revalidateTag: revalidateTagMock,
}));

vi.mock("@/lib/pipeline/runJob", () => ({
  runJob: runJobMock,
}));

// Route's only other dependency we don't need to actually exercise.
vi.mock("@/lib/pipeline/jobs/discover", () => ({
  discoverJob: vi.fn(),
}));

async function importRoute(): Promise<{
  GET: (req: Request) => Promise<Response>;
}> {
  vi.resetModules();
  return (await import("@/app/api/cron/discover/route")) as {
    GET: (req: Request) => Promise<Response>;
  };
}

// CRON_SECRET comes from vitest.config.ts env — "test-cron-secret".
const VALID_AUTH = "Bearer test-cron-secret";

describe("app/api/cron/discover — revalidateTag wiring", () => {
  beforeEach(() => {
    revalidateTagMock.mockClear();
    runJobMock.mockReset();
  });

  it("rejects requests without the matching bearer token (401)", async () => {
    runJobMock.mockResolvedValue({ changedRepoIds: [] });
    const { GET } = await importRoute();

    const res = await GET(
      new Request("http://localhost/api/cron/discover", {
        headers: { authorization: "Bearer wrong" },
      }),
    );
    expect(res.status).toBe(401);
    expect(revalidateTagMock).not.toHaveBeenCalled();
  });

  it("calls revalidateTag for repos:facets + repos:list + each changed repo id", async () => {
    runJobMock.mockResolvedValue({ changedRepoIds: ["id-1", "id-2"] });
    const { GET } = await importRoute();

    const res = await GET(
      new Request("http://localhost/api/cron/discover", {
        headers: { authorization: VALID_AUTH },
      }),
    );
    expect(res.status).toBe(200);

    expect(revalidateTagMock).toHaveBeenCalledWith("repos:facets", "max");
    expect(revalidateTagMock).toHaveBeenCalledWith("repos:list", "max");
    expect(revalidateTagMock).toHaveBeenCalledWith("repo:id-1", "max");
    expect(revalidateTagMock).toHaveBeenCalledWith("repo:id-2", "max");
  });

  it("does NOT call revalidateTag when changedRepoIds is empty", async () => {
    runJobMock.mockResolvedValue({ changedRepoIds: [] });
    const { GET } = await importRoute();

    const res = await GET(
      new Request("http://localhost/api/cron/discover", {
        headers: { authorization: VALID_AUTH },
      }),
    );
    expect(res.status).toBe(200);
    expect(revalidateTagMock).not.toHaveBeenCalled();
  });

  it("does NOT call revalidateTag when changedRepoIds is absent from the job result", async () => {
    runJobMock.mockResolvedValue({ repos_discovered: 3 });
    const { GET } = await importRoute();

    const res = await GET(
      new Request("http://localhost/api/cron/discover", {
        headers: { authorization: VALID_AUTH },
      }),
    );
    expect(res.status).toBe(200);
    expect(revalidateTagMock).not.toHaveBeenCalled();
  });
});
