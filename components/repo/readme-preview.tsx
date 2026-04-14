import DOMPurify from "isomorphic-dompurify";

export function ReadmePreview({ html }: { html: string }) {
  // DOMPurify strips <script>, javascript: URLs, on* attrs, etc.
  // Allow images via http(s) only (camo URLs already filtered upstream).
  const clean = DOMPurify.sanitize(html, {
    ALLOWED_TAGS: [
      "h1",
      "h2",
      "h3",
      "h4",
      "h5",
      "h6",
      "p",
      "br",
      "strong",
      "em",
      "u",
      "code",
      "pre",
      "blockquote",
      "ul",
      "ol",
      "li",
      "a",
      "img",
      "table",
      "thead",
      "tbody",
      "tr",
      "th",
      "td",
      "hr",
      "div",
      "span",
    ],
    ALLOWED_ATTR: ["href", "src", "alt", "title", "class"],
    ALLOWED_URI_REGEXP: /^(?:https?:\/\/|#)/i,
  });
  return (
    <section aria-labelledby="readme-heading" className="prose dark:prose-invert max-w-none">
      <h2 id="readme-heading">Documentation preview</h2>
      {/* biome-ignore lint/security/noDangerouslySetInnerHtml: sanitized via DOMPurify above */}
      <div dangerouslySetInnerHTML={{ __html: clean }} />
    </section>
  );
}
