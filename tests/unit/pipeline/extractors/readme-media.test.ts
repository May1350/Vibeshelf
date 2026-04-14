import { describe, expect, it } from "vitest";
import { extractReadmeMedia } from "@/lib/pipeline/extractors/readme-media";

describe("extractReadmeMedia", () => {
  it("returns empty array for empty input", async () => {
    expect(await extractReadmeMedia("")).toEqual([]);
  });

  it("extracts markdown image syntax", async () => {
    const md = "Welcome!\n\n![alt text](https://example.com/x.png)";
    const media = await extractReadmeMedia(md);
    expect(media).toHaveLength(1);
    expect(media[0]?.url).toBe("https://example.com/x.png");
    expect(media[0]?.kind).toBe("readme_image");
  });

  it("extracts raw HTML img tags", async () => {
    const md = '<img src="https://example.com/x.gif" alt="demo">';
    const media = await extractReadmeMedia(md);
    expect(media).toHaveLength(1);
    expect(media[0]?.url).toBe("https://example.com/x.gif");
    expect(media[0]?.kind).toBe("readme_gif");
  });

  it("extracts HTML img tags with single quotes", async () => {
    const md = "<img src='https://example.com/y.png' />";
    const media = await extractReadmeMedia(md);
    expect(media.map((m) => m.url)).toContain("https://example.com/y.png");
  });

  it("gives GIFs higher priority (lower number) than images", async () => {
    const md = `
![screenshot](https://example.com/img.png)

![demo](https://example.com/clip.gif)
`;
    const media = await extractReadmeMedia(md);
    const gif = media.find((m) => m.kind === "readme_gif");
    const img = media.find((m) => m.kind === "readme_image");
    if (!gif || !img) throw new Error("expected both a gif and an image in output");
    expect(gif.priority).toBeGreaterThanOrEqual(10);
    expect(gif.priority).toBeLessThan(20);
    expect(img.priority).toBeGreaterThanOrEqual(20);
    expect(gif.priority).toBeLessThan(img.priority);
  });

  it("dedupes identical URLs across markdown and HTML passes", async () => {
    const md = `
![screenshot](https://example.com/shared.png)

<img src="https://example.com/shared.png">
`;
    const media = await extractReadmeMedia(md);
    expect(media).toHaveLength(1);
    expect(media[0]?.url).toBe("https://example.com/shared.png");
  });

  it("filters out shields.io badges (img.shields.io subdomain)", async () => {
    const md = "![build](https://img.shields.io/github/stars/foo/bar)";
    expect(await extractReadmeMedia(md)).toEqual([]);
  });

  it("filters out shields.io on the bare host too", async () => {
    const md = "![build](https://shields.io/something)";
    expect(await extractReadmeMedia(md)).toEqual([]);
  });

  it("filters out badgen.net badges", async () => {
    const md = "![badge](https://badgen.net/npm/v/foo)";
    expect(await extractReadmeMedia(md)).toEqual([]);
  });

  it("filters out /badge.svg style paths even on arbitrary hosts", async () => {
    const md = "![ci](https://github.com/owner/repo/actions/workflows/ci.yml/badge.svg)";
    expect(await extractReadmeMedia(md)).toEqual([]);
  });

  it("filters out relative markdown URLs (docs/screenshot.png)", async () => {
    const md = "![screenshot](docs/screenshot.png)";
    expect(await extractReadmeMedia(md)).toEqual([]);
  });

  it("filters out data URLs", async () => {
    const md =
      "![pixel](data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8/5+hHgAHggJ/PchI7wAAAABJRU5ErkJggg==)";
    expect(await extractReadmeMedia(md)).toEqual([]);
  });

  it("handles malformed markdown without throwing", async () => {
    const md = '![broken](unclosed\n\n<img src="https://example.com/ok.png">';
    await expect(extractReadmeMedia(md)).resolves.toBeDefined();
    const media = await extractReadmeMedia(md);
    expect(media.map((m) => m.url)).toContain("https://example.com/ok.png");
  });

  it("classifies .gif URLs as readme_gif (case-insensitive)", async () => {
    const md = "![anim](https://example.com/x.GIF)";
    const media = await extractReadmeMedia(md);
    expect(media[0]?.kind).toBe("readme_gif");
  });

  it("classifies non-gif extensions as readme_image", async () => {
    const md = "![pic](https://example.com/photo.jpeg)";
    const media = await extractReadmeMedia(md);
    expect(media[0]?.kind).toBe("readme_image");
  });

  it("still classifies as readme_gif when there is a query string (foo.gif?v=1)", async () => {
    const md = "![anim](https://example.com/foo.gif?v=1)";
    const media = await extractReadmeMedia(md);
    expect(media[0]?.kind).toBe("readme_gif");
  });

  it("orders GIFs before images in the returned list", async () => {
    const md = `
![pic1](https://example.com/a.png)
![pic2](https://example.com/b.jpg)
![anim](https://example.com/c.gif)
`;
    const media = await extractReadmeMedia(md);
    expect(media[0]?.kind).toBe("readme_gif");
  });
});
