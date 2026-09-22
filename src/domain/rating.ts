/**
 * Product rating aggregate - the incremental rule the storefront fix uses (BUG_FIXES #3, replacing the legacy ">150 reviews drift"):
 *   count' = count + 1,   rating' = round1( (rating * count + new) / (count + 1) )
 * `ratingUpdatePipeline` is the same maths as an ATOMIC MongoDB update (no read-modify-write race between two reviews).
 */
export const round1 = (n: number) => Math.round(n * 10) / 10;

export function applyReviewToRating(rating: number, reviewCount: number, newRating: number): { rating: number; reviewCount: number } {
  const count = reviewCount + 1;
  return { rating: round1((rating * reviewCount + newRating) / count), reviewCount: count };
}

export const ratingUpdatePipeline = (newRating: number) => [
  {
    $set: {
      rating: { $round: [{ $divide: [{ $add: [{ $multiply: ['$rating', '$reviewCount'] }, newRating] }, { $add: ['$reviewCount', 1] }] }, 1] },
      reviewCount: { $add: ['$reviewCount', 1] },
    },
  },
];

/**
 * The exact inverse (Module 6, for moderating a review away): count' = count - 1, rating' = round1((rating*count - removed) / count').
 * Once the last real review is removed (count reaches 0) there is nothing left to average, so it resets to the product's
 * creation baseline (5 / 0) rather than leaving a stale number behind.
 */
export function removeReviewFromRating(rating: number, reviewCount: number, removedRating: number): { rating: number; reviewCount: number } {
  if (reviewCount <= 1) return { rating: 5, reviewCount: 0 };
  const count = reviewCount - 1;
  return { rating: round1((rating * reviewCount - removedRating) / count), reviewCount: count };
}

export const ratingRemovalPipeline = (removedRating: number) => [
  {
    $set: {
      rating: {
        $cond: [
          { $lte: ['$reviewCount', 1] },
          5,
          { $round: [{ $divide: [{ $subtract: [{ $multiply: ['$rating', '$reviewCount'] }, removedRating] }, { $subtract: ['$reviewCount', 1] }] }, 1] },
        ],
      },
      reviewCount: { $cond: [{ $lte: ['$reviewCount', 1] }, 0, { $subtract: ['$reviewCount', 1] }] },
    },
  },
];
