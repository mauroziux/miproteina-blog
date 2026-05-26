import { getCollection } from 'astro:content';
import type { APIRoute } from 'astro';
import { CDN_URL, SITE_URL } from '../../consts';

function resolveHeroImage(image: string): string {
  if (image.startsWith('http')) return image;
  if (image.startsWith('/blog/infographics/')) return `${SITE_URL}${image}`;
  return `${CDN_URL}${image}`;
}

export const GET: APIRoute = async () => {
  const now = new Date();
  const posts = (await getCollection('blog'))
    .filter((post) => post.data.pubDate <= now)
    .sort((a, b) => b.data.pubDate.valueOf() - a.data.pubDate.valueOf())
    .slice(0, 4)
    .map((post) => {
      const heroImage = post.data.heroImage || '';
      const image = heroImage
        ? resolveHeroImage(heroImage)
        : 'https://unsplash.it/350/200';

      return {
        title: post.data.title,
        description: post.data.description,
        date: post.data.pubDate,
        link: `${SITE_URL}/${post.data.wpSlug}/`,
        image,
      };
    });

  return new Response(JSON.stringify(posts), {
    headers: {
      'Content-Type': 'application/json; charset=utf-8',
      'Cache-Control': 'public, max-age=300, s-maxage=600',
    },
  });
};
