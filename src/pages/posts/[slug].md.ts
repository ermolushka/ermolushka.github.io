import type { APIRoute, GetStaticPaths } from "astro";
import { getCollection } from "astro:content";
import { SITE } from "@config";

export const getStaticPaths = (async () => {
  const posts = await getCollection("blog", ({ data }) => !data.draft);
  return posts.map(post => ({ params: { slug: post.slug }, props: { post } }));
}) satisfies GetStaticPaths;

export const GET: APIRoute = ({ props }) => {
  const { post } = props as { post: Awaited<ReturnType<typeof getCollection<"blog">>>[number] };
  const { title, description, pubDatetime, modDatetime, author } = post.data;
  const url = new URL(`posts/${post.slug}/`, SITE.website).href;
  const header = [
    `# ${title}`,
    "",
    `> ${description}`,
    "",
    `Author: ${author}`,
    `Published: ${pubDatetime.toISOString()}`,
    ...(modDatetime ? [`Updated: ${modDatetime.toISOString()}`] : []),
    `Canonical: ${url}`,
    "",
    "---",
    "",
  ].join("\n");
  return new Response(header + (post.body ?? ""), {
    headers: { "Content-Type": "text/markdown; charset=utf-8" },
  });
};
