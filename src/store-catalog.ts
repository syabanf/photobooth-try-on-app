// Loads real product photos from the DummyJSON sample store. Images are transparent cutouts served with open CORS.
import { CATEGORY_DEFAULTS, type CatalogItem, type Category } from './catalog';

const API = 'https://dummyjson.com/products/category';

const SOURCES: Array<{ slug: string; category: Category; scale: number }> = [
  { slug: 'mens-shirts', category: 'clothing', scale: CATEGORY_DEFAULTS.clothing.scale },
  { slug: 'tops', category: 'clothing', scale: CATEGORY_DEFAULTS.clothing.scale },
  { slug: 'sunglasses', category: 'glasses', scale: 1.6 },
];

interface Product {
  id: number;
  title: string;
  images: string[];
}

export async function loadStoreCatalog(): Promise<CatalogItem[]> {
  const lists = await Promise.all(
    SOURCES.map(async (source) => {
      const response = await fetch(`${API}/${source.slug}?select=title,images`);
      if (!response.ok) throw new Error(`${source.slug}: HTTP ${response.status}`);
      const { products } = (await response.json()) as { products: Product[] };
      return products
        .filter((product) => product.images.length > 0)
        .map<CatalogItem>((product) => ({
          id: `store-${product.id}`,
          name: product.title,
          category: source.category,
          src: product.images[0],
          scale: source.scale,
          offsetX: 0,
          offsetY: CATEGORY_DEFAULTS[source.category].offsetY,
        }));
    }),
  );
  return lists.flat();
}
