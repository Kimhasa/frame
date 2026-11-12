// Allocate rounded percentage points in option order so a nonempty poll always totals exactly 100%.
export function pollPercentages(options: readonly { votes: number }[]): number[] {
  const total = options.reduce((sum, option) => sum + option.votes, 0);
  if (!total) return options.map(() => 0);
  const exact = options.map(option => option.votes / total * 100), rounded = exact.map(Math.floor);
  const order = exact.map((value, index) => ({ index, remainder: value - rounded[index] }))
    .sort((a, b) => b.remainder - a.remainder || a.index - b.index);
  for (const { index } of order.slice(0, 100 - rounded.reduce((sum, value) => sum + value, 0))) rounded[index]++;
  return rounded;
}
