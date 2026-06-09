import { getCollection } from 'astro:content';

// Returns published posts, newest first. Drafts are excluded in production
// builds but visible during `astro dev` so you can preview them.
export async function getPublishedPosts() {
	const posts = await getCollection('blog', ({ data }) =>
		import.meta.env.PROD ? data.draft !== true : true,
	);
	return posts.sort((a, b) => b.data.pubDate.valueOf() - a.data.pubDate.valueOf());
}
