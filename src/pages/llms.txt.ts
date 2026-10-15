import type { APIRoute } from "astro";
import { getCollection } from "astro:content";
import getSortedPosts from "@utils/getSortedPosts";
import { SITE } from "@config";

export const GET: APIRoute = async () => {
  const posts = getSortedPosts(await getCollection("blog"));
  const lines = [
    `# ${SITE.title}`,
    "",
    `> ${SITE.desc}`,
    "",
    "Each post is available as HTML and as raw Markdown (append `.md` to the post URL).",
    "",
    "## Posts",
    "",
    ...posts.map(
      ({ data, slug }) =>
        `- [${data.title}](${new URL(`posts/${slug}.md`, SITE.website).href}): ${data.description}`,
    ),
    "",
    "## Optional",
    "",
    `- [RSS feed](${new URL("rss.xml", SITE.website).href})`,
    `- [Sitemap](${new URL("sitemap-index.xml", SITE.website).href})`,
    `- [Author on GitHub](${SITE.profile})`,
  ];
  return new Response(lines.join("\n"), {
    headers: { "Content-Type": "text/plain; charset=utf-8" },
  });
};
