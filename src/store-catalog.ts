// Real product photos: clothing and glasses from the DummyJSON sample store, which serves
// transparent cutouts, and hats from Wikimedia Commons. Both send open CORS headers.
import { commons } from './backgrounds';
import { CATEGORY_DEFAULTS, type CatalogItem, type Category } from './catalog';

function hat(id: string, name: string, path: string, scale: number, offsetY: number, credit: string): CatalogItem {
  return { id: `hat-${id}`, name, category: 'hat', src: commons(path, 960), scale, offsetX: 0, offsetY, credit };
}

/**
 * Hat photos from Wikimedia Commons. Most sit on a plain backdrop, which `loadImage` clears. The
 * credit shows on each item's tooltip, as the CC BY and CC BY-SA licenses ask. File pages:
 * commons.wikimedia.org/wiki/File:<name>.
 */
export const COMMONS_HATS: CatalogItem[] = [
  hat('baseball', 'Baseball cap', '6/64/Baseball_cap.png', 1.6, 0.24, 'Photo: TexasRebel and ReneeWrites, CC BY 4.0'),
  hat('fedora', 'Fedora', '6/64/Herrenhut_breitkrempig_03_%28fcm%29.jpg', 1.7, 0.18, 'Photo: Frank C. Müller and Rainer Zenz, CC BY-SA 2.5'),
  hat('flat', 'Flat cap', '9/9d/Hat_MET_29.158.485_S.jpg', 1.4, 0.24, 'Photo: The Metropolitan Museum of Art, CC0'),
  hat('bobble', 'Bobble hat', 'c/cc/M%C3%B6ssa_-_Nordiska_museet_-_NM.0050303.jpg', 1.25, 0.2, 'Photo: Elisabeth Eriksson, Nordiska museet, CC BY 4.0'),
  hat('top', 'Top hat', '4/47/Collapsible_top_hat_IMGP9647.jpg', 1.45, 0.28, 'Photo: Nikodem Nijaki, CC BY-SA 3.0'),
  hat('straw', 'Straw hat', '4/45/Straw_hat%2C_Vietnamese_Women%27s_Museum.jpg', 2.0, 0.2, "Photo: Vietnamese Women's Museum, CC BY-SA 3.0"),
];

const API = 'https://dummyjson.com/products/category';

const SOURCES: Array<{ slug: string; category: Category; scale: number }> = [
  { slug: 'mens-shirts', category: 'clothing', scale: CATEGORY_DEFAULTS.clothing.scale },
  { slug: 'tops', category: 'clothing', scale: CATEGORY_DEFAULTS.clothing.scale },
  { slug: 'sunglasses', category: 'glasses', scale: 1.8 },
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
