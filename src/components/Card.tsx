import { slugifyStr } from "@utils/slugify";
import type { CollectionEntry } from "astro:content";
import { LOCALE } from "@config";

export interface Props {
  href?: string;
  frontmatter: CollectionEntry<"blog">["data"];
  secHeading?: boolean;
}

export default function Card({ href, frontmatter, secHeading = true }: Props) {
  const { title, pubDatetime, modDatetime, description } = frontmatter;
  const shown = new Date(
    modDatetime && modDatetime > pubDatetime ? modDatetime : pubDatetime,
  );
  const when = shown.toLocaleDateString(LOCALE.langTag, {
    year: "numeric",
    month: "short",
  });

  const headerProps = {
    style: { viewTransitionName: slugifyStr(title) },
    className: "text-base font-semibold leading-snug",
  };

  return (
    <li
      data-post-row={href}
      className="group grid gap-x-6 border-t border-skin-line py-5 transition-colors data-[on]:bg-skin-card sm:grid-cols-[6.5rem_1fr] [&.on]:bg-skin-card"
    >
      <time
        dateTime={shown.toISOString()}
        className="font-mono text-xs leading-7 opacity-85"
      >
        {when}
      </time>
      <div>
        <a
          href={href}
          className="block text-skin-accent underline-offset-4 hover:underline focus-visible:underline"
        >
          {secHeading ? (
            <h2 {...headerProps}>{title}</h2>
          ) : (
            <h3 {...headerProps}>{title}</h3>
          )}
        </a>
        <p className="mt-1 max-w-[38rem]">{description}</p>
      </div>
    </li>
  );
}
