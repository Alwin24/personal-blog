# alwinhelor.com

Personal blog — technical writing on Solana smart contract development.
Built with [Astro](https://astro.build), deployed on Vercel.

## Development

```sh
npm install      # install dependencies
npm run dev      # start dev server at localhost:4321
npm run build    # production build to ./dist
npm run preview  # preview the production build locally
```

## Writing a post

Add a Markdown or MDX file under `src/content/blog/`. Frontmatter:

```yaml
---
title: 'Post title'
description: 'One-line summary used for SEO and post listings.'
pubDate: 'YYYY-MM-DD'
# updatedDate: 'YYYY-MM-DD'   # optional
# draft: true                 # optional — hidden in production builds
---
```

Drafts are visible in `npm run dev` but excluded from production builds,
the post list, RSS, and the sitemap.

## Structure

- `src/pages/` — routes (home, `/blog`, `/about`, `rss.xml`)
- `src/content/blog/` — posts
- `src/layouts/BlogPost.astro` — post layout
- `src/components/` — header, footer, head/meta
- `src/consts.ts` — site title, description, social links
- `src/styles/global.css` — global styles
